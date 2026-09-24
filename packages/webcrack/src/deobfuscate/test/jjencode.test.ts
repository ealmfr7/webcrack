import { parse } from '@babel/parser';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { applyTransformAsync, generate } from '../../ast-utils';
import { webcrack } from '../../index';
import jjencode from '../jjencode';
import type { Sandbox } from '../vm';

// Fixtures are real jjencode output (canonical encoder algorithm,
// verified by executing each file in node): a small program encoded
// with the default `$` variable, with a custom variable name, and with
// statements before/after the encoded block:
//   default.js      `$` + `alert(1);`
//   custom-name.js  `V` + `alert(isNaN(0));`
//   surrounding.js  `console.log("before");` + `$` + `alert(2);` +
//                   `console.log("after");`
const FIXTURES_DIR = join(__dirname, 'jjencode');

function recordingSandbox(impl: (code: string) => unknown): {
  sandbox: Sandbox;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    sandbox: (code) => {
      calls.push(code);
      return Promise.resolve(impl(code));
    },
  };
}

async function runJjencode(input: string, sandbox?: Sandbox) {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const { changes } = await applyTransformAsync(ast, jjencode, sandbox);
  return { code: generate(ast), changes };
}

describe('jjencode fixtures decode end to end', () => {
  test.each([
    ['default.js', 'alert(1);'],
    ['custom-name.js', 'alert(isNaN(0));'],
    [
      'surrounding.js',
      'console.log("before");\nalert(2);\nconsole.log("after");',
    ],
  ])('%s decodes via webcrack()', async (file, expected) => {
    const code = await readFile(join(FIXTURES_DIR, file), 'utf8');
    const result = await webcrack(code);
    expect(result.code).toBe(expected);
  });
});

describe('jjencode transform', () => {
  // The sandbox evaluates the preamble's implicit-global assignments,
  // so tests run it in a fresh vm context (sloppy, like isolated-vm)
  // instead of a bare eval, which would throw in strict mode.
  function vmSandbox(): { sandbox: Sandbox; calls: string[] } {
    return recordingSandbox((code) => vm.runInNewContext(code));
  }

  test('preamble and final call are replaced with a Function call', async () => {
    const input = await readFile(join(FIXTURES_DIR, 'custom-name.js'), 'utf8');
    const { sandbox, calls } = vmSandbox();
    const { code, changes } = await runJjencode(input, sandbox);
    expect(changes).toBe(1);
    expect(code).toBe(`Function("alert(isNaN(0));")();`);
    // Only the payload-building part reaches the sandbox: the preamble
    // plus the inner expression, never the outer executing call alone.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('= ~[]');
    expect(calls[0]).toContain('V.$(');
  });

  test('neighbouring statements are preserved', async () => {
    const input = await readFile(join(FIXTURES_DIR, 'surrounding.js'), 'utf8');
    const { sandbox } = vmSandbox();
    const { code, changes } = await runJjencode(input, sandbox);
    expect(changes).toBe(1);
    expect(code).toBe(
      `console.log("before");\nFunction("alert(2);")();\nconsole.log("after");`,
    );
  });

  test('no-op without a sandbox', async () => {
    const input = `V=~[];V={___:++V};V.$(V.$("alert(1);")())();`;
    const { code, changes } = await runJjencode(input, undefined);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });

  test('non-string sandbox results are left untouched', async () => {
    const { sandbox, calls } = recordingSandbox(() => 42);
    const { changes } = await runJjencode(
      `V=~[];V={___:++V};V.$(V.$("alert(1);")())();`,
      sandbox,
    );
    expect(changes).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('sandbox errors are left untouched', async () => {
    const { sandbox } = recordingSandbox(() => {
      throw new Error('timeout');
    });
    const { changes } = await runJjencode(
      `V=~[];V={___:++V};V.$(V.$("alert(1);")())();`,
      sandbox,
    );
    expect(changes).toBe(0);
  });
});

describe('jjencode negative cases (never evaluated)', () => {
  test.each([
    // A `$` object used normally is not encoder output.
    `var $ = { foo: 1 }; console.log($.foo);`,
    `var $ = {}; $.x = 1; $.y = 2; console.log($.x);`,
    // Incomplete blocks: init alone, init plus object without the call.
    `$=~[];`,
    `V=~[];V={___:++V};console.log("x");`,
    // Calls and foreign identifiers never match the encoder grammar.
    `V=~[];V={___:++V};V.$(V.$(foo())())();`,
    `V=~[];V={___:++V};V.$_=foo();V.$(V.$("x")())();`,
    // A declared variable (or Function) means user code owns the name.
    `var V;V=~[];V={___:++V};V.$(V.$("x")())();`,
    `function V(){};V=~[];V={___:++V};V.$(V.$("x")())();`,
  ])('%s is untouched', async (input) => {
    const { sandbox, calls } = recordingSandbox(() => {
      throw new Error('must not be called');
    });
    const { code, changes } = await runJjencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });

  test('a `$` object used normally is untouched via webcrack()', async () => {
    const input = `var $ = { foo: 1 }; console.log($.foo);`;
    const result = await webcrack(input);
    expect(result.code).toContain('console.log');
    expect(result.code).not.toContain('Function(');
  });
});
