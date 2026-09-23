import { parse } from '@babel/parser';
import { expect, test } from 'vitest';
import { applyTransform } from '../../ast-utils';
import { testTransform } from '../../../test';
import constantFolding from '../constant-folding';

const expectJS = testTransform(constantFolding);

test('fold string concatenation', () =>
  expectJS(`"a" + "b";`).toMatchInlineSnapshot(`"ab";`));

test('fold nested string concatenation', () =>
  expectJS(`"a" + "b" + "c";`).toMatchInlineSnapshot(`"abc";`));

test('fold numeric operations', () => {
  expectJS(`1 + 2 * 3;`).toMatchInlineSnapshot(`7;`);
  expectJS(`0x1f ^ 0x3;`).toMatchInlineSnapshot(`28;`);
  expectJS(`1 << 4;`).toMatchInlineSnapshot(`16;`);
  expectJS(`2 ** 10;`).toMatchInlineSnapshot(`1024;`);
  expectJS(`7 % 3;`).toMatchInlineSnapshot(`1;`);
});

test('fold bitwise operations', () => {
  expectJS(`5 & 3;`).toMatchInlineSnapshot(`1;`);
  expectJS(`5 | 2;`).toMatchInlineSnapshot(`7;`);
  expectJS(`~5;`).toMatchInlineSnapshot(`-6;`);
});

test('fold JSFuck-ish unary expressions', () => {
  expectJS(`![];`).toMatchInlineSnapshot(`false;`);
  expectJS(`!![];`).toMatchInlineSnapshot(`true;`);
  expectJS(`+[];`).toMatchInlineSnapshot(`0;`);
});

test('fold unary on literals', () => {
  expectJS(`-"5";`).toMatchInlineSnapshot(`-5;`);
  expectJS(`typeof "x";`).toMatchInlineSnapshot(`"string";`);
  expectJS(`typeof 1;`).toMatchInlineSnapshot(`"number";`);
  expectJS(`!"a";`).toMatchInlineSnapshot(`false;`);
});

test('fold comparisons of literals', () => {
  expectJS(`"a" === "a";`).toMatchInlineSnapshot(`true;`);
  expectJS(`1 < 2;`).toMatchInlineSnapshot(`true;`);
  expectJS(`1 !== "1";`).toMatchInlineSnapshot(`true;`);
});

test('fold mixed string and number coercion', () =>
  expectJS(`1 + "2";`).toMatchInlineSnapshot(`"12";`));

test('keep -0 correct', () =>
  expectJS(`0 / -1;`).toMatchInlineSnapshot(`-0;`));

test('do not fold NaN or Infinity', () => {
  expectJS(`0 / 0;`).toMatchInlineSnapshot(`0 / 0;`);
  expectJS(`1 / 0;`).toMatchInlineSnapshot(`1 / 0;`);
});

test('do not fold huge strings', () => {
  const input = `"${'a'.repeat(6000)}" + "${'b'.repeat(6000)}";`;
  const ast = parse(input, { sourceType: 'unambiguous' });
  const state = applyTransform(ast, constantFolding);
  expect(state.changes).toBe(0);
});

test('do not fold identifiers', () => {
  expectJS(`a + "b";`).toMatchInlineSnapshot(`a + "b";`);
  expectJS(`"a" + b;`).toMatchInlineSnapshot(`"a" + b;`);
});

test('do not fold calls', () => {
  expectJS(`foo() + "b";`).toMatchInlineSnapshot(`foo() + "b";`);
  expectJS(`foo();`).toMatchInlineSnapshot(`foo();`);
});

test('do not fold member access with possible getters', () => {
  expectJS(`({a: 1}).a + 1;`).toMatchInlineSnapshot(`
    ({
      a: 1
    }).a + 1;
  `);
  expectJS(`o.x === 1;`).toMatchInlineSnapshot(`o.x === 1;`);
});

test('do not fold typeof on non-literals', () =>
  expectJS(`typeof x;`).toMatchInlineSnapshot(`typeof x;`));

test('is idempotent', () => {
  const input = `!![] + "b" + (0x1f ^ 0x3);`;
  const once = parse(input, { sourceType: 'unambiguous' });
  const first = applyTransform(once, constantFolding);
  const twice = applyTransform(once, constantFolding);
  expect(first.changes).toBeGreaterThan(0);
  expect(twice.changes).toBe(0);
});
