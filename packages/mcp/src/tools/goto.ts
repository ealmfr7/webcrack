import { z } from 'zod';
import { WcError } from '../format/errors';
import { numberLines, textResult } from '../format/response';
import { resolveSymbol } from '../format/target';
import { approximateSymbolMatches } from '../workspace/approximate';
import type { Location } from '../workspace/types';
import { defineTool, readOnly, workspaceArg } from './define';

export const goto = defineTool({
  name: 'wc_goto',
  title: 'Go to definition',
  description:
    'Jump to the definition of a symbol: location, signature and first lines. Pass `from` (module:line where the name is used) to resolve it through scopes and imports exactly.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('Name or module:name.'),
    from: z.string().optional().describe('module:line where the name appears.'),
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    let selected;
    try {
      selected = resolveSymbol(
        ws,
        args.symbol,
        args.from as Location | undefined,
      );
    } catch (error) {
      if (
        !(error instanceof WcError) ||
        !error.message.startsWith('Unknown symbol')
      )
        throw error;
      const matches = approximateSymbolMatches(ws, args.symbol);
      if (matches.length === 0) throw error;
      const body = [
        `Approximate matches for ${JSON.stringify(args.symbol)} (not a resolved definition):`,
        ...matches.map((m) => `${m.module}:${m.line}  ${m.kind}  ${m.code}`),
      ].join('\n');
      return Promise.resolve(
        textResult(body, {
          budget: ctx.config.outputBudget,
          next: [`wc_read ${matches[0].module}:${matches[0].line}`],
        }),
      );
    }
    let symbol = selected;
    if (selected.aliasOf !== undefined) {
      try {
        symbol = resolveSymbol(
          ws,
          selected.aliasOf,
          `${selected.module}:${selected.line}`,
        );
      } catch {
        // Keep the assignment as the best known definition.
      }
    }
    const entry = ws.modules.get(symbol.module);
    const params =
      symbol.params !== undefined ? `(${symbol.params.join(', ')})` : '';
    const signature = `${symbol.kind} ${symbol.name}${params}`;
    const refs = symbol.refCount === 1 ? '1 ref' : `${symbol.refCount} refs`;
    const header =
      `${symbol.module}:${symbol.line} · ${signature} · ` +
      `${symbol.exported ? 'exported' : 'not exported'} · ${refs}`;
    const lines = entry?.code.split('\n') ?? [];
    const snippet = lines.slice(symbol.line - 1, symbol.line + 7).join('\n');
    const body =
      snippet.length > 0
        ? `${header}\n\`\`\`js\n${numberLines(snippet, symbol.line)}\n\`\`\``
        : header;
    return Promise.resolve(
      textResult(body, {
        budget: ctx.config.outputBudget,
        next: [
          `wc_read ${symbol.module}:${symbol.name}`,
          `wc_refs ${symbol.module}:${symbol.name}`,
        ],
      }),
    );
  },
});
