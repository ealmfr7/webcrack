import type * as t from '@babel/types';
import { Module } from '../module';

export class RollupModule extends Module {
  /**
   * Chunk specifiers this module loads: static `import` / `export ... from`
   * sources plus dynamic `import()` targets (including ones wrapped in
   * `__vitePreload(...)`). Multi-chunk resolution is a later task, so these
   * stay raw specifier strings.
   */
  dependencies: string[];

  constructor(
    id: string,
    ast: t.File,
    isEntry: boolean,
    dependencies: string[] = [],
  ) {
    super(id, ast, isEntry);
    this.dependencies = dependencies;
  }
}
