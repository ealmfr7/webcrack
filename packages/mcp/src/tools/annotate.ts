import { z } from 'zod';
import { WcError } from '../format/errors';
import { textResult } from '../format/response';
import { resolveSymbol } from '../format/target';
import { renameSymbol } from '../workspace/annotations';
import type { Location } from '../workspace/types';
import { defineTool, workspaceArg } from './define';

/** Added occurrences of `name` in `code` (word match, so `sign` skips `assign`). */
function countOccurrences(code: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return code.match(new RegExp(`\\b${escaped}\\b`, 'g'))?.length ?? 0;
}

export const annotate = defineTool({
  name: 'wc_annotate',
  title: 'Rename / annotate',
  description:
    'Record what you understood: rename a symbol (scope-aware, applied everywhere) and/or attach a note. Renames and notes persist across sessions and show up in wc_read, wc_outline and wc_export.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('module:name of the binding.'),
    name: z.string().optional().describe('New name.'),
    note: z.string().optional(),
    from: z
      .string()
      .optional()
      .describe('module:line where the name is used, to resolve it exactly.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    if (args.name === undefined && args.note === undefined) {
      throw new WcError(
        'Nothing to record: pass at least one of "name" (rename the symbol) or "note" (attach a note).',
      );
    }
    const ws = ctx.store.get(args.workspace);
    const symbol = resolveSymbol(
      ws,
      args.symbol,
      args.from as Location | undefined,
    );
    const key = `${symbol.module}:${symbol.name}`;
    const lines: string[] = [];
    let readName = symbol.name;

    let changed: string[] = [];
    if (args.name !== undefined) {
      const before = ws.modules.get(symbol.module)?.code ?? '';
      changed = renameSymbol(ws, symbol, args.name);
      const after = ws.modules.get(symbol.module)?.code ?? '';
      const sites =
        countOccurrences(after, args.name) -
        countOccurrences(before, args.name);
      const perModule = changed
        .map((module) => `${sites} site${sites === 1 ? '' : 's'} in ${module}`)
        .join(', ');
      lines.push(`Renamed ${key} → ${args.name} (${perModule}).`);
      readName = args.name;
    }

    const existing = ws.annotations.find(
      (annotation) => annotation.symbol === key,
    );
    if (existing) {
      if (args.name !== undefined) existing.rename = args.name;
      if (args.note !== undefined) existing.note = args.note;
    } else {
      ws.annotations.push({
        symbol: key,
        ...(args.name === undefined ? {} : { rename: args.name }),
        ...(args.note === undefined ? {} : { note: args.note }),
      });
    }
    if (args.note !== undefined) {
      lines.push(`Note recorded on ${key}: ${args.note}`);
    }

    await ctx.store.commit(ws, changed);
    return textResult(lines.join('\n'), {
      budget: ctx.config.outputBudget,
      next: [`wc_read ${symbol.module}:${readName}`],
    });
  },
});
