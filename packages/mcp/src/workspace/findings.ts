import { parse, type ParseResult } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { ModuleEntry, Workspace } from './types';

/**
 * Shared findings logic (M1.7). Pure queries over a `Workspace`, also used
 * later by the `wc_open` overview (M1.3) and `wc_export` (M3.1).
 *
 * Categories `endpoints`/`urls`/`secrets`/`regexes`/`interesting` come
 * straight from `ws.report[module]` (finding lines are already module
 * lines). Categories `sinks`/`storage`/`crypto` are derived by parsing each
 * module's clean code with `@babel/parser` (`errorRecovery`) on demand;
 * `vm` comes from `ws.interpreters`.
 *
 * Secret values are returned RAW here; masking (`maskSecret`) is a
 * presentation decision of the `wc_findings` tool (`reveal` flag).
 */

export type FindingCategory =
  | 'endpoints'
  | 'urls'
  | 'secrets'
  | 'regexes'
  | 'interesting'
  | 'sinks'
  | 'storage'
  | 'crypto'
  | 'vm';

export const ALL_FINDING_CATEGORIES: readonly FindingCategory[] = [
  'endpoints',
  'urls',
  'secrets',
  'regexes',
  'interesting',
  'sinks',
  'storage',
  'crypto',
  'vm',
];

export interface Finding {
  category: FindingCategory;
  module: string;
  line: number;
  column?: number;
  title: string;
  value?: string;
  detail?: string;
}

/** Show only the head and tail of a secret: `sk_live_ab…yz` style. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '…';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

// -- Callee/API tables (also reused by workspace/tags.ts, M1.4) -------------

/** Exact dotted callee names that are always sinks. */
export const SINK_CALLEES: Record<string, string> = {
  eval: 'eval()',
  Function: 'Function()',
  'document.write': 'document.write()',
  'document.writeln': 'document.writeln()',
};

/** Member-call suffixes that are sinks regardless of the receiver root. */
export const SINK_CALLEE_SUFFIXES: Record<string, string> = {
  '.postMessage': 'postMessage()',
};

/** Dotted roots for storage access (calls and property reads). */
export const STORAGE_APIS: readonly string[] = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
];

/**
 * Crypto call roots, shared with `workspace/tags.ts`. `btoa`/`atob` match
 * exactly; `crypto` matches itself and anything under it (`crypto.subtle.*`,
 * `crypto.getRandomValues`, …).
 */
export const CRYPTO_APIS: readonly string[] = ['crypto', 'btoa', 'atob'];

/** Known hash/cipher numeric constants, matched against numeric literals. */
export const CRYPTO_CONSTANTS: readonly {
  label: string;
  values: readonly number[];
}[] = [
  {
    label: 'MD5/SHA-1 init',
    values: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
  },
  {
    label: 'SHA-256 init',
    values: [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ],
  },
  {
    label: 'SHA-256 round constant',
    values: [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5],
  },
  {
    label: 'CRC32 polynomial',
    values: [0xedb88320, 0x04c11db7],
  },
];

/**
 * Start of the AES S-box; matched as an array-literal prefix (single bytes
 * like `0x63` alone would be far too noisy).
 */
export const AES_SBOX_START: readonly number[] = [0x63, 0x7c, 0x77, 0x7b];

/**
 * Heuristic: this many bitwise ops (`| & ^ << >> >>> ~`, including compound
 * assignment forms) inside one function suggests a hand-rolled hash/cipher
 * loop. Documented threshold, deliberately recall-oriented.
 */
export const DENSE_BITWISE_THRESHOLD = 8;

// -- On-demand AST parsing (cached per module entry) --------------------------
//
// The cache is keyed by the `ModuleEntry` OBJECT (not `ws` + path) and stores
// the code it was parsed from: when a tool rewrites `module.code` in place
// (e.g. `wc_deobfuscate apply`), the next query reparses instead of serving
// the stale tree.

const astCache = new WeakMap<
  ModuleEntry,
  { code: string; ast: ParseResult<t.File> | undefined }
>();

export interface ModuleAstOptions {
  /**
   * When `false`, parse fresh without reading or populating the per-entry
   * cache. Precompute/commit pass `false` (nothing re-reads those trees,
   * queries use `ws.findings`); on-demand queries use the default cached
   * path.
   */
  cache?: boolean;
  /** Injectable parser (defaults to `@babel/parser`); lets tests count parses. */
  parse?: typeof parse;
}

function parseFresh(
  code: string,
  parseFn: typeof parse,
): ParseResult<t.File> | undefined {
  try {
    return parseFn(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['jsx'],
    });
  } catch {
    return undefined;
  }
}

function moduleAst(
  module: ModuleEntry,
  opts?: ModuleAstOptions,
): t.File | undefined {
  const parseFn = opts?.parse ?? parse;
  if (opts?.cache === false) return parseFresh(module.code, parseFn);
  const cached = astCache.get(module);
  if (cached !== undefined && cached.code === module.code) return cached.ast;
  const ast = parseFresh(module.code, parseFn);
  astCache.set(module, { code: module.code, ast });
  return ast;
}

/** Dotted name of a callee/object expression (`a.b.c`), or `undefined`. */
function dotted(node: t.Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (t.isIdentifier(node)) return node.name;
  if (t.isThisExpression(node)) return 'this';
  if (t.isMemberExpression(node) && !node.computed) {
    const object = dotted(node.object);
    const prop = t.isIdentifier(node.property) ? node.property.name : undefined;
    if (object !== undefined && prop !== undefined) return `${object}.${prop}`;
  }
  return undefined;
}

function lineOf(node: t.Node): number {
  return node.loc?.start.line ?? 0;
}

function columnOf(node: t.Node): number | undefined {
  return node.loc?.start.column;
}

function sourceLine(module: ModuleEntry, line: number): string {
  return (module.code.split('\n')[line - 1] ?? '').trim();
}

const BITWISE_BINARY_OPS: ReadonlySet<string> = new Set([
  '|',
  '&',
  '^',
  '<<',
  '>>',
  '>>>',
  '|=',
  '&=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
]);

function functionName(node: t.Function, parent: t.Node | null): string {
  if (
    (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) &&
    node.id
  ) {
    return node.id.name;
  }
  if (parent && t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
    return parent.id.name;
  }
  if (
    parent &&
    t.isAssignmentExpression(parent) &&
    parent.operator === '=' &&
    t.isIdentifier(parent.left)
  ) {
    return parent.left.name;
  }
  return '<anonymous>';
}

// -- Report-backed categories ------------------------------------------------

function reportFindings(
  ws: Workspace,
  category: FindingCategory,
  modules: ModuleEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const mod of modules) {
    const report = ws.report[mod.path];
    if (!report) continue;
    switch (category) {
      case 'endpoints':
        for (const entry of report.endpoints) {
          findings.push({
            category,
            module: mod.path,
            line: entry.line,
            column: entry.column,
            title: `${entry.method ?? 'unknown method'} ${entry.url ?? '(dynamic url)'}`,
            value: entry.url ?? undefined,
          });
        }
        break;
      case 'urls':
        for (const entry of report.urls) {
          findings.push({
            category,
            module: mod.path,
            line: entry.line,
            column: entry.column,
            title: 'url',
            value: entry.value,
          });
        }
        break;
      case 'secrets':
        for (const entry of report.secrets) {
          findings.push({
            category,
            module: mod.path,
            line: entry.line,
            column: entry.column,
            title: entry.rule,
            value: entry.value,
          });
        }
        break;
      case 'regexes':
        for (const entry of report.regexes) {
          findings.push({
            category,
            module: mod.path,
            line: entry.line,
            column: entry.column,
            title: 'regex',
            value: entry.value,
          });
        }
        break;
      case 'interesting':
        for (const entry of report.interesting) {
          findings.push({
            category,
            module: mod.path,
            line: entry.line,
            column: entry.column,
            title: entry.kind,
            value: entry.value,
          });
        }
        break;
      default:
        break;
    }
  }
  return findings;
}

// -- AST-backed categories (sinks / storage / crypto) ------------------------

const cryptoValueToLabel = new Map<number, string>();
for (const group of CRYPTO_CONSTANTS) {
  for (const value of group.values) {
    if (!cryptoValueToLabel.has(value))
      cryptoValueToLabel.set(value, group.label);
  }
}

function isStorageName(name: string): boolean {
  return STORAGE_APIS.some(
    (root) => name === root || name.startsWith(`${root}.`),
  );
}

function cryptoCallTitle(name: string): string | undefined {
  const hit = CRYPTO_APIS.some(
    (root) => name === root || name.startsWith(`${root}.`),
  );
  return hit ? `${name}()` : undefined;
}

function isStringArg(
  node: t.CallExpression['arguments'][number] | undefined,
): boolean {
  return (
    t.isStringLiteral(node) ||
    (t.isTemplateLiteral(node) && node.expressions.length === 0)
  );
}

function collectFromAst(mod: ModuleEntry, opts?: ModuleAstOptions): Finding[] {
  const ast = moduleAst(mod, opts);
  if (!ast) return [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (finding: Finding): void => {
    const key = `${finding.module}:${finding.line}:${finding.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  const at = (
    category: FindingCategory,
    node: t.Node,
    title: string,
    value?: string,
  ): void => {
    push({
      category,
      module: mod.path,
      line: lineOf(node),
      column: columnOf(node),
      title,
      value: value ?? sourceLine(mod, lineOf(node)),
    });
  };

  // Bitwise-op frames: one per function plus a module top-level frame.
  const frames: { name: string; line: number; count: number }[] = [
    { name: '<module>', line: 1, count: 0 },
  ];

  traverse(ast, {
    Function: {
      enter(path) {
        frames.push({
          name: functionName(path.node, path.parent),
          line: lineOf(path.node),
          count: 0,
        });
      },
      exit() {
        const frame = frames.pop();
        if (frame && frame.count >= DENSE_BITWISE_THRESHOLD) {
          push({
            category: 'crypto',
            module: mod.path,
            line: frame.line,
            column: undefined,
            title: 'dense bitwise ops',
            value: `${frame.count} bitwise ops in function '${frame.name}'`,
          });
        }
      },
    },
    BinaryExpression(path) {
      if (BITWISE_BINARY_OPS.has(path.node.operator)) {
        frames[frames.length - 1].count += 1;
      }
    },
    AssignmentExpression(path) {
      const node = path.node;
      if (BITWISE_BINARY_OPS.has(node.operator)) {
        frames[frames.length - 1].count += 1;
      }
      const left = node.left;
      if (t.isMemberExpression(left) && !left.computed) {
        const prop = t.isIdentifier(left.property)
          ? left.property.name
          : undefined;
        const object = dotted(left.object);
        if (prop === 'innerHTML' || prop === 'outerHTML') {
          at('sinks', node, `${prop} assignment`);
        } else if (
          prop === 'location' ||
          object === 'location' ||
          (prop === 'href' && (object ?? '').endsWith('location'))
        ) {
          at('sinks', node, 'location assignment');
        }
      } else if (t.isIdentifier(left) && left.name === 'location') {
        at('sinks', node, 'location assignment');
      }
    },
    UnaryExpression(path) {
      if (path.node.operator === '~') {
        frames[frames.length - 1].count += 1;
      }
    },
    CallExpression(path) {
      const node = path.node;
      const name = dotted(node.callee);
      if (name === undefined) return;
      const args = node.arguments;
      const sinkTitle = SINK_CALLEES[name];
      if (sinkTitle !== undefined) at('sinks', node, sinkTitle);
      for (const [suffix, title] of Object.entries(SINK_CALLEE_SUFFIXES)) {
        if (name.endsWith(suffix)) at('sinks', node, title);
      }
      if (
        (name === 'setTimeout' ||
          name === 'setInterval' ||
          name.endsWith('.setTimeout') ||
          name.endsWith('.setInterval')) &&
        isStringArg(args[0])
      ) {
        at(
          'sinks',
          node,
          `${name.endsWith('setInterval') ? 'setInterval' : 'setTimeout'}() with string argument`,
        );
      }
      if (
        (name === 'addEventListener' || name.endsWith('.addEventListener')) &&
        t.isStringLiteral(args[0]) &&
        args[0].value === 'message'
      ) {
        at('sinks', node, "addEventListener('message')");
      }
      // `document.cookie.*` calls are owned by the MemberExpression visitor
      // (one `document.cookie` finding per line); the other roots report
      // the full dotted callee here.
      if (
        name !== 'document.cookie' &&
        !name.startsWith('document.cookie.') &&
        isStorageName(name)
      ) {
        at('storage', node, name);
      }
      const cryptoTitle = cryptoCallTitle(name);
      if (cryptoTitle !== undefined) at('crypto', node, cryptoTitle);
    },
    NewExpression(path) {
      const node = path.node;
      if (dotted(node.callee) === 'Function') at('sinks', node, 'Function()');
    },
    MemberExpression(path) {
      const node = path.node;
      // `document.cookie` reads/writes are property access, not calls. Fire
      // on the exact name regardless of parent: chain reads like
      // `document.cookie.split(';')` nest the match inside an outer member
      // (whose dotted name never equals `document.cookie`), and the
      // per-line `seen` dedupe keeps one finding per line.
      if (dotted(node) === 'document.cookie') {
        at('storage', node, 'document.cookie');
      }
    },
    NumericLiteral(path) {
      const label = cryptoValueToLabel.get(path.node.value);
      if (label !== undefined) {
        push({
          category: 'crypto',
          module: mod.path,
          line: lineOf(path.node),
          column: columnOf(path.node),
          title: `crypto constant: ${label}`,
          value: `0x${path.node.value.toString(16)}`,
        });
      }
    },
    ArrayExpression(path) {
      const elements = path.node.elements.map((el) =>
        t.isNumericLiteral(el) ? el.value : undefined,
      );
      if (
        elements.length >= AES_SBOX_START.length &&
        AES_SBOX_START.every((v, i) => elements[i] === v)
      ) {
        push({
          category: 'crypto',
          module: mod.path,
          line: lineOf(path.node),
          column: columnOf(path.node),
          title: 'crypto constant: AES S-box',
          value: sourceLine(mod, lineOf(path.node)),
        });
      }
    },
  });
  return findings;
}

// -- Public API --------------------------------------------------------------

/**
 * AST-based findings (`sinks`/`storage`/`crypto`) for one module, parsed on
 * demand (and cached per entry — see `moduleAst`). Exported so the store can
 * precompute and refresh `Workspace.findings` without going through a
 * workspace. The store passes `{ cache: false }` there: nothing re-reads
 * those trees, so they must not be retained.
 */
export function collectModuleAstFindings(
  mod: ModuleEntry,
  opts?: ModuleAstOptions,
): Finding[] {
  return collectFromAst(mod, opts);
}

/**
 * Precomputed AST-based findings for every module, keyed by module path —
 * the shape stored on `Workspace.findings` and in `findings.json`.
 * "Process once, query many": `open`/`commit` compute this, queries read it.
 * The store passes `{ cache: false }` so precomputing retains no ASTs.
 */
export function precomputeModuleFindings(
  modules: Iterable<ModuleEntry>,
  opts?: ModuleAstOptions,
): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const mod of modules) out[mod.path] = collectFromAst(mod, opts);
  return out;
}

/**
 * Collect findings of one category. `modules` defaults to every module in
 * workspace order; results are in module order, then source (line) order.
 *
 * AST categories (`sinks`/`storage`/`crypto`) read `ws.findings` when
 * present (a module missing from it — e.g. added without a `commit` — is
 * parsed on demand); workspaces without it (old disk caches,
 * hand-built fixtures) fall back to parsing every module.
 */
export function collectFindings(
  ws: Workspace,
  category: FindingCategory,
  modules?: ModuleEntry[],
  opts?: ModuleAstOptions,
): Finding[] {
  const mods = modules ?? [...ws.modules.values()];
  switch (category) {
    case 'endpoints':
    case 'urls':
    case 'secrets':
    case 'regexes':
    case 'interesting':
      return reportFindings(ws, category, mods);
    case 'sinks':
    case 'storage':
    case 'crypto': {
      const findings: Finding[] = [];
      for (const mod of mods) {
        const precomputed = ws.findings?.[mod.path];
        const all = precomputed ?? collectFromAst(mod, opts);
        findings.push(...all.filter((f) => f.category === category));
      }
      // Already in module order, then source order (Babel enter order).
      return findings;
    }
    case 'vm': {
      const paths = new Set(mods.map((m) => m.path));
      return ws.interpreters
        .filter((interp) => paths.has(interp.module))
        .map((interp) => ({
          category: 'vm' as const,
          module: interp.module,
          line: interp.line,
          column: undefined,
          title: `VM interpreter (${interp.dispatchKind}, ${interp.handlerCount} handlers)`,
          value:
            [interp.pc, interp.bytecode, interp.stack]
              .filter((v) => v !== undefined)
              .join(' ') || undefined,
        }));
    }
  }
}

/** Priority order for the summary's top findings (most actionable first). */
const SUMMARY_PRIORITY: readonly FindingCategory[] = [
  'secrets',
  'endpoints',
  'sinks',
  'crypto',
  'storage',
  'vm',
  'urls',
  'interesting',
  'regexes',
];

export interface FindingsSummary {
  counts: Record<FindingCategory, number>;
  top: Finding[];
}

/** Per-category counts over the whole workspace plus the top 5 findings. */
export function summarizeFindings(ws: Workspace): FindingsSummary {
  const counts = {} as Record<FindingCategory, number>;
  const byCategory = new Map<FindingCategory, Finding[]>();
  for (const category of ALL_FINDING_CATEGORIES) {
    const findings = collectFindings(ws, category);
    counts[category] = findings.length;
    byCategory.set(category, findings);
  }
  const top: Finding[] = [];
  for (const category of SUMMARY_PRIORITY) {
    for (const finding of byCategory.get(category) ?? []) {
      if (top.length >= 5) break;
      top.push(finding);
    }
    if (top.length >= 5) break;
  }
  return { counts, top };
}
