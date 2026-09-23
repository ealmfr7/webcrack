import { expect, test } from 'vitest';
import { suggest } from '../src/format/errors';
import { numberLines, paginate, textResult } from '../src/format/response';

test('paginate tells how to get the next page', () => {
  const page = paginate([1, 2, 3, 4, 5], 2, 0);
  expect(page.items).toEqual([1, 2]);
  expect(page.footer).toBe('Showing 1-2 of 5. More: offset=2');
  expect(paginate([1, 2], 2, 0).footer).toBeUndefined();
});

test('numberLines pads line numbers', () => {
  expect(numberLines('a\nb', 9)).toBe(' 9 │ a\n10 │ b');
});

test('textResult truncates over budget and appends next steps', () => {
  const result = textResult('line1\nline2\nline3', {
    budget: 12,
    next: ['wc_map'],
  });
  const { text } = result.content[0] as { text: string };
  expect(text).toMatch(/^line1\nline2\n… truncated/);
  expect(text).toMatch(/Next: wc_map$/);
});

test('suggest ranks close names first', () => {
  expect(suggest('fetchUsr', ['render', '_fetch', 'fetchUser'])).toEqual([
    'fetchUser',
    '_fetch',
  ]);
  expect(suggest('fetch', ['fetchUser', 'render', '_fetch'])).toEqual([
    '_fetch',
    'fetchUser',
  ]);
});
