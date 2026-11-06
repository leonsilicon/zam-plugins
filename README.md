# zam-plugins

Custom plugins for [Zam](https://github.com/az4521/Zam), the Matrix client.

| Plugin                                | What it does                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Beeper threads](apps/beeper-threads) | Shows thread replies in Beeper's bridged rooms, where Beeper's server refuses the Matrix thread endpoints. |

## Install

Zam → Settings → Plugins:

- **From this repo**: under Repos, add `leonsilicon/zam-plugins`, then install from Browse. Zam fetches plugins from GitHub without signing in, so this needs the repository to be public.
- **From a checkout**: under Local folder, choose a plugin's folder (for example `apps/beeper-threads`). Zam keeps a copy; after rebuilding, use Reload or pick the folder again.

Plugins are full-trust code with access to your account, as Zam warns.

## Layout

`index.json` is the plugin index Zam reads. Each plugin is an app in `apps/<name>` with its `manifest.json`, its source entry `main.ts`, and the built `plugin.js` that Zam loads. The built file is committed because Zam installs from a pinned commit. Logic lives in packages under `packages/com/leonsilicon/zam-plugins/`. See [DEVELOPMENT.md](DEVELOPMENT.md).
