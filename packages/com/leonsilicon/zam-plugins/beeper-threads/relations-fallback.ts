/**
 * Rebuilds the answers of the Matrix thread endpoints (`/relations` and
 * `/threads`) from plain room history (`/messages`). Beeper's server refuses
 * those endpoints in bridged rooms, but `/messages` works there, and every
 * thread reply carries its `m.relates_to` in cleartext, even when encrypted.
 */

/** A client-server API event as `/messages` returns it. */
export interface RawEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  room_id?: string;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

/** `b`: newest first. `f`: oldest first. */
export type Direction = "b" | "f";

export interface MessagesPage {
  chunk: RawEvent[];
  start?: string;
  end?: string;
}

/** The three history reads the fallback needs. */
export interface RoomHistory {
  /** `/messages`. A null `from` starts at the live end (for `b`). */
  messages(
    roomId: string,
    from: string | null,
    limit: number,
    dir: Direction,
  ): Promise<MessagesPage>;
  /** A pagination token for the point just after `eventId` (`/context`). */
  tokenAfter(roomId: string, eventId: string): Promise<string | null>;
  event(roomId: string, eventId: string): Promise<RawEvent>;
}

export interface ScanLimits {
  /** Events per `/messages` request. */
  pageSize: number;
  /** Stop after this many pages once something was found. */
  softPages: number;
  /** Never read more than this many pages in one call. */
  hardPages: number;
}

export const DEFAULT_LIMITS: ScanLimits = { pageSize: 100, softPages: 10, hardPages: 50 };

const DEFAULT_RELATIONS_LIMIT = 50;
/** Servers follow relations of relations to at least this depth (MSC3981). */
const RECURSION_DEPTH = 3;
const THREAD_REL_TYPES = new Set(["m.thread", "io.element.thread"]);

interface RelatesTo {
  rel_type?: string;
  event_id?: string;
}

function relatesTo(event: RawEvent): RelatesTo | undefined {
  const relation = event.content?.["m.relates_to"];
  return typeof relation === "object" && relation !== null ? (relation as RelatesTo) : undefined;
}

function withRoomId(event: RawEvent, roomId: string): RawEvent {
  return event.room_id === undefined ? { ...event, room_id: roomId } : event;
}

function isExhausted(page: MessagesPage, token: string | null): boolean {
  return page.chunk.length === 0 || page.end === undefined || page.end === token;
}

export interface RelationsQuery {
  roomId: string;
  eventId: string;
  relationType: string | null;
  eventType: string | null;
  dir: Direction;
  from: string | null;
  limit?: number;
  recurse?: boolean;
}

/** The shape of a `/relations` response. */
export interface RelationsPage {
  chunk: RawEvent[];
  next_batch?: string;
  prev_batch?: string;
}

function matchesFilters(event: RawEvent, query: RelationsQuery): boolean {
  if (query.relationType !== null && relatesTo(event)?.rel_type !== query.relationType)
    return false;
  return query.eventType === null || event.type === query.eventType;
}

/** The scanned events `/relations` would return, in scan order. */
function selectRelations(scanned: RawEvent[], query: RelationsQuery): RawEvent[] {
  let targets = new Set([query.eventId]);
  const related = new Set<string>();
  const depth = query.recurse === true ? RECURSION_DEPTH : 1;
  for (let level = 0; level < depth && targets.size > 0; level++) {
    // Each level only follows relations to the previous level's events.
    const found = new Set<string>();
    for (const event of scanned) {
      const target = relatesTo(event)?.event_id;
      if (target === undefined || related.has(event.event_id) || !targets.has(target)) continue;
      related.add(event.event_id);
      found.add(event.event_id);
    }
    targets = found;
  }
  return scanned.filter((event) => related.has(event.event_id) && matchesFilters(event, query));
}

/**
 * Answers a `/relations` request by paging through room history. Backwards
 * scans stop at the parent event, since nothing older can relate to it.
 */
export async function scanRelations(
  history: RoomHistory,
  query: RelationsQuery,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<RelationsPage> {
  const limit = query.limit ?? DEFAULT_RELATIONS_LIMIT;
  let token = query.from;
  if (token === null && query.dir === "f") {
    token = await history.tokenAfter(query.roomId, query.eventId);
    if (token === null) return { chunk: [] };
  }

  const scanned: RawEvent[] = [];
  let direct = 0;
  let next: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= limits.hardPages || (pages >= limits.softPages && direct > 0)) {
      next = token;
      break;
    }
    const page = await history.messages(query.roomId, token, limits.pageSize, query.dir);
    let reachedParent = false;
    for (const event of page.chunk) {
      if (query.dir === "b" && event.event_id === query.eventId) {
        reachedParent = true;
        break;
      }
      scanned.push(event);
      if (relatesTo(event)?.event_id === query.eventId && matchesFilters(event, query)) direct++;
    }
    if (reachedParent || isExhausted(page, token)) break;
    token = page.end ?? null;
    if (direct >= limit) {
      next = token;
      break;
    }
  }

  const chunk = selectRelations(scanned, query).map((event) => withRoomId(event, query.roomId));
  return {
    chunk,
    ...(next === null ? {} : { next_batch: next }),
    ...(query.from === null ? {} : { prev_batch: query.from }),
  };
}

export interface ThreadRootsQuery {
  roomId: string;
  userId: string | null;
  /** Only threads the user started or replied in (`include=participated`). */
  participatedOnly: boolean;
  /** Listings are one page, so any token means there is nothing more. */
  from: string | null;
}

/** The bundled `m.thread` aggregation a server puts on a thread root. */
export interface ThreadSummary {
  latest_event: RawEvent;
  count: number;
  current_user_participated: boolean;
}

function threadRootOf(event: RawEvent): string | undefined {
  const relation = relatesTo(event);
  return relation?.rel_type !== undefined && THREAD_REL_TYPES.has(relation.rel_type)
    ? relation.event_id
    : undefined;
}

function withThreadSummary(root: RawEvent, roomId: string, summary: ThreadSummary): RawEvent {
  const unsigned = root.unsigned ?? {};
  const relations = (unsigned["m.relations"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...withRoomId(root, roomId),
    unsigned: { ...unsigned, "m.relations": { ...relations, "m.thread": summary } },
  };
}

/**
 * Answers a `/threads` request from recent room history: thread roots, most
 * recent activity first, each with the bundled summary clients expect. Reply
 * counts are exact for threads whose root is inside the scanned window.
 */
export async function scanThreadRoots(
  history: RoomHistory,
  query: ThreadRootsQuery,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<{ chunk: RawEvent[] }> {
  if (query.from !== null) return { chunk: [] };

  const seen = new Map<string, RawEvent>();
  const threads = new Map<string, { latest: RawEvent; count: number; participated: boolean }>();
  let token: string | null = null;
  for (let pages = 0; pages < limits.hardPages; pages++) {
    if (pages >= limits.softPages && threads.size > 0) break;
    const page: MessagesPage = await history.messages(query.roomId, token, limits.pageSize, "b");
    for (const event of page.chunk) {
      seen.set(event.event_id, event);
      const rootId = threadRootOf(event);
      if (rootId === undefined) continue;
      const mine = event.sender === query.userId;
      const thread = threads.get(rootId);
      if (thread === undefined) {
        threads.set(rootId, {
          latest: withRoomId(event, query.roomId),
          count: 1,
          participated: mine,
        });
      } else {
        thread.count++;
        thread.participated ||= mine;
      }
    }
    if (isExhausted(page, token)) break;
    token = page.end ?? null;
  }

  const roots: RawEvent[] = [];
  // A backwards scan meets each thread's latest reply first, so map order is
  // already most recent activity first.
  for (const [rootId, thread] of threads) {
    const root =
      seen.get(rootId) ?? (await history.event(query.roomId, rootId).catch(() => undefined));
    if (root === undefined) continue;
    const participated = thread.participated || root.sender === query.userId;
    if (query.participatedOnly && !participated) continue;
    roots.push(
      withThreadSummary(root, query.roomId, {
        latest_event: thread.latest,
        count: thread.count,
        current_user_participated: participated,
      }),
    );
  }
  return { chunk: roots };
}

export interface HistoryCacheOptions {
  now?: () => number;
  /** For pages read from the live end, which change as messages arrive. */
  liveTtlMs?: number;
  /** For pages read from a token, which stay put. */
  tokenTtlMs?: number;
  maxEntries?: number;
}

/**
 * Shares `/messages` pages between scans, so several threads of one room
 * loading at once read its history only once.
 */
export function cacheHistory(inner: RoomHistory, options: HistoryCacheOptions = {}): RoomHistory {
  const now = options.now ?? Date.now;
  const liveTtlMs = options.liveTtlMs ?? 5_000;
  const tokenTtlMs = options.tokenTtlMs ?? 300_000;
  const maxEntries = options.maxEntries ?? 200;
  const pages = new Map<string, { expires: number; page: Promise<MessagesPage> }>();

  return {
    messages(roomId, from, limit, dir) {
      const key = JSON.stringify([roomId, from, limit, dir]);
      const hit = pages.get(key);
      if (hit !== undefined && hit.expires > now()) return hit.page;

      const page = inner.messages(roomId, from, limit, dir);
      const entry = { expires: now() + (from === null ? liveTtlMs : tokenTtlMs), page };
      pages.delete(key);
      pages.set(key, entry);
      page.catch(() => {
        if (pages.get(key) === entry) pages.delete(key);
      });
      for (const oldest of pages.keys()) {
        if (pages.size <= maxEntries) break;
        pages.delete(oldest);
      }
      return page;
    },
    tokenAfter: (roomId, eventId) => inner.tokenAfter(roomId, eventId),
    event: (roomId, eventId) => inner.event(roomId, eventId),
  };
}
