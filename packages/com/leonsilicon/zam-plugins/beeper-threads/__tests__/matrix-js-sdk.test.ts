/**
 * Runs the patch against matrix-js-sdk's real Thread code (the version Zam
 * ships), with a fake homeserver that refuses /relations and /threads the way
 * Beeper does in bridged rooms. This is the test that notices if a Zam or SDK
 * update changes the internals the plugin relies on.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createClient,
  Feature,
  FeatureSupport,
  logger,
  PendingEventOrdering,
  Room,
  ServerSupport,
  Thread,
  type IEvent,
  type MatrixClient,
} from "@-/com.npmjs.matrix-js-sdk";
import {
  patchClient,
  retryFailedThreads,
  type PatchableClient,
} from "@-/com.leonsilicon.zam-plugins.beeper-threads";

const ROOM = "!room:beeper.local";
const ME = "@me:beeper.com";
const BOT = "@bot:beeper.local";

function raw(id: string, sender: string, ts: number, threadRoot?: string): IEvent {
  return {
    event_id: id,
    room_id: ROOM,
    type: "m.room.message",
    sender,
    origin_server_ts: ts,
    unsigned: {},
    content: {
      msgtype: "m.text",
      body: id,
      ...(threadRoot === undefined
        ? {}
        : { "m.relates_to": { rel_type: "m.thread", event_id: threadRoot } }),
    },
  };
}

const history = [
  raw("$old", ME, 1),
  raw("$root", ME, 2),
  raw("$reply1", BOT, 3, "$root"),
  raw("$noise", BOT, 4),
  raw("$reply2", BOT, 5, "$root"),
];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function beeperLikeServer(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const path = decodeURIComponent(url.pathname);
  if (path.includes("/relations/") || path.endsWith("/threads")) {
    return respond(403, { errcode: "M_FORBIDDEN", error: `User ${ME} not in room ${ROOM}` });
  }
  if (path.endsWith("/messages")) {
    const limit = Number(url.searchParams.get("limit"));
    const from = url.searchParams.get("from");
    if (url.searchParams.get("dir") === "b") {
      const at = from === null ? history.length : Number(from);
      const start = Math.max(0, at - limit);
      return respond(200, {
        chunk: history.slice(start, at).reverse(),
        start: String(at),
        end: String(start),
      });
    }
    const at = from === null ? 0 : Number(from);
    const end = Math.min(history.length, at + limit);
    return respond(200, { chunk: history.slice(at, end), start: String(at), end: String(end) });
  }
  const eventId = path.match(/\/event\/(.+)$/)?.[1];
  const found = history.find((e) => e.event_id === eventId);
  return found === undefined ? respond(404, { errcode: "M_NOT_FOUND" }) : respond(200, found);
}

function setUp(): { client: MatrixClient; room: Room } {
  const client = createClient({
    baseUrl: "https://hs.invalid",
    userId: ME,
    accessToken: "token",
    deviceId: "DEVICE",
    fetchFn: beeperLikeServer,
  });
  // What startClient would set up after reading /versions (Beeper advertises v1.11).
  (client as unknown as { clientOpts: object }).clientOpts = {
    threadSupport: true,
    pendingEventOrdering: PendingEventOrdering.Detached,
  };
  client.canSupport.set(Feature.RelationsRecursion, ServerSupport.Stable);
  const room = new Room(ROOM, client, ME, { pendingEventOrdering: PendingEventOrdering.Detached });
  client.store.storeRoom(room);
  return { client, room };
}

async function receive(client: MatrixClient, room: Room, events: IEvent[]): Promise<void> {
  await room.addLiveEvents(events.map(client.getEventMapper()), { addToState: false });
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** What Zam's thread panel lists: the thread's replies. */
function panel(room: Room, rootId: string): string[] {
  const thread = room.getThread(rootId);
  assert.ok(thread, `no thread ${rootId}`);
  return thread.events
    .filter((e) => e.getId() !== rootId && e.isRelation("m.thread"))
    .map((e) => e.getId() ?? "");
}

const asPatchable = (client: MatrixClient) => client as unknown as PatchableClient;
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);
let runnerListeners: NodeJS.UnhandledRejectionListener[] = [];

before(() => {
  (logger as unknown as { disableAll(): void }).disableAll();
  Thread.setServerSideSupport(FeatureSupport.Stable);
  Thread.setServerSideListSupport(FeatureSupport.Stable);
  Thread.setServerSideFwdPaginationSupport(FeatureSupport.Stable);
  // matrix-js-sdk awaits a failed first load again without catching it. A
  // browser only logs that; node:test would fail the test, so collect them.
  runnerListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", recordUnhandled);
});

after(() => {
  process.off("unhandledRejection", recordUnhandled);
  for (const listener of runnerListeners) process.on("unhandledRejection", listener);
  // Only the refusal itself may go unhandled, never an error from the patch.
  for (const reason of unhandled) {
    assert.equal((reason as { errcode?: unknown }).errcode, "M_FORBIDDEN");
  }
});

test("without the patch, the reply is counted but the thread stays empty", async () => {
  const { client, room } = setUp();
  await receive(client, room, [raw("$root", ME, 2), raw("$reply2", BOT, 5, "$root")]);
  await settle();
  const thread = room.getThread("$root");
  assert.equal(thread?.length, 1);
  assert.equal(thread.initialEventsFetched, false);
  assert.deepEqual(panel(room, "$root"), []);
});

test("patching after a failed load fills the thread, older replies included", async () => {
  const { client, room } = setUp();
  await receive(client, room, [raw("$root", ME, 2), raw("$reply2", BOT, 5, "$root")]);
  await settle();

  const unpatch = patchClient(asPatchable(client));
  assert.equal(retryFailedThreads(asPatchable(client)), 1);
  await settle();
  assert.deepEqual(panel(room, "$root"), ["$reply1", "$reply2"]);

  await receive(client, room, [raw("$reply3", BOT, 6, "$root")]);
  await settle();
  assert.deepEqual(panel(room, "$root"), ["$reply1", "$reply2", "$reply3"]);
  unpatch();
});

test("with the patch in place first, threads load normally", async () => {
  const { client, room } = setUp();
  const unpatch = patchClient(asPatchable(client));
  await receive(client, room, [raw("$root", ME, 2), raw("$reply2", BOT, 5, "$root")]);
  await settle();
  assert.deepEqual(panel(room, "$root"), ["$reply1", "$reply2"]);
  unpatch();
});

test("the threads list loads from history", async () => {
  const { client, room } = setUp();
  const unpatch = patchClient(asPatchable(client));
  await room.createThreadsTimelineSets();
  await room.fetchRoomThreads();
  const [all, mine] = room.threadsTimelineSets.map((set) =>
    set
      .getLiveTimeline()
      .getEvents()
      .map((e) => e.getId()),
  );
  assert.deepEqual(all, ["$root"]);
  assert.deepEqual(mine, ["$root"]);
  // The listing's bundled summary also gives the thread its full reply count.
  assert.equal(room.getThread("$root")?.length, 2);
  await settle();
  assert.deepEqual(panel(room, "$root"), ["$reply1", "$reply2"]);
  unpatch();
});
