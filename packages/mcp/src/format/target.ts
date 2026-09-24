import { suggest, WcError } from './errors';
import type {
  Location,
  ModuleEntry,
  SymbolEntry,
  Workspace,
} from '../workspace/types';

/**
 * Shared `target`/`symbol` resolver (used by `wc_read`, `wc_goto`,
 * `wc_refs`, `wc_deobfuscate`, …). Module paths never contain `:`, so every
 * split below is on the LAST `:`.
 */
export type ParsedTarget =
  /** `mod` — a whole module. */
  | { kind: 'module'; module: string }
  /** `mod:line` — one line. */
  | { kind: 'line'; module: string; line: number }
  /** `mod:start-end` — an inclusive line range. */
  | { kind: 'range'; module: string; start: number; end: number }
  /** `mod:symbol` — a named symbol in a module. */
  | { kind: 'symbol'; module: string; symbol: string }
  /** `symbol` — a bare name, resolved against modules or symbols by the caller. */
  | { kind: 'bare'; name: string };

/** A `target` resolved to a module plus an optional line range/symbol. */
export interface ResolvedTarget {
  /** Resolved module path (`ModuleEntry.path`). */
  module: string;
  /** 1-based start line, when the target names lines or a symbol. */
  start?: number;
  /** 1-based inclusive end line, when the target names lines or a symbol. */
  end?: number;
  /** The resolved symbol, when the target names one. */
  symbol?: SymbolEntry;
}

/**
 * Parse a `target` string into its form. A string without `:` is a `bare`
 * name when it looks like a binding (`login`, `Client.request`) and a
 * `module` when it looks like a path (contains `/` or `\`, or ends in a
 * real JS extension, e.g. `src/api.js`).
 */
export function parseTarget(str: string): ParsedTarget {
  const input = str.trim();
  const colon = input.lastIndexOf(':');
  if (colon === -1) {
    if (looksLikePath(input)) return { kind: 'module', module: input };
    if (input === '')
      throw new WcError(
        'Empty target. Pass a module path, `module:line`, `module:start-end`, `module:symbol` or a symbol name.',
      );
    return { kind: 'bare', name: input };
  }
  const module = input.slice(0, colon).trim();
  const rest = input.slice(colon + 1).trim();
  if (module === '' || rest === '') {
    throw new WcError(
      `Invalid target "${str}". Use module, module:line, module:start-end, module:symbol or a bare symbol name.`,
    );
  }
  const range = /^(\d+)-(\d+)$/.exec(rest);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 1 || end < 1 || start > end) {
      throw new WcError(
        `Invalid range "${rest}" in target "${str}": use start-end with 1 <= start <= end.`,
      );
    }
    return { kind: 'range', module, start, end };
  }
  if (/^\d+$/.test(rest)) {
    const line = Number(rest);
    if (line < 1) {
      throw new WcError(
        `Invalid line "${rest}" in target "${str}": lines start at 1.`,
      );
    }
    return { kind: 'line', module, line };
  }
  return { kind: 'symbol', module, symbol: rest };
}

function looksLikePath(name: string): boolean {
  return (
    name.includes('/') ||
    name.includes('\\') ||
    /\.(?:js|mjs|cjs|jsx|ts|tsx)$/.test(name)
  );
}

/** Strip one leading `./` so `src/api.js` and `./src/api.js` match. */
function normalizeModule(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
}

/**
 * Resolve a module reference: the path with or without a leading `./`,
 * or the bundle id (`ModuleEntry.bundleId`). Throws a `WcError` with
 * `suggest()` candidates otherwise.
 */
export function resolveModule(ws: Workspace, name: string): ModuleEntry {
  const needle = normalizeModule(name);
  const modules = [...ws.modules.values()];
  const byPath = modules.find((m) => normalizeModule(m.path) === needle);
  if (byPath) return byPath;
  const byId = modules.find((m) => m.bundleId === needle);
  if (byId) return byId;
  const candidates = suggest(
    needle,
    modules.flatMap((m) => [m.path, m.bundleId]),
  );
  throw new WcError(
    `Unknown module "${name}".${formatSuggestions(candidates)} Call wc_map to list modules.`,
    candidates,
  );
}

function formatSuggestions(candidates: string[]): string {
  return candidates.length > 0
    ? ` Did you mean ${candidates.map((c) => `\`${c}\``).join(', ')}?`
    : '';
}

/** 1-based line count of a module's clean code. */
function lineCount(entry: ModuleEntry): number {
  return entry.code.split('\n').length;
}

/**
 * Throw an actionable `WcError` when `start`-`end` exceeds the module's line
 * count (e.g. `src/api.js has 9 lines; valid range 1-9`).
 */
function checkLines(entry: ModuleEntry, start: number, end: number): void {
  const count = lineCount(entry);
  if (start > count || end > count) {
    throw new WcError(
      `${entry.path} has ${count} line${count === 1 ? '' : 's'}; valid range 1-${count}.`,
    );
  }
}

/**
 * Match modules by an optional filter. Shared by `wc_map`, `wc_search`, and
 * `wc_findings` so every tool filters modules the same way.
 *
 * - An undefined filter matches all modules.
 * - A leading `./` is stripped before matching.
 * - An exact module path or bundle id matches that one module.
 * - Anything else is a path prefix (a folder filter, e.g. `src/api/`).
 * - No match → `WcError` with `suggest()` candidates over module paths.
 */
export function matchModules(ws: Workspace, filter?: string): ModuleEntry[] {
  const modules = [...ws.modules.values()];
  if (filter === undefined) return modules;
  const needle = normalizeModule(filter);
  const exact = modules.find(
    (m) => normalizeModule(m.path) === needle || m.bundleId === needle,
  );
  if (exact) return [exact];
  const prefixed = modules.filter((m) =>
    normalizeModule(m.path).startsWith(needle),
  );
  if (prefixed.length > 0) return prefixed;
  const candidates = suggest(
    needle,
    modules.map((m) => m.path),
  );
  throw new WcError(
    `No modules match "${filter}".${formatSuggestions(candidates)} Call wc_map to list modules.`,
    candidates,
  );
}

const symbolsByNameCache = new WeakMap<Workspace, Map<string, SymbolEntry[]>>();

/**
 * Group a workspace's symbols by name, memoized per workspace object (so
 * callers like the wave-B call-graph tools can pre-filter edges before
 * calling `resolveSymbol` on each one). The map is a snapshot: re-indexing
 * into the same workspace object after the first call is not reflected.
 */
export function symbolsByName(ws: Workspace): Map<string, SymbolEntry[]> {
  const cached = symbolsByNameCache.get(ws);
  if (cached) return cached;
  const grouped = new Map<string, SymbolEntry[]>();
  for (const symbol of ws.index.symbols) {
    const list = grouped.get(symbol.name);
    if (list) list.push(symbol);
    else grouped.set(symbol.name, [symbol]);
  }
  symbolsByNameCache.set(ws, grouped);
  return grouped;
}

/** Module part of a `module:line` location. */
function locationModule(from: Location): string {
  return from.slice(0, from.lastIndexOf(':'));
}

/**
 * Resolve a symbol reference (`name` or `module:name`) to its `SymbolEntry`.
 *
 * - Unknown name → `WcError` with `suggest()` candidates.
 * - One real definition plus import bindings elsewhere → the real definition
 *   (import bindings never shadow one, so bare `sign` is `src/sign.js:sign`
 *   even though `src/api.js` also binds `sign` via its import). Only when
 *   every match is an import binding is each followed through its import and
 *   deduped; ambiguity is reported only when more than one REAL definition
 *   remains. A single match that is an import binding is followed through
 *   its import the same way, falling back to the binding itself when it
 *   follows nowhere (e.g. a namespace import).
 * - A qualified `module:name` whose match is an import binding is followed
 *   through the import too (e.g. `src/api.js:sign` is `src/sign.js:sign`,
 *   not the import line in `src/api.js`); a namespace binding still resolves
 *   to the binding itself.
 * - With `from` (a `module:line` location): the symbol defined in `from`'s
 *   module wins, else the symbol reached through that module's import of the
 *   name (e.g. `api.js` imports `sign`, so `resolveSymbol(ws, 'sign',
 *   'src/api.js:5')` returns `src/sign.js:sign`).
 */
export function resolveSymbol(
  ws: Workspace,
  spec: string,
  from?: Location,
): SymbolEntry {
  const input = spec.trim();
  const colon = input.lastIndexOf(':');
  if (colon !== -1) {
    const entry = resolveModule(ws, input.slice(0, colon).trim());
    const name = input.slice(colon + 1).trim();
    const inModule = ws.index.symbols.filter(
      (s) => s.module === entry.path && s.name === name,
    );
    if (inModule.length === 0) {
      const names = ws.index.symbols
        .filter((s) => s.module === entry.path)
        .map((s) => s.name);
      const candidates = suggest(name, names);
      throw new WcError(
        `Unknown symbol "${name}" in module "${entry.path}".${formatSuggestions(candidates)} Call wc_outline with module="${entry.path}" to list its symbols.`,
        candidates,
      );
    }
    const found = inModule[0];
    if (found.kind === 'import') {
      return resolveThroughImport(ws, entry.path, name) ?? found;
    }
    return found;
  }

  const matches = ws.index.symbols.filter((s) => s.name === input);
  if (matches.length === 0) {
    const candidates = suggest(
      input,
      ws.index.symbols.map((s) => s.name),
    );
    throw new WcError(
      `Unknown symbol "${input}".${formatSuggestions(candidates)} Call wc_search with query="${input}" to find similar code.`,
      candidates,
    );
  }
  if (from !== undefined) {
    const fromModule = normalizeModule(locationModule(from));
    const local = matches.filter(
      (s) => normalizeModule(s.module) === fromModule,
    );
    // A real definition in `from`'s module wins; an import binding alone
    // resolves through to its target (e.g. `s`, aliased from `sign`, at
    // `src/api.js:5` is `src/sign.js:sign`, not the import line).
    const defined = local.find((s) => s.kind !== 'import');
    if (defined) return defined;
    const imported = resolveThroughImport(ws, fromModule, input);
    if (imported) return imported;
    if (local.length > 0) return local[0];
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (only.kind === 'import') {
      return resolveThroughImport(ws, only.module, only.name) ?? only;
    }
    return only;
  }

  const real = matches.filter((s) => s.kind !== 'import');
  if (real.length === 1) return real[0];
  if (real.length > 1) {
    const qualified = real.map((s) => `${s.module}:${s.name}`);
    throw new WcError(
      `Ambiguous symbol "${input}": defined in ${qualified.length} modules. Qualify it as one of: ${qualified.map((q) => `\`${q}\``).join(', ')}.`,
      qualified,
    );
  }
  // Only import bindings: follow each through its import and dedupe (e.g.
  // two modules re-exporting the same symbol collapse to one target).
  const followed = new Map<string, SymbolEntry>();
  for (const binding of matches) {
    const target = resolveThroughImport(ws, binding.module, binding.name);
    if (target) followed.set(`${target.module}:${target.name}`, target);
  }
  if (followed.size === 1) return [...followed.values()][0];
  if (followed.size > 1) {
    const qualified = [...followed.keys()];
    throw new WcError(
      `Ambiguous symbol "${input}": defined in ${qualified.length} modules. Qualify it as one of: ${qualified.map((q) => `\`${q}\``).join(', ')}.`,
      qualified,
    );
  }
  const qualified = matches.map((s) => `${s.module}:${s.name}`);
  throw new WcError(
    `Ambiguous symbol "${input}": defined in ${qualified.length} modules. Qualify it as one of: ${qualified.map((q) => `\`${q}\``).join(', ')}.`,
    qualified,
  );
}

/**
 * Follow `fromModule`'s import of `name` to the exported symbol, using the
 * import binding's `from` + `importedName` (`import { sign as s }` follows
 * `from` under the name `sign`; default imports follow `default`; namespace
 * imports (`'*'`, including CJS `require`) resolve per-member, so the bare
 * binding itself follows nowhere). Barrels (`export … from '…'`, recorded in
 * `index.reexports`) are followed transitively; cycles resolve to `undefined`
 * instead of looping. Bindings without `from` fall back to the
 * `index.imports` edges plus a same-named export.
 */
export function resolveThroughImport(
  ws: Workspace,
  fromModule: string,
  name: string,
  seen: Set<string> = new Set(),
): SymbolEntry | undefined {
  const from = normalizeModule(fromModule);
  const key = `${from}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const binding = ws.index.symbols.find(
    (s) =>
      normalizeModule(s.module) === from &&
      s.name === name &&
      s.kind === 'import',
  );
  if (!binding) return undefined;
  if (binding.from !== undefined) {
    if (binding.importedName === '*') return undefined;
    return resolveExport(ws, binding.from, binding.importedName ?? name, seen);
  }
  const entry = [...ws.modules.values()].find(
    (m) => normalizeModule(m.path) === from,
  );
  if (!entry) return undefined;
  const edges = ws.index.imports[entry.path] ?? [];
  for (const target of edges) {
    const exported = ws.index.symbols.find(
      (s) => s.module === target && s.name === name && s.exported,
    );
    if (exported) return exported;
  }
  return undefined;
}

/**
 * Resolve an exported name in a module: a real (non-import) local symbol
 * first, then the `index.reexports` chain (barrels, including `export *`),
 * then an import binding that is re-exported. Cycles give `undefined`.
 *
 * `export *` never re-exports `default`; `export * as ns from '…'` (stored
 * as `{ name: 'ns', importedName: '*' }`) is a namespace, so requesting that
 * name gives `undefined` instead of following into the source module.
 */
function resolveExport(
  ws: Workspace,
  modulePath: string,
  name: string,
  seen: Set<string>,
): SymbolEntry | undefined {
  const mod = normalizeModule(modulePath);
  const key = `export:${mod}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const local = ws.index.symbols.filter(
    (s) => normalizeModule(s.module) === mod && s.name === name,
  );
  const real = local.find((s) => s.kind !== 'import');
  if (real) return real;
  for (const re of ws.index.reexports) {
    if (normalizeModule(re.module) !== mod) continue;
    if (re.name === name && re.importedName === '*') {
      // `export * as ns from '…'`: a namespace, not a followable binding.
      return undefined;
    }
    if (re.name === name && re.importedName !== '*') {
      const found = resolveExport(ws, re.from, re.importedName, seen);
      if (found) return found;
    } else if (re.name === '*' && name !== 'default') {
      const found = resolveExport(ws, re.from, name, seen);
      if (found) return found;
    }
  }
  const binding = local.find(
    (s) => s.kind === 'import' && s.from !== undefined,
  );
  if (binding) {
    if (binding.importedName === '*') return undefined;
    return resolveExport(ws, binding.from!, binding.importedName ?? name, seen);
  }
  return undefined;
}

/**
 * Single entry point for resolving a `target` (`wc_read`, `wc_goto`,
 * `wc_refs`, `wc_deobfuscate`): parse it, then resolve modules/symbols with
 * `WcError`s (with suggestions) on failure. A bare name resolves as a symbol
 * first; when no symbol matches and the name is a module path or bundle id
 * (e.g. `'5'`), it resolves to the module instead.
 */
export function resolveTarget(
  ws: Workspace,
  target: string,
  from?: Location,
): ResolvedTarget {
  const parsed = parseTarget(target);
  switch (parsed.kind) {
    case 'module': {
      const entry = resolveModule(ws, parsed.module);
      return { module: entry.path };
    }
    case 'line': {
      const entry = resolveModule(ws, parsed.module);
      checkLines(entry, parsed.line, parsed.line);
      return { module: entry.path, start: parsed.line, end: parsed.line };
    }
    case 'range': {
      const entry = resolveModule(ws, parsed.module);
      checkLines(entry, parsed.start, parsed.end);
      return { module: entry.path, start: parsed.start, end: parsed.end };
    }
    case 'symbol': {
      const entry = resolveModule(ws, parsed.module);
      const symbol = resolveSymbol(ws, `${entry.path}:${parsed.symbol}`, from);
      return {
        module: symbol.module,
        start: symbol.line,
        end: symbol.endLine,
        symbol,
      };
    }
    case 'bare': {
      try {
        const symbol = resolveSymbol(ws, parsed.name, from);
        return {
          module: symbol.module,
          start: symbol.line,
          end: symbol.endLine,
          symbol,
        };
      } catch (error) {
        if (error instanceof WcError) {
          try {
            const entry = resolveModule(ws, parsed.name);
            return { module: entry.path };
          } catch {
            // Not a module either: the symbol error carries the suggestions.
          }
        }
        throw error;
      }
    }
  }
}
