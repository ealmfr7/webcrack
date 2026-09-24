import { describe, expect, test } from 'vitest';
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
