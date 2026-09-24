import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { webcrack } from 'webcrack';
import { WcError } from '../src/format/errors';
import { evaluateInModule } from '../src/workspace/sandbox';

const OPTS = { timeoutMs: 5000, memoryLimitMb: 128 };

describe('evaluateInModule', () => {
  test('decodes a string via a module-defined function', async () => {
    const code = `var _0xa=['hello','world'];function _0xd(i){return _0xa[i];}`;
    await expect(evaluateInModule(code, '_0xd(1)', OPTS)).resolves.toBe(
      'world',
    );
  });

  test('a module that throws at top level still lets the expression run', async () => {
    const code = `throw new Error('boom');var x = 42;`;
    await expect(evaluateInModule(code, '1 + 1', OPTS)).resolves.toBe('2');
  });

  test('a non-serializable result comes back in its String form', async () => {
    const code = `function decoder(i){return i;}`;
    const result = await evaluateInModule(code, 'decoder', OPTS);
    expect(result).toContain('function');
  });

  test('an infinite loop fails with a timeout error', async () => {
    await expect(
      evaluateInModule('', '(() => { while(true){} })()', {
        ...OPTS,
        timeoutMs: 500,
      }),
    ).rejects.toThrowError(WcError);
    await expect(
      evaluateInModule('', '(() => { while(true){} })()', {
        ...OPTS,
        timeoutMs: 500,
      }),
    ).rejects.toThrowError(/timed out after 500ms/);
  });

  test('a module ending in a line comment with no newline still evaluates', async () => {
    const code = `function _0xd(i){return i * 2;}\n//# sourceMappingURL=x.map`;
    await expect(evaluateInModule(code, '_0xd(21)', OPTS)).resolves.toBe('42');
  });

  test('a module starting with a hashbang still evaluates', async () => {
    const code = `#!/usr/bin/env node\nfunction _0xd(i){return i + 1;}`;
    await expect(evaluateInModule(code, '_0xd(41)', OPTS)).resolves.toBe('42');
  });

  test('a module ending inside an unterminated block comment still evaluates', async () => {
    // sanitizeModuleCode closes the dangling comment, so the expression runs.
    const code = `var x = 40;\n/* trailing comment never closed`;
    await expect(evaluateInModule(code, 'x + 2', OPTS)).resolves.toBe('42');
  });

  test('an ESM module with an exported decoder evaluates', async () => {
    const code = [
      "const _0xa = ['hello', 'world'];",
      'export function _0xd(i) { return _0xa[i]; }',
    ].join('\n');
    await expect(evaluateInModule(code, '_0xd(1)', OPTS)).resolves.toBe(
      'world',
    );
  });

  test('a module with imports still evaluates', async () => {
    const code = [
      "import decode from './decoder.js';",
      "import { a as b } from './other.js';",
      "import * as ns from './ns.js';",
      "import './side-effect.js';",
      'var y = 40;',
    ].join('\n');
    await expect(evaluateInModule(code, 'y + 2', OPTS)).resolves.toBe('42');
    await expect(evaluateInModule(code, 'typeof ns', OPTS)).resolves.toBe(
      'object',
    );
  });

  test('an export-default module evaluates', async () => {
    const code = 'export default function decode(i) { return i * 2; }';
    await expect(evaluateInModule(code, 'decode(21)', OPTS)).resolves.toBe(
      '42',
    );
    const anonymous = 'export default 40 + 2;';
    await expect(
      evaluateInModule(anonymous, 'module.exports.default', OPTS),
    ).resolves.toBe('42');
  });

  test('an anonymous default-exported function evaluates', async () => {
    const code = [
      'export default function () { return 42; }',
      'export const z = 1;',
    ].join('\n');
    await expect(
      evaluateInModule(code, 'module.exports.z', OPTS),
    ).resolves.toBe('1');
    await expect(
      evaluateInModule(code, 'module.exports.default()', OPTS),
    ).resolves.toBe('42');
  });

  test('an anonymous default-exported class evaluates', async () => {
    const code = 'export default class { static v = 7 }';
    await expect(
      evaluateInModule(code, 'module.exports.default.v', OPTS),
    ).resolves.toBe('7');
  });

  test('a non-exported top-level binding in an ESM module is visible', async () => {
    const code = 'const hidden = 5; export const z = hidden + 1;';
    await expect(evaluateInModule(code, 'hidden', OPTS)).resolves.toBe('5');
    await expect(evaluateInModule(code, 'z', OPTS)).resolves.toBe('6');
  });

  test('a CJS top-level const is visible to the expression', async () => {
    const code = 'const hidden = 5; module.exports = hidden;';
    await expect(evaluateInModule(code, 'hidden', OPTS)).resolves.toBe('5');
  });

  test('a script with top-level let and class is visible', async () => {
    const code = 'let a = 1; class C { static v = 2 }';
    await expect(evaluateInModule(code, 'a + C.v', OPTS)).resolves.toBe('3');
  });

  test('an ESM module can call its default export before declaration', async () => {
    const code = [
      'const v = decode(21);',
      'export default function decode(i) { return i * 2; }',
    ].join('\n');
    await expect(evaluateInModule(code, 'v', OPTS)).resolves.toBe('42');
  });

  test('an anonymous default export survives a user __wc_default binding', async () => {
    // The hoisted name is scope-unique, so a user binding of the old
    // reserved name no longer collides with the transpile.
    const code = [
      'const __wc_default = 3;',
      'export default function () { return 42; }',
    ].join('\n');
    await expect(
      evaluateInModule(code, 'module.exports.default.name', OPTS),
    ).resolves.toBe('default');
    await expect(evaluateInModule(code, '__wc_default', OPTS)).resolves.toBe(
      '3',
    );
    await expect(
      evaluateInModule(code, 'module.exports.default()', OPTS),
    ).resolves.toBe('42');
  });

  test('an anonymous default export reports name "default"', async () => {
    await expect(
      evaluateInModule(
        'export default function () { return 42; }',
        'module.exports.default.name',
        OPTS,
      ),
    ).resolves.toBe('default');
    await expect(
      evaluateInModule(
        'export default class { static v = 7 }',
        'module.exports.default.name',
        OPTS,
      ),
    ).resolves.toBe('default');
  });

  test('a top-level for-let keeps block scoping', async () => {
    const code = [
      'var fns = [];',
      'for (let i = 0; i < 3; i++) { fns.push(() => i); }',
    ].join('\n');
    await expect(
      evaluateInModule(code, 'fns.map((g) => g()).join(",")', OPTS),
    ).resolves.toBe('0,1,2');
  });

  test('a for-let inside a function keeps block scoping', async () => {
    const code = [
      'export const z = 0;',
      'function f() {',
      '  const fns = [];',
      '  for (let i = 0; i < 3; i++) { fns.push(() => i); }',
      '  return fns.map((g) => g()).join(",");',
      '}',
    ].join('\n');
    await expect(evaluateInModule(code, 'f()', OPTS)).resolves.toBe('0,1,2');
  });

  test('a real webcrack-unpacked ESM module evaluates', async () => {
    const source = await readFile(
      new URL('../../webcrack/test/corpus/webpack-5.js', import.meta.url),
      'utf8',
    );
    const { bundle } = await webcrack(source);
    const mod = bundle?.modules.get('3');
    expect(mod?.code).toContain('import');
    await expect(evaluateInModule(mod!.code, '1 + 1', OPTS)).resolves.toBe('2');
  });

  test('an injection attempt is rejected before anything runs', async () => {
    await expect(
      evaluateInModule('', '1)}); evil(', OPTS),
    ).rejects.toThrowError(WcError);
  });

  test('a missing isolated-vm becomes an actionable error', async () => {
    const missing = Object.assign(
      new Error("Cannot find module 'isolated-vm-6'"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const sandboxFactory = () => () => Promise.reject<unknown>(missing);
    await expect(
      evaluateInModule('', '1 + 1', { ...OPTS, sandboxFactory }),
    ).rejects.toThrowError(
      'isolated-vm is not available; install it or use wc_read to inspect the decoder manually.',
    );
  });
});
