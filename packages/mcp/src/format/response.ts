import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WcError } from './errors';

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  /** Footer telling the agent how to get the next page, if any. */
  footer: string | undefined;
}

export function paginate<T>(
  items: T[],
  limit: number,
  offset: number,
): Page<T> {
  const page = items.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    items: page,
    total: items.length,
    offset,
    footer:
      end < items.length
        ? `Showing ${offset + 1}-${end} of ${items.length}. More: offset=${end}`
        : undefined,
  };
}

/** Prefix each line with its 1-based number: `  120 │ code`. */
export function numberLines(code: string, startLine = 1): string {
  const lines = code.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} │ ${line}`)
    .join('\n');
}

/**
 * Build a text tool result. Output over `budget` characters is cut at a line
 * boundary with a note on how to narrow the request.
 */
export function textResult(
  body: string,
  options: { next?: string[]; budget: number },
): CallToolResult {
  let text = body;
  if (text.length > options.budget) {
    const cut = text.lastIndexOf('\n', options.budget);
    const kept = text.slice(0, cut > 0 ? cut : options.budget);
    const omitted = text.length - kept.length;
    text = `${kept}\n… truncated (${omitted} more chars). Narrow the request: use offset/limit, a module filter or a smaller line range.`;
  }
  if (options.next?.length) text += `\nNext: ${options.next.join(' · ')}`;
  return { content: [{ type: 'text', text }] };
}

export function errorResult(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof WcError) {
    text = error.message;
    if (error.suggestions.length > 0) {
      text += `\nDid you mean: ${error.suggestions.join(', ')}?`;
    }
  } else {
    text = `Internal error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { content: [{ type: 'text', text }], isError: true };
}
