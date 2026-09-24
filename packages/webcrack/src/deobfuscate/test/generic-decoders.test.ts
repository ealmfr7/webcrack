import { parse } from '@babel/parser';
import { describe, expect, test, vi } from 'vitest';
import { applyTransformAsync, generate } from '../../ast-utils';
import genericDecoders from '../generic-decoders';
import type { Sandbox } from '../vm';

// Indirect eval runs the generated code in global scope, where `atob` and
// friends are available like they are in the real sandbox.
const sandbox: Sandbox = (code) => Promise.resolve((0, eval)(code));

async function decodeJS(input: string): Promise<string> {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  await applyTransformAsync(ast, genericDecoders, sandbox);
  return generate(ast);
}

describe('generic decoders', () => {
  test('base64 decoder is inlined and removed', async () => {
    await expect(
      decodeJS(`
        const decode = (s) => atob(s);
        console.log(decode("aGVsbG8="));
        console.log(decode("d29ybGQ="));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("hello");
      console.log("world");"
    `);
  });

  test('xor decoder is inlined and removed', async () => {
    await expect(
      decodeJS(`
        function xor(s, k) {
          let r = "";
          for (let i = 0; i < s.length; i++) {
            r += String.fromCharCode(s.charCodeAt(i) ^ k);
          }
          return r;
        }
        console.log(xor("aaa", 3));
        console.log(xor("b", 1));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("bbb");
      console.log("c");"
    `);
  });

  test('charCode-shift decoder is inlined and removed', async () => {
    await expect(
      decodeJS(`
        const shift = function (s, n) {
          return s.split("").map((c) => String.fromCharCode(c.charCodeAt(0) + n)).join("");
        };
        console.log(shift("abc", 1));
        console.log(shift("xyz", 2));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("bcd");
      console.log("z{|");"
    `);
  });

  test('decoder using a pure helper inlines both and removes both', async () => {
    await expect(
      decodeJS(`
        function helper(c) {
          return String.fromCharCode(c);
        }
        function decode(a, b) {
          return helper(a) + helper(b);
        }
        console.log(decode(104, 105));
        console.log(decode(106, 107));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("hi");
      console.log("jk");"
    `);
  });

  test('numeric and boolean results are inlined', async () => {
    await expect(
      decodeJS(`
        function add(a, b) {
          return a + b;
        }
        console.log(add(40, 2));
        console.log(add(1, 2));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log(42);
      console.log(3);"
    `);
  });

  test('calls are evaluated in a single batch', async () => {
    const spy = vi.fn(sandbox);
    const ast = parse(
      `const d = (s) => atob(s); console.log(d("YQ==")); console.log(d("Yg=="));`,
      { sourceType: 'unambiguous' },
    );
    await applyTransformAsync(ast, genericDecoders, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(generate(ast)).toBe('console.log("a");\nconsole.log("b");');
  });

  test('function touching outer variables is untouched', async () => {
    const input = `
      let count = 0;
      function decode(s) {
        count++;
        return atob(s);
      }
      console.log(decode("YQ=="));
      console.log(decode("Yg=="));
    `;
    await expect(decodeJS(input)).resolves.toContain('decode("YQ==")');
  });

  test('function touching globals is untouched', async () => {
    const input = `
      function decode(s) {
        console.log(s);
        return atob(s);
      }
      console.log(decode("YQ=="));
      console.log(decode("Yg=="));
    `;
    await expect(decodeJS(input)).resolves.toContain('decode("YQ==")');
  });

  test('function using Math.random is untouched', async () => {
    const input = `
      function decode(s) {
        return Math.random() > 2 ? s : atob(s);
      }
      console.log(decode("YQ=="));
      console.log(decode("Yg=="));
    `;
    await expect(decodeJS(input)).resolves.toContain('decode("YQ==")');
  });

  test('computed access to Math.random is untouched', async () => {
    const input = `
      function decode(s) {
        return Math[atob("cmFuZG9t")]() > 0.5 ? s : atob(s);
      }
      console.log(decode("YQ=="));
      console.log(decode("Yg=="));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('decode("YQ==")');
    expect(code).toContain('decode("Yg==")');
  });

  test('call with non-literal args leaves the function alone', async () => {
    const input = `
      const decode = (s) => atob(s);
      const input = window.name;
      console.log(decode("YQ=="));
      console.log(decode(input));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('decode("YQ==")');
    expect(code).toContain('decode(input)');
  });

  test('single call is untouched', async () => {
    const input = `
      const decode = (s) => atob(s);
      console.log(decode("YQ=="));
    `;
    await expect(decodeJS(input)).resolves.toContain('decode("YQ==")');
  });

  test('huge results are skipped and the function is kept', async () => {
    const input = `
      function big() {
        return "x".repeat(20000);
      }
      console.log(big());
      console.log(big());
    `;
    const code = await decodeJS(input);
    expect(code).toContain('console.log(big())');
  });

  test('non-primitive results are skipped and the function is kept', async () => {
    const input = `
      function wrap(a) {
        return [a];
      }
      console.log(wrap(1));
      console.log(wrap(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('console.log(wrap(1))');
  });

  test('Object.keys over shared prototype is kept', async () => {
    const input = `
      function h(s) {
        return Object.keys(Object.prototype).length + s;
      }
      Object.prototype.q = 1;
      console.log(h(1), h(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('h(1)');
    expect(code).toContain('h(2)');
  });

  test('JSON.stringify over shared prototype is kept', async () => {
    const input = `
      function r(s) {
        return JSON.stringify(Array.prototype) + s;
      }
      Array.prototype.foo = 1;
      console.log(r(1), r(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('r(1)');
    expect(code).toContain('r(2)');
  });

  test('Object.defineProperty side effect is kept', async () => {
    const input = `
      function f(a) {
        Object.defineProperty(Object.prototype, 'zz', { value: a, configurable: true });
        return a;
      }
      f(1);
      f(2);
      console.log(({}).zz);
    `;
    const code = await decodeJS(input);
    expect(code).toContain('f(1)');
    expect(code).toContain('f(2)');
  });

  test('aliased Object over shared prototype is kept', async () => {
    const input = `
      function h(s) {
        const O = Object;
        return O.keys(O.prototype).length + s;
      }
      Object.prototype.q = 1;
      console.log(h(1), h(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('h(1)');
    expect(code).toContain('h(2)');
  });

  test('aliased Math.random is kept', async () => {
    const input = `
      function h(s) {
        const M = Math;
        return M.random() + s;
      }
      console.log(h(1), h(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('h(1)');
    expect(code).toContain('h(2)');
  });

  test('builtin passed as a value is kept', async () => {
    const input = `
      function k(s) {
        return String(Object) + s;
      }
      console.log(k("a"));
      console.log(k("b"));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('k("a")');
    expect(code).toContain('k("b")');
  });

  test('direct builtin calls stay pure', async () => {
    await expect(
      decodeJS(`
        function f(a) {
          return String(a);
        }
        console.log(f(1));
        console.log(f(2));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("1");
      console.log("2");"
    `);
  });

  test('computed access on builtins is kept', async () => {
    const input = `
      function g(s) {
        return Object['keys']({}).length + s;
      }
      console.log(g(1));
      console.log(g(2));
    `;
    const code = await decodeJS(input);
    expect(code).toContain('g(1)');
    expect(code).toContain('g(2)');
  });

  test('stops evaluating after the first sandbox timeout', async () => {
    const spy = vi.fn(() =>
      Promise.reject(new Error('Script execution timed out.')),
    );
    const ast = parse(
      `function a(n) { while (true) {} } function b(n) { while (true) {} }
       console.log(a(1)); console.log(a(2)); console.log(b(1)); console.log(b(2));`,
      { sourceType: 'unambiguous' },
    );
    await applyTransformAsync(ast, genericDecoders, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(generate(ast)).toContain('a(1)');
  });

  test('undefined results are inlined as void 0', async () => {
    await expect(
      decodeJS(`
        function f(a) {
          return undefined;
        }
        console.log(f(1));
        console.log(f(2));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log(void 0);
      console.log(void 0);"
    `);
  });

  test('Math and parseInt users are treated as pure', async () => {
    await expect(
      decodeJS(`
        function decode(s, k) {
          return String.fromCharCode(parseInt(s, 16) + Math.floor(k));
        }
        console.log(decode("41", 1));
        console.log(decode("42", 2));
      `),
    ).resolves.toMatchInlineSnapshot(`
      "console.log("B");
      console.log("D");"
    `);
  });
});
