# Library signature seed database

Each `<library>/<name>.JSON` file is one known library module:

```JSON
{
  "library": "tiny-hash",
  "version": "1.0.0",
  "path": "tiny-hash/crc32.js",
  "hash": "<sha256 from fingerprint(parse(source))>",
  "source": "<original module source the hash was built from>"
}
```

- `path` doubles as the webcrack `mappings` key (`Bundle.applyMappings`
  resolves it under `node_modules/`).
- `source` is kept so hashes stay auditable and regenerable without network
  access. The seeds are hand-written fixtures in `packages/webcrack`
  dependency style (CommonJS, no imports); real vendored copies can replace
  them as long as `hash` is regenerated.

`./index.ts` re-exports `SIGNATURES` from `./generated.ts`, which is checked
in but fully derived from the JSON files (plain TS so it works under
vitest, `tsc` and esbuild, which in this repo do not transform static JSON
imports). Never edit `generated.ts` by hand.

## Adding or regenerating entries

1. Add/edit the `<library>/<name>.JSON` file (any `hash` value is fine for
   new entries).
2. Run the freshness test with updates enabled (from the repo root, using
   the same binaries `pnpm` would run — the pnpm store is read-only here):

```sh
cd packages/webcrack
UPDATE_SIGNATURES=1 ../../node_modules/.bin/vitest run --no-isolate src/analysis/test/lib-fingerprint.test.ts
```

This recomputes every `hash` from its `source` with the current
`fingerprint()` implementation, rewrites stale JSON files in canonical form
and regenerates `./generated.ts`. Without the env var the same test fails
on any stale entry or on a `generated.ts` mismatch instead of writing.

After regenerating, re-run the full package checks
(`vitest run --no-isolate`, `typecheck`, `lint`, `build`) and commit the
updated JSON/`generated.ts` files alongside the code change.
