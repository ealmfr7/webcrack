import { test } from 'vitest';
import { testTransform } from '../../../test';
import opaquePredicates from '../opaque-predicates';

const expectJS = testTransform(opaquePredicates);

test('if with true numeric comparison keeps consequent', () =>
  expectJS(`
    if (5 > 3) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `).toMatchInlineSnapshot(`console.log("foo");`));

test('if with false string comparison keeps alternate', () =>
  expectJS(`
    if ("xYz" !== "xYz") {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `).toMatchInlineSnapshot(`console.log("bar");`));

test('if with truthy unary expression', () =>
  expectJS(`
    if (!![]) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `).toMatchInlineSnapshot(`console.log("foo");`));

test('if without else and falsy test is removed', () =>
  expectJS(`
    if (1 === 2) {
      console.log("foo");
    }
  `).toMatchInlineSnapshot(``));

test('ternary with literal test', () =>
  expectJS(`
    const x = "abc" === "abc" ? 1 : 2;
  `).toMatchInlineSnapshot(`const x = 1;`));

test('logical && with truthy left keeps right', () =>
  expectJS(`
    console.log(5 > 3 && foo);
  `).toMatchInlineSnapshot(`console.log(foo);`));

test('logical && with falsy left keeps left', () =>
  expectJS(`
    console.log(5 < 3 && foo);
  `).toMatchInlineSnapshot(`console.log(5 < 3);`));

test('logical || with falsy left keeps right', () =>
  expectJS(`
    console.log(5 < 3 || foo);
  `).toMatchInlineSnapshot(`console.log(foo);`));

test('logical || with truthy left keeps left', () =>
  expectJS(`
    console.log("a" === "a" || foo);
  `).toMatchInlineSnapshot(`console.log("a" === "a");`));

test('while(false) is removed', () =>
  expectJS(`
    while (1 === 2) {
      console.log("foo");
    }
    console.log("done");
  `).toMatchInlineSnapshot(`console.log("done");`));

test('while(true) is kept', () =>
  expectJS(`
    while (1 === 1) {
      break;
    }
  `).toMatchInlineSnapshot(`
    while (1 === 1) {
      break;
    }
  `));

test('colliding let stays in a block', () =>
  expectJS(`
    let foo = 1;
    if (5 > 3) {
      let foo = 2;
      console.log(foo);
    }
  `).toMatchInlineSnapshot(`
    let foo = 1;
    {
      let foo = 2;
      console.log(foo);
    }
  `));

test('non-colliding let is hoisted', () =>
  expectJS(`
    if (5 > 3) {
      let bar = 2;
      console.log(bar);
    }
  `).toMatchInlineSnapshot(`
    let bar = 2;
    console.log(bar);
  `));

test('non-literal if test is kept', () =>
  expectJS(`
    if (x > 3) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `).toMatchInlineSnapshot(`
    if (x > 3) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `));

test('non-literal logical left is kept', () =>
  expectJS(`
    console.log(x && foo);
  `).toMatchInlineSnapshot(`console.log(x && foo);`));

test('non-literal ternary test is kept', () =>
  expectJS(`
    const x = y ? 1 : 2;
  `).toMatchInlineSnapshot(`const x = y ? 1 : 2;`));

test('non-literal while test is kept', () =>
  expectJS(`
    while (x) {
      break;
    }
  `).toMatchInlineSnapshot(`
    while (x) {
      break;
    }
  `));

test('if with side-effectful sequence test is kept', () =>
  expectJS(`
    if ((sideEffect(), true)) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `).toMatchInlineSnapshot(`
    if (sideEffect(), true) {
      console.log("foo");
    } else {
      console.log("bar");
    }
  `));

test('if with void call test is kept', () =>
  expectJS(`
    if (void sideEffect()) {
      console.log("foo");
    }
  `).toMatchInlineSnapshot(`
    if (void sideEffect()) {
      console.log("foo");
    }
  `));

test('logical with side-effectful left is kept', () =>
  expectJS(`
    console.log((sideEffect(), 1) && foo);
  `).toMatchInlineSnapshot(`console.log((sideEffect(), 1) && foo);`));

test('removed branch preserves hoisted var and function', () =>
  expectJS(`
    if (1 === 2) {
      var v = 1;
      function g() {}
    }
    console.log(v, g);
  `).toMatchInlineSnapshot(`
    var v, g;
    console.log(v, g);
  `));

test('removed while body preserves hoisted var', () =>
  expectJS(`
    while (0) {
      var w = 1;
    }
    console.log(w);
  `).toMatchInlineSnapshot(`
    var w;
    console.log(w);
  `));

test('kept let capturing an outer reference stays in a block', () =>
  expectJS(`
    if (5 > 3) {
      let foo = 1;
    }
    console.log(foo);
  `).toMatchInlineSnapshot(`
    {
      let foo = 1;
    }
    console.log(foo);
  `));

test('kept const capturing a function reference stays in a block', () =>
  expectJS(`
    function f() {
      return bar;
    }
    if (5 > 3) {
      const bar = 1;
    }
  `).toMatchInlineSnapshot(`
    function f() {
      return bar;
    }
    {
      const bar = 1;
    }
  `));

test('labeled if keeps its label and block', () =>
  expectJS(`
    lbl: if (5 > 3) {
      console.log("a");
      break lbl;
    }
  `).toMatchInlineSnapshot(`
    lbl: {
      console.log("a");
      break lbl;
    }
  `));

test('else-if with var in dropped branch keeps the var', () =>
  expectJS(`
    if (x) {
    } else if (5 > 3) {
      a();
    } else {
      var z = 1;
    }
  `).toMatchInlineSnapshot(`
    if (x) {} else {
      var z;
      a();
    }
  `));

test('if as loop body with var in dropped branch keeps the var', () =>
  expectJS(`
    for (;;) if (5 > 3) a(); else {
      var z;
    }
  `).toMatchInlineSnapshot(`
    for (;;) {
      var z;
      a();
    }
  `));
