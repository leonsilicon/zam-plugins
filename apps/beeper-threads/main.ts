/**
 * Zam plugin entry: patches the live Matrix client so threads load in Beeper's
 * bridged rooms, and follows the client when Zam switches accounts.
 * Built into plugin.js, which is what Zam loads.
 */
import {
  patchClient,
  retryFailedThreads,
  type PatchableClient,
} from "@-/com.leonsilicon.zam-plugins.beeper-threads";

/** The part of Zam's plugin host API this plugin uses. */
interface ZamHost {
  unsafe: { getClient(): unknown };
}

const CLIENT_CHECK_MS = 5_000;

function log(message: string, ...details: unknown[]): void {
  console.info("[beeper-threads]", message, ...details);
}

function isPatchable(value: unknown): value is PatchableClient {
  if (typeof value !== "object" || value === null) return false;
  const client = value as Partial<Record<keyof PatchableClient, unknown>>;
  return (
    typeof client.fetchRelations === "function" &&
    typeof client.createThreadListMessagesRequest === "function" &&
    typeof client.getUserId === "function" &&
    typeof client.getRooms === "function" &&
    typeof (client.http as { authedRequest?: unknown } | undefined)?.authedRequest === "function"
  );
}

let timer: ReturnType<typeof setInterval> | undefined;
let attached: { client: unknown; unpatch: () => void } | undefined;

function attach(zam: ZamHost): void {
  const client = zam.unsafe.getClient() ?? undefined;
  if (client === attached?.client) return;
  attached?.unpatch();
  attached = undefined;
  if (client === undefined) return;
  if (!isPatchable(client)) {
    log("This Zam build's Matrix client doesn't look like matrix-js-sdk 45; not patching it.");
    return;
  }
  attached = { client, unpatch: patchClient(client, { log }) };
  const waiting = retryFailedThreads(client, log);
  if (waiting > 0) log(`Watching ${waiting} thread(s) still on their first load.`);
}

export default {
  onload(zam: ZamHost): void {
    attach(zam);
    timer = setInterval(() => attach(zam), CLIENT_CHECK_MS);
  },
  onunload(): void {
    clearInterval(timer);
    timer = undefined;
    attached?.unpatch();
    attached = undefined;
  },
};
