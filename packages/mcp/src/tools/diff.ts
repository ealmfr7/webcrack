import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { paginate, textResult } from '../format/response';
import type { ModuleEntry, Workspace } from '../workspace/types';
import { defineTool, pagination, readOnly } from './define';
import { parseClean } from '../workspace/parse';

/**
 * Structural hashes, keyed by module entry and invalidated when the module
 * code changes. Hashing is pure CPU work on already-loaded code, so a
 * process-wide cache is safe: entries are dropped when their module is
 * garbage-collected.
 */
const hashCache = new WeakMap<ModuleEntry, { code: string; hash: string }>();

/** AST keys that carry no meaning: positions, raw text, comments, errors. */
const DROP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'errors',
]);

/**
 * True when `node` is a property name rather than a renamed binding: a
 * non-computed member property (`a.foo`) or a non-computed, non-shorthand
 * object/class key (`{ key: … }`). Those are semantics — `getItem` vs
 * `setItem` must still differ — while shorthand keys (`{ login }`) name the
 * binding itself and are normalized like any other identifier.
 */
function keepName(parent: t.Node, node: t.Identifier): boolean {
  if (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) {
    return parent.property === node && parent.computed === false;
  }
  if (
    t.isObjectMethod(parent) ||
    t.isClassMethod(parent) ||
    t.isClassPrivateMethod(parent) ||
    t.isClassProperty(parent) ||
    t.isClassAccessorProperty(parent)
  ) {
    return parent.key === node && parent.computed === false;
  }
  if (t.isObjectProperty(parent)) {
    if (parent.shorthand) return false;
    return parent.key === node && parent.computed === false;
  }
  return false;
}

/**
 * Replace every binding-like identifier with a positional placeholder
 * (`$0`, `$1`, …) in first-seen order, so modules that differ only by
 * renames — or by minification — normalize to the same AST.
 */
function normalizeIdentifiers(ast: t.File): void {
  const slots = new Map<string, string>();
  traverse(ast, {
    Identifier(path) {
      if (keepName(path.parent, path.node)) return;
      let slot = slots.get(path.node.name);
      if (slot === undefined) {
        slot = `$${slots.size}`;
        slots.set(path.node.name, slot);
      }
      path.node.name = slot;
    },
  });
}

/** sha1 of the AST normalized without locations, comments, raw text or identifier names. */
function hashCode(code: string): string {
  try {
    const ast = parseClean(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['jsx'],
    });
    normalizeIdentifiers(ast);
    const normalized = JSON.stringify(ast, (key, value: unknown) =>
      DROP_KEYS.has(key) ? undefined : value,
    );
    return createHash('sha1').update(normalized, 'utf8').digest('hex');
  } catch {
    return createHash('sha1').update(code, 'utf8').digest('hex');
  }
}

function structuralHash(entry: ModuleEntry): string {
  const cached = hashCache.get(entry);
  if (cached !== undefined && cached.code === entry.code) return cached.hash;
  const hash = hashCode(entry.code);
  hashCache.set(entry, { code: entry.code, hash });
  return hash;
}

/** `sk_live_ab…yz`: secrets never leave this tool unmasked. */
function maskSecret(value: string): string {
  return value.length <= 4 ? '••••' : `${value.slice(0, 2)}…${value.slice(-2)}`;
}

type ChangeKind = 'added' | 'removed' | 'changed' | 'renamed';

interface ModuleRow {
  kind: ChangeKind;
  /** Sort/display path: the new path for renames. */
  path: string;
  /** Previous path, for renames. */
  from?: string;
}

interface Finding {
  key: string;
  text: string;
}

function collectEndpoints(ws: Workspace): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const report of Object.values(ws.report)) {
    for (const entry of report.endpoints) {
      const key = `${entry.method ?? ''}\n${entry.url ?? ''}`;
      if (!out.has(key)) {
        out.set(key, {
          key,
          text: `${entry.method ?? '?'} ${entry.url ?? '(dynamic)'}`,
        });
      }
    }
  }
  return out;
}

function collectUrls(ws: Workspace): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const report of Object.values(ws.report)) {
    for (const entry of report.urls) {
      if (!out.has(entry.value)) {
        out.set(entry.value, { key: entry.value, text: entry.value });
      }
    }
  }
  return out;
}

function collectSecrets(ws: Workspace): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const report of Object.values(ws.report)) {
    for (const entry of report.secrets) {
      const key = `${entry.rule}\n${entry.value}`;
      if (!out.has(key)) {
        out.set(key, {
          key,
          text: `${maskSecret(entry.value)} (${entry.rule})`,
        });
      }
    }
  }
  return out;
}

/** Keys present in `next` but absent from `prev`, in sorted key order. */
function addedOnly(
  prev: Map<string, Finding>,
  next: Map<string, Finding>,
): Finding[] {
  return [...next.values()]
    .filter((finding) => !prev.has(finding.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function tagsOf(ws: Workspace, path: string): string[] {
  return ws.modules.get(path)?.tags ?? [];
}

function symbolNames(ws: Workspace, path: string): string[] {
  return ws.index.symbols
    .filter((symbol) => symbol.module === path)
    .map((symbol) => symbol.name);
}

export const diff = defineTool({
  name: 'wc_diff',
  title: 'Diff workspaces',
  description:
    'Compare two workspaces (e.g. two versions of an app bundle): modules added, removed, changed (by structural hash, so pure renames do not count) or renamed (same structure under a new path), endpoint/url/secret findings added or removed, and per-module tag changes. Secrets are always masked.',
  inputSchema: {
    a: z.string().describe('First workspace id (e.g. the older version).'),
    b: z.string().describe('Second workspace id (e.g. the newer version).'),
    detail: z.enum(['concise', 'full']).default('concise'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const wa = ctx.store.get(args.a);
    const wb = ctx.store.get(args.b);

    const hashA = new Map<string, string>();
    for (const entry of wa.modules.values()) {
      hashA.set(entry.path, structuralHash(entry));
    }
    const hashB = new Map<string, string>();
    for (const entry of wb.modules.values()) {
      hashB.set(entry.path, structuralHash(entry));
    }

    const changed: string[] = [];
    let unchanged = 0;
    const onlyA = new Map<string, string>();
    for (const [path, hash] of hashA) {
      const other = hashB.get(path);
      if (other === undefined) onlyA.set(path, hash);
      else if (other === hash) unchanged += 1;
      else changed.push(path);
    }
    const onlyB = new Map<string, string>();
    for (const [path, hash] of hashB) {
      if (!hashA.has(path)) onlyB.set(path, hash);
    }

    // Unmatched modules with the same structural hash are renames, not
    // add/remove pairs. Pair deterministically by sorted path.
    const byHashB = new Map<string, string[]>();
    for (const [path, hash] of [...onlyB].sort(([p], [q]) =>
      p < q ? -1 : p > q ? 1 : 0,
    )) {
      const list = byHashB.get(hash) ?? [];
      list.push(path);
      byHashB.set(hash, list);
    }
    const renamed: { from: string; to: string }[] = [];
    for (const [path, hash] of [...onlyA].sort(([p], [q]) =>
      p < q ? -1 : p > q ? 1 : 0,
    )) {
      const candidates = byHashB.get(hash);
      const to = candidates?.shift();
      if (to !== undefined) {
        renamed.push({ from: path, to });
        onlyA.delete(path);
        onlyB.delete(to);
      }
    }

    const added = [...onlyB.keys()].sort();
    const removed = [...onlyA.keys()].sort();
    changed.sort();
    renamed.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

    const rows: ModuleRow[] = [
      ...added.map((path): ModuleRow => ({ kind: 'added', path })),
      ...removed.map((path): ModuleRow => ({ kind: 'removed', path })),
      ...changed.map((path): ModuleRow => ({ kind: 'changed', path })),
      ...renamed.map(
        ({ from, to }): ModuleRow => ({
          kind: 'renamed',
          path: to,
          from,
        }),
      ),
    ];

    const endpointsAdded = addedOnly(
      collectEndpoints(wa),
      collectEndpoints(wb),
    );
    const endpointsRemoved = addedOnly(
      collectEndpoints(wb),
      collectEndpoints(wa),
    );
    const urlsAdded = addedOnly(collectUrls(wa), collectUrls(wb));
    const urlsRemoved = addedOnly(collectUrls(wb), collectUrls(wa));
    const secretsAdded = addedOnly(collectSecrets(wa), collectSecrets(wb));
    const secretsRemoved = addedOnly(collectSecrets(wb), collectSecrets(wa));

    // Tag deltas for modules present on both sides (by path, or by rename).
    const tagLines: string[] = [];
    for (const path of [...hashA.keys()].filter((p) => hashB.has(p)).sort()) {
      const before = tagsOf(wa, path);
      const after = tagsOf(wb, path);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        tagLines.push(
          `  ~ \`${path}\`: [${before.join(', ')}] → [${after.join(', ')}]`,
        );
      }
    }
    for (const { from, to } of renamed) {
      const before = tagsOf(wa, from);
      const after = tagsOf(wb, to);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        tagLines.push(
          `  ~ \`${from}\` => \`${to}\`: [${before.join(', ')}] → [${after.join(', ')}]`,
        );
      }
    }

    // Full detail: symbol-level delta for changed modules.
    const symbolLines: string[] = [];
    if (args.detail === 'full') {
      for (const path of changed) {
        const before = new Set(symbolNames(wa, path));
        const after = new Set(symbolNames(wb, path));
        const parts = [
          ...[...after]
            .filter((name) => !before.has(name))
            .sort()
            .map((name) => `+ \`${name}\``),
          ...[...before]
            .filter((name) => !after.has(name))
            .sort()
            .map((name) => `- \`${name}\``),
        ];
        if (parts.length > 0) {
          symbolLines.push(`  \`${path}\` symbols: ${parts.join(' · ')}`);
        }
      }
    }

    const summary =
      `${added.length} added · ${removed.length} removed · ` +
      `${changed.length} changed · ${renamed.length} renamed · ` +
      `${unchanged} unchanged`;
    const lines = [
      rows.length === 0
        ? `Diff ${wa.id} → ${wb.id}: no differences (${unchanged} modules unchanged).`
        : `Diff ${wa.id} → ${wb.id}: ${summary}.`,
    ];

    const KIND_HEADER: Record<ChangeKind, string> = {
      added: 'Added modules',
      removed: 'Removed modules',
      changed: 'Changed modules',
      renamed: 'Renamed modules',
    };
    const KIND_MARK: Record<ChangeKind, string> = {
      added: '+',
      removed: '-',
      changed: '~',
      renamed: '→',
    };
    const page = paginate(rows, args.limit, args.offset);
    let lastKind: ChangeKind | undefined;
    for (const row of page.items) {
      if (row.kind !== lastKind) {
        const total = rows.filter((r) => r.kind === row.kind).length;
        lines.push(`${KIND_HEADER[row.kind]} (${total}):`);
        lastKind = row.kind;
      }
      lines.push(
        row.kind === 'renamed' && row.from !== undefined
          ? `  ${KIND_MARK[row.kind]} \`${row.from}\` => \`${row.path}\``
          : `  ${KIND_MARK[row.kind]} \`${row.path}\``,
      );
    }
    if (page.footer !== undefined) lines.push(page.footer);

    const findingSection = (
      title: string,
      mark: '+' | '-',
      findings: Finding[],
    ): void => {
      if (findings.length === 0) return;
      lines.push(`${title} (${findings.length}):`);
      for (const finding of findings) {
        lines.push(`  ${mark} \`${finding.text}\``);
      }
    };
    findingSection('Endpoints added', '+', endpointsAdded);
    findingSection('Endpoints removed', '-', endpointsRemoved);
    findingSection('URLs added', '+', urlsAdded);
    findingSection('URLs removed', '-', urlsRemoved);
    findingSection('Secrets added', '+', secretsAdded);
    findingSection('Secrets removed', '-', secretsRemoved);

    if (tagLines.length > 0) {
      lines.push(`Tags changed (${tagLines.length}):`);
      lines.push(...tagLines);
    }
    if (symbolLines.length > 0) {
      lines.push(`Symbols changed (${changed.length} modules):`);
      lines.push(...symbolLines);
    }

    // The first changed module is the natural next read; fall back to an
    // added module or a rename target when nothing changed.
    const nextPath = changed[0] ?? added[0] ?? renamed[0]?.to ?? removed[0];
    return Promise.resolve(
      textResult(lines.join('\n'), {
        budget: ctx.config.outputBudget,
        next: nextPath === undefined ? [] : [`wc_read ${nextPath}`],
      }),
    );
  },
});
