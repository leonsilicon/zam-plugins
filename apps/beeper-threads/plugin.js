// packages/com/leonsilicon/zam-plugins/beeper-threads/relations-fallback.ts
const DEFAULT_LIMITS = {
	pageSize: 100,
	softPages: 10,
	hardPages: 50
};
const DEFAULT_RELATIONS_LIMIT = 50;
/** Servers follow relations of relations to at least this depth (MSC3981). */
const RECURSION_DEPTH = 3;
const THREAD_REL_TYPES = /* @__PURE__ */ new Set(["m.thread", "io.element.thread"]);
function relatesTo(event) {
	const relation = event.content?.["m.relates_to"];
	return typeof relation === "object" && relation !== null ? relation : void 0;
}
function withRoomId(event, roomId) {
	return event.room_id === void 0 ? {
		...event,
		room_id: roomId
	} : event;
}
function isExhausted(page, token) {
	return page.chunk.length === 0 || page.end === void 0 || page.end === token;
}
function matchesFilters(event, query) {
	if (query.relationType !== null && relatesTo(event)?.rel_type !== query.relationType) return false;
	return query.eventType === null || event.type === query.eventType;
}
/** The scanned events `/relations` would return, in scan order. */
function selectRelations(scanned, query) {
	let targets = /* @__PURE__ */ new Set([query.eventId]);
	const related = /* @__PURE__ */ new Set();
	const depth = query.recurse === true ? RECURSION_DEPTH : 1;
	for (let level = 0; level < depth && targets.size > 0; level++) {
		const found = /* @__PURE__ */ new Set();
		for (const event of scanned) {
			const target = relatesTo(event)?.event_id;
			if (target === void 0 || related.has(event.event_id) || !targets.has(target)) continue;
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
async function scanRelations(history, query, limits = DEFAULT_LIMITS) {
	const limit = query.limit ?? DEFAULT_RELATIONS_LIMIT;
	let token = query.from;
	if (token === null && query.dir === "f") {
		token = await history.tokenAfter(query.roomId, query.eventId);
		if (token === null) return { chunk: [] };
	}
	const scanned = [];
	let direct = 0;
	let next = null;
	for (let pages = 0;; pages++) {
		if (pages >= limits.hardPages || pages >= limits.softPages && direct > 0) {
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
	return {
		chunk: selectRelations(scanned, query).map((event) => withRoomId(event, query.roomId)),
		...next === null ? {} : { next_batch: next },
		...query.from === null ? {} : { prev_batch: query.from }
	};
}
function threadRootOf(event) {
	const relation = relatesTo(event);
	return relation?.rel_type !== void 0 && THREAD_REL_TYPES.has(relation.rel_type) ? relation.event_id : void 0;
}
function withThreadSummary(root, roomId, summary) {
	const unsigned = root.unsigned ?? {};
	const relations = unsigned["m.relations"] ?? {};
	return {
		...withRoomId(root, roomId),
		unsigned: {
			...unsigned,
			"m.relations": {
				...relations,
				"m.thread": summary
			}
		}
	};
}
/**
* Answers a `/threads` request from recent room history: thread roots, most
* recent activity first, each with the bundled summary clients expect. Reply
* counts are exact for threads whose root is inside the scanned window.
*/
async function scanThreadRoots(history, query, limits = DEFAULT_LIMITS) {
	if (query.from !== null) return { chunk: [] };
	const seen = /* @__PURE__ */ new Map();
	const threads = /* @__PURE__ */ new Map();
	let token = null;
	for (let pages = 0; pages < limits.hardPages; pages++) {
		if (pages >= limits.softPages && threads.size > 0) break;
		const page = await history.messages(query.roomId, token, limits.pageSize, "b");
		for (const event of page.chunk) {
			seen.set(event.event_id, event);
			const rootId = threadRootOf(event);
			if (rootId === void 0) continue;
			const mine = event.sender === query.userId;
			const thread = threads.get(rootId);
			if (thread === void 0) threads.set(rootId, {
				latest: withRoomId(event, query.roomId),
				count: 1,
				participated: mine
			});
			else {
				thread.count++;
				thread.participated ||= mine;
			}
		}
		if (isExhausted(page, token)) break;
		token = page.end ?? null;
	}
	const roots = [];
	for (const [rootId, thread] of threads) {
		const root = seen.get(rootId) ?? await history.event(query.roomId, rootId).catch(() => void 0);
		if (root === void 0) continue;
		const participated = thread.participated || root.sender === query.userId;
		if (query.participatedOnly && !participated) continue;
		roots.push(withThreadSummary(root, query.roomId, {
			latest_event: thread.latest,
			count: thread.count,
			current_user_participated: participated
		}));
	}
	return { chunk: roots };
}
/**
* Shares `/messages` pages between scans, so several threads of one room
* loading at once read its history only once.
*/
function cacheHistory(inner, options = {}) {
	const now = options.now ?? Date.now;
	const liveTtlMs = options.liveTtlMs ?? 5e3;
	const tokenTtlMs = options.tokenTtlMs ?? 3e5;
	const maxEntries = options.maxEntries ?? 200;
	const pages = /* @__PURE__ */ new Map();
	return {
		messages(roomId, from, limit, dir) {
			const key = JSON.stringify([
				roomId,
				from,
				limit,
				dir
			]);
			const hit = pages.get(key);
			if (hit !== void 0 && hit.expires > now()) return hit.page;
			const page = inner.messages(roomId, from, limit, dir);
			const entry = {
				expires: now() + (from === null ? liveTtlMs : tokenTtlMs),
				page
			};
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
		event: (roomId, eventId) => inner.event(roomId, eventId)
	};
}
const noLog = () => {};
/** Beeper answers `M_FORBIDDEN` ("not in room"); other servers may not know the endpoint. */
function isThreadEndpointRefusal(error) {
	if (typeof error !== "object" || error === null) return false;
	const { errcode } = error;
	return errcode === "M_FORBIDDEN" || errcode === "M_UNRECOGNIZED";
}
/** Room history read through the client's own authenticated HTTP API. */
function clientHistory(client) {
	const room = (roomId) => `/rooms/${encodeURIComponent(roomId)}`;
	return {
		async messages(roomId, from, limit, dir) {
			const query = {
				dir,
				limit: String(limit)
			};
			if (from !== null) query.from = from;
			return await client.http.authedRequest("GET", `${room(roomId)}/messages`, query);
		},
		async tokenAfter(roomId, eventId) {
			return (await client.http.authedRequest("GET", `${room(roomId)}/context/${encodeURIComponent(eventId)}`, { limit: "0" })).end ?? null;
		},
		async event(roomId, eventId) {
			return await client.http.authedRequest("GET", `${room(roomId)}/event/${encodeURIComponent(eventId)}`);
		}
	};
}
/**
* Wraps `fetchRelations` and `createThreadListMessagesRequest` on this client
* instance. Each room tries the server first; after a refusal, that room uses
* history for the rest of the session. Returns a function that undoes the patch.
*/
function patchClient(client, options = {}) {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const log = options.log ?? noLog;
	const history = cacheHistory(clientHistory(client));
	const refused = /* @__PURE__ */ new Set();
	async function withFallback(roomId, endpoint, server, fallback) {
		if (!refused.has(roomId)) try {
			return await server();
		} catch (error) {
			if (!isThreadEndpointRefusal(error)) throw error;
			refused.add(roomId);
			log(`The server refused ${endpoint} in ${roomId}; reading room history instead.`);
		}
		return fallback();
	}
	const originalFetchRelations = client.fetchRelations;
	const originalThreadList = client.createThreadListMessagesRequest;
	const hadOwnFetchRelations = Object.hasOwn(client, "fetchRelations");
	const hadOwnThreadList = Object.hasOwn(client, "createThreadListMessagesRequest");
	client.fetchRelations = (roomId, eventId, relationType, eventType, opts = { dir: "b" }) => withFallback(roomId, "/relations", () => originalFetchRelations.call(client, roomId, eventId, relationType, eventType, opts), () => scanRelations(history, {
		roomId,
		eventId,
		relationType,
		eventType,
		dir: opts.dir ?? "b",
		from: opts.from ?? null,
		limit: opts.limit,
		recurse: opts.recurse
	}, limits));
	client.createThreadListMessagesRequest = (roomId, fromToken, limit, dir, threadListType, filter) => withFallback(roomId, "/threads", () => originalThreadList.call(client, roomId, fromToken, limit, dir, threadListType, filter), async () => {
		const { chunk } = await scanThreadRoots(history, {
			roomId,
			userId: client.getUserId(),
			participatedOnly: threadListType === 0,
			from: fromToken ?? null
		}, limits);
		return { chunk: chunk.slice().reverse() };
	});
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
function retryFailedThreads(client, log = noLog) {
	let waiting = 0;
	for (const room of client.getRooms()) for (const thread of room.getThreads()) {
		const firstLoad = thread.initalEventFetchProm;
		if (thread.initialEventsFetched || firstLoad === void 0) continue;
		if (typeof thread.updateThreadMetadata !== "function") continue;
		waiting++;
		firstLoad.then(() => {}, () => {
			if (thread.initialEventsFetched || thread.initalEventFetchProm !== firstLoad) return;
			thread.initalEventFetchProm = void 0;
			thread.updateThreadMetadata?.().catch((error) => {
				log(`Couldn't load thread ${thread.id} in ${room.roomId}.`, error);
			});
		});
	}
	return waiting;
}
// apps/beeper-threads/main.ts
/**
* Zam plugin entry: patches the live Matrix client so threads load in Beeper's
* bridged rooms, and follows the client when Zam switches accounts.
* Built into plugin.js, which is what Zam loads.
*/
const CLIENT_CHECK_MS = 5e3;
function log(message, ...details) {
	console.info("[beeper-threads]", message, ...details);
}
function isPatchable(value) {
	if (typeof value !== "object" || value === null) return false;
	const client = value;
	return typeof client.fetchRelations === "function" && typeof client.createThreadListMessagesRequest === "function" && typeof client.getUserId === "function" && typeof client.getRooms === "function" && typeof client.http?.authedRequest === "function";
}
let timer;
let attached;
function attach(zam) {
	const client = zam.unsafe.getClient() ?? void 0;
	if (client === attached?.client) return;
	attached?.unpatch();
	attached = void 0;
	if (client === void 0) return;
	if (!isPatchable(client)) {
		log("This Zam build's Matrix client doesn't look like matrix-js-sdk 45; not patching it.");
		return;
	}
	attached = {
		client,
		unpatch: patchClient(client, { log })
	};
	const waiting = retryFailedThreads(client, log);
	if (waiting > 0) log(`Watching ${waiting} thread(s) still on their first load.`);
}
var main_default = {
	onload(zam) {
		attach(zam);
		timer = setInterval(() => attach(zam), CLIENT_CHECK_MS);
	},
	onunload() {
		clearInterval(timer);
		timer = void 0;
		attached?.unpatch();
		attached = void 0;
	}
};
export { main_default as default };
