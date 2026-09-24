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

/**
 * Parse a `target` string into its form. A string without `:` is a `bare`
 * name when it looks like a binding (`login`) and a `module` when it looks
 * like a path (contains `/`, `\`, or a file extension, e.g. `src/api.js`).
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
    name.includes('/') || name.includes('\\') || /\.[A-Za-z0-9]+$/.test(name)
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

/** Module part of a `module:line` location. */
function locationModule(from: Location): string {
  return from.slice(0, from.lastIndexOf(':'));
}

/**
 * Resolve a symbol reference (`name` or `module:name`) to its `SymbolEntry`.
 *
 * - Unknown name → `WcError` with `suggest()` candidates.
 * - Several modules export the name → `WcError` listing the `module:name`
 *   candidates, unless `from` (a `module:line` location) disambiguates: the
 *   symbol defined in `from`'s module wins, else the symbol reached through
 *   that module's import of the name (e.g. `api.js` imports `sign`, so
 *   `resolveSymbol(ws, 'sign', 'src/api.js:5')` returns `src/sign.js:sign`).
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
    return inModule[0];
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
  if (matches.length === 1) return matches[0];

  if (from !== undefined) {
    const fromModule = normalizeModule(locationModule(from));
    const local = matches.filter(
      (s) => normalizeModule(s.module) === fromModule,
    );
    // A real definition in `from`'s module wins; an import binding alone
    // resolves through to its target (e.g. `sign` from `src/api.js:5` is
    // `src/sign.js:sign`, not the import line).
    const defined = local.find((s) => s.kind !== 'import');
    if (defined) return defined;
    const imported = resolveThroughImport(ws, fromModule, input);
    if (imported) return imported;
    if (local.length > 0) return local[0];
  }

  const qualified = matches.map((s) => `${s.module}:${s.name}`);
  throw new WcError(
    `Ambiguous symbol "${input}": defined in ${qualified.length} modules. Qualify it as one of: ${qualified.map((q) => `\`${q}\``).join(', ')}.`,
    qualified,
  );
}

/**
 * Follow `fromModule`'s import of `name` to the exported symbol: the import
 * binding plus the `index.imports` edges tell which modules to look in, and
 * the (same-named) exported symbol there is the target.
 */
function resolveThroughImport(
  ws: Workspace,
  fromModule: string,
  name: string,
): SymbolEntry | undefined {
  const entry = [...ws.modules.values()].find(
    (m) => normalizeModule(m.path) === fromModule,
  );
  if (!entry) return undefined;
  const hasImportBinding = ws.index.symbols.some(
    (s) =>
      normalizeModule(s.module) === fromModule &&
      s.name === name &&
      s.kind === 'import',
  );
  if (!hasImportBinding) return undefined;
  const edges = ws.index.imports[entry.path] ?? [];
  for (const target of edges) {
    const exported = ws.index.symbols.find(
      (s) => s.module === target && s.name === name && s.exported,
    );
    if (exported) return exported;
  }
  return undefined;
}
