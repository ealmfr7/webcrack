import { test } from 'vitest';
import { testTransform } from '../../../test';
import tsEnum from '../transforms/ts-enum';

const expectJS = testTransform(tsEnum);

test('numeric enum', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
      E[E["B"] = 1] = "B";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
      B = 1,
    }
  `));

test('string enum', () =>
  expectJS(`
    var E;
    (function (E) {
      E["A"] = "a";
      E["B"] = "b";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = "a",
      B = "b",
    }
  `));

test('mixed enum', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
      E["B"] = "b";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
      B = "b",
    }
  `));

test('auto-increment values are preserved as emitted', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 5] = "A";
      E[E["B"] = 6] = "B";
      E[E["C"] = 10] = "C";
      E[E["D"] = 11] = "D";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 5,
      B = 6,
      C = 10,
      D = 11,
    }
  `));

test('minified tsc shape', () =>
  expectJS(`
    var E;
    !function (e) { e[e.A = 0] = "A"; e[e.B = 1] = "B"; }(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
      B = 1,
    }
  `));

test('logical assignment init', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
    })(E ||= {});
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
    }
  `));

test('esbuild arrow shape', () =>
  expectJS(`
    var E = /* @__PURE__ */ ((E) => {
      E[E["A"] = 0] = "A";
      E["B"] = "b";
      return E;
    })(E || {});
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
      B = "b",
    }
  `));

test('computed initializer referencing an earlier member', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 1] = "A";
      E[E["B"] = E.A + 1] = "B";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 1,
      B = E.A + 1,
    }
  `));

test('declaration merging folds consecutive augmentations', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
    })(E || (E = {}));
    (function (E) {
      E["B"] = "b";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    enum E {
      A = 0,
      B = "b",
    }
  `));

test('lookalike IIFE with other statements is left alone', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
      console.log("side effect");
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
      console.log("side effect");
    })(E || (E = {}));
  `));

test('plain numeric assignments without reverse mapping are left alone', () =>
  expectJS(`
    var E;
    (function (E) {
      E.A = 0;
      E.B = 1;
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    var E;
    (function (E) {
      E.A = 0;
      E.B = 1;
    })(E || (E = {}));
  `));

test('mismatched reverse-mapping name is left alone', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "B";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "B";
    })(E || (E = {}));
  `));

test('duplicate members across augmentations are left alone', () =>
  expectJS(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
    })(E || (E = {}));
    (function (E) {
      E[E["A"] = 1] = "A";
    })(E || (E = {}));
  `).toMatchInlineSnapshot(`
    var E;
    (function (E) {
      E[E["A"] = 0] = "A";
    })(E || (E = {}));
    (function (E) {
      E[E["A"] = 1] = "A";
    })(E || (E = {}));
  `));

test('unrelated code is left alone', () =>
  expectJS(`
    var x = [1, 2, 3];
    function f(a) { return a + x.length; }
  `).toMatchInlineSnapshot(`
    var x = [1, 2, 3];
    function f(a) {
      return a + x.length;
    }
  `));
