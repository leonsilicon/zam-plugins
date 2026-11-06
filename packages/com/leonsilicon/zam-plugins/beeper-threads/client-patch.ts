/**
 * Patches a live matrix-js-sdk client so its thread requests fall back to
 * room history in rooms where the server refuses `/relations` or `/threads`.
 * The client is typed structurally, by the few members used here; some are
 * matrix-js-sdk internals (checked against 45.0.0, which Zam 1.54.0 ships).
 */
import {
  cacheHistory,
  DEFAULT_LIMITS,
  scanRelations,
  scanThreadRoots,
  type Direction,
  type MessagesPage,
  type RawEvent,
  type RoomHistory,
  type ScanLimits,
} from "#relations-fallback";

export interface RelationsOptions {
  dir?: Direction;
  from?: string;
  limit?: number;
  recurse?: boolean;
}

export interface RelationsResponse {
  chunk: RawEvent[];
  next_batch?: string | null;
  prev_batch?: string | null;
}

/** What `createThreadListMessagesRequest` resolves to (already reshaped). */
export interface ThreadListResponse {
  chunk: RawEvent[];
  start?: string;
  end?: string;
}

/** matrix-js-sdk's `Thread`, including the private members used to retry it. */
export interface ThreadLike {
  id: string;
  initialEventsFetched: boolean;
  /** Spelled this way in matrix-js-sdk. */
  initalEventFetchProm?: Promise<unknown>;
  updateThreadMetadata?(): Promise<void>;
}

export interface RoomLike {
  roomId: string;
  getThreads(): ThreadLike[];
}

/** The request methods are typed as properties so they can be swapped out. */
export interface PatchableClient {
  fetchRelations: (
    roomId: string,
    eventId: string,
    relationType: string | null,
    eventType: string | null,
    opts?: RelationsOptions,
  ) => Promise<RelationsResponse>;
  createThreadListMessagesRequest: (
    roomId: string,
    fromToken: string | null,
    limit?: number,
    dir?: Direction,
    threadListType?: number | null,
    filter?: unknown,
  ) => Promise<ThreadListResponse>;
  getUserId(): string | null;
  getRooms(): RoomLike[];
  http: {
    authedRequest(
      method: string,
      path: string,
      queryParams?: Record<string, string>,
    ): Promise<unknown>;
  };
}

/** matrix-js-sdk's `ThreadFilterType.My` (`include=participated`). */
export const THREAD_LIST_PARTICIPATED = 0;

export type Log = (message: string, ...details: unknown[]) => void;

export interface PatchOptions {
  limits?: ScanLimits;
  log?: Log;
}

const noLog: Log = () => {};

/** Beeper answers `M_FORBIDDEN` ("not in room"); other servers may not know the endpoint. */
export function isThreadEndpointRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errcode } = error as { errcode?: unknown };
  return errcode === "M_FORBIDDEN" || errcode === "M_UNRECOGNIZED";
}

/** Room history read through the client's own authenticated HTTP API. */
export function clientHistory(client: Pick<PatchableClient, "http">): RoomHistory {
  const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;
  return {
    async messages(roomId, from, limit, dir) {
      const query: Record<string, string> = { dir, limit: String(limit) };
      if (from !== null) query.from = from;
      return (await client.http.authedRequest(
        "GET",
        `${room(roomId)}/messages`,
        query,
      )) as MessagesPage;
    },
    async tokenAfter(roomId, eventId) {
      const context = (await client.http.authedRequest(
        "GET",
        `${room(roomId)}/context/${encodeURIComponent(eventId)}`,
        { limit: "0" },
      )) as { end?: string };
      return context.end ?? null;
    },
    async event(roomId, eventId) {
      return (await client.http.authedRequest(
        "GET",
        `${room(roomId)}/event/${encodeURIComponent(eventId)}`,
      )) as RawEvent;
    },
  };
}

/**
 * Wraps `fetchRelations` and `createThreadListMessagesRequest` on this client
 * instance. Each room tries the server first; after a refusal, that room uses
 * history for the rest of the session. Returns a function that undoes the patch.
 */
export function patchClient(client: PatchableClient, options: PatchOptions = {}): () => void {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const log = options.log ?? noLog;
  const history = cacheHistory(clientHistory(client));
  const refused = new Set<string>();

  async function withFallback<T>(
    roomId: string,
    endpoint: string,
    server: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (!refused.has(roomId)) {
      try {
        return await server();
      } catch (error) {
        if (!isThreadEndpointRefusal(error)) throw error;
        refused.add(roomId);
        log(`The server refused ${endpoint} in ${roomId}; reading room history instead.`);
      }
    }
    return fallback();
  }

  const originalFetchRelations = client.fetchRelations;
  const originalThreadList = client.createThreadListMessagesRequest;
  const hadOwnFetchRelations = Object.hasOwn(client, "fetchRelations");
  const hadOwnThreadList = Object.hasOwn(client, "createThreadListMessagesRequest");

  client.fetchRelations = (roomId, eventId, relationType, eventType, opts = { dir: "b" }) =>
    withFallback(
      roomId,
      "/relations",
      () => originalFetchRelations.call(client, roomId, eventId, relationType, eventType, opts),
      () =>
        scanRelations(
          history,
          {
            roomId,
            eventId,
            relationType,
            eventType,
            dir: opts.dir ?? "b",
            from: opts.from ?? null,
            limit: opts.limit,
            recurse: opts.recurse,
          },
          limits,
        ),
    );

  client.createThreadListMessagesRequest = (
    roomId,
    fromToken,
    limit,
    dir,
    threadListType,
    filter,
  ) =>
    withFallback(
      roomId,
      "/threads",
      () => originalThreadList.call(client, roomId, fromToken, limit, dir, threadListType, filter),
      async () => {
        const { chunk } = await scanThreadRoots(
          history,
          {
            roomId,
            userId: client.getUserId(),
            participatedOnly: threadListType === THREAD_LIST_PARTICIPATED,
            from: fromToken ?? null,
          },
          limits,
        );
        // matrix-js-sdk reverses a /threads chunk before handing it on, and
        // equal (here absent) start and end tokens mean there are no more pages.
        return { chunk: chunk.slice().reverse() };
      },
    );

  return () => {
    if (hadOwnFetchRelations) client.fetchRelations = originalFetchRelations;
    else Reflect.deleteProperty(client, "fetchRelations");
    if (hadOwnThreadList) client.createThreadListMessagesRequest = originalThreadList;
    else Reflect.deleteProperty(client, "createThreadListMessagesRequest");
  };
}

/**
 * matrix-js-sdk never retries a thread whose first load failed: it keeps the
 * rejected promise and awaits it again. Once each such load settles as a
 * failure, clear it and load the thread again (through the patched client).
 * Returns how many threads were still waiting on their first load.
 */
export function retryFailedThreads(
  client: Pick<PatchableClient, "getRooms">,
  log: Log = noLog,
): number {
  let waiting = 0;
  for (const room of client.getRooms()) {
    for (const thread of room.getThreads()) {
      const firstLoad = thread.initalEventFetchProm;
      if (thread.initialEventsFetched || firstLoad === undefined) continue;
      if (typeof thread.updateThreadMetadata !== "function") continue;
      waiting++;
      firstLoad.then(
        () => {},
        () => {
          if (thread.initialEventsFetched || thread.initalEventFetchProm !== firstLoad) return;
          thread.initalEventFetchProm = undefined;
          thread.updateThreadMetadata?.().catch((error: unknown) => {
            log(`Couldn't load thread ${thread.id} in ${room.roomId}.`, error);
          });
        },
      );
    }
  }
  return waiting;
}
