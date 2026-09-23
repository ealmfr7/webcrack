import { parse } from '@babel/parser';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  applyTransformAsync,
  applyTransforms,
  generate,
} from '../../ast-utils';
import aaencode from '../aaencode';
import evalUnwrap from '../eval-unwrap';
import packer from '../packer';
import type { Sandbox } from '../vm';
import { createNodeSandbox } from '../vm';

// Fixtures are real aaencode output (Yosuke HASEGAWA's encoder) as static
// files: a small program, the same shape with surrounding user statements,
// a non-ASCII program (exercises the `oﾟｰﾟo` `\uXXXX` path) and an empty
// program (payload without per-character groups).
const FIXTURES_DIR = join(__dirname, 'aaencode');

// Record sandbox inputs while delegating to the real isolated-vm sandbox,
// so fixtures execute exactly as in production.
function recordingSandbox(): { sandbox: Sandbox; calls: string[] } {
  const calls: string[] = [];
  const real = createNodeSandbox();
  return {
    calls,
    sandbox: (code) => {
      calls.push(code);
      return real(code);
    },
  };
}

function throwingSandbox(): { sandbox: Sandbox; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sandbox: (code) => {
      calls.push(code);
      throw new Error('must not be called');
    },
  };
}

async function runAaencode(input: string, sandbox?: Sandbox) {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const { changes } = await applyTransformAsync(ast, aaencode, sandbox);
  return { code: generate(ast), changes };
}

// Local end-to-end loop mirroring the unwrap loop in `../index`: aaencode
// rewrites the block as `Function("<decoded>")()` and evalUnwrap splices it
// open on the next iteration. Registration in index.ts belongs to another
// task, so it is wired up here instead of importing the pipeline.
async function decodeEndToEnd(input: string, sandbox: Sandbox) {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const state = { changes: 0 };
  for (let iteration = 0; iteration < 10; iteration++) {
    const before = state.changes;
    state.changes += applyTransforms(ast, [packer, evalUnwrap]).changes;
    state.changes += (
      await applyTransformAsync(ast, aaencode, sandbox)
    ).changes;
    if (state.changes === before) break;
  }
  return generate(ast);
}

describe('aaencode transform', () => {
  test('basic fixture decodes to a Function construction', async () => {
    const { sandbox, calls } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const { code: output, changes } = await runAaencode(code, sandbox);
    expect(changes).toBe(1);
    expect(output).toBe(`Function("alert(1);")();`);
    // Only the setup plus the inner decoder call reach the sandbox: the
    // outer `("_")` execution call must not be among them.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ﾟεﾟ');
    expect(calls[0]).not.toContain('("_")');
  });

  test('surrounding statements are preserved', async () => {
    const { sandbox, calls } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'surrounded.js'), 'utf8');
    const { code: output, changes } = await runAaencode(code, sandbox);
    expect(changes).toBe(1);
    expect(output).toBe(
      `console.log("before");\nFunction("console.log(\\"middle\\");")();\nconsole.log("after");`,
    );
    expect(calls).toHaveLength(1);
  });

  test('non-ASCII payload decodes', async () => {
    const { sandbox } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'unicode.js'), 'utf8');
    const { code: output, changes } = await runAaencode(code, sandbox);
    expect(changes).toBe(1);
    expect(output).toBe(`Function("console.log(\\"π\\");")();`);
  });

  test('empty payload decodes', async () => {
    const { sandbox } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'empty.js'), 'utf8');
    const { code: output, changes } = await runAaencode(code, sandbox);
    expect(changes).toBe(1);
    expect(output).toBe(`Function("")();`);
  });

  test('two encoded blocks both decode', async () => {
    const { sandbox, calls } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const { code: output, changes } = await runAaencode(
      `${code}\n${code}`,
      sandbox,
    );
    expect(changes).toBe(2);
    expect(output).toBe(`Function("alert(1);")();\nFunction("alert(1);")();`);
    expect(calls).toHaveLength(2);
  });

  test('interleaved blocks decode without touching neighbours', async () => {
    const { sandbox, calls } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const { code: output, changes } = await runAaencode(
      `var a = 1;\n${code}\nvar b = 2;\n${code}\nvar c = 3;`,
      sandbox,
    );
    expect(changes).toBe(2);
    expect(output).toBe(
      `var a = 1;\nFunction("alert(1);")();\nvar b = 2;\nFunction("alert(1);")();\nvar c = 3;`,
    );
    expect(calls).toHaveLength(2);
  });

  test('no-op without a sandbox', async () => {
    const input = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const { code, changes } = await runAaencode(input, undefined);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });

  test('non-string sandbox results are left untouched', async () => {
    const { code, changes } = await runAaencode(
      await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8'),
      () => Promise.resolve(42),
    );
    expect(changes).toBe(0);
    expect(code).toContain('ﾟωﾟﾉ');
  });

  test('sandbox errors are left untouched', async () => {
    const { changes } = await runAaencode(
      await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8'),
      () => Promise.reject(new Error('timeout')),
    );
    expect(changes).toBe(0);
  });
});

describe('aaencode lookalikes are never evaluated', () => {
  // The opener line, exactly as the encoder emits it.
  const opener = 'ﾟωﾟﾉ= /｀ｍ´）ﾉ ~┻━┻   //*´∇｀*/ ["_"];';

  test.each([
    // Bare constructor calls are eval-unwrap's shape, not this transform's.
    `Function("alert(1);")()`,
    // Opener without the rest of the block.
    `${opener}`,
    `${opener} console.log("hi");`,
    // A call inside the setup breaks the encoder grammar.
    `${opener} o = foo();`,
    `${opener} c=(ﾟΘﾟ) =(ﾟｰﾟ)-(ﾟΘﾟ); console.log(c);`,
    // Executor-shaped calls with a static payload would execute as code;
    // the encoder always builds the payload from `ﾟεﾟ` member chains.
    `${opener} (ﾟДﾟ)["_"]((ﾟДﾟ)["_"]("alert(1);")(ﾟΘﾟ))("_");`,
    `${opener} (ﾟДﾟ)["_"]((ﾟДﾟ)["_"]((ﾟΘﾟ))(ﾟΘﾟ))("_");`,
    // Wrong invocation arguments on either call.
    `${opener} (ﾟДﾟ)["_"]((ﾟДﾟ)["_"]((ﾟεﾟ))(ﾟΘﾟ))("x");`,
    // Non-encoder identifiers, even with the right shape otherwise.
    `ﾟωﾟﾉ = 1; console.log(ﾟωﾟﾉ);`,
    `${opener} evil = 1;`,
  ])('%s is untouched', async (input) => {
    const { sandbox, calls } = throwingSandbox();
    const { code, changes } = await runAaencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });

  test('shadowed Function blocks the replacement', async () => {
    const { sandbox, calls } = throwingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const input = `var Function = f;\n${code}`;
    const { code: output, changes } = await runAaencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(output).toBe(generate(parse(input)));
  });

  test('user o/c params leave the block untouched', async () => {
    const { sandbox, calls } = throwingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const input = `function f(o, c) {\n${code}\nreturn o + c;\n}`;
    const { code: output, changes } = await runAaencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(output).toBe(generate(parse(input)));
  });

  test('user _ binding leaves the block untouched', async () => {
    const { sandbox, calls } = throwingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const input = `var _ = require("lodash");\n${code}\n_.map([1, 2], String);`;
    const { code: output, changes } = await runAaencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(output).toBe(generate(parse(input)));
  });

  test('user ﾟωﾟﾉ binding leaves the block untouched', async () => {
    const { sandbox, calls } = throwingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const input = `var ﾟωﾟﾉ = 1;\n${code}`;
    const { code: output, changes } = await runAaencode(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(output).toBe(generate(parse(input)));
  });

  test('unrelated bindings still decode', async () => {
    const { sandbox, calls } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'basic.js'), 'utf8');
    const input = `var unrelated = 1;\n${code}`;
    const { code: output, changes } = await runAaencode(input, sandbox);
    expect(changes).toBe(1);
    expect(output).toBe(
      `var unrelated = 1;\nFunction("alert(1);")();`,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('aaencode end to end (locally registered loop)', () => {
  test.each([
    ['basic.js', 'alert(1);'],
    ['unicode.js', 'console.log("π");'],
    ['empty.js', ''],
  ])('%s decodes to the original program', async (file, expected) => {
    const { sandbox } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, file), 'utf8');
    await expect(decodeEndToEnd(code, sandbox)).resolves.toBe(expected);
  });

  test('surrounded.js keeps its neighbours in order', async () => {
    const { sandbox } = recordingSandbox();
    const code = await readFile(join(FIXTURES_DIR, 'surrounded.js'), 'utf8');
    await expect(decodeEndToEnd(code, sandbox)).resolves.toBe(
      `console.log("before");\nconsole.log("middle");\nconsole.log("after");`,
    );
  });
});
