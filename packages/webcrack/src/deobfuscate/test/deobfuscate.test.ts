import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { describe, expect, test } from 'vitest';
import {
  applyTransformAsync,
  generate,
  inlineFunctionAliases,
  inlineVariableAliases,
} from '../../ast-utils';
import deobfuscate from '../index';

describe('inline decoder', () => {
  test('inline variable', () => {
    const ast = parse(`
      function decoder() {}
      decoder(1);
      (() => {
        const alias = decoder, alias3 = alias;
        alias(2);
        alias3(3);
        (() => {
          let alias2;
          (alias2 = alias)(4);
        });
        let alias4;
        alias4 = alias;
        alias4(5);
      });
  `);
    traverse(ast, {
      FunctionDeclaration(path) {
        const binding = path.scope.getBinding('decoder')!;
        inlineVariableAliases(binding);
        path.stop();
      },
    });
    expect(generate(ast)).toMatchSnapshot();
  });

  test('inline function', () => {
    const ast = parse(`
      function decoder(a, b) {}
      decoder(1, 2);
      function ignore() {
        return decoder(3, 4);
      }
      (() => {
        function alias(a, b) {
          return decoder(a - 625, b);
        }
        alias(2, 3);
        (() => {
          function alias2(a, b) {
            return alias(b - -678, a);
          }
          alias2(4, 5);
        })();
      })();
  `);
    traverse(ast, {
      FunctionDeclaration(path) {
        const binding = path.scope.parent.bindings.decoder;
        inlineFunctionAliases(binding);
        path.stop();
      },
    });

    expect(generate(ast)).toMatchSnapshot();
  });
});

// The sandbox is only used to execute string-array decoders, so a dummy
// is enough for inputs without a string array.
const sandbox = () => Promise.resolve(undefined);

async function deobfuscateJS(input: string): Promise<string> {
  return (await deobfuscateWithChanges(input)).code;
}

async function deobfuscateWithChanges(input: string) {
  const ast = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const { changes } = await applyTransformAsync(ast, deobfuscate, sandbox);
  return { code: generate(ast), changes };
}

describe('pipeline without string array', () => {
  test('dead code is removed', async () => {
    await expect(
      deobfuscateJS(`
        if ('a' === 'a') {
          console.log('foo');
        } else {
          console.log('bar');
        }
      `),
    ).resolves.toBe("console.log('foo');");
  });

  test('control flow switch is unwrapped', async () => {
    await expect(
      deobfuscateJS(`
        function f() {
          var d = '0'.split('|');
          var e = 0;
          while (true) {
            switch (d[e++]) {
              case '0':
                if ('a' === 'a') {
                  return 123;
                } else {
                  return 456;
                }
            }
            break;
          }
        }
      `),
    ).resolves.toBe('function f() {\n  return 123;\n}');
  });

  test('control flow object is inlined', async () => {
    await expect(
      deobfuscateJS(`
        console.log(({
          QuFtJ: function (n, r) {
            return n === r;
          }
        }).QuFtJ(u, undefined));
      `),
    ).resolves.toBe('console.log(u === undefined);');
  });

  test('strings are merged', async () => {
    await expect(deobfuscateJS(`console.log('foo' + 'bar');`)).resolves.toBe(
      'console.log("foobar");',
    );
  });
});

describe('pipeline fixpoint', () => {
  test('no phantom changes without inlineable code', async () => {
    // `o.b` is not a known property, so nothing can be inlined and the
    // loop must converge immediately instead of hitting MAX_ITERATIONS.
    const { code, changes } = await deobfuscateWithChanges(
      `const o = {a: 1}; console.log(o.b);`,
    );
    expect(code).toBe(`const o = {\n  a: 1\n};\nconsole.log(o.b);`);
    expect(changes).toBe(0);
  });

  test('inlines object props revealed by dead code removal', async () => {
    // The `o.b` reference blocks inlining until dead code removal deletes
    // it; the next iteration must see refreshed scope info and inline `o.a`.
    const { code, changes } = await deobfuscateWithChanges(
      `const o = {a: 1}; if ('a' === 'b') { console.log(o.b); } console.log(o.a);`,
    );
    expect(code).toBe('console.log(1);');
    // 3 = constant-folding resolves the branch test + dead-code removal +
    // object-prop inlining (the folding used to be counted inside dead-code).
    expect(changes).toBe(3);
  });

  test('ignores violations removed by dead code removal', async () => {
    // `o.a = 2` disappears with the dead branch, so `o` is readonly again
    // and `o.a` inlines to 1 once scope info is refreshed.
    const { code, changes } = await deobfuscateWithChanges(
      `function f(){ const o = {a: 1}; if ('a' === 'b') { o.a = 2; } return o.a; }`,
    );
    expect(code).toBe('function f() {\n  return 1;\n}');
    // 3 = constant-folding resolves the branch test + dead-code removal +
    // object-prop inlining (the folding used to be counted inside dead-code).
    expect(changes).toBe(3);
  });

  test('output is stable when run again', async () => {
    const input = `
      function f() {
        var d = '0'.split('|');
        var e = 0;
        while (true) {
          switch (d[e++]) {
            case '0':
              if ('a' === 'a') {
                return 123;
              } else {
                return 456;
              }
          }
          break;
        }
      }
      if ('b' !== 'b') {
        console.log('dead');
      }
    `;
    const once = await deobfuscateJS(input);
    await expect(deobfuscateJS(once)).resolves.toBe(once);
  });
});
