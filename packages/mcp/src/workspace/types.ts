import type { Report } from 'webcrack/analysis';
import type { InterpreterDispatchKind } from 'webcrack/analysis';

/**
 * Data model of an opened bundle/script. Everything except `ast` caches must
 * be JSON-serializable so it can be stored in the disk cache (ROADMAP_MCP §3.3).
 */

/** `module:line`, e.g. `src/api/client.js:120`. */
export type Location = `${string}:${number}`;

export type ModuleTag =
  | 'network'
  | 'auth'
  | 'crypto'
  | 'storage'
  | 'dom'
  | 'vm'
  | 'vendor';

export interface ModuleEntry {
  /** Readable path used as the module id in every tool, e.g. `src/api.js`. */
  path: string;
  /** Original bundler module id. */
  bundleId: string;
  isEntry: boolean;
  /** Clean (deobfuscated) code; line numbers in the index refer to it. */
  code: string;
  tags: ModuleTag[];
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'import';

/**
 * Top-level bindings only: functions, classes, class methods, top-level
 * variables, and imports. No locals, no params.
 *
 * Naming rules: methods are named `Class.method` (dotted); `const f = () => {}`
 * and `const f = function () {}` are kind `function` with `params` recorded and
 * count as a named function for `caller`; `export default function () {}` and an
 * anonymous default-exported class are named `default`; CJS `const x =
 * require('./x.js')` is kind `import` with `importedName: '*'` and `from` set,
 * while `module.exports.x = …` / `exports.x = …` sets `exported` on `x` (or
 * creates a variable symbol `x`).
 */
export interface SymbolEntry {
  module: string;
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  params?: string[];
  /** Exports use the `exported` flag instead of a dedicated kind. */
  exported: boolean;
  /**
   * Number of refs whose `defModule`/`defLine`/`name` match this symbol,
   * INCLUDING cross-module refs that reach it through imports
   * (e.g. `sign.js:sign` has `refCount` 1 from the `sign(user)` call in
   * `api.js`, resolved via the `import { sign }` binding). Only defined after
   * linking (`linkIndex`); `indexModule` leaves it at 0.
   */
  refCount: number;
  /**
   * For kind `import`: the name in the source module (`'default'` for a
   * default import, `'*'` for a namespace import or CJS `require`, otherwise
   * the exported name, e.g. `import { sign as s }` gives `name: 's'` with
   * `importedName: 'sign'`).
   */
  importedName?: string;
  /**
   * For kind `import`: the resolved module path the binding comes from
   * (e.g. `import { sign } from './sign.js'` in `src/api.js` gives
   * `from: 'src/sign.js'`).
   */
  from?: string;
}

/**
 * One re-exported binding: `export { name } from '…'`, `export { x as name }
 * from '…'`, `export * from '…'` (recorded with both names as `'*'`), or
 * `export * as ns from '…'` (recorded as `{ name: 'ns', importedName: '*'
 * }`).
 */
export interface ReexportEntry {
  /** Name exported from the re-exporting module. */
  name: string;
  /** Name in the source module (`'default'` | `'*'` | name). */
  importedName: string;
  /** Resolved module path the binding comes from. */
  from: string;
}

/** A `ReexportEntry` tagged with its module (for `WorkspaceIndex`). */
export interface WorkspaceReexportEntry extends ReexportEntry {
  module: string;
}

export interface CallSite {
  module: string;
  line: number;
  /**
   * Normalized callee name.
   *
   * A root that is a global or an import binding gives the dotted name
   * (`fetch`, `JSON.stringify`, `localStorage.setItem`, `axios.post`,
   * `sign` for a call through an import). A root that is a local binding
   * or any other expression gives `*.<prop>` (e.g. `(await res.json())`
   * on line 8 of `src/api.js` gives `*.json`). Member access on a namespace
   * import keeps the dotted name (`ns.sign()` gives `ns.sign`).
   */
  callee: string;
  /** Nearest enclosing NAMED function, if any. */
  caller?: string;
}

/**
 * Every string literal, INCLUDING import/require sources (`'./sign.js'`)
 * but EXCLUDING object property keys (`{ "x-sign": … }` contributes no
 * string; only its value positions do).
 */
export interface StringLiteralEntry {
  module: string;
  line: number;
  value: string;
}

export type RefKind = 'read' | 'write' | 'call';

/**
 * Declaration sites and import-specifier sites are NOT refs: `refCount`
 * counts only uses whose `defModule`/`defLine`/`name` match the symbol.
 */
export interface RefEntry {
  /** Module containing the reference. */
  module: string;
  /** 1-based line of the reference in the module's clean code. */
  line: number;
  /**
   * Name of the referenced binding. Member access on a namespace import
   * keeps the dotted name (`ns.sign` refers to the exported symbol `sign`,
   * with `defModule`/`defLine` set after linking).
   */
  name: string;
  /**
   * Module where the binding is defined. Absent for refs to imported
   * bindings before linking (see `ModuleIndex`). Globals are never refs.
   */
  defModule?: string;
  /** 1-based definition line. Absent under the same conditions. */
  defLine?: number;
  kind: RefKind;
}

/**
 * The per-module slice of the index, produced by `indexModule` before
 * cross-module linking.
 *
 * Refs to imported bindings stay unresolved here: they carry the local
 * `name` (the import specifier's local name) with no `defModule`/`defLine`.
 * `linkIndex` resolves them to the exporting module afterwards.
 */
export interface ModuleIndex {
  /** In source order. */
  symbols: SymbolEntry[];
  /** In source order (Babel enter order). */
  calls: CallSite[];
  /** In source order. */
  strings: StringLiteralEntry[];
  /** In source order. */
  refs: RefEntry[];
  /** Resolved module paths this module imports/requires. */
  imports: string[];
  /** In source order. */
  reexports: ReexportEntry[];
}

/** Module keys are webcrack paths with the leading `./` stripped. */
export interface WorkspaceIndex {
  /** In source order (module order, then source order within each module). */
  symbols: SymbolEntry[];
  /** In source order (Babel enter order). */
  calls: CallSite[];
  /** In source order. */
  strings: StringLiteralEntry[];
  /** In source order. */
  refs: RefEntry[];
  /** module path -> module paths it imports/requires. */
  imports: Record<string, string[]>;
  /** In source order. */
  reexports: WorkspaceReexportEntry[];
}

export interface SearchHit {
  module: string;
  line: number;
  text: string;
}

/** Serializable summary of one `detectInterpreters()` hit. */
export interface InterpreterSummary {
  module: string;
  /** 1-based line where the interpreter loop starts. */
  line: number;
  endLine: number;
  dispatchKind: InterpreterDispatchKind;
  handlerCount: number;
  /** Binding names, when they resolve to real bindings. */
  pc?: string;
  bytecode?: string;
  stack?: string;
}

export interface Annotation {
  /** `module:name` of the original binding. */
  symbol: string;
  rename?: string;
  note?: string;
}

/**
 * Options accepted by `wc_open`. They mirror the `webcrack()` options, plus
 * `refresh` to bypass the disk cache and reprocess the input.
 */
export interface OpenOptions {
  unpack?: boolean;
  deobfuscate?: boolean;
  unminify?: boolean;
  jsx?: boolean;
  mangle?: boolean;
  renameHeuristics?: boolean;
  refresh?: boolean;
}

/** A resolved `wc_open` source: literal code plus its provenance. */
export interface LoadedSource {
  kind: 'path' | 'url' | 'code';
  label: string;
  code: string;
  bytes: number;
}

/** One-line summary of a disk-cached workspace, for `wc_workspaces`. */
export interface CachedSummary {
  id: string;
  kind: 'path' | 'url' | 'code';
  label: string;
  bundleType?: string;
  moduleCount: number;
  openedAt: string;
}

export interface Workspace {
  /** First 8 hex chars of sha256(input + options + webcrack version). */
  id: string;
  source: { kind: 'path' | 'url' | 'code'; label: string; bytes: number };
  original: string;
  /**
   * Bundler output info. `entryId` is the entry module's `bundleId`
   * (e.g. `'0'`), NOT a module path.
   */
  bundle?: { type: string; entryId: string };
  /** Keyed by `ModuleEntry.path`. */
  modules: Map<string, ModuleEntry>;
  index: WorkspaceIndex;
  /**
   * `extractReport()` run on EACH module's clean code, keyed by module path,
   * so finding lines are module lines (matching `wc_read`).
   */
  report: Record<string, Report>;
  interpreters: InterpreterSummary[];
  annotations: Annotation[];
  stats: { openMs: number; techniques: string[] };
}
