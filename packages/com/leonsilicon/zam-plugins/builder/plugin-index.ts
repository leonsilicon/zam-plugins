/**
 * Reads this repository as Zam reads a plugin repo: `index.json` at the root
 * lists each plugin's folder, and each folder holds `manifest.json` plus the
 * bundle it names. The checks mirror Zam 1.54.0's own (src/lib/plugins/repo.ts
 * and manifest.ts), so a mistake fails here instead of in the app.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PluginIndexEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  path: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  minAppVersion?: string;
  capabilities?: string[];
}

export interface PluginSource {
  entry: PluginIndexEntry;
  /** Absolute path of the plugin's folder. */
  dir: string;
  manifest: PluginManifest;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KNOWN_CAPABILITIES = new Set([
  "commands",
  "composer",
  "ui",
  "messages:read",
  "messages:send",
  "rooms:read",
  "storage",
  "network",
  "unsafe",
  "audio",
  "native",
  "frames",
]);
const SHARED_FIELDS = ["id", "name", "version", "description", "author"] as const;

/** Zam's `isSafeRelPath`: plain relative segments only. */
export function isSafeRelPath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes(":")) return false;
  return p
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStrings<K extends string>(
  value: Record<string, unknown>,
  fields: readonly K[],
  where: string,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const field of fields) {
    const v = value[field];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${where}: "${field}" must be a non-empty string`);
    }
    out[field] = v;
  }
  return out;
}

export function parseIndex(raw: unknown): PluginIndexEntry[] {
  if (!isObject(raw) || raw.schema !== 1 || !Array.isArray(raw.plugins)) {
    throw new Error('index.json must be { "schema": 1, "plugins": [...] }');
  }
  const seen = new Set<string>();
  return raw.plugins.map((value: unknown, i) => {
    const where = `index.json plugins[${i}]`;
    if (!isObject(value)) throw new Error(`${where} must be an object`);
    const entry = requireStrings(value, [...SHARED_FIELDS, "path"], where);
    if (!ID_PATTERN.test(entry.id)) throw new Error(`${where}: bad id "${entry.id}"`);
    if (!SEMVER.test(entry.version)) throw new Error(`${where}: bad version "${entry.version}"`);
    if (!isSafeRelPath(entry.path)) throw new Error(`${where}: unsafe path "${entry.path}"`);
    if (seen.has(entry.id)) throw new Error(`${where}: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    return entry;
  });
}

export function parseManifest(raw: unknown, where: string): PluginManifest {
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const manifest: PluginManifest = requireStrings(raw, [...SHARED_FIELDS, "entry"], where);
  if (!ID_PATTERN.test(manifest.id)) throw new Error(`${where}: bad id "${manifest.id}"`);
  if (!SEMVER.test(manifest.version))
    throw new Error(`${where}: bad version "${manifest.version}"`);
  if (!isSafeRelPath(manifest.entry)) throw new Error(`${where}: unsafe entry "${manifest.entry}"`);
  if (raw.minAppVersion !== undefined) {
    if (typeof raw.minAppVersion !== "string" || !SEMVER.test(raw.minAppVersion)) {
      throw new Error(`${where}: bad minAppVersion`);
    }
    manifest.minAppVersion = raw.minAppVersion;
  }
  if (raw.capabilities !== undefined) {
    const { capabilities } = raw;
    if (!Array.isArray(capabilities)) throw new Error(`${where}: capabilities must be an array`);
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !KNOWN_CAPABILITIES.has(capability)) {
        throw new Error(`${where}: unknown capability ${JSON.stringify(capability)}`);
      }
    }
    manifest.capabilities = capabilities as string[];
  }
  return manifest;
}

/** Zam refuses an install whose manifest disagrees with its index entry. */
export function indexMismatches(entry: PluginIndexEntry, manifest: PluginManifest): string[] {
  return SHARED_FIELDS.filter((field) => entry[field] !== manifest[field]).map(
    (field) =>
      `${entry.path}: index.json has ${field} ${JSON.stringify(entry[field])}, manifest.json has ${JSON.stringify(manifest[field])}`,
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/** Every plugin in the repo at `root`, with its manifest. Throws on any mismatch. */
export async function readPlugins(root: string): Promise<PluginSource[]> {
  const entries = parseIndex(await readJson(path.join(root, "index.json")));
  const plugins: PluginSource[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.path);
    const manifest = parseManifest(
      await readJson(path.join(dir, "manifest.json")),
      `${entry.path}/manifest.json`,
    );
    const mismatches = indexMismatches(entry, manifest);
    if (mismatches.length > 0) throw new Error(mismatches.join("\n"));
    plugins.push({ entry, dir, manifest });
  }
  return plugins;
}

/**
 * Bare module specifiers a bundle still imports. Zam loads a plugin from a
 * blob: URL, where they can't resolve, so a shippable bundle has none.
 */
export function bareImports(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s*(?:[\w$*{}\s,]+\s*from\s*)?["']([^"']+)["']/g,
    /\bexport\s*[\w$*{}\s,]*\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      if (!/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) found.add(specifier);
    }
  }
  return [...found];
}
