import { z } from 'zod';
import { WcError } from '../format/errors';
import { numberLines, textResult } from '../format/response';
import { parseTarget, resolveTarget } from '../format/target';
import type { SymbolEntry, Workspace } from '../workspace/types';
import { defineTool, readOnly, workspaceArg } from './define';

/** Displayed raw lines longer than this are cut (minified originals). */
const MAX_RAW_LINE = 400;

function signatureOf(symbol: SymbolEntry): string {
  if (
    symbol.kind === 'function' ||
    symbol.kind === 'method' ||
    symbol.kind === 'class'
  ) {
    return `${symbol.kind} ${symbol.name}(${(symbol.params ?? []).join(', ')})`;
  }
  if (symbol.kind === 'variable') return `variable ${symbol.name}`;
  const imported = symbol.importedName ?? symbol.name;
  const from = symbol.from ?? '?';
  return imported === symbol.name
    ? `import ${symbol.name} from ${from}`
    : `import ${symbol.name} (${imported} from ${from})`;
}

/**
 * Cut a raw line longer than 400 chars. With `column` (1-based), show a
 * 400-char window centered on it; otherwise show the first 400 chars.
 */
function cutLine(line: string, column?: number): string {
  if (line.length <= MAX_RAW_LINE) return line;
  if (column !== undefined) {
    const center = Math.max(0, Math.min(line.length - 1, column - 1));
    let start = Math.max(0, center - 200);
    const end = Math.min(line.length, start + MAX_RAW_LINE);
    start = Math.max(0, end - MAX_RAW_LINE);
    const shown = line.slice(start, end);
    const omitted = line.length - shown.length;
    const prefix = start > 0 ? '…' : '';
    const suffix = end < line.length ? '…' : '';
    return `${prefix}${shown}${suffix} (+${omitted} chars)`;
  }
  return `${line.slice(0, MAX_RAW_LINE)}… (+${line.length - MAX_RAW_LINE} chars)`;
}

/** Notes/renames on symbols overlapping the displayed range. */
function notesInRange(
  ws: Workspace,
  module: string,
  start: number,
  end: number,
): string[] {
  const notes: string[] = [];
  for (const annotation of ws.annotations) {
    const colon = annotation.symbol.lastIndexOf(':');
    if (colon === -1) continue;
    if (annotation.symbol.slice(0, colon) !== module) continue;
    const name = annotation.symbol.slice(colon + 1);
    const overlaps = ws.index.symbols.some(
      (s) =>
        s.module === module &&
        s.name === name &&
        s.line <= end &&
        s.endLine >= start,
    );
    if (!overlaps) continue;
    const parts: string[] = [];
    if (annotation.rename) parts.push(`renamed to ${annotation.rename}`);
    if (annotation.note) parts.push(annotation.note);
    if (parts.length > 0) notes.push(`Note on ${name}: ${parts.join(' · ')}`);
  }
  return notes;
}

function readClean(
  ws: Workspace,
  target: string,
  context: number,
  budget: number,
) {
  const resolved = resolveTarget(ws, target);
  const entry = ws.modules.get(resolved.module);
  if (!entry) {
    throw new WcError(
      `Unknown module "${resolved.module}". Call wc_map to list modules.`,
    );
  }
  const count = entry.code.split('\n').length;
  const parsed = parseTarget(target);
  let start: number;
  let end: number;
  if (resolved.symbol) {
    start = resolved.symbol.line;
    end = resolved.symbol.endLine;
  } else if (resolved.start === undefined || resolved.end === undefined) {
    start = 1;
    end = count;
  } else if (parsed.kind === 'line') {
    start = Math.max(1, resolved.start - context);
    end = Math.min(count, resolved.end + context);
  } else {
    start = resolved.start;
    end = resolved.end;
  }
  const code = entry.code
    .split('\n')
    .slice(start - 1, end)
    .join('\n');
  const signature = resolved.symbol ? ` · ${signatureOf(resolved.symbol)}` : '';
  let body =
    `${entry.path}:${start}-${end} (clean)${signature}\n` +
    `\`\`\`js\n${numberLines(code, start)}\n\`\`\``;
  for (const note of notesInRange(ws, entry.path, start, end)) {
    body += `\n${note}`;
  }
  if (resolved.symbol) {
    const n = resolved.symbol.refCount;
    body += `\nRefs: called/referenced from ${n} ${n === 1 ? 'place' : 'places'} (wc_refs ${resolved.symbol.module}:${resolved.symbol.name})`;
  }
  const next = resolved.symbol
    ? [`wc_refs ${resolved.symbol.module}:${resolved.symbol.name}`]
    : [`wc_outline ${entry.path}`];
  return textResult(body, { budget, next });
}

function parseRawTarget(target: string): {
  start: number;
  end: number;
  single: boolean;
} {
  const input = target.trim();
  const single = /^(\d+)$/.exec(input);
  if (single) {
    return { start: Number(single[1]), end: Number(single[1]), single: true };
  }
  const range = /^(?:raw:)?(\d+)-(\d+)$/.exec(input);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && start <= end) return { start, end, single: false };
  }
  throw new WcError(
    `Invalid raw target "${target}". In view=raw, target is a line in the original input: N (e.g. "10"), N-M (e.g. "10-14") or raw:N-M.`,
  );
}

function readRaw(
  ws: Workspace,
  target: string,
  context: number,
  column: number | undefined,
  budget: number,
) {
  const parsed = parseRawTarget(target);
  const original = ws.original.split('\n');
  const total = original.length;
  if (parsed.start < 1 || parsed.end > total) {
    throw new WcError(
      `Original input has ${total} line${total === 1 ? '' : 's'}; valid range 1-${total}.`,
    );
  }
  const start = parsed.single
    ? Math.max(1, parsed.start - context)
    : parsed.start;
  const end = parsed.single
    ? Math.min(total, parsed.end + context)
    : parsed.end;
  const code = original
    .slice(start - 1, end)
    .map((line) => cutLine(line, parsed.single ? column : undefined))
    .join('\n');
  const body =
    `original:${start}-${end} (raw)\n` +
    `\`\`\`js\n${numberLines(code, start)}\n\`\`\``;
  const next =
    end < total ? [`wc_read ${end + 1}-${total} view=raw`] : ['wc_map'];
  return textResult(body, { budget, next });
}

export const read = defineTool({
  name: 'wc_read',
  title: 'Read code',
  description:
    'Read code with line numbers. target: a module ("src/api.js"), a line ("src/api.js:120"), a range ("src/api.js:100-160"), a symbol ("src/api.js:login" or just "login"). view=clean (deobfuscated, default) or raw (original input lines: N, N-M or raw:N-M; column centers a window on long lines). Applies renames and shows notes from wc_annotate.',
  inputSchema: {
    workspace: workspaceArg,
    target: z.string(),
    view: z.enum(['clean', 'raw']).default('clean'),
    context: z
      .number()
      .int()
      .min(0)
      .max(200)
      .default(10)
      .describe('Extra lines around a single-line target.'),
    column: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Center a 400-char window on this 1-based column (raw view, single-line targets).',
      ),
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const target = String(args.target);
    const context = args.context ?? 10;
    if ((args.view ?? 'clean') === 'raw') {
      return Promise.resolve(
        readRaw(ws, target, context, args.column, ctx.config.outputBudget),
      );
    }
    return Promise.resolve(
      readClean(ws, target, context, ctx.config.outputBudget),
    );
  },
});
