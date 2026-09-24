import type { ModuleEntry, ModuleIndex, ModuleTag } from './types';

/**
 * Heuristic module tags (M1.4: `network`, `auth`, `crypto`, `storage`,
 * `dom`, `vm`, `vendor`) from the module's index slice (calls, strings).
 * Returns `[]` until M1.4 fills in the heuristics.
 */
export function tagModule(
  module: ModuleEntry,
  index: ModuleIndex,
): ModuleTag[] {
  void module;
  void index;
  return [];
}
