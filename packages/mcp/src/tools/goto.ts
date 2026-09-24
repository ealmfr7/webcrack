import { z } from 'zod';
import { numberLines, textResult } from '../format/response';
import { resolveSymbol } from '../format/target';
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
    const symbol = resolveSymbol(
      ws,
      args.symbol,
      args.from as Location | undefined,
    );
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
