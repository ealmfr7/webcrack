import { z } from 'zod';
import { paginate, textResult } from '../format/response';
import { resolveModule } from '../format/target';
import { findAnnotation } from '../workspace/annotations';
import type { Annotation, SymbolEntry } from '../workspace/types';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

function annotationSuffix(annotation: Annotation, currentName: string): string {
  const parts: string[] = [];
  if (annotation.originalName && annotation.originalName !== currentName) {
    parts.push(`originally ${annotation.originalName}`);
  } else if (annotation.rename) {
    parts.push(`renamed to ${annotation.rename}`);
  }
  if (annotation.note) parts.push(`note: ${annotation.note}`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/** `sign from src/sign.js`, or `s (sign from src/sign.js)` when aliased. */
function describeImport(symbol: SymbolEntry): string {
  const imported = symbol.importedName ?? symbol.name;
  const from = symbol.from ?? '?';
  return imported === symbol.name
    ? `${symbol.name} from ${from}`
    : `${symbol.name} (${imported} from ${from})`;
}

function formatSymbol(
  symbol: SymbolEntry,
  annotation: Annotation | undefined,
): string {
  const range =
    symbol.line === symbol.endLine
      ? `${symbol.line}`
      : `${symbol.line}-${symbol.endLine}`;
  let head: string;
  if (symbol.kind === 'import') {
    head = `${range} import ${describeImport(symbol)}`;
  } else if (
    symbol.kind === 'function' ||
    symbol.kind === 'method' ||
    symbol.kind === 'class'
  ) {
    head = `${range} ${symbol.kind} ${symbol.name}(${(symbol.params ?? []).join(', ')})`;
  } else {
    head = `${range} variable ${symbol.name}`;
  }
  const exported = symbol.exported ? ' [exported]' : '';
  const suffix = annotation ? annotationSuffix(annotation, symbol.name) : '';
  return `${head}${exported} · refs: ${symbol.refCount}${suffix}`;
}

export const outline = defineTool({
  name: 'wc_outline',
  title: 'Module outline',
  description:
    'List the symbols of one module (functions, classes, methods, top-level variables, imports, exports) with line numbers, parameters and reference counts. Cheaper than reading the whole module.',
  inputSchema: {
    workspace: workspaceArg,
    module: z.string().describe('Module path from wc_map, e.g. src/api.js.'),
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe(
        'concise groups imports on one line; full lists every symbol separately.',
      ),
    includeNested: z
      .boolean()
      .default(false)
      .describe('Include definitions inside nested functions and methods.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const entry = resolveModule(ws, args.module);
    const detail = args.detail ?? 'concise';
    const limit = args.limit ?? 30;
    const offset = args.offset ?? 0;
    const allSymbols = ws.index.symbols.filter((s) => s.module === entry.path);
    const symbols = args.includeNested
      ? allSymbols
      : allSymbols.filter((s) => (s.scopeDepth ?? 0) <= 1);
    const page = paginate(symbols, limit, offset);
    const annotated = (s: SymbolEntry) =>
      findAnnotation(ws.annotations, s.module, s.name);

    const lines: string[] = [];
    if (detail === 'full') {
      for (const symbol of page.items) {
        lines.push(formatSymbol(symbol, annotated(symbol)));
      }
    } else {
      // Concise: plain imports collapse to one line. Imports carrying an
      // annotation stay individual so their rename/note still shows.
      const plain = page.items.filter(
        (s) => s.kind === 'import' && !annotated(s),
      );
      let grouped = false;
      for (const symbol of page.items) {
        if (symbol.kind === 'import' && !annotated(symbol)) {
          if (!grouped) {
            grouped = true;
            const items = plain.map(describeImport).join(', ');
            lines.push(`${plain[0].line} imports (${plain.length}): ${items}`);
          }
          continue;
        }
        lines.push(formatSymbol(symbol, annotated(symbol)));
      }
    }

    const plural = symbols.length === 1 ? 'symbol' : 'symbols';
    let body = `${entry.path} · ${symbols.length} ${plural} (${detail})`;
    if (lines.length > 0) body += `\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    else body += '\nNo symbols at this depth in this module.';
    if (!args.includeNested && allSymbols.length > symbols.length) {
      body += `\n${allSymbols.length - symbols.length} nested definitions hidden; use includeNested=true to list them.`;
    }
    if (page.footer) body += `\n${page.footer}`;

    const top = symbols.find((s) => s.kind !== 'import') ?? symbols[0];
    const next = top
      ? [`wc_read ${entry.path}:${top.name}`]
      : [`wc_read ${entry.path}`];
    return Promise.resolve(
      textResult(body, { budget: ctx.config.outputBudget, next }),
    );
  },
});
