import { notImplemented } from '../format/errors';
import type { SearchHit, Workspace } from './types';

/**
 * AST-pattern search (M2.5): match a JS pattern with `$X` / `$$ARGS`
 * wildcards (ast-grep style) against the workspace modules (or one module).
 * Implemented on Babel; `search.ts` delegates `kind=ast` here.
 */
export function searchAst(
  ws: Workspace,
  pattern: string,
  module?: string,
): SearchHit[] {
  void ws;
  void pattern;
  void module;
  return notImplemented('M2.5');
}
