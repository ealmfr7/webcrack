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
