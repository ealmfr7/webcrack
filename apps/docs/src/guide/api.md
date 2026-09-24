# API Examples

Installation:

::: code-group

```bash [npm]
npm install webcrack@latest
```

```bash [yarn]
yarn add webcrack@latest
```

```bash [pnpm]
pnpm add webcrack@latest --allow-build=isolated-vm
```

:::

## Basic Usage

> [!NOTE]
> All examples are shown with ESM syntax.
> For CommonJS, use the following instead:
>
> ```js
> const { webcrack } = require('webcrack');
>
> webcrack('const a = 1+1;').then((result) => {
>   console.log(result.code); // 'const a = 2;'
> });
> ```

```js
import { webcrack } from 'webcrack';

const result = await webcrack('const a = 1+1;');
console.log(result.code); // 'const a = 2;'
```

Save the deobfuscated code and the unpacked bundle to the given directory:

```js
import fs from 'fs';
import { webcrack } from 'webcrack';

const code = fs.readFileSync('bundle.js', 'utf8');
const result = await webcrack(code);
await result.save('output-dir');
```

## Get Bundle Info

```js
const { bundle } = await webcrack(code);
bundle.type; // 'webpack' or 'browserify'
bundle.entryId; // '0'
bundle.modules; // Map(10) { '0' => Module { id: '0', ... }, 1 => ... }

const entry = bundle.modules.get(bundle.entryId);
entry.id; // '0'
entry.path; // './index.js'
entry.code; // 'const a = require("./1.js");'
```

## Result Fields

Besides `code` and `bundle`, the result carries the opt-in analysis outputs.
See [Analysis](../concepts/analysis.md) for details and examples.

```js
const result = await webcrack(code, { report: true, graph: true });

result.report; // { urls, endpoints, secrets, regexes, interesting }
result.moduleGraph; // { nodes, edges } — only when a bundle was found
result.callGraph; // { nodes, edges }
```

With `sourceMap: true`, `result.map` holds a version 3 source map of the
deobfuscated code back to the input (`sources: ['input.js']`, with
`sourcesContent`). With `trace: true`, `result.trace` holds one entry per
pipeline stage (`{ name, changes, diff }`, with a unified line diff).

`save()` writes everything to the output directory:

- `deobfuscated.js` (plus `deobfuscated.js.map` and a `sourceMappingURL`
  comment when `sourceMap` is enabled)
- the unpacked bundle (`bundle.json` and the modules)
- `report.json` (when `report` is enabled)
- `graph.modules.json` / `graph.modules.dot` (when `graph` is enabled and a
  bundle was found) and `graph.calls.json` / `graph.calls.dot`
- `trace.diff` (when `trace` is enabled)

> [!NOTE]
> Tracing is reentrant on Node.js (each call collects only its own entries
> via `AsyncLocalStorage`), so concurrent `webcrack()` calls with `trace`
> enabled are supported. Where `AsyncLocalStorage` is unavailable (e.g.
> browsers) tracing falls back to a single module-global tracer, so
> overlapping async calls may observe each other's entries there.

## Named Exports

```js
import {
  webcrack,
  unpackChunks,
  renameWithLLM,
  extractReport,
  moduleGraph,
  callGraph,
  toDot,
  fingerprint,
  matchModules,
  detectInterpreters,
  labelHandlers,
  disassemble,
  formatDisassembly,
  liftDisassembly,
} from 'webcrack';
```

- `unpackChunks` merges several chunk files (runtime/entry plus jsonp,
  Turbopack or Rollup/Vite chunks) into a single bundle.
- `renameWithLLM` renames short/mangled bindings using a caller-provided
  `suggestNames` callback (no network access inside webcrack itself).
- `extractReport`, `moduleGraph`, `callGraph`, `toDot` return the same report
  and graphs as the `report`/`graph` options, for use without `webcrack()`.
- `fingerprint` / `matchModules` identify known open-source library modules
  (used by the `libraryMappings` option).
- `detectInterpreters` / `labelHandlers` analyze VM-based obfuscation.
- `disassemble` / `formatDisassembly` disassemble VM-interpreter bytecode,
  and `liftDisassembly` (experimental) lifts a disassembly back to
  JavaScript code.
- Each function has matching TypeScript types (e.g. `Report`,
  `Graph`/`GraphNode`/`GraphEdge`, `LibraryMatch`, `InterpreterInfo`,
  `HandlerLabel`, `RenameLLMOptions`).

## Options

The default options are:

```js
await webcrack(code, {
  jsx: true, // Decompile react components to JSX
  unpack: true, // Extract modules from the bundle
  unminify: true, // Unminify the code
  deobfuscate: true, // Deobfuscate the code
  mangle: false, // Mangle variable names
  renameHeuristics: false, // Rename short names using heuristics
  tsEnums: false, // Restore TypeScript enums (output becomes TypeScript)
  report: false, // Collect URLs, endpoints, secrets, ... (see below)
  graph: false, // Build module and call graphs (see below)
  sourceMap: false, // Emit a source map as `result.map`
  trace: false, // Record a per-stage transform trace as `result.trace`
  libraryMappings: false, // Name known library modules as `node_modules/<path>`
  plugins: {}, // Explained below
  sandbox, // Explained below
});
```

Only mangle variable names that match a filter:

```js
await webcrack(code, {
  mangle: (id) => id.startsWith('_0x'),
});
```

Other options include:

- `mappings`: The `mappings` option takes a function that receives an instance of [@codemod/matchers](https://github.com/codemod-js/codemod/tree/main/packages/matchers#readme), and returns an object that maps any matching nodes, to the path specified in the object key.

## Browser Usage & Sandbox

The `sandbox` option has to be passed when trying to deobfuscate string arrays in a browser.
In future versions, this should hopefully not be necessary anymore.

It is an (optionally async) function that takes a `code` parameter and returns the evaluated value.

> [!CAUTION]
> Simplest possible implementation. Don't run this with untrusted or malicious code.

```js
const result = await webcrack('function _0x317a(){....', { sandbox: eval });
```

This is how the webcrack playground currently implements it in a more secure way, with [sandybox](https://github.com/trentmwillis/sandybox), a Content-Security-Policy to prevent network access and a timeout:

```js
const sandbox = await Sandybox.create();
const iframe = document.querySelector('.sandybox');
iframe?.contentDocument?.head.insertAdjacentHTML(
  'afterbegin',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none';">`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evalCode(code) {
  const fn = await sandbox.addFunction(`() => ${code}`);
  return Promise.race([
    fn(),
    sleep(10_000).then(() => Promise.reject(new Error('Sandbox timeout'))),
  ]).finally(() => sandbox.removeFunction(fn));
}

const result = await webcrack('function _0x317a(){....', { sandbox: evalCode });
```

## Customize Paths

Useful for reverse-engineering and tracking changes across multiple versions of a bundle.

The `mappings` option takes a function that receives an instance of [@codemod/matchers](https://github.com/codemod-js/codemod/tree/main/packages/matchers#readme), and returns an object that maps any matching nodes, to the path specified in the object key.

If a matching node in the AST of a module is found, it will be renamed to the given path.

- Path starting with `./` are relative to the output directory.
- Otherwise, the path is treated as a node module.

```js
const result = await webcrack(code, {
  mappings: (m) => ({
    './utils/color.js': m.regExpLiteral('^#([0-9a-f]{3}){1,2}$'),
    'lodash/index.js': m.memberExpression(
      m.identifier('lodash'),
      m.identifier('map'),
    ),
  }),
});
await result.save('output-dir');
```

New folder structure:

```txt
├── index.js
├── utils
│   └── color.js
└── node_modules
    └── lodash
        └── index.js
```

See [@codemod/matchers](https://github.com/codemod-js/codemod/tree/main/packages/matchers#readme) for more information about matchers.

## Plugins

Webcrack's processing pipeline consists of six key stages:

1. **Parse**: The input code is parsed into an Abstract Syntax Tree (AST).
2. **Prepare**: Performs basic normalization, such as adding block statements.
3. **[Deobfuscate](../concepts/deobfuscate.md)**
4. **[Transpile](../concepts/transpile.md)** and **[Unminify](../concepts/unminify.md)**
5. **[JSX](../concepts/jsx.md)** and **[Unpack](../concepts/unpack.md)**
6. **Generate**: Converts the modified AST back into executable code.

You can extend or modify webcrack's behavior by hooking into its pipeline stages using plugins. Plugins allow you to manipulate the AST at specific stages of the pipeline.

### Supported Stages

The `plugins` option lets you specify an array of plugins for the following stages:

- `afterParse`
- `afterPrepare`
- `afterDeobfuscate`
- `afterUnminify`
- `afterUnpack`

Plugins are executed sequentially in the order they are defined for each stage.

### Writing Plugins

Refer to the [Babel Plugin Handbook](https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md#writing-your-first-babel-plugin) for a detailed guide on writing plugins.

Webcrack's plugin API is similar to Babel's but only the following utility libraries are provided to the plugin function:

- [`parse`](https://babeljs.io/docs/babel-parser)
- [`types`](https://babeljs.io/docs/babel-types)
- [`traverse`](https://babeljs.io/docs/babel-traverse)
- [`template`](https://babeljs.io/docs/babel-template)
- [`matchers`](https://github.com/codemod-js/codemod/tree/main/packages/matchers)

### Example Plugin

```js
import { webcrack } from 'webcrack';

function myPlugin({ types: t }) {
  return {
    pre() {
      console.log('Running before traversal');
    },
    visitor: {
      NumericLiteral(path) {
        console.log('Found a number:', path.node.value);
        path.replaceWith(t.stringLiteral('x'));
      },
    },
    post() {
      console.log('Running after traversal');
    },
  };
}

const result = await webcrack('1 + 1', {
  plugins: {
    afterParse: [myPlugin],
  },
});
console.log(result.code); // '"xx"'
```

### Using Babel plugins

It should be compatible with most Babel plugins as long as they only access the limited API specified above.

```js
import removeConsole from 'babel-plugin-transform-remove-console';
import { webcrack } from 'webcrack';

const result = await webcrack('consol.log(a), b()', {
  plugins: {
    afterUnminify: [removeConsole],
  },
});
console.log(result.code); // 'b();'
```
