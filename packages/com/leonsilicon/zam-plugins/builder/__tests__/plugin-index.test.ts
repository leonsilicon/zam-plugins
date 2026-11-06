import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import {
  bareImports,
  indexMismatches,
  isSafeRelPath,
  parseIndex,
  parseManifest,
  readPlugins,
} from "@-/com.leonsilicon.zam-plugins.builder";

const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");

describe("this repository", () => {
  test("index.json agrees with every plugin's manifest", async () => {
    const plugins = await readPlugins(repoRoot);
    assert.ok(plugins.length > 0);
  });

  test("every plugin ships a self-contained bundle", async () => {
    for (const plugin of await readPlugins(repoRoot)) {
      const code = await readFile(path.join(plugin.dir, plugin.manifest.entry), "utf8");
      assert.ok(code.includes("export"), `${plugin.entry.id} bundle exports nothing`);
      assert.deepEqual(bareImports(code), [], `${plugin.entry.id} bundle has imports`);
    }
  });
});

describe("validation", () => {
  const entry = {
    id: "com.example.x",
    name: "X",
    version: "1.0.0",
    description: "d",
    author: "a",
    path: "apps/x",
  };

  test("rejects what Zam rejects", () => {
    assert.throws(() => parseIndex({ schema: 2, plugins: [] }));
    assert.throws(() => parseIndex({ schema: 1, plugins: [{ ...entry, path: "../x" }] }));
    assert.throws(() => parseIndex({ schema: 1, plugins: [entry, entry] }), /duplicate/);
    assert.throws(() => parseManifest({ ...entry, entry: "x.js", capabilities: ["root"] }, "m"));
    assert.throws(() => parseManifest({ ...entry, entry: "@dist/x.js" }, "m"), /unsafe entry/);
  });

  test("reports manifest fields that drift from the index", () => {
    const manifest = parseManifest({ ...entry, entry: "plugin.js", version: "1.0.1" }, "m");
    assert.equal(indexMismatches(entry, manifest).length, 1);
  });

  test("isSafeRelPath", () => {
    assert.equal(isSafeRelPath("apps/beeper-threads"), true);
    assert.equal(isSafeRelPath("/abs"), false);
    assert.equal(isSafeRelPath("a//b"), false);
  });

  test("bareImports", () => {
    assert.deepEqual(bareImports('import x from "matrix-js-sdk";\nimport "./y.js";'), [
      "matrix-js-sdk",
    ]);
    assert.deepEqual(bareImports("export { a as default };"), []);
  });
});
