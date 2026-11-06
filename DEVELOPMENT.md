# Development

This workspace follows the [Flatcap convention](https://github.com/leonsilicon/flatcap) with Vite+.

| Location                                        | Purpose                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `index.json`                                    | Zam plugin index (schema 1): one entry per plugin, pointing at its folder           |
| `apps/<plugin>/`                                | A plugin: `manifest.json`, `main.ts` (entry source), `plugin.js` (built, committed) |
| `packages/com/leonsilicon/zam-plugins/<name>/`  | Plugin logic and tests                                                              |
| `packages/com/leonsilicon/zam-plugins/builder/` | `_build-plugins` and the index/manifest checks                                      |
| `packages/com/npmjs/`                           | Wrappers for upstream npm packages                                                  |

```sh
vp install
vpr -w build       # bundle every plugin into its plugin.js
vpr -w test
vpr -w typecheck
vp check
```

## Adding a plugin

1. Create `apps/<name>/` with `package.json` (`@-apps/<name>`), `manifest.json` and `main.ts` whose default export has `onload(zam)` and optionally `onunload()`.
2. Put the logic in a package under `packages/com/leonsilicon/zam-plugins/<name>/` with tests.
3. Add an entry to `index.json` whose `id`, `name`, `version`, `description` and `author` match the manifest, and `path` is `apps/<name>`.
4. Run `vpr -w build` and commit the resulting `plugin.js`. CI rebuilds it and fails when it is stale.

Bump the version in both `manifest.json` and `index.json` for each release, so Zam offers the update.

## Testing in Zam

Load the plugin's folder under Settings → Plugins → Local folder. To drive Zam from an agent, relaunch it with a remote debugging port (argent's `boot-device` with `electronAppPath: /Applications/Zam.app`). In Electron, Choose folder opens a native dialog, so hand the folder to the hidden `input[webkitdirectory]` with CDP `DOM.setFileInputFiles` instead. Quit and reopen Zam normally afterwards so the debugging port closes.

Tests that touch matrix-js-sdk internals run against the version Zam ships, pinned in the root catalog. Bump it together with Zam.
