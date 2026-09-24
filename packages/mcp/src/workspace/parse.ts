import { parse, type ParserOptions } from '@babel/parser';
import type { File } from '@babel/types';

/**
 * Parse a module's clean code. webcrack prints JavaScript, except that its
 * `tsEnum` transform restores TypeScript `enum` declarations, which a
 * JavaScript parse rejects ("Unexpected token"): whole bundles written in
 * TypeScript then failed to open. Parse as JavaScript first — the
 * TypeScript grammar reads some JavaScript differently (`a < b > (c)` is a
 * generic call there) — and only on a syntax error retry with the
 * `typescript` plugin added. The first error is rethrown if both fail.
 */
export function parseClean(code: string, options: ParserOptions): File {
  try {
    return parse(code, options);
  } catch (error) {
    try {
      return parse(code, {
        ...options,
        plugins: [...(options.plugins ?? []), 'typescript'],
      });
    } catch {
      throw error;
    }
  }
}
