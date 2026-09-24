import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_OUTPUT_BUDGET,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
} from '../src/config';

test('defaults are correct when env is empty', () => {
  expect(loadConfig({})).toEqual({
    roots: [process.cwd()],
    cacheDir: join(homedir(), '.cache', 'webcrack-mcp'),
    maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputBudget: DEFAULT_OUTPUT_BUDGET,
  });
  expect(DEFAULT_MAX_INPUT_BYTES).toBe(20 * 1024 * 1024);
  expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
  expect(DEFAULT_OUTPUT_BUDGET).toBe(20_000);
});

test('helpers-style call with only ROOTS keeps working', () => {
  const config = loadConfig({ WEBCRACK_MCP_ROOTS: process.cwd() });
  expect(config.roots).toEqual([process.cwd()]);
  expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
});

describe.each([
  ['WEBCRACK_MCP_TIMEOUT_MS', 'milliseconds', '120000'],
  ['WEBCRACK_MCP_OUTPUT_BUDGET', 'characters', '20000'],
] as const)('%s', (name, unit, defaultText) => {
  test('accepts a valid positive integer', () => {
    const config = loadConfig({ [name]: '5000' });
    const key =
      name === 'WEBCRACK_MCP_TIMEOUT_MS' ? 'timeoutMs' : 'outputBudget';
    expect(config[key]).toBe(5000);
  });

  test.each(['', '   '])('empty string %j falls back to the default', (raw) => {
    const config = loadConfig({ [name]: raw });
    const key =
      name === 'WEBCRACK_MCP_TIMEOUT_MS' ? 'timeoutMs' : 'outputBudget';
    expect(config[key]).toBe(Number(defaultText));
  });

  test.each(['abc', '0', '-5', '1.5', '12ms'])(
    'invalid value %j throws a clear error',
    (raw) => {
      expect(() => loadConfig({ [name]: raw })).toThrowError(
        new RegExp(
          `Invalid ${name}="${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": expected a positive integer \\(${unit}\\)\\. Default: ${defaultText}\\.`,
        ),
      );
    },
  );

  test('error message names the variable, value and expected format', () => {
    try {
      loadConfig({ [name]: 'abc' });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(name);
      expect(message).toContain('"abc"');
      expect(message).toContain('expected a positive integer');
      expect(message).toContain(`Default: ${defaultText}`);
    }
  });
});

describe('WEBCRACK_MCP_MAX_INPUT', () => {
  test('accepts a valid byte count', () => {
    expect(loadConfig({ WEBCRACK_MCP_MAX_INPUT: '1024' }).maxInputBytes).toBe(
      1024,
    );
  });

  test.each(['5mb', '5MB', '512kb', '1gb', '100b'])(
    'accepts size suffix %j',
    (raw) => {
      const multipliers: Record<string, number> = {
        '5mb': 5 * 1024 ** 2,
        '5MB': 5 * 1024 ** 2,
        '512kb': 512 * 1024,
        '1gb': 1024 ** 3,
        '100b': 100,
      };
      expect(loadConfig({ WEBCRACK_MCP_MAX_INPUT: raw }).maxInputBytes).toBe(
        multipliers[raw],
      );
    },
  );

  test.each(['', '   '])('empty string %j falls back to the default', (raw) => {
    expect(loadConfig({ WEBCRACK_MCP_MAX_INPUT: raw }).maxInputBytes).toBe(
      DEFAULT_MAX_INPUT_BYTES,
    );
  });

  test.each(['abc', '0', '-5', '1.5', '10tb', '0mb'])(
    'invalid value %j throws a clear error',
    (raw) => {
      expect(() => loadConfig({ WEBCRACK_MCP_MAX_INPUT: raw })).toThrowError(
        new RegExp(
          `Invalid WEBCRACK_MCP_MAX_INPUT="${raw}": expected a positive integer.*Default: ${DEFAULT_MAX_INPUT_BYTES}\\.`,
        ),
      );
    },
  );
});

describe('WEBCRACK_MCP_ROOTS', () => {
  test('splits on the path delimiter and resolves to absolute paths', () => {
    const config = loadConfig({
      WEBCRACK_MCP_ROOTS: ['/tmp/a', '/tmp/b'].join(delimiter),
    });
    expect(config.roots).toEqual([resolve('/tmp/a'), resolve('/tmp/b')]);
  });

  test('ignores empty segments', () => {
    const config = loadConfig({
      WEBCRACK_MCP_ROOTS: ['', '/tmp/a', '', '/tmp/b', ''].join(delimiter),
    });
    expect(config.roots).toEqual([resolve('/tmp/a'), resolve('/tmp/b')]);
  });

  test('resolves relative entries against the cwd', () => {
    const config = loadConfig({ WEBCRACK_MCP_ROOTS: 'sub/dir' });
    expect(config.roots).toEqual([resolve('sub/dir')]);
  });

  test.each([undefined, '', '   '])(
    'missing or empty %j falls back to the cwd',
    (raw) => {
      const env = raw === undefined ? {} : { WEBCRACK_MCP_ROOTS: raw };
      expect(loadConfig(env).roots).toEqual([process.cwd()]);
    },
  );
});

describe('WEBCRACK_MCP_TIMEOUT_MS', () => {
  test.each(['2147483648', '9999999999', '9007199254740991'])(
    'overflow value %j is rejected (would overflow setTimeout)',
    (raw) => {
      expect(() => loadConfig({ WEBCRACK_MCP_TIMEOUT_MS: raw })).toThrowError(
        `Invalid WEBCRACK_MCP_TIMEOUT_MS="${raw}": expected a positive integer (milliseconds). Default: ${DEFAULT_TIMEOUT_MS}.`,
      );
    },
  );

  test('accepts the maximum 32-bit signed value', () => {
    expect(
      loadConfig({ WEBCRACK_MCP_TIMEOUT_MS: '2147483647' }).timeoutMs,
    ).toBe(2147483647);
  });
});

describe('WEBCRACK_MCP_CACHE', () => {
  test('uses the given directory', () => {
    expect(loadConfig({ WEBCRACK_MCP_CACHE: '/tmp/wc-cache' }).cacheDir).toBe(
      resolve('/tmp/wc-cache'),
    );
  });

  test('resolves a relative directory against the cwd', () => {
    expect(loadConfig({ WEBCRACK_MCP_CACHE: 'sub/cache' }).cacheDir).toBe(
      resolve('sub/cache'),
    );
  });

  test.each([undefined, '', '   '])(
    'missing or empty %j falls back to the default',
    (raw) => {
      const env = raw === undefined ? {} : { WEBCRACK_MCP_CACHE: raw };
      expect(loadConfig(env).cacheDir).toBe(
        join(homedir(), '.cache', 'webcrack-mcp'),
      );
    },
  );
});
