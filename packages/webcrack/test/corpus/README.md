# Regression corpus

End-to-end regression samples for `webcrack()`. Each `*.js` file in this
directory is run through `webcrack()` by [`corpus.test.ts`](../corpus.test.ts)
and the deobfuscated output is compared against the committed
`<name>.js.snap` file snapshot.

Current samples (9):

| File                    | Category                          | Origin                                    |
| ----------------------- | --------------------------------- | ----------------------------------------- |
| `obfuscator-default.js` | obfuscator.io (default preset)    | Copy of `src/deobfuscate/test/samples/`   |
| `obfuscator-high.js`    | obfuscator.io (high preset)       | Copy of `src/deobfuscate/test/samples/`   |
| `obfuscator-control-flow.js` | obfuscator.io (control flow) | Copy of `src/deobfuscate/test/samples/`   |
| `webpack-5.js`          | minified webpack 5 bundle         | Copy of `src/unpack/test/samples/`        |
| `webpack-esm.js`        | webpack bundle (ESM)              | Copy of `src/unpack/test/samples/`        |
| `browserify.js`         | minified browserify bundle        | Copy of `src/unpack/test/samples/`        |
| `babel-transpiled.js`   | Babel-transpiled CommonJS output  | Self-generated (hand-written)             |
| `minified-iife.js`      | minified plain script (IIFE)      | Self-generated (hand-written)             |
| `bookmarklet.js`        | `javascript:` bookmarklet         | Self-generated (hand-written)             |

All samples are license-safe: either copied from this repo's own test
fixtures or hand-written for this corpus.

## Adding a sample

1. Drop a `*.js` file into this directory (no test changes needed — samples
   are discovered from the directory listing, sorted for stable ordering).
2. Generate its snapshot:
   `pnpm vitest run --no-isolate packages/webcrack/test/corpus.test.ts -u`
3. Inspect the new `<name>.js.snap` diff to confirm the output looks right,
   then commit both files.

## Updating snapshots

After a intentional change to deobfuscation output, refresh all snapshots
with `vitest -u` on the corpus test and review the diff before committing.
