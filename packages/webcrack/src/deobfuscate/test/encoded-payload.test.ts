import { parse } from '@babel/parser';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { applyTransformAsync, generate } from '../../ast-utils';
import { webcrack } from '../../index';
import encodedPayload from '../encoded-payload';
import type { Sandbox } from '../vm';

// Fixtures are representative JSFuck/JJEncode/AAEncode-style samples: each
// payload expression uses only the encoder's idiom (literals, operators
// and property access on literals) and was verified to evaluate to the
// original program. They are static files generated without extra
// dependencies (see the wrap shapes below):
//   jsfuck.js   `[]["filter"]["constructor"](<jsfuck>)()`      -> alert(1)
//   jjencode.js `[]["fil"+"ter"]["con"+"structor"](<jj>)()`     -> isNaN(0)
//   aaencode.js `Function(<aaencode>)()`                        -> eval(1)
const FIXTURES_DIR = join(__dirname, 'encoded-payload');

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

async function runEncodedPayload(input: string, sandbox?: Sandbox) {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const { changes } = await applyTransformAsync(ast, encodedPayload, sandbox);
  return { code: generate(ast), changes };
}

describe('encoded-payload fixtures decode end to end', () => {
  test.each([
    ['jsfuck.js', 'alert(1);'],
    ['jjencode.js', 'isNaN(0);'],
    ['aaencode.js', 'eval(1);'],
  ])('%s decodes via webcrack()', async (file, expected) => {
    const code = await readFile(join(FIXTURES_DIR, file), 'utf8');
    const result = await webcrack(code);
    expect(result.code).toBe(expected);
  });
});

describe('encoded-payload user constructor is never executed', () => {
  test('user object .constructor through webcrack() stays unchanged', async () => {
    const input = `function Greeter(m){return function(){console.log(m)}} const g=Object.create(Greeter.prototype); g.constructor("alert("+"1)")();`;
    const result = await webcrack(input);
    expect(result.code).toContain('constructor');
    expect(result.code).not.toContain('alert(1);');
  });
});

describe('encoded-payload transform', () => {
  test('encoded member-constructor payload is evaluated and rewritten', async () => {
    const { sandbox, calls } = recordingSandbox((code) => eval(code));
    const { code, changes } = await runEncodedPayload(
      `[]["filter"]["constructor"]((![]+"")[+[]])()`,
      sandbox,
    );
    expect(changes).toBe(1);
    expect(code).toBe(`Function("f")();`);
    // Only the payload expression reaches the sandbox, never the outer call.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('constructor');
    expect(calls[0]).toContain('![]');
  });

  test('static member-constructor payload is rewritten without the sandbox', async () => {
    const { sandbox, calls } = recordingSandbox(() => {
      throw new Error('must not be called');
    });
    const { code, changes } = await runEncodedPayload(
      `([]["filter"].constructor)("alert(4);")()`,
      sandbox,
    );
    expect(changes).toBe(1);
    expect(code).toBe(`Function("alert(4);")();`);
    expect(calls).toHaveLength(0);
  });

  test('static bare Function payload is left for eval-unwrap', async () => {
    const { sandbox, calls } = recordingSandbox(() => {
      throw new Error('must not be called');
    });
    const { code, changes } = await runEncodedPayload(
      `Function("alert(5);")()`,
      sandbox,
    );
    expect(changes).toBe(0);
    expect(code).toBe(`Function("alert(5);")();`);
    expect(calls).toHaveLength(0);
  });

  test('no-op without a sandbox', async () => {
    const input = `[]["filter"]["constructor"]((![]+"")[+[]])()`;
    const { code, changes } = await runEncodedPayload(input, undefined);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });

  test('non-string sandbox results are left untouched', async () => {
    const { sandbox, calls } = recordingSandbox(() => 42);
    const { code, changes } = await runEncodedPayload(
      `[]["filter"]["constructor"]((![]+"")[+[]])()`,
      sandbox,
    );
    expect(changes).toBe(0);
    expect(calls).toHaveLength(1);
    expect(code).toContain('constructor');
  });

  test('sandbox errors are left untouched', async () => {
    const { sandbox } = recordingSandbox(() => {
      throw new Error('timeout');
    });
    const { changes } = await runEncodedPayload(
      `[]["filter"]["constructor"]((![]+"")[+[]])()`,
      sandbox,
    );
    expect(changes).toBe(0);
  });
});

describe('encoded-payload negative cases (never evaluated)', () => {
  test.each([
    // Calls (to user bindings or otherwise) in the payload.
    `[]["filter"]["constructor"](foo("alert(1)"))()`,
    `var foo = () => "alert(1)"; []["filter"]["constructor"](foo())()`,
    // Bare identifiers, assignments and mutations in the payload.
    `var s = "alert(1)"; Function(s)()`,
    `[]["filter"]["constructor"]((s = "alert(1)"))()`,
    `var i = 0; Function(i++)()`,
    `Function(delete ({}).x)()`,
    `Function(this)()`,
    // Shadowed Function is a user value, not the constructor.
    `var Function = f; Function("alert(1);")()`,
    // Parameterized constructions and invoked results are out of scope.
    `Function("a", "return a;")("hi")`,
    `Function("a", "b")()`,
    // Non-constructor member calls and unknown computed properties.
    `[]["filter"]["map"]("alert(1)")()`,
    `var key = "constructor"; [][key]("alert(1)")()`,
    // User receivers are not payloads, even with a static payload string.
    `var g = {}; g.constructor("alert(1)")()`,
    `foo.constructor("alert(1)")()`,
    `var g = {}; g.constructor("alert(" + "1)")()`,
    `function Greeter(m){return function(){console.log(m)}} const g=Object.create(Greeter.prototype); g.constructor("alert("+"1)")();`,
    // `new Function(...)` is eval-unwrap's shape, not this transform's.
    `new Function("alert(1);")()`,
  ])('%s is untouched', async (input) => {
    const { sandbox, calls } = recordingSandbox(() => {
      throw new Error('must not be called');
    });
    const { code, changes } = await runEncodedPayload(input, sandbox);
    expect(calls).toHaveLength(0);
    expect(changes).toBe(0);
    expect(code).toBe(generate(parse(input)));
  });
});
