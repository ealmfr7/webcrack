import { z } from 'zod';
import { matchModules } from '../format/target';
import { paginate, textResult } from '../format/response';
import {
  ALL_FINDING_CATEGORIES,
  collectFindings,
  maskSecret,
  summarizeFindings,
  type Finding,
} from '../workspace/findings';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const findings = defineTool({
  name: 'wc_findings',
  title: 'Security findings',
  description:
    'Precomputed intel with module:line locations. category: summary (counts + top items), endpoints (HTTP calls with method/URL), urls, secrets (API keys/tokens, masked unless reveal=true), regexes, interesting (emails, IPs, paths), sinks (eval, innerHTML, postMessage…), storage (localStorage, cookies, indexedDB), crypto (WebCrypto, hash/cipher constants), vm (VM interpreter loops).',
  inputSchema: {
    workspace: workspaceArg,
    category: z
      .enum([
        'summary',
        'endpoints',
        'urls',
        'secrets',
        'regexes',
        'interesting',
        'sinks',
        'storage',
        'crypto',
        'vm',
      ])
      .default('summary'),
    module: z.string().optional(),
    reveal: z.boolean().default(false).describe('Show secrets unmasked.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    if (args.category === 'summary') {
      const { counts, top } = summarizeFindings(ws);
      const shown = args.reveal ? top : top.map(maskTopSecrets);
      const lines = [
        `Findings summary (workspace ${ws.id}, ${ws.modules.size} modules):`,
        ALL_FINDING_CATEGORIES.map((c) => `${c}: ${counts[c]}`).join(' · '),
        ...shown.map((f) => formatFinding(f)),
      ];
      const next = nextSteps(shown);
      return Promise.resolve(
        textResult(lines.join('\n'), {
          budget: ctx.config.outputBudget,
          next,
        }),
      );
    }
    const modules = matchModules(ws, args.module);
    const all = collectFindings(ws, args.category, modules);
    const shown = args.reveal ? all : all.map(maskFindingSecrets);
    const page = paginate(shown, args.limit, args.offset);
    const lines = [
      `${args.category}: ${all.length} finding${all.length === 1 ? '' : 's'} (workspace ${ws.id})`,
      ...page.items.map((f) => formatFinding(f)),
    ];
    if (page.footer) lines.push(page.footer);
    return Promise.resolve(
      textResult(lines.join('\n'), {
        budget: ctx.config.outputBudget,
        next: nextSteps(page.items),
      }),
    );
  },
});

function maskFindingSecrets(finding: Finding): Finding {
  if (finding.category !== 'secrets' || finding.value === undefined) {
    return finding;
  }
  return { ...finding, value: maskSecret(finding.value) };
}

const maskTopSecrets = maskFindingSecrets;

/** One line `module:line  title  value`; bundle strings are quoted. */
function formatFinding(finding: Finding): string {
  const where = `${finding.module}:${finding.line}`;
  const value =
    finding.value === undefined ? '' : `  ${quoteValue(finding.value)}`;
  return `${where}  ${finding.title}${value}`;
}

/**
 * Untrusted bundle strings stay data: single-line values are quoted inline,
 * anything with a backtick or newline goes in a fenced block.
 */
function quoteValue(value: string): string {
  if (!value.includes('`') && !value.includes('\n')) return `\`${value}\``;
  const fence = value.includes('```') ? '````' : '```';
  return `\n${fence}\n${value}\n${fence}`;
}

function nextSteps(items: Finding[]): string[] {
  if (items.length === 0) return ['wc_map'];
  const first = items[0];
  return [`wc_read ${first.module}:${first.line}`];
}
