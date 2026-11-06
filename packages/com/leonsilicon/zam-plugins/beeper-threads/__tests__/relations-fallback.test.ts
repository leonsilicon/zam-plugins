import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cacheHistory,
  scanRelations,
  scanThreadRoots,
  type Direction,
  type MessagesPage,
  type RawEvent,
  type RelationsQuery,
  type RoomHistory,
  type ThreadSummary,
} from "@-/com.leonsilicon.zam-plugins.beeper-threads";

const ROOM = "!room:beeper.local";
const ME = "@me:beeper.com";
const BOT = "@bot:beeper.local";

let clock = 0;
function event(
  id: string,
  sender: string,
  relation?: { rel_type: string; event_id: string },
): RawEvent {
  return {
    event_id: id,
    type: "m.room.encrypted",
    sender,
    origin_server_ts: ++clock,
    content: relation === undefined ? {} : { "m.relates_to": relation },
  };
}
const thread = (root: string) => ({ rel_type: "m.thread", event_id: root });

/** Room history in chronological order; tokens are positions between events. */
function fakeHistory(timeline: RawEvent[]): RoomHistory & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async messages(
      roomId: string,
      from: string | null,
      limit: number,
      dir: Direction,
    ): Promise<MessagesPage> {
      assert.equal(roomId, ROOM);
      reads.push(`${dir}:${from ?? "live"}`);
      if (dir === "b") {
        const at = from === null ? timeline.length : Number(from);
        const start = Math.max(0, at - limit);
        return {
          chunk: timeline.slice(start, at).reverse(),
          start: String(at),
          end: String(start),
        };
      }
      const at = from === null ? 0 : Number(from);
      const end = Math.min(timeline.length, at + limit);
      return { chunk: timeline.slice(at, end), start: String(at), end: String(end) };
    },
    async tokenAfter(_roomId: string, eventId: string) {
      const index = timeline.findIndex((e) => e.event_id === eventId);
      return index === -1 ? null : String(index + 1);
    },
    async event(_roomId: string, eventId: string) {
      const found = timeline.find((e) => e.event_id === eventId);
      if (found === undefined)
        throw Object.assign(new Error("not found"), { errcode: "M_NOT_FOUND" });
      return found;
    },
  };
}

const ids = (events: RawEvent[]) => events.map((e) => e.event_id);

function summaryOf(roots: RawEvent[], id: string): ThreadSummary {
  const root = roots.find((e) => e.event_id === id);
  assert.ok(root, `no thread root ${id}`);
  const relations = root.unsigned?.["m.relations"] as Record<string, ThreadSummary> | undefined;
  assert.ok(relations?.["m.thread"], `no thread summary on ${id}`);
  return relations["m.thread"];
}
const small = { pageSize: 2, softPages: 10, hardPages: 50 };

function query(overrides: Partial<RelationsQuery> = {}): RelationsQuery {
  return {
    roomId: ROOM,
    eventId: "$root",
    relationType: null,
    eventType: null,
    dir: "b",
    from: null,
    ...overrides,
  };
}

describe("scanRelations", () => {
  const timeline = [
    event("$older", ME),
    event("$root", ME),
    event("$a", BOT, thread("$root")),
    event("$other", ME),
    event("$edit-a", BOT, { rel_type: "m.replace", event_id: "$a" }),
    event("$b", ME, thread("$root")),
    event("$elsewhere", BOT, thread("$older")),
  ];

  test("returns direct relations newest first and stops at the parent", async () => {
    const history = fakeHistory(timeline);
    const page = await scanRelations(history, query(), small);
    assert.deepEqual(ids(page.chunk), ["$b", "$a"]);
    assert.equal(page.next_batch, undefined);
    assert.ok(page.chunk.every((e) => e.room_id === ROOM));
    // Never reads past the root into older history.
    assert.deepEqual(history.reads, ["b:live", "b:5", "b:3"]);
  });

  test("includes relations of relations when recursing", async () => {
    const page = await scanRelations(fakeHistory(timeline), query({ recurse: true }), small);
    assert.deepEqual(ids(page.chunk), ["$b", "$edit-a", "$a"]);
  });

  test("filters by relation type", async () => {
    const page = await scanRelations(
      fakeHistory(timeline),
      query({ relationType: "m.thread", recurse: true }),
      small,
    );
    assert.deepEqual(ids(page.chunk), ["$b", "$a"]);
  });

  test("pages by limit and continues from next_batch", async () => {
    const history = fakeHistory(timeline);
    const first = await scanRelations(history, query({ limit: 1 }), small);
    assert.deepEqual(ids(first.chunk), ["$b"]);
    assert.equal(first.next_batch, "5");
    const second = await scanRelations(history, query({ limit: 1, from: first.next_batch }), small);
    assert.deepEqual(ids(second.chunk), ["$a"]);
    assert.equal(second.next_batch, undefined);
    assert.equal(second.prev_batch, "5");
  });

  test("scans forwards from just after the parent", async () => {
    const page = await scanRelations(fakeHistory(timeline), query({ dir: "f" }), small);
    assert.deepEqual(ids(page.chunk), ["$a", "$b"]);
  });

  test("gives up at the page budget and hands back a token", async () => {
    const quiet = [
      event("$root", ME),
      ...Array.from({ length: 20 }, (_, i) => event(`$n${i}`, BOT)),
    ];
    const history = fakeHistory(quiet);
    const page = await scanRelations(history, query(), { pageSize: 2, softPages: 1, hardPages: 3 });
    assert.deepEqual(page.chunk, []);
    assert.equal(history.reads.length, 3);
    assert.equal(page.next_batch, "15");
  });
});

describe("scanThreadRoots", () => {
  const timeline = [
    event("$old-root", BOT),
    event("$root1", ME),
    event("$r1a", BOT, thread("$root1")),
    event("$root2", BOT),
    event("$r2a", BOT, thread("$root2")),
    event("$r1b", BOT, thread("$root1")),
    event("$r-old", BOT, thread("$old-root")),
  ];

  test("lists roots by latest activity with bundled summaries", async () => {
    const history = fakeHistory(timeline);
    const { chunk } = await scanThreadRoots(
      history,
      { roomId: ROOM, userId: ME, participatedOnly: false, from: null },
      { pageSize: 2, softPages: 2, hardPages: 2 },
    );
    // The 4-event window misses $old-root itself, so it is fetched by id.
    assert.deepEqual(ids(chunk), ["$old-root", "$root1", "$root2"]);
    assert.equal(summaryOf(chunk, "$root1").count, 1);
    assert.equal(summaryOf(chunk, "$root1").latest_event.event_id, "$r1b");
    assert.equal(summaryOf(chunk, "$root1").current_user_participated, true);
    assert.equal(summaryOf(chunk, "$root2").current_user_participated, false);
  });

  test("counts every reply once the window reaches the root", async () => {
    const { chunk } = await scanThreadRoots(
      fakeHistory(timeline),
      { roomId: ROOM, userId: ME, participatedOnly: false, from: null },
      small,
    );
    assert.equal(summaryOf(chunk, "$root1").count, 2);
  });

  test("keeps only threads the user is part of", async () => {
    const { chunk } = await scanThreadRoots(
      fakeHistory(timeline),
      { roomId: ROOM, userId: ME, participatedOnly: true, from: null },
      small,
    );
    assert.deepEqual(ids(chunk), ["$root1"]);
  });

  test("has nothing after the first page", async () => {
    const { chunk } = await scanThreadRoots(
      fakeHistory(timeline),
      { roomId: ROOM, userId: ME, participatedOnly: false, from: "3" },
      small,
    );
    assert.deepEqual(chunk, []);
  });
});

describe("cacheHistory", () => {
  test("shares pages until they expire", async () => {
    let now = 0;
    const inner = fakeHistory([event("$x", ME)]);
    const cached = cacheHistory(inner, { now: () => now, liveTtlMs: 10 });
    await cached.messages(ROOM, null, 5, "b");
    await cached.messages(ROOM, null, 5, "b");
    assert.equal(inner.reads.length, 1);
    now = 11;
    await cached.messages(ROOM, null, 5, "b");
    assert.equal(inner.reads.length, 2);
  });

  test("forgets failed reads", async () => {
    let calls = 0;
    const cached = cacheHistory({
      async messages() {
        calls++;
        throw new Error("offline");
      },
      tokenAfter: async () => null,
      event: async () => event("$x", ME),
    });
    await assert.rejects(cached.messages(ROOM, "1", 5, "b"));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(cached.messages(ROOM, "1", 5, "b"));
    assert.equal(calls, 2);
  });
});
