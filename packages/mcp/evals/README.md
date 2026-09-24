# MCP evals (M1.8 / M2.6)

Measures whether a real agent solves reverse-engineering tasks with the
MCP tools, and at what cost. Target (ROADMAP_MCP.md M1.8, §1): ≥ 80 %
solved with a median of ≤ 12 tool calls.

## Files

- `tasks.jsonl`: one task per line:
  `{"id", "sample", "prompt", "check", "set"}`. `sample` is a file name in
  `packages/webcrack/test/corpus`; prompts reference it as
  `packages/webcrack/test/corpus/<file>` (relative to the repo root).
  `check` is `{"type": "contains"|"regex", "value"}` or
  `{"type": "all-of"|"any-of", "checks": [...]}`. All matching is
  case-insensitive. `set` is `"v1"` (original bundler/deobfuscation tasks)
  or `"v2"` (navigation, trace, annotation and diff tasks); it is optional
  and defaults to `"v1"`.
- `mcp.json`: MCP config whose server path (`packages/mcp/dist/index.js`)
  resolves from the repo root — `run.ts` always spawns `claude` with the
  repo root as cwd.
- `lib.ts`: pure logic (task validation, checkers, stream-json parser,
  aggregation incl. per-set `aggregateBySet`, RESULTS.md row formatting).
  Unit-tested by `lib.test.ts`.
- `run.ts`: runs each task with
  `claude -p <prompt> --mcp-config <absolute path to mcp.json> --strict-mcp-config --allowedTools mcp__webcrack --output-format stream-json --verbose`,
  applies the `check` to the final result text, and records pass/fail,
  tool calls (webcrack vs other), turns and tokens. `--set v1|v2|all`
  (default `all`) restricts the run to one set.
- `results/`: one `<date>-<commit>.json` per run (created on real runs,
  with overall `summary` plus per-set `bySet`).
- `RESULTS.md`: one table row per set per run (created/appended on real
  runs; the `Set` column holds `v1`/`v2`).

## Usage (from the repo root)

```sh
node --experimental-strip-types packages/mcp/evals/run.ts --dry-run [--set v1|v2|all]
node --experimental-strip-types packages/mcp/evals/run.ts [--set v1|v2|all] [--only <id>] [--concurrency N]
```

`--dry-run` validates the tasks, checks the samples exist, warns if
`packages/mcp/dist/index.js` is missing, and spawns nothing — it never
invokes `claude`. A real run costs money (one Claude session per task);
only run it on purpose. The unit tests (`lib.test.ts`) also never spawn
`claude`: the stream-json parser is tested on a hand-written fixture.

## Notes

- `tsc` and `eslint` in `packages/mcp` do not cover `evals/`
  (tsconfig `include` is `*.ts`, `src`, `test`; lint runs on `src test`),
  which is acceptable: `evals/` is run directly with
  `node --experimental-strip-types` (explicit `.ts` import extensions,
  no enums, no parameter properties) and tested with vitest, which picks
  up `evals/*.test.ts`.
- `mcp.json` needs no change for a new checkout: the server path is
  relative to the repo root, which `run.ts` uses as cwd.
