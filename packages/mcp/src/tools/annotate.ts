import { z } from 'zod';
import { WcError } from '../format/errors';
import { textResult } from '../format/response';
import { resolveModule, resolveSymbol } from '../format/target';
import { findAnnotation, renameSymbol } from '../workspace/annotations';
import type { Location, SymbolEntry, Workspace } from '../workspace/types';
import { defineTool, workspaceArg } from './define';

/**
 * Resolve `spec` to its symbol, following renames: when the index no
 * longer has the name (it was renamed), an annotation matching it as an
 * old name (`originalName` or a previous `rename`) points at the current
 * key, which resolves instead. Anything else rethrows the original error.
 */
function resolveCurrentSymbol(
  ws: Workspace,
  spec: string,
  from: Location | undefined,
): SymbolEntry {
  try {
    return resolveSymbol(ws, spec, from);
  } catch (error) {
    if (!(error instanceof WcError) || from !== undefined) throw error;
    const colon = spec.lastIndexOf(':');
    if (colon !== -1) {
      const entry = resolveModule(ws, spec.slice(0, colon).trim());
      const name = spec.slice(colon + 1).trim();
      const annotation = findAnnotation(ws.annotations, entry.path, name);
      if (annotation !== undefined) {
        return resolveSymbol(ws, annotation.symbol);
      }
    } else {
      const oldName = spec.trim();
      const matches = ws.annotations.filter(
        (annotation) =>
          annotation.originalName === oldName || annotation.rename === oldName,
      );
      if (matches.length === 1) {
        return resolveSymbol(ws, matches[0].symbol);
      }
    }
    throw error;
  }
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
    const symbol = resolveCurrentSymbol(
      ws,
      args.symbol,
      args.from as Location | undefined,
    );
    const key = `${symbol.module}:${symbol.name}`;
    const lines: string[] = [];
    let readName = symbol.name;
    let newKey = key;

    let changed: string[] = [];
    if (args.name !== undefined) {
      const renamed = renameSymbol(ws, symbol, args.name);
      changed = renamed.changed;
      newKey = `${symbol.module}:${args.name}`;
      const perModule = changed
        .map(
          (module) =>
            `${renamed.sites} site${renamed.sites === 1 ? '' : 's'} in ${module}`,
        )
        .join(', ');
      lines.push(`Renamed ${key} → ${args.name} (${perModule}).`);
      readName = args.name;
    }

    // One entry per binding: a rename re-keys the existing entry to the
    // new name (keeping the very first name in `originalName`), so a later
    // note on the new name updates the same entry.
    const existing = findAnnotation(ws.annotations, symbol.module, symbol.name);
    if (existing) {
      if (args.name !== undefined) {
        if (existing.originalName === undefined) {
          const colon = existing.symbol.lastIndexOf(':');
          existing.originalName = existing.symbol.slice(colon + 1);
        }
        existing.symbol = newKey;
        existing.rename = args.name;
      }
      if (args.note !== undefined) existing.note = args.note;
    } else {
      ws.annotations.push({
        symbol: newKey,
        ...(args.name === undefined
          ? {}
          : { rename: args.name, originalName: symbol.name }),
        ...(args.note === undefined ? {} : { note: args.note }),
      });
    }
    if (args.note !== undefined) {
      lines.push(`Note recorded on ${newKey}: ${args.note}`);
    }

    await ctx.store.commit(ws, changed);
    return textResult(lines.join('\n'), {
      budget: ctx.config.outputBudget,
      next: [`wc_read ${symbol.module}:${readName}`],
    });
  },
});
