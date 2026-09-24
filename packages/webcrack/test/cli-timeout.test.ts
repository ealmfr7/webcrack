import { describe, expect, test } from 'vitest';
import { validateLLMFlags } from '../src/cli-lib';

const MESSAGE = '--llm-timeout must be a positive integer';

// The --llm-timeout commander parser is `(value) => Number(value)`, so
// validateLLMFlags receives either the raw string (direct API use) or its
// Number() conversion (CLI use). Both forms are covered below.
describe('strict --llm-timeout parsing', () => {
  test.each([
    ['1e4', 10000],
    ['0x10', 16],
    [' 100 ', 100],
  ] as Array<[string, number]>)('accepts %p as %p', (raw, parsed) => {
    expect(Number(raw)).toBe(parsed);
    expect(
      validateLLMFlags({ llmRenameCommand: 'cmd', llmTimeout: raw }),
    ).toBeUndefined();
    expect(
      validateLLMFlags({ llmRenameCommand: 'cmd', llmTimeout: parsed }),
    ).toBeUndefined();
  });

  test.each(['10s', '', 'abc', 0, -5, 1.5])(
    'rejects --llm-timeout %p',
    (llmTimeout) => {
      expect(validateLLMFlags({ llmRenameCommand: 'cmd', llmTimeout })).toBe(
        MESSAGE,
      );
      expect(
        validateLLMFlags({
          llmRenameCommand: 'cmd',
          llmTimeout:
            typeof llmTimeout === 'string' ? Number(llmTimeout) : llmTimeout,
        }),
      ).toBe(MESSAGE);
    },
  );

  test('accepts 2147483647', () => {
    expect(
      validateLLMFlags({
        llmRenameCommand: 'cmd',
        llmTimeout: 2147483647,
      }),
    ).toBeUndefined();
    expect(
      validateLLMFlags({
        llmRenameCommand: 'cmd',
        llmTimeout: '2147483647',
      }),
    ).toBeUndefined();
  });

  test('rejects 2147483648', () => {
    expect(
      validateLLMFlags({
        llmRenameCommand: 'cmd',
        llmTimeout: 2147483648,
      }),
    ).toBe(MESSAGE);
    expect(
      validateLLMFlags({
        llmRenameCommand: 'cmd',
        llmTimeout: '2147483648',
      }),
    ).toBe(MESSAGE);
  });
});
