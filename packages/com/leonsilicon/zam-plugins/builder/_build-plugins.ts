#!/usr/bin/env node
/**
 * Bundles every plugin listed in index.json: `<plugin>/main.ts` becomes the
 * self-contained file its manifest names as `entry`. Zam fetches that file from
 * a pinned commit, so the output is committed.
 *
 *   vpx _build-plugins [plugin-id ...]
 */
import { execFileSync } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { bareImports, readPlugins } from "#plugin-index";

const root = process.cwd();
const only = new Set(process.argv.slice(2));
const plugins = (await readPlugins(root)).filter((p) => only.size === 0 || only.has(p.entry.id));
if (only.size > 0 && plugins.length !== only.size) {
  throw new Error(`Unknown plugin id in: ${[...only].join(", ")}`);
}

for (const plugin of plugins) {
  const outDir = path.join(root, ".cache", "build-plugins", plugin.entry.id);
  await rm(outDir, { recursive: true, force: true });
  execFileSync(
    "vp",
    [
      "pack",
      path.join(plugin.dir, "main.ts"),
      "--no-config",
      "--format",
      "esm",
      "--platform",
      "browser",
      "--target",
      "es2022",
      "--out-dir",
      outDir,
      "--logLevel",
      "warn",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const built = path.join(outDir, "main.js");
  const leftover = bareImports(await readFile(built, "utf8"));
  if (leftover.length > 0) {
    throw new Error(`${plugin.entry.id}: bundle still imports ${leftover.join(", ")}`);
  }
  const target = path.join(plugin.dir, plugin.manifest.entry);
  await copyFile(built, target);
  console.log(`${plugin.entry.id} ${plugin.manifest.version} → ${path.relative(root, target)}`);
}
