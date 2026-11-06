import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

export default defineConfig({
  lint: {
    ...flatcap.configs.oxlint,
    // Built plugin bundles are committed because Zam installs them from GitHub.
    ignorePatterns: ["apps/*/plugin.js"],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // node:test registers top-level tests through promises managed by its runner.
        files: ["**/__tests__/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
  fmt: { ignorePatterns: ["apps/*/plugin.js"] },
  run: {
    tasks: {
      build: {
        cache: false,
        command: "node packages/com/leonsilicon/zam-plugins/builder/_build-plugins.ts",
      },
      test: {
        cache: false,
        command: "node --test 'packages/com/leonsilicon/zam-plugins/*/__tests__/*.test.ts'",
      },
      typecheck: { command: "tsc --noEmit" },
    },
  },
});
