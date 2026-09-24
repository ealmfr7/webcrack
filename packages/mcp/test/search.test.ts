import { describe, expect, test } from 'vitest';
import { connect, fixtureWorkspace } from './helpers';

async function search(args: Record<string, unknown>): Promise<string> {
  const { call } = await connect(fixtureWorkspace());
  return call('wc_search', args);
}

describe('wc_search kinds', () => {
  test('text finds a case-insensitive substring with context', async () => {
    const text = await search({ query: 'localStorage' });
    expect(text).toContain('1 hit in 1 module');
    expect(text).toContain('src/api.js:8');
    expect(text).toContain('```js');
    expect(text).toContain('Next: wc_read src/api.js:8');
  });

  test('text is case-insensitive', async () => {
    const text = await search({ query: 'LOCALSTORAGE' });
    expect(text).toContain('src/api.js:8');
  });

  test('regex matches a pattern line by line', async () => {
    const text = await search({ query: 'x-\\w+', kind: 'regex' });
    expect(text).toContain('src/api.js:5');
  });

  test('regex accepts the /pattern/flags form', async () => {
    const text = await search({ query: '/x-\\w+/', kind: 'regex' });
    expect(text).toContain('src/api.js:5');
  });

  test('string matches index values by substring', async () => {
    const text = await search({ query: 'api.example', kind: 'string' });
    expect(text).toContain('src/api.js:3');
    expect(text).toContain('https://api.example.com/v1/login');
  });

  test('string accepts a /regex/ query', async () => {
    const text = await search({
      query: '/api\\.example\\.com/',
      kind: 'string',
    });
    expect(text).toContain('src/api.js:3');
  });

  test('identifier finds symbols and refs with their kind', async () => {
    const text = await search({ query: 'sign', kind: 'identifier' });
    expect(text).toContain('src/api.js:1');
    expect(text).toContain('src/sign.js:1');
    expect(text).toContain('src/api.js:5');
    expect(text).toContain('symbol function');
    expect(text).toContain('symbol import');
    expect(text).toContain('ref call');
  });

  test('identifier with quotes matches exactly', async () => {
    const ws = fixtureWorkspace();
    ws.index.symbols.push({
      module: 'src/sign.js',
      name: 'signup',
      kind: 'function',
      line: 1,
      endLine: 3,
      exported: true,
      refCount: 0,
    });
    const { call } = await connect(ws);
    const loose = await call('wc_search', {
      query: 'sign',
      kind: 'identifier',
    });
    expect(loose).toContain('signup');
    const exact = await call('wc_search', {
      query: '"sign"',
      kind: 'identifier',
    });
    expect(exact).not.toContain('signup');
    expect(exact).toContain('src/sign.js:1');
  });

  test('call matches dotted names with * wildcards', async () => {
    const dotted = await search({
      query: 'localStorage.*',
      kind: 'call',
    });
    expect(dotted).toContain('src/api.js:8');
    expect(dotted).toContain('caller login');
    const star = await search({ query: '*.json', kind: 'call' });
    expect(star).toContain('src/api.js:8');
    expect(star).toContain('*.json');
  });

  test('call matches an exact callee', async () => {
    const text = await search({ query: 'fetch', kind: 'call' });
    expect(text).toContain('src/api.js:3');
  });
});

describe('wc_search module filter', () => {
  test('limits results to one module, ./ prefix accepted', async () => {
    const text = await search({ query: 'sign', module: './src/api.js' });
    expect(text).toContain('in 1 module');
    expect(text).toContain('src/api.js');
    expect(text).not.toContain('src/sign.js');
  });

  test('accepts a bundle id', async () => {
    const text = await search({ query: 'btoa', module: '1' });
    expect(text).toContain('src/sign.js:2');
  });

  test('unknown module suggests candidates', async () => {
    await expect(
      search({ query: 'sign', module: 'src/nope.js' }),
    ).rejects.toThrow(/src\/api\.js/);
  });
});

describe('wc_search regex guards', () => {
  test('invalid regex is an actionable error', async () => {
    await expect(search({ query: '(unclosed', kind: 'regex' })).rejects.toThrow(
      /Invalid regex.*kind="text"/,
    );
  });

  test('catastrophic regex on a long line finishes fast', async () => {
    const ws = fixtureWorkspace();
    ws.modules.set('src/long.js', {
      path: 'src/long.js',
      bundleId: '2',
      isEntry: false,
      // The scanned 2 000-char prefix ends with `!` after a long a-run, so
      // the match fails only after heavy backtracking (a single hanging
      // exec that the time budget must interrupt).
      code: `const s = "${'a'.repeat(1985)}!";`,
      tags: [],
    });
    const { call } = await connect(ws);
    const started = Date.now();
    const text = await call('wc_search', {
      query: '(a+)+$',
      kind: 'regex',
    });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(text).toContain('time budget');
  }, 15000);
});

describe('wc_search pagination and output', () => {
  test('page footer tells how to continue', async () => {
    const first = await search({ query: 'a', limit: 2 });
    expect(first).toContain('More: offset=2');
    const second = await search({ query: 'a', limit: 2, offset: 2 });
    expect(second).toContain('Showing 3-');
    expect(second).toContain('More: offset=4');
  });

  test('groups hits under a module header when shorter', async () => {
    // 7 hits across 2 modules: headers cost less than repeating the paths.
    const text = await search({ query: 'a' });
    expect(text).toContain('### src/api.js');
    expect(text).toContain('### src/sign.js');
  });

  test('single hits stay flat', async () => {
    const text = await search({ query: 'localStorage' });
    expect(text).not.toContain('###');
    expect(text).toContain('- src/api.js:8');
  });

  test('no matches suggest wc_map', async () => {
    const text = await search({ query: 'zzz-no-such-thing' });
    expect(text).toContain('No matches');
    expect(text).toContain('Next: wc_map');
  });

  test('kind=ast is delegated to the M2.5 structural search', async () => {
    const text = await search({ query: 'fetch($URL, $$REST)', kind: 'ast' });
    expect(text).toContain('1 hit in 1 module');
    expect(text).toContain('src/api.js:3');
    expect(text).toContain('Next: wc_read src/api.js:3');
  });

  test('kind=ast paginates over the structural hits', async () => {
    const first = await search({ query: '$X', kind: 'ast', limit: 2 });
    expect(first).toContain('More: offset=2');
  });

  test('kind=ast with an unparseable pattern is an actionable error', async () => {
    await expect(search({ query: '((( ', kind: 'ast' })).rejects.toThrow(
      /Invalid AST pattern/,
    );
  });
});
