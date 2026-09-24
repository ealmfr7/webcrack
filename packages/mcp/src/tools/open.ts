import { z } from 'zod';
import { textResult } from '../format/response';
import {
  ALL_FINDING_CATEGORIES,
  summarizeFindings,
  type FindingCategory,
} from '../workspace/findings';
import { detectTechniques } from '../workspace/techniques';
import type { ModuleTag, Workspace } from '../workspace/types';
import { defineTool } from './define';

/** Canonical tag order (same as `wc_map`). */
const TAG_ORDER: ModuleTag[] = [
  'network',
  'auth',
  'crypto',
  'storage',
  'dom',
  'vm',
  'vendor',
];

export const open = defineTool({
  name: 'wc_open',
  title: 'Open bundle',
  description:
    'Load a JavaScript file, URL or code snippet: deobfuscates, unpacks bundles (webpack, browserify, esbuild, rollup, parcel, metro, turbopack) and indexes everything once. Returns an overview (bundler, modules, obfuscation techniques, findings count, where to start) and a workspace id. Call this first; results are cached, so reopening the same input is instant.',
  inputSchema: {
    source: z
      .string()
      .describe('File path, http(s) URL, or the JavaScript code itself.'),
    options: z
      .object({
        unpack: z.boolean().optional(),
        deobfuscate: z.boolean().optional(),
        unminify: z.boolean().optional(),
        jsx: z.boolean().optional(),
        mangle: z.boolean().optional(),
        renameHeuristics: z.boolean().optional(),
      })
      .optional()
      .describe('webcrack options; defaults are fine for almost everything.'),
    refresh: z
      .boolean()
      .default(false)
      .describe('Ignore the cache and process the input again.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const { workspace, cached } = await ctx.store.open(
      args.source,
      { ...args.options, refresh: args.refresh },
      ctx.progress,
    );
    // The store leaves `techniques` empty (persisting them to the cache is
    // a later follow-up); compute them in memory for the overview instead.
    if (workspace.stats.techniques.length === 0) {
      workspace.stats.techniques = detectTechniques(
        workspace.original,
        [...workspace.modules.values()].map((module) => module.code),
        workspace.interpreters,
      );
    }
    const { counts } = summarizeFindings(workspace);
    const lines = [
      headline(workspace, cached),
      obfuscationLine(workspace),
      ...entryLines(workspace),
      findingsLine(counts),
      ...topModulesLines(workspace),
    ];
    return textResult(lines.join('\n'), {
      budget: ctx.config.outputBudget,
      next: nextSteps(counts),
    });
  },
});

export const workspaces = defineTool({
  name: 'wc_workspaces',
  title: 'List workspaces',
  description:
    'List opened and cached workspaces (id, source, bundler, module count). The current workspace is marked; cached workspaces reopen instantly with wc_open.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const opened = ctx.store.list();
    let current: string | undefined;
    try {
      current = ctx.store.get().id;
    } catch {
      current = undefined;
    }
    const cached = await ctx.store.listCached();
    const openedIds = new Set(opened.map((workspace) => workspace.id));
    const unopened = cached.filter((summary) => !openedIds.has(summary.id));

    if (opened.length === 0 && unopened.length === 0) {
      return textResult(
        'No workspaces open yet. Open one first with wc_open (a file path, URL or literal code).',
        { budget: ctx.config.outputBudget, next: ['wc_open'] },
      );
    }

    const lines = [
      `Workspaces: ${opened.length} open · ${cached.length} cached`,
    ];
    for (const workspace of opened) {
      const bundle = workspace.bundle?.type ?? 'script';
      const marker = workspace.id === current ? '*' : ' ';
      const currentMark = workspace.id === current ? ' (current)' : '';
      // The label comes from the bundle/input (untrusted data), so it is
      // quoted, never bare in the prose.
      lines.push(
        `${marker} ${workspace.id} · ${bundle} · ${pluralModules(workspace.modules.size)} · ${JSON.stringify(workspace.source.label)}${currentMark}`,
      );
    }
    if (unopened.length > 0) {
      lines.push('Cached:');
      for (const summary of unopened) {
        lines.push(
          `  ${summary.id} · ${summary.bundleType ?? 'script'} · ${pluralModules(summary.moduleCount)} · ${JSON.stringify(summary.label)} · cached ${summary.openedAt}`,
        );
      }
    }
    const label = unopened[0]?.label ?? opened[0]?.source.label;
    return textResult(lines.join('\n'), {
      budget: ctx.config.outputBudget,
      next:
        label === undefined
          ? ['wc_open']
          : [`wc_open ${JSON.stringify(label)}`],
    });
  },
});

function pluralModules(count: number): string {
  return `${count} module${count === 1 ? '' : 's'}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function headline(workspace: Workspace, cached: boolean): string {
  const bundle = workspace.bundle?.type ?? 'script';
  const clean = [...workspace.modules.values()].reduce(
    (total, module) => total + Buffer.byteLength(module.code, 'utf8'),
    0,
  );
  const seconds = (workspace.stats.openMs / 1000).toFixed(1);
  return (
    `Workspace ${workspace.id} · ${bundle} · ${pluralModules(workspace.modules.size)}` +
    ` · ${formatSize(workspace.source.bytes)} → ${formatSize(clean)} clean` +
    ` · ${seconds} s${cached ? ' (cached)' : ''}`
  );
}

function obfuscationLine(workspace: Workspace): string {
  const techniques = workspace.stats.techniques;
  return `Obfuscation: ${techniques.length > 0 ? techniques.join(', ') : 'none detected'}`;
}

function entryLines(workspace: Workspace): string[] {
  const modules = [...workspace.modules.values()];
  const entry = modules.find((module) => module.isEntry) ?? modules[0];
  return entry === undefined ? [] : [`Entry: ${entry.path}`];
}

/** Singular form for the `Findings:` counts line. */
function categoryName(category: FindingCategory, count: number): string {
  if (category === 'vm') {
    return count === 1 ? 'VM interpreter' : 'VM interpreters';
  }
  if (count !== 1) return category;
  switch (category) {
    case 'endpoints':
      return 'endpoint';
    case 'urls':
      return 'url';
    case 'secrets':
      return 'secret';
    case 'regexes':
      return 'regex';
    case 'sinks':
      return 'sink';
    default:
      return category;
  }
}

function findingsLine(counts: Record<FindingCategory, number>): string {
  const parts = ALL_FINDING_CATEGORIES.filter(
    (category) => counts[category] > 0,
  ).map(
    (category) =>
      `${counts[category]} ${categoryName(category, counts[category])}`,
  );
  return `Findings: ${parts.length > 0 ? parts.join(' · ') : 'none'}`;
}

function callsIn(workspace: Workspace, path: string): number {
  return workspace.index.calls.filter((call) => call.module === path).length;
}

/** Up to 3 tagged modules, most call sites first, then largest. */
function topForTag(workspace: Workspace, tag: ModuleTag): string[] {
  const modules = [...workspace.modules.values()].filter((module) =>
    module.tags.includes(tag),
  );
  modules.sort((a, b) => {
    const calls = callsIn(workspace, b.path) - callsIn(workspace, a.path);
    if (calls !== 0) return calls;
    return (
      Buffer.byteLength(b.code, 'utf8') - Buffer.byteLength(a.code, 'utf8')
    );
  });
  return modules.slice(0, 3).map((module) => {
    const calls = callsIn(workspace, module.path);
    return calls > 0
      ? `${module.path} (${calls} call${calls === 1 ? '' : 's'})`
      : module.path;
  });
}

function topModulesLines(workspace: Workspace): string[] {
  const present = TAG_ORDER.filter((tag) =>
    [...workspace.modules.values()].some((module) => module.tags.includes(tag)),
  );
  if (present.length === 0) return [];
  const width = Math.max(...present.map((tag) => tag.length));
  return [
    'Top modules by tag:',
    ...present.map(
      (tag) =>
        `  ${tag.padEnd(width)}  ${topForTag(workspace, tag).join(' · ')}`,
    ),
  ];
}

/** The categories with the most findings first. */
function nextSteps(counts: Record<FindingCategory, number>): string[] {
  const ranked = ALL_FINDING_CATEGORIES.filter(
    (category) => counts[category] > 0,
  ).sort((a, b) => counts[b] - counts[a]);
  return ranked.length > 0
    ? [`wc_findings category=${ranked[0]}`, 'wc_map', 'wc_search']
    : ['wc_map', 'wc_search', 'wc_findings'];
}
