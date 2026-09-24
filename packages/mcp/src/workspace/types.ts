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
   * `api.js`, resolved via the `import { sign }` binding).
   */
  refCount: number;
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
   * on line 8 of `src/api.js` gives `*.json`).
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
  /** Name of the referenced binding. */
  name: string;
  /**
   * Module where the binding is defined. Absent for refs to imported
   * bindings before linking (see `ModuleIndex`), and for globals.
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
  symbols: SymbolEntry[];
  calls: CallSite[];
  strings: StringLiteralEntry[];
  refs: RefEntry[];
  /** Resolved module paths this module imports/requires. */
  imports: string[];
}

export interface WorkspaceIndex {
  symbols: SymbolEntry[];
  calls: CallSite[];
  strings: StringLiteralEntry[];
  refs: RefEntry[];
  /** module path -> module paths it imports/requires. */
  imports: Record<string, string[]>;
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
