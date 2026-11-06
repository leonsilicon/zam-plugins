# @-apps/beeper-threads

Zam plugin that makes threads work in Beeper's bridged rooms.

Beeper's homeserver answers `M_FORBIDDEN "not in room"` to `/relations` and `/threads` in every bridged (`:beeper.local`) room. Zam asks for those whenever it opens a thread, so the reply count shows ("1 reply") but the panel says "No replies yet". The threads list fails the same way. This plugin patches the live Matrix client (`zam.unsafe.getClient()`), so those requests fall back to reading room history through `/messages`, which Beeper allows. It also retries threads whose first load already failed before the plugin loaded. Rooms where the server answers normally are unaffected.

Verified in Zam 1.54.0 against a live Beeper account: thread replies, older threads, "Load older replies" and the threads list all load.

## Limits

- Opening an old thread reads history from the newest message back to the thread's root, up to 5,000 events.
- The threads list scans the most recent 1,000 events (5,000 if none have threads), so older threads are missing from it, and reply counts are lower bounds when a root is outside that window.
- It relies on matrix-js-sdk internals. A Zam update that changes them makes the plugin log a warning or stop helping, but it never breaks threads that already work.

Logic and tests: `@-/com.leonsilicon.zam-plugins.beeper-threads`.
