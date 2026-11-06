# @-/com.leonsilicon.zam-plugins.beeper-threads

Rebuilds Matrix thread data from room history, for rooms where the server refuses the thread endpoints. Beeper's server answers `M_FORBIDDEN "not in room"` to `/relations` and `/threads` in every bridged (`:beeper.local`) room, while `/messages`, `/context` and `/event` work. Thread replies keep `m.relates_to` in cleartext even when encrypted, so history has everything needed. The Zam plugin in `apps/beeper-threads` wires this into Zam's client.

## API

- `scanRelations(history, query, limits?)` answers a `/relations` request (`dir`, `from`, `limit`, `recurse`, relation and event type filters) by paging `/messages`. Backward scans stop at the parent event. Returns `{ chunk, next_batch?, prev_batch? }`; `next_batch` is a `/messages` token.
- `scanThreadRoots(history, query, limits?)` answers a `/threads` request from recent history: roots by latest activity with a bundled `m.thread` summary (`count`, `latest_event`, `current_user_participated`). It is one page; counts are exact when the root is inside the scanned window.
- `cacheHistory(history, options?)` shares `/messages` pages between scans (5 s from the live end, 5 min from a token).
- `patchClient(client, { limits?, log? })` wraps a matrix-js-sdk client's `fetchRelations` and `createThreadListMessagesRequest`. Each room asks the server first; after `M_FORBIDDEN` or `M_UNRECOGNIZED` it reads history for the rest of the session. Returns an undo function.
- `retryFailedThreads(client, log?)` reloads threads whose first load already failed. matrix-js-sdk keeps that rejected promise and never retries on its own.
- `clientHistory(client)`, `isThreadEndpointRefusal(error)`, `THREAD_LIST_PARTICIPATED`, and the structural client types.

`DEFAULT_LIMITS` reads up to 100 events per request, 10 requests once something matched, and 50 at most.

## matrix-js-sdk internals

`retryFailedThreads` touches `Thread.initialEventsFetched`, `initalEventFetchProm` (sic) and the private `updateThreadMetadata()`. `__tests__/matrix-js-sdk.test.ts` runs the patch against the real SDK at the version Zam ships, so bump the `matrix-js-sdk` catalog pin when Zam does.
