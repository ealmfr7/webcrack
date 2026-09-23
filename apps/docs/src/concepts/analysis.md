# Code Analysis

Besides deobfuscated code, webcrack can collect an analysis report, module
and call graphs, VM-interpreter insight, library identifications and
LLM-suggested names. The one-shot way is the
[`webcrack()`](../guide/api.md#result-fields) options `report`, `graph`,
`sourceMap`, `trace`, `libraryMappings` and `renameHeuristics`; the same
building blocks are also available as named `webcrack` exports for custom
pipelines.

## Analysis Report

With `report: true`, `result.report` collects URLs, network endpoints,
secrets, regexes and other interesting strings with their original source
positions (1-based line, 0-based column). The report runs on the freshly
parsed code, so positions refer to the input. `save()` writes it as
`report.json`.

```js
const result = await webcrack(
  'fetch("https://example.com/api", { method: "POST" });',
  {
    report: true,
    deobfuscate: false,
    unminify: false,
    jsx: false,
    unpack: false,
  },
);
result.report.urls; // [{ value: 'https://example.com/api', line: 1, column: 6 }]
result.report.endpoints; // [{ method: 'POST', url: 'https://example.com/api', line: 1, column: 0 }]
result.report.interesting; // [{ value: '/api', kind: 'path', line: 1, column: 6 }]
```

Each category is deduplicated by value (first occurrence wins) and kept in
source order:

- `urls`: `http(s)`/`ws(s)` string literals, including static
  concatenations (`'https://' + host`) and plain template literals.
- `endpoints`: `fetch` / `window.fetch`, `axios` (`get`/`post`/…,
  `request`, config objects), `xhr.open(method, url)`,
  `navigator.sendBeacon` and `$.ajax` calls. The method is upper-cased, or
  `null` when it is not statically known — as is the URL.
- `secrets`: named rules (`aws-access-key`, `google-api-key`, `stripe-key`,
  `jwt`) plus a conservative high-entropy fallback
  (`generic-high-entropy`). Named matches win over the generic rule.
- `regexes`: literals normalized to `/source/flags` form.
- `interesting`: emails, IPv4/IPv6 addresses and `/api…` paths
  (`{ value, kind, line, column }`).

The same collection is available standalone as
`extractReport(ast): Report` (imported from `'webcrack'`).

## Module and Call Graphs

With `graph: true`, `result.callGraph` holds the static call graph of the
deobfuscated code, and `result.moduleGraph` holds the dependency graph of
the unpacked bundle (only when a bundle was found). `save()` writes them as
`graph.calls.json` / `graph.calls.dot` and `graph.modules.json` /
`graph.modules.dot`.

```js
const result = await webcrack('function a() { b(); }\nfunction b() {}\na();', {
  graph: true,
  unpack: false,
  deobfuscate: false,
  unminify: false,
  jsx: false,
});
result.callGraph.nodes; // [{ id: '<toplevel>', ... }, { id: 'a', ... }, { id: 'b', ... }]
result.callGraph.edges; // [{ from: '<toplevel>', to: 'a', ... }, { from: 'a', to: 'b', ... }]
```

Both graphs share the `Graph` shape (`{ nodes, edges }`): nodes carry a
stable `id` (`external:<name>` for unresolved callees/dependencies), a
`label`, and optional `path` / `isEntry` / `external` flags; edges point
from caller/importer to callee/imported module with the raw specifier or
call name as `label`. Calls from the top level use a `<toplevel>` caller
node.

`toDot(graph, name?)` serializes a graph to Graphviz DOT (node ids and
labels quoted and escaped; externals styled dashed), and `toJSON(graph)`
serializes the same sorted `{ nodes, edges }` structure that `save()` writes
to the `.json` files:

```js
import { toDot } from 'webcrack';

toDot(result.callGraph);
// digraph "graph" {
//   "<toplevel>" [label="<toplevel>"];
//   "a" [label="a"];
//   "b" [label="b"];
//   "<toplevel>" -> "a" [label="a"];
//   "a" -> "b" [label="b"];
// }
```

`moduleGraph(bundle)` and `callGraph(ast)` are also exported from
`'webcrack'` for use without `webcrack()`.

## VM Analysis

Some obfuscators compile the code to bytecode run by an interpreter loop
(`while (true)` with a `switch` on an opcode read through an incrementing
program counter). `detectInterpreters(ast)` finds such loops:

```js
import { detectInterpreters, labelHandlers } from 'webcrack';

const [info] = detectInterpreters(ast);
// info.dispatchKind; // 'switch' | 'if-chain' | 'handler-table'
// info.pc?.identifier.name; // 'pc'
// info.bytecode?.identifier.name; // 'bc'
// info.stack?.identifier.name; // 'stack'
// info.handlers.map((h) => h.value); // [0, 1, 2, 3, 4, null]
```

`info.handlers` pairs each case value (`null` for `default`/unknown) with
its body. Loops produced by the obfuscator.io control-flow flattening
(`"<n>|<m>|…".split("|")` switches) are deliberately not reported.

`labelHandlers(info)` classifies each handler by AST pattern:

```js
labelHandlers(info);
// [
//   { value: 0, operands: 1, viaPc: true, kind: 'push-const', confidence: 0.95 },
//   { value: 1, operands: 0, viaPc: false, kind: 'binop', operator: '+', confidence: 0.9 },
//   { value: 2, operands: 0, viaPc: false, kind: 'pop', confidence: 0.8 },
//   { value: 3, operands: 1, viaPc: true, kind: 'jump', confidence: 0.9 },
//   { value: 4, operands: 0, viaPc: false, kind: 'return', confidence: 0.95 },
//   { value: null, operands: 0, viaPc: false, kind: 'unknown', confidence: 0 }
// ]
```

Each `HandlerLabel` reports the case `value`, how many bytecode operand
reads it performs (`operands`, and whether they go through the program
counter via `viaPc`), the `kind` (`push-const`, `push-var`, `store`, `pop`,
`dup`, `binop`, `unop`, `jump`, `cond-jump`, `call`, `return`,
`get-property`, `set-property`, `unknown` — plus `operator` for
`binop`/`unop`, `argc` for `call`, `jumpWhenTrue` for `cond-jump`) and a
`confidence` between 0 and 1. Unrecognized shapes are labeled `unknown`
with confidence 0 rather than given a confident wrong label.

`disassemble(info, labels, bytecode?)` performs a linear disassembly of the
interpreter's bytecode — resolved from the `bytecode` binding when it is a
literal array/string/typed-array initializer, or passed explicitly as
`number[] | Uint8Array | string` — decoding each byte as an opcode looked up
in `labels`, with the following `label.operands` bytes as its operands.
`formatDisassembly(instructions)` renders the text listing with `L_0000`
jump labels:

```txt
L_0000:
0000: push-const 10
0002: db 0x63
0003: binop
0004: jump L_0000
0006: pop
0007: return
```

Unknown opcodes and `unknown`-kind handlers consume no operands and render
as `db 0x..`.

> [!WARNING]
> EXPERIMENTAL: `liftDisassembly(disasm, labels?) → { code, warnings }`
> lifts a disassembly back to JavaScript code (with warnings for the parts it
> could not lift).

## Library Fingerprinting

`fingerprint(node)` hashes a module AST structurally: identifier bindings,
comments, formatting and long string contents are stripped, so the hash is
stable under minification. `matchModules(bundle)` looks each bundle module
up by that hash and returns identifications (`{ moduleId, library, version?,
path, confidence }`, sorted by `moduleId`) whose `path` is directly usable
as a `mappings` key.

With `libraryMappings: true`, `webcrack()` applies this automatically:
modules matching a known signature are renamed to
`node_modules/<path>` (e.g. `node_modules/tiny-hash/crc32.js`) and
`require()` calls are rewritten. Explicit `mappings` win for modules they
match.

## LLM-Assisted Renaming

`renameWithLLM(ast, options)` renames short or machine-generated bindings
using names from a caller-provided async callback — no LLM SDK or network
access inside webcrack itself:

```js
import { renameWithLLM } from 'webcrack';

const log = await renameWithLLM(ast, {
  suggestNames: async (batch) => myLLM(batch),
  batchSize: 20, // max bindings per suggestNames call
  filter: (info) => info.kind !== 'param', // optional exclusion
});
// [{ from: '_0xabc', to: 'add', kind: 'hoisted' }, ...]
```

Each `suggestNames` batch receives `LLMBindingInfo` entries (`name`, `kind`,
`context` snippet, `scopeType`) and returns a `current name -> suggested
name` map. Only short/mangled names are offered (already-descriptive names,
exports, `import` bindings and globals are never renamed); suggestions must
be valid identifiers, collisions get a numeric suffix, and a throwing
callback leaves just that batch unapplied. The returned log records every
rename in application order.

The CLI exposes this via the `--llm-rename-command` flag, which supplies an
LLM-backed `suggestNames` implementation.
