import type { GeneratorOptions, GeneratorResult } from '@babel/generator';
import babelGenerate from '@babel/generator';
import type * as t from '@babel/types';

const defaultOptions: GeneratorOptions = { jsescOption: { minimal: true } };

export function generate(
  ast: t.Node,
  options: GeneratorOptions = defaultOptions,
): string {
  return babelGenerate(ast, options).code;
}

export interface GenerateWithMapOptions {
  sourceFileName: string;
  sourceContent?: string;
}

export type GeneratedWithMap = {
  code: string;
  map: NonNullable<GeneratorResult['map']>;
};

/**
 * Like {@link generate}, but also emits a version 3 source map that maps
 * generated positions back to the original input positions carried by the
 * AST nodes' `loc` fields. Parse the input with locations enabled (the
 * default for `@babel/parser`) and keep `loc` intact for the mapping to
 * resolve.
 */
export function generateWithMap(
  ast: t.Node,
  { sourceFileName, sourceContent }: GenerateWithMapOptions,
): GeneratedWithMap {
  const { code, map } = babelGenerate(
    ast,
    { ...defaultOptions, sourceMaps: true, sourceFileName },
    sourceContent,
  );
  if (map === null) {
    throw new Error('generateWithMap: expected a source map to be generated');
  }
  return { code, map };
}

export function codePreview(node: t.Node): string {
  const code = generate(node, {
    minified: true,
    shouldPrintComment: () => false,
    ...defaultOptions,
  });
  if (code.length > 100) {
    return code.slice(0, 70) + ' … ' + code.slice(-30);
  }
  return code;
}
