import { generate } from '@babel/generator';
import { parse } from '@babel/parser';
import { expect, test } from 'vitest';
import { applyTransform } from '../../src/ast-utils';
import slicedToArray from '../../src/transpile/transforms/sliced-to-array';

// Remaining wave-2 stub: the task that implements this transform deletes
// this file, so stub owners never edit a shared file.
const SAMPLE = 'var x = [1, 2, 3];\nfunction f(a) { return a + x.length; }';

test('stub sliced-to-array leaves code unchanged', () => {
  const ast = parse(SAMPLE, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const { changes } = applyTransform(ast, slicedToArray);
  expect(changes).toBe(0);
  expect(generate(ast).code).toBe(generate(parse(SAMPLE)).code);
});
