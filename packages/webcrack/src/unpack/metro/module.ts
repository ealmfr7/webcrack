import type * as t from '@babel/types';
import { Module } from '../module';

export class MetroModule extends Module {
  dependencies: (number | string)[];
  verboseName?: string;

  constructor(
    id: string,
    ast: t.File,
    isEntry: boolean,
    dependencies: (number | string)[],
    verboseName?: string,
  ) {
    super(id, ast, isEntry);
    this.dependencies = dependencies;
    this.verboseName = verboseName;
  }
}
