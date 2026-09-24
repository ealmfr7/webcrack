# @webcrack/mcp

An MCP server that turns webcrack into a **reverse-engineering explorer for
agents**: open an obfuscated script or bundle, get oriented, search, navigate
(definition / references), read, deobfuscate on demand, annotate what you
understood, and export the result.

Design and work plan: [`ROADMAP_MCP.md`](../../ROADMAP_MCP.md).

## Install

Requirements: Node.js 22 or 24 (see the main README for the `isolated-vm`
note), `pnpm@11`.

```bash
pnpm install
pnpm build
```

This builds `packages/mcp/dist/index.js`, the stdio server entry point.
Run it with:

```bash
node packages/mcp/dist/index.js
```

## Connect a client

Claude Code (run from the repo root, with an absolute `dist` path):

```bash
claude mcp add webcrack -- node /abs/path/to/webcrack/packages/mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webcrack": {
      "command": "node",
      "args": ["/abs/path/to/webcrack/packages/mcp/dist/index.js"],
      "env": {
        "WEBCRACK_MCP_ROOTS": "/abs/path/to/samples"
      }
    }
  }
}
```

A ready-made example for development lives at the repo root
([`.mcp.json`](../../.mcp.json)).

## Tools

Every tool takes an optional `workspace` id; when omitted, the last opened
workspace is used. Every location is `module:line` and can be passed straight
from one tool to the next. Lists are paginated (`limit`, default 30, max 500;
`offset`, default 0).

| Tool             | Purpose                                                                                                                                                   | Key params                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wc_open`        | Load a file, URL or code snippet: deobfuscates, unpacks the bundle and indexes it once (results are cached); or reopen a cached workspace by its 8-hex id | `source` (path, URL, code or workspace id), `options` (`unpack`, `deobfuscate`, `unminify`, `jsx`, `mangle`, `renameHeuristics`), `refresh`                 |
| `wc_workspaces`  | List opened and cached workspaces (pass a cached id back to `wc_open` to reopen it instantly)                                                             | —                                                                                                                                                           |
| `wc_map`         | Browse modules like a file tree (size, tags, entry point)                                                                                                 | `path`, `tag` (`network`, `auth`, `crypto`, `storage`, `dom`, `vm`, `vendor`), `sort`, `detail`, `limit`, `offset`                                          |
| `wc_outline`     | List the symbols of one module with lines, params and ref counts                                                                                          | `module`, `detail` (`concise`, `full`)                                                                                                                      |
| `wc_search`      | Search the clean code (text/string: case-insensitive; identifier: case-insensitive unless quoted, then exact; regex/call/ast: case-sensitive)             | `query`, `kind` (`text`, `regex`, `string`, `identifier`, `call`, `ast`), `module`, `limit`, `offset`                                                       |
| `wc_findings`    | Precomputed intel with `module:line` locations                                                                                                            | `category` (`summary`, `endpoints`, `urls`, `secrets`, `regexes`, `interesting`, `sinks`, `storage`, `crypto`, `vm`), `module`, `reveal`, `limit`, `offset` |
| `wc_read`        | Read code with line numbers (`module`, `module:line`, `module:start-end`, `module:symbol` or bare `symbol`)                                               | `target`, `view` (`clean`, `raw`), `context`, `column`                                                                                                      |
| `wc_goto`        | Jump to a symbol's definition (location, signature, first lines)                                                                                          | `symbol`, `from` (`module:line` used for scope-accurate resolution)                                                                                         |
| `wc_refs`        | Find where a symbol is used across modules                                                                                                                | `symbol`, `direction` (`callers`, `callees`, `all`), `from`, `limit`, `offset`                                                                              |
| `wc_graph`       | Module dependency graph or call graph around a root                                                                                                       | `kind` (`modules`, `calls`), `root`, `depth` (default 2, max 6), `format` (`tree`, `json`, `dot`)                                                           |
| `wc_diff`        | Compare two workspaces (added/removed/changed/renamed modules, findings deltas)                                                                           | `a`, `b` (workspace ids), `detail`                                                                                                                          |
| `wc_deobfuscate` | Re-run webcrack passes on a module, range or symbol (or evaluate an expression in the sandbox); `apply=true` saves it into the workspace                  | `target`, `passes`, `expression`, `apply`                                                                                                                   |
| `wc_annotate`    | Rename a symbol (scope-aware, applied everywhere) and/or attach a note; persists across sessions                                                          | `symbol` (`module:name`), `name`, `note`, `from` (`module:line` to resolve the name exactly)                                                                |
| `wc_export`      | Write the reconstructed project to a directory                                                                                                            | `dir` (must be inside the allowed roots), `include` (`code`, `report`, `notes`, `graph`), `overwrite`                                                       |
| `wc_trace`       | Follow the flow of a value: where a URL/token is built and which function sends it (via refs + assignments)                                               | `value`, `direction` (`backward`, `forward`, `both`), `depth` (default 4, max 8), `maxSteps` (default 40, max 200)                                          |

Every tool above is implemented.

Renames via `wc_annotate` reindex only the changed module — except the
first rename after reopening a workspace by id, which does a full reindex
(a few seconds on multi-MB bundles).

## Resources

For clients that prefer attaching resources over calling tools:

- `webcrack://<workspace-id>/report` — the findings report
  (endpoints, urls, secrets) as JSON.
- `webcrack://<workspace-id>/module/<path>` — the clean code of one module
  as JavaScript.

## Prompt: `audit`

The `audit` prompt runs the guided reverse-engineering workflow:
`source` (file path, URL or code; required), `goal` (e.g. `"how requests
are signed"`; optional, defaults to a security-oriented overview) and
`focus` (`network` | `auth` | `crypto` | `storage` | `obfuscation` | `all`;
optional, defaults to `all`). It walks
the agent through open → findings → map → investigate
(read/goto/refs/deobfuscate/annotate) → a final report citing `module:line`
for every claim.

## Configuration

| Variable                     | Default                   | Meaning                                                                                                |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `WEBCRACK_MCP_ROOTS`         | current working directory | Directories that `path` sources and `wc_export` output must live under (`:`-separated, `;` on Windows) |
| `WEBCRACK_MCP_CACHE`         | `~/.cache/webcrack-mcp`   | Directory where processed workspaces are cached                                                        |
| `WEBCRACK_MCP_MAX_INPUT`     | `20 MB`                   | Maximum input size in bytes (suffixes allowed: `b`, `kb`, `mb`, `gb`)                                  |
| `WEBCRACK_MCP_TIMEOUT_MS`    | `120000`                  | Timeout for a whole `wc_open` run, in milliseconds                                                     |
| `WEBCRACK_MCP_OUTPUT_BUDGET` | `20000`                   | Soft limit for the text of a single tool response, in characters                                       |

## Security model

The analyzed code is treated as **hostile**:

- `path` sources and `wc_export` output are confined to
  `WEBCRACK_MCP_ROOTS`; anything outside is rejected with an actionable error.
- `url` sources accept only `http(s)`, with a size cap and a timeout; no
  `file:` URLs, and no credentials in logs.
- Code is never executed outside the sandbox (`isolated-vm`), always with a
  timeout and a memory limit. If `isolated-vm` is unavailable, `wc_open` still
  works without the sandbox-dependent passes and says so in the workspace
  card.
- Strings from the analyzed bundle are returned as **data**, inside code
  blocks — they are untrusted content, never instructions.
- Secrets are masked by default (`sk_live_ab…yz`); pass `reveal=true` to
  `wc_findings` to see them in full.

## Typical session

```
> wc_open { source: "app.bundle.js" }
Workspace a1b2c3d4 · webpack 5 · 214 modules · 1.8 MB → 2.3 MB clean · 4.1 s
Obfuscation: string-array (rotated, base64), control-flow-flattening, self-defending (removed)
Entry: index.js
Findings: 17 endpoints · 42 urls · 3 secrets · 11 regexes · 2 VM interpreters
Top modules by tag:
  network  src/api/client.js (12 calls) · 541.js · 77.js
  auth     src/auth/session.js · 902.js
  crypto   133.js (md5-like)
Next: wc_findings category=endpoints · wc_map · wc_search

> wc_findings { category: "endpoints" }
POST https://api.example.com/v1/login · src/api/client.js:88
...

> wc_read { target: "src/api/client.js:80-100" }
src/api/client.js:40-58 (clean) · function request(method, url, body)
  80 │ function request(method, url, body) {
  81 │   const headers = { "x-sign": sign(url, body) };
...
Refs: called from 12 places (wc_refs src/api/client.js:request)

> wc_goto { symbol: "sign", from: "src/api/client.js:81" }
Defined at src/crypto/sign.js:12 · function sign(url, body)
...

> wc_annotate { symbol: "133.js:_0x1a2b", name: "decodeString", note: "string-array decoder" }
Renamed _0x1a2b → decodeString in 133.js (14 occurrences).
```

## Using with the browser-api MCP

To analyze a script running on a live page, pair this server with the
`browser-api` MCP. The flow is `browser_trace_source` → `wc_open
source=<code|url>`:

1. In the `browser-api` session, navigate to the page and locate the script
   (network log, page sources, or an inline `<script>` block).
2. Use `browser_trace_source` to grab the script's code (or its URL).
3. Hand the result to webcrack: if you got code, `wc_open` it directly as
   `source`; if you got a URL, pass the URL as `source` and let `wc_open`
   fetch it (http(s) only, size-capped).
4. Continue the analysis here (`wc_findings`, `wc_map`, …); go back to the
   browser session for dynamic confirmation (breakpoints, request
   inspection) when a static lead needs it.

Nothing is wired automatically: copy the code or URL between the two MCP
sessions by hand (or via the agent driving both).

## Inspector

To poke at the server manually:

```bash
npx @modelcontextprotocol/inspector node packages/mcp/dist/index.js
```
