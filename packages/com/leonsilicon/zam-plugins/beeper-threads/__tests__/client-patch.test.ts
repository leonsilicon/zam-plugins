import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isThreadEndpointRefusal,
  patchClient,
  retryFailedThreads,
  THREAD_LIST_PARTICIPATED,
  type PatchableClient,
  type RawEvent,
  type RelationsResponse,
  type ThreadLike,
  type ThreadListResponse,
} from "@-/com.leonsilicon.zam-plugins.beeper-threads";

const ROOM = "!room:beeper.local";
const ME = "@me:beeper.com";

const timeline: RawEvent[] = [
  { event_id: "$root", type: "m.room.message", sender: ME, origin_server_ts: 1, content: {} },
  {
    event_id: "$reply",
    type: "m.room.encrypted",
    sender: "@bot:beeper.local",
    origin_server_ts: 2,
    content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
  },
];

const refusal = () =>
  Object.assign(new Error("not in room"), { errcode: "M_FORBIDDEN", httpStatus: 403 });

/** A client whose thread endpoints answer like Beeper's server in bridged rooms. */
function beeperLikeClient(serverError: () => Error = refusal) {
  const calls: string[] = [];
  const client: PatchableClient & { calls: string[] } = {
    calls,
    async fetchRelations(): Promise<RelationsResponse> {
      calls.push("relations");
      throw serverError();
    },
    async createThreadListMessagesRequest(): Promise<ThreadListResponse> {
      calls.push("threads");
      throw serverError();
    },
    getUserId: () => ME,
    getRooms: () => [],
    http: {
      async authedRequest(_method: string, path: string, query?: Record<string, string>) {
        calls.push(path.split("/").slice(3).join("/"));
        if (path.endsWith("/messages")) {
          if (query?.from !== undefined) return { chunk: [] };
          return { chunk: timeline.slice().reverse(), end: "t0" };
        }
        throw new Error(`unexpected ${path}`);
      },
    },
  };
  return client;
}

describe("patchClient", () => {
  test("answers /relations from history after a refusal, then skips the server", async () => {
    const client = beeperLikeClient();
    patchClient(client);
    const first = await client.fetchRelations(ROOM, "$root", null, null, { dir: "b" });
    assert.deepEqual(
      first.chunk.map((e) => e.event_id),
      ["$reply"],
    );
    await client.fetchRelations(ROOM, "$root", null, null, { dir: "b" });
    assert.equal(client.calls.filter((c) => c === "relations").length, 1);
  });

  test("lists thread roots in the order matrix-js-sdk expects", async () => {
    const client = beeperLikeClient();
    patchClient(client);
    const all = await client.createThreadListMessagesRequest(ROOM, null);
    assert.deepEqual(
      all.chunk.map((e) => e.event_id),
      ["$root"],
    );
    assert.equal(all.start, all.end);
    const mine = await client.createThreadListMessagesRequest(
      ROOM,
      null,
      30,
      "b",
      THREAD_LIST_PARTICIPATED,
    );
    assert.equal(mine.chunk.length, 1);
  });

  test("passes other errors through", async () => {
    const client = beeperLikeClient(() => new Error("offline"));
    patchClient(client);
    await assert.rejects(client.fetchRelations(ROOM, "$root", null, null), /offline/);
  });

  test("unpatching restores the prototype methods", async () => {
    class Client {
      async fetchRelations(): Promise<RelationsResponse> {
        return { chunk: [] };
      }
      async createThreadListMessagesRequest(): Promise<ThreadListResponse> {
        return { chunk: [] };
      }
      getUserId = () => ME;
      getRooms = () => [];
      http = { authedRequest: async () => ({}) };
    }
    const client = new Client();
    const unpatch = patchClient(client);
    assert.ok(Object.hasOwn(client, "fetchRelations"));
    unpatch();
    assert.ok(!Object.hasOwn(client, "fetchRelations"));
    assert.ok(!Object.hasOwn(client, "createThreadListMessagesRequest"));
  });
});

test("isThreadEndpointRefusal", () => {
  assert.equal(isThreadEndpointRefusal(refusal()), true);
  assert.equal(isThreadEndpointRefusal({ errcode: "M_UNRECOGNIZED" }), true);
  assert.equal(isThreadEndpointRefusal({ errcode: "M_LIMIT_EXCEEDED" }), false);
  assert.equal(isThreadEndpointRefusal(null), false);
});

describe("retryFailedThreads", () => {
  function thread(id: string, state: Partial<ThreadLike>) {
    const retries: string[] = [];
    const value: ThreadLike = {
      id,
      initialEventsFetched: false,
      async updateThreadMetadata() {
        retries.push(id);
      },
      ...state,
    };
    return { value, retries };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("reloads threads whose first load failed, once it has failed", async () => {
    const rejected = Promise.reject(new Error("403"));
    rejected.catch(() => {});
    const failed = thread("$failed", { initalEventFetchProm: rejected });
    const done = thread("$done", {
      initialEventsFetched: true,
      initalEventFetchProm: Promise.resolve(),
    });
    const pending = thread("$pending", { initalEventFetchProm: new Promise(() => {}) });
    const notStarted = thread("$not-started", {});
    const client = {
      getRooms: () => [
        {
          roomId: ROOM,
          getThreads: () => [failed.value, done.value, pending.value, notStarted.value],
        },
      ],
    };

    assert.equal(retryFailedThreads(client), 2);
    await settle();
    assert.deepEqual(failed.retries, ["$failed"]);
    assert.equal(failed.value.initalEventFetchProm, undefined);
    assert.deepEqual([...done.retries, ...pending.retries, ...notStarted.retries], []);
  });
});
