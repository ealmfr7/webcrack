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
  | 'export'
  | 'import';

export interface SymbolEntry {
  module: string;
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  params?: string[];
  exported: boolean;
  /** Number of references to the binding. */
  refCount: number;
}

export interface CallSite {
  module: string;
  line: number;
  /** Normalized callee: `fetch`, `axios.post`, `*.postMessage`. */
  callee: string;
  /** Enclosing function symbol name, if any. */
  caller?: string;
}

export interface StringLiteralEntry {
  module: string;
  line: number;
  value: string;
}

export interface WorkspaceIndex {
  symbols: SymbolEntry[];
  calls: CallSite[];
  strings: StringLiteralEntry[];
  /** module path -> module paths it imports/requires. */
  imports: Record<string, string[]>;
}

export interface Annotation {
  /** `module:name` of the original binding. */
  symbol: string;
  rename?: string;
  note?: string;
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
  // TODO(M0.2/M1.7): type as `Report` / interpreter summaries from `webcrack/analysis`.
  report: unknown;
  interpreters: unknown[];
  annotations: Annotation[];
  stats: { openMs: number; techniques: string[] };
}
