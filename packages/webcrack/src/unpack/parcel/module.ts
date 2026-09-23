import type * as t from '@babel/types';
import { Module } from '../module';

export class ParcelModule extends Module {
  /**
   * Parcel 1 specifier -> module id (e.g. `{ './utils/add': 'dep1' }`).
   * Empty for Parcel 2 modules, whose `parcelRequire` calls reference
   * module ids directly.
   */
  dependencies: Record<string, string>;

  constructor(
    id: string,
    ast: t.File,
    isEntry: boolean,
    dependencies: Record<string, string> = {},
  ) {
    super(id, ast, isEntry);
    this.dependencies = dependencies;
  }
}
