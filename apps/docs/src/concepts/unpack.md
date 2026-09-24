# Bundle Unpacking

This feature can unpack bundles from several bundlers into separate files.

## Webpack

- `__webpack_require(id)__` gets rewritten to `require('./relative/path.js')`.

- Modules may get converted to ESM.

- Multiple chunks can be merged with [`unpackChunks`](#multiple-chunks-unpackchunks).

![Webpack structure](../assets/webpack-structure.png)

### `__webpack_require__`

```ts
/**
 * Most of the time this is an object for multiple exports,
 * but a module can export anything
 */
type Exports = unknown;

/**
 * Each module is wrapped in a factory function to give it access to these arguments like they were global variables
 */
type FactoryFunction = (
  module: Module,
  exports: Exports,
  __webpack_require__: WebpackRequire,
) => void;

interface Module {
  exports: Exports; // module exports
  i: number; // module id
  l: boolean; // loaded
}
```

`__webpack_require__` is a function with some additional properties:

```ts
interface WebpackRequire {
  // Call to load a module
  (moduleId: number): Exports;
  // Define getter functions for esm exports
  d(exports: Exports, name: string, getter: () => Exports): void;
  // Load a chunk
  e(chunkId: number): Promise<Exports>;
  // Returns globalThis or window
  g(): typeof globalThis;
  // loadScript function to load a script via script tag
  l(
    url: string,
    done: (event: Event) => void,
    key: string | undefined,
    chunkId: number,
  ): void;
  // Get the default export of a module, for compatibility with non-esm
  n(exports: Exports): { (): Exports; get a(): Exports };
  // Object.prototype.hasOwnProperty.call
  o(object: unknown, property: string): boolean;
  // On error function for async loading
  oe(err: Error): never;
  // Set __esModule to true
  r(exports: Exports): void;
  // Create a fake namespace object
  t(value: number | Record<string, unknown>, mode: number): unknown;
  // Get javascript chunk filename. Example: u(0) -> 'chunks/0.138aa346.js'
  u(chunkId: number): string;

  // Contains all installed modules. The keys are module ids
  c: Record<number, Module>;
  f: {
    // JSONP chunk loading for javascript
    j(chunkId: number, promises: Promise<unknown>[]): void;
  };
  // Contains all module functions. The keys are module ids
  m: Record<number, FactoryFunction>;
  // Public base path for chunks. Example: '/_next/'
  p: string;
  // Entry module id
  s: number;
  // All WebAssembly.instance exports. The keys are wasm module ids
  w: Record<number, Exports>;
}
```

## Browserify

Each module has a numerical id and contains a list of dependencies: `{ './foo': 1, './bar': 3 }`.
These paths are relative to the current module and are used like `require('./foo')`.

The absolute path a module is not stored anywhere, so webcrack builds a dependency tree
and resolves the paths to preserve the original file structure as much as possible.

Sometimes the entry module was deeply nested (e.g. `src/app/index.js`), but `"src"` or `"app"` is not included in the bundle.
In this case, directory names like `tmp0/tmp1`, etc. are used instead.

### Example

Module id -> dependencies:

```js
{
  0: { 1: './a.js', 4: 'lib' }, // entry
  1: { 2: '../bar/b.js' },
  2: { 3: '../../c.js' },
  3: {},
  4: {},
}
```

Resulting file structure:

```txt
├── tmp0
│   ├── tmp1
│   │   ├── index.js
│   │   └── a.js
│   └── bar
│       └── b.js
├── c.js
```

## esbuild

[esbuild](https://esbuild.github.io/) bundles (`--bundle --format=cjs/iife`)
keep the original relative paths, so modules are extracted under those paths.
Internal `require_<name>(...)` calls are rewritten to `require("./path.js")`
and the synthetic top-level entry becomes its own module:

```js
__toESM(require_dep(...)); // [!code --]
__toESM(require("./src/dep.js")); // [!code ++]
```

## Metro

[Metro](https://metrobundler.dev/) bundles (React Native) define modules with
numeric ids and a dependency map. `_$$_REQUIRE(_dependencyMap[...])` calls are
rewritten to plain `require(id)`:

```js
_$$_REQUIRE(_dependencyMap[0]); // [!code --]
require(1); // [!code ++]
```

## Vite / Rollup

[Vite](https://vite.dev/) production output is Rollup ESM: modules are
separated by `// <path>` comment regions with a shared-chunk import header.
Each region becomes a module under its path, the header moves into the entry
module, and cross-chunk `import ... from './chunk-*.js'` references to chunks
that were not loaded are kept as-is:

```js
import { x } from "./chunk-shared.a1b2c3.js"; // kept: external chunk
// ./src/main.js
console.log(x);
```

`__vitePreload(() => import(...))` wrappers mark lazy chunk boundaries.

## Parcel

[Parcel](https://parceljs.org/) v2 bundles map hashed module ids through a
`parcelRequire` registry. The registry is removed and dependencies are
rewritten to relative requires:

```js
parcelRequire("addhash"); // [!code --]
require("./addhash.js"); // [!code ++]
```

## Turbopack

[Turbopack](https://turbo.build/pack) (Next.js) chunks key modules by ids like
`[project]/src/greet.js [app-client] (ecmascript)`. webcrack derives file paths
from those keys and rewrites `__turbopack_require__`/`__turbopack_import__` to
`require`/`import`:

```js
__turbopack_require__("[project]/src/name.js [app-client] (ecmascript)"); // [!code --]
require("./name.js"); // [!code ++]
```

## Multiple chunks (unpackChunks)

Code-split apps ship a runtime/entry file plus lazy chunks (webpack JSONP,
Turbopack, or Rollup/Vite chunks). `unpackChunks` unpacks each file with the
per-format unpackers above and merges the modules into a single bundle:

- Pass the runtime/entry file first: the merged bundle takes its entry from
  the first input that has one.
- Cross-chunk `require`/`import` references are re-resolved against the merged
  modules; ids with no matching chunk are reported as `unresolved`.
- The first input wins on duplicate module ids; unknown inputs and type
  mismatches are reported as non-fatal `warnings`.
