import { z } from 'zod';
import { paginate, textResult } from '../format/response';
import { matchModules } from '../format/target';
import type { ModuleEntry, ModuleTag, Workspace } from '../workspace/types';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

/** Canonical tag order for the header counts. */
const TAG_ORDER: ModuleTag[] = [
  'network',
  'auth',
  'crypto',
  'storage',
  'dom',
  'vm',
  'vendor',
];

export const map = defineTool({
  name: 'wc_map',
  title: 'Module map',
  description:
    'Browse the workspace modules like a file tree: path, size, exports/imports count, tags (network, auth, crypto, storage, dom, vm, vendor) and entry point. Filter by folder or tag, sort by path, size or refs. Use it to decide where to look next.',
  inputSchema: {
    workspace: workspaceArg,
    path: z.string().optional().describe('Only modules under this folder.'),
    tag: z
      .enum(['network', 'auth', 'crypto', 'storage', 'dom', 'vm', 'vendor'])
      .optional()
      .describe('Only modules with this tag.'),
    sort: z.enum(['path', 'size', 'refs']).default('path'),
    detail: z.enum(['concise', 'full']).default('concise'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const scoped = matchModules(ws, args.path);
    const tag = args.tag;
    const listed =
      tag === undefined
        ? scoped
        : scoped.filter((module) => module.tags.includes(tag));

    const rows = listed.map((entry) => ({
      entry,
      refs: inboundRefs(ws, entry.path),
      bytes: Buffer.byteLength(entry.code, 'utf8'),
    }));
    if (args.sort === 'size') {
      rows.sort((a, b) => b.bytes - a.bytes || comparePath(a.entry, b.entry));
    } else if (args.sort === 'refs') {
      rows.sort((a, b) => b.refs - a.refs || comparePath(a.entry, b.entry));
    } else {
      rows.sort((a, b) => comparePath(a.entry, b.entry));
    }

    const page = paginate(rows, args.limit, args.offset);
    const lines = [headerLine(ws, listed)];
    if (page.items.length === 0) {
      lines.push(
        'No modules match this filter. Drop the tag or widen the path filter (plain wc_map lists everything).',
      );
    }
    for (const row of page.items) {
      lines.push(formatRow(ws, row, args.sort, args.detail));
    }
    if (page.footer !== undefined) lines.push(page.footer);

    const first = page.items[0];
    const next =
      first !== undefined
        ? [`wc_outline ${first.entry.path}`, 'wc_findings']
        : ['wc_map', 'wc_findings'];
    return Promise.resolve(
      textResult(lines.join('\n'), {
        budget: ctx.config.outputBudget,
        next,
      }),
    );
  },
});

function comparePath(a: ModuleEntry, b: ModuleEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Inbound refs to a module = sum of `refCount` over its symbols. */
function inboundRefs(ws: Workspace, path: string): number {
  let total = 0;
  for (const symbol of ws.index.symbols) {
    if (symbol.module === path) total += symbol.refCount;
  }
  return total;
}

function lineCount(entry: ModuleEntry): number {
  return entry.code.split('\n').length;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function exportCount(ws: Workspace, path: string): number {
  return ws.index.symbols.filter(
    (symbol) => symbol.module === path && symbol.exported,
  ).length;
}

function importCount(ws: Workspace, path: string): number {
  return ws.index.imports[path]?.length ?? 0;
}

/** Totals plus per-tag counts over the filtered selection. */
function headerLine(ws: Workspace, listed: ModuleEntry[]): string {
  const lines = listed.reduce((total, entry) => total + lineCount(entry), 0);
  const bytes = listed.reduce(
    (total, entry) => total + Buffer.byteLength(entry.code, 'utf8'),
    0,
  );
  const counts = TAG_ORDER.map((tag) => ({
    tag,
    count: listed.filter((entry) => entry.tags.includes(tag)).length,
  })).filter(({ count }) => count > 0);
  const head =
    `Workspace ${ws.id} · ${listed.length} module${listed.length === 1 ? '' : 's'}` +
    ` · ${lines} lines · ${kb(bytes)}`;
  return counts.length > 0
    ? `${head}\nTags: ${counts.map(({ tag, count }) => `${tag}(${count})`).join(' · ')}`
    : head;
}

function formatRow(
  ws: Workspace,
  row: { entry: ModuleEntry; refs: number; bytes: number },
  sort: 'path' | 'size' | 'refs',
  detail: 'concise' | 'full',
): string {
  const { entry, refs, bytes } = row;
  const tags = entry.tags.length > 0 ? entry.tags.join(', ') : 'untagged';
  let line =
    `${entry.path} · ${lineCount(entry)} lines · ${kb(bytes)}` +
    ` · exports ${exportCount(ws, entry.path)}` +
    ` · imports ${importCount(ws, entry.path)}` +
    ` · ${tags}`;
  if (entry.isEntry) line += ' · entry';
  if (sort === 'refs') line += ` · ${refs} ref${refs === 1 ? '' : 's'}`;
  if (detail === 'full') {
    const names = ws.index.symbols
      .filter((symbol) => symbol.module === entry.path && symbol.exported)
      .map((symbol) => symbol.name);
    // Exported names come from the bundle (untrusted data), so they go in
    // a fenced block, never bare in the prose.
    if (names.length > 0) {
      line += `\n\`\`\`exports ${entry.path}\n${names.join('\n')}\n\`\`\``;
    }
  }
  return line;
}
