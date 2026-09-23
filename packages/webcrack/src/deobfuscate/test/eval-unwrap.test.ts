import { parse } from '@babel/parser';
import { expect, test } from 'vitest';
import { testTransform } from '../../../test';
import { applyTransformAsync, generate } from '../../ast-utils';
import { webcrack } from '../../index';
import deobfuscate from '../index';
import evalUnwrap from '../eval-unwrap';

const expectJS = testTransform(evalUnwrap);

test('direct eval statement is inlined', () =>
  expectJS(`eval("console.log(1);");`).toMatchInlineSnapshot(
    `console.log(1);`,
  ));

test('template literal without expressions is inlined', () =>
  expectJS('eval(`console.log(2);`);').toMatchInlineSnapshot(
    `console.log(2);`,
  ));

test('concatenated literals are inlined', () =>
  expectJS(`eval("console." + "log(3);");`).toMatchInlineSnapshot(
    `console.log(3);`,
  ));

test('indirect eval via sequence is inlined', () =>
  expectJS(`(0, eval)("console.log(4);");`).toMatchInlineSnapshot(
    `console.log(4);`,
  ));

test('window.eval and globalThis.eval are inlined', () => {
  expectJS(`window.eval("console.log(5);");`).toMatchInlineSnapshot(
    `console.log(5);`,
  );
  expectJS(`globalThis.eval("console.log(6);");`).toMatchInlineSnapshot(
    `console.log(6);`,
  );
  expectJS(`window["eval"]("console.log(7);");`).toMatchInlineSnapshot(
    `console.log(7);`,
  );
});

test('multi-statement payloads are spliced', () =>
  expectJS(`eval("var a = 1; console.log(a);");`).toMatchInlineSnapshot(`
    var a = 1;
    console.log(a);
  `));

test('Function("code")() is inlined', () =>
  expectJS(`Function("console.log(8);")();`).toMatchInlineSnapshot(
    `console.log(8);`,
  ));

test('new Function("code")() is inlined', () =>
  expectJS(`new Function("console.log(9);")();`).toMatchInlineSnapshot(
    `console.log(9);`,
  ));

test('Function call in expression position becomes an IIFE', () =>
  expectJS(`var x = Function("1 + 2;")();`).toMatchInlineSnapshot(`
    var x = function () {
      1 + 2;
    }();
  `));

test('IIFE preserves an explicit return', () =>
  expectJS(`var x = Function("return 5;")();`).toMatchInlineSnapshot(`
    var x = function () {
      return 5;
    }();
  `));

test('Function with params becomes a function expression', () =>
  expectJS(`var f = Function("a", "b", "return a + b;");`)
    .toMatchInlineSnapshot(`
    var f = function (a, b) {
      return a + b;
    };
  `));

test('new Function with params becomes a function expression', () =>
  expectJS(`var g = new Function("a", "return a * 2;");`)
    .toMatchInlineSnapshot(`
    var g = function (a) {
      return a * 2;
    };
  `));

test('immediately-invoked Function with params keeps the call', () =>
  expectJS(`Function("a", "return a;")("hi");`).toMatchInlineSnapshot(`
    (function (a) {
      return a;
    })("hi");
  `));

test('empty eval is removed', () =>
  expectJS(`eval("");`).toMatchInlineSnapshot(``));

test('non-literal arguments are untouched', () => {
  expectJS(`eval(x);`).toMatchInlineSnapshot(`eval(x);`);
  expectJS(`eval("a" + x);`).toMatchInlineSnapshot(`eval("a" + x);`);
  expectJS('eval(`a${x}`);').toMatchInlineSnapshot(`eval(\`a\${x}\`);`);
  expectJS(`Function(x)();`).toMatchInlineSnapshot(`Function(x)();`);
  expectJS(`eval();`).toMatchInlineSnapshot(`eval();`);
});

test('unparseable payloads are untouched', () =>
  expectJS(`eval("function (");`).toMatchInlineSnapshot(`eval("function (");`));

// Direct eval shares the caller's scope and indirect eval/Function run in
// global scope, so anything nested inside a function is left untouched:
// inlining could capture locals or leak declarations.
test('direct eval inside a function is untouched', () =>
  expectJS(`function f(x) { eval("console.log(x);"); }`).toMatchInlineSnapshot(`
    function f(x) {
      eval("console.log(x);");
    }
  `));

test('indirect eval inside a function is untouched', () =>
  expectJS(`function f() { (0, eval)("console.log(1);"); }`)
    .toMatchInlineSnapshot(`
    function f() {
      (0, eval)("console.log(1);");
    }
  `));

test('Function inside a function is untouched', () => {
  expectJS(`function f() { Function("1 + 2;")(); }`).toMatchInlineSnapshot(`
    function f() {
      Function("1 + 2;")();
    }
  `);
  expectJS(`function f() { var g = Function("a", "return a;"); }`)
    .toMatchInlineSnapshot(`
    function f() {
      var g = Function("a", "return a;");
    }
  `);
});

test('shadowed eval/Function are untouched', () => {
  expectJS(`function eval() {} eval("1;");`).toMatchInlineSnapshot(`
    function eval() {}
    eval("1;");
  `);
  expectJS(`var Function = f; Function("1;")();`).toMatchInlineSnapshot(`
    var Function = f;
    Function("1;")();
  `);
  expectJS(`function f(window) { window.eval("1;"); }`).toMatchInlineSnapshot(`
    function f(window) {
      window.eval("1;");
    }
  `);
});

test('top-level return payloads are untouched', () =>
  expectJS(`eval("return 1;");`).toMatchInlineSnapshot(`eval("return 1;");`));

test('payloads colliding with visible bindings are untouched', () =>
  expectJS(`let a = 1; eval("let a = 2;");`).toMatchInlineSnapshot(`
    let a = 1;
    eval("let a = 2;");
  `));

// A leading directive applies to the eval scope only and the parser lifts
// it out of the payload body, so splicing the rest would silently drop it.
test('payloads with directives are untouched', () =>
  expectJS(`eval("'use strict'; console.log(1);");`).toMatchInlineSnapshot(
    `eval("'use strict'; console.log(1);");`,
  ));

// The sandbox is only used to execute string-array decoders, so a dummy
// is enough for inputs without a string array.
const sandbox = () => Promise.resolve(undefined);

async function deobfuscateJS(input: string): Promise<string> {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  await applyTransformAsync(ast, deobfuscate, sandbox);
  return generate(ast);
}

test('3-level nested eval unwraps via the deobfuscate loop', async () => {
  const level1 = `console.log("nested");`;
  const level2 = `eval(${JSON.stringify(level1)});`;
  const level3 = `eval(${JSON.stringify(level2)});`;
  await expect(deobfuscateJS(level3)).resolves.toBe(`console.log("nested");`);
});

test('Function wrapping eval unwraps via the deobfuscate loop', async () => {
  const inner = `console.log("deep");`;
  const outer = `Function(${JSON.stringify(
    `eval(${JSON.stringify(inner)});`,
  )})();`;
  await expect(deobfuscateJS(outer)).resolves.toBe(`console.log("deep");`);
});

test('new Function wrapping eval unwraps via the deobfuscate loop', async () => {
  const inner = `console.log("deep new");`;
  const outer = `new Function(${JSON.stringify(
    `eval(${JSON.stringify(inner)});`,
  )})();`;
  await expect(deobfuscateJS(outer)).resolves.toBe(`console.log("deep new");`);
});

test('nested eval unwraps end to end via webcrack', async () => {
  const level1 = `console.log("e2e");`;
  const level2 = `eval(${JSON.stringify(level1)});`;
  const result = await webcrack(`eval(${JSON.stringify(level2)});`);
  expect(result.code).toBe(`console.log("e2e");`);
});

test('function-scoped eval survives the full pipeline untouched', async () => {
  const result = await webcrack(`function f(x) { eval("return x;"); }`);
  expect(result.code).toBe(`function f(x) {\n  eval("return x;");\n}`);
});
