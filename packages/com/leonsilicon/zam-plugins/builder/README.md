# @-/com.leonsilicon.zam-plugins.builder

Builds and checks this repository as a Zam plugin repo.

## Usage

```sh
vpx _build-plugins [plugin-id ...]
```

Bundles each plugin in `index.json` from `<path>/main.ts` into the file its manifest names as `entry`, through `vp pack` (ESM, browser, ES2022). The bundle must have no bare imports, because Zam loads it from a `blob:` URL. Run it from the repository root.

## API

- `readPlugins(root)` reads `index.json` and every manifest, and throws when an entry and its manifest disagree on `id`, `name`, `version`, `description` or `author` (Zam refuses those installs).
- `parseIndex(raw)`, `parseManifest(raw, where)` and `isSafeRelPath(path)` apply Zam 1.54.0's validation rules.
- `indexMismatches(entry, manifest)` lists the fields that disagree.
- `bareImports(code)` lists the bare module specifiers a bundle still imports.
