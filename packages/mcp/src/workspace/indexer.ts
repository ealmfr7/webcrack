import { notImplemented } from '../format/errors';
import type { ModuleEntry, ModuleIndex, WorkspaceIndex } from './types';

/**
 * Index one module's clean code (M1.2): re-parse it and extract the
 * per-module slice (symbols, calls, strings, refs, imports).
 *
 * Refs to imported bindings stay unresolved here (no `defModule`/`defLine`
 * for the other module); `linkIndex` resolves them afterwards.
 */
export function indexModule(
  module: ModuleEntry,
  modulePaths: string[],
): ModuleIndex {
  void module;
  void modulePaths;
  return notImplemented('M1.2');
}

/**
 * Link per-module slices into a workspace-wide index (M1.2): resolve refs
 * to imported bindings to their exporting module (`defModule`/`defLine`)
 * and recompute `refCount` including cross-module refs.
 */
export function linkIndex(parts: Map<string, ModuleIndex>): WorkspaceIndex {
  void parts;
  return notImplemented('M1.2');
}

/**
 * Index every module, then link. Reindexing one module (M2.3, after a
 * rename) = `indexModule(changed)` + `linkIndex(all parts, with the
 * refreshed part swapped in)`.
 */
export function buildIndex(modules: Map<string, ModuleEntry>): WorkspaceIndex {
  void modules;
  return notImplemented('M1.2');
}
