import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from 'vitest';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

/** Fixture + a module aliasing the `sign` import (`s` -> `src/sign.js:sign`). */
function aliasedWorkspace(): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.set('src/alias.js', {
    path: 'src/alias.js',
    bundleId: '2',
    isEntry: false,
    code: 'import { sign as s } from "./sign.js";\nexport const t = s;',
    tags: [],
  });
  ws.index.symbols.push({
    module: 'src/alias.js',
    name: 's',
    kind: 'import',
    line: 1,
    endLine: 1,
    exported: false,
    refCount: 0,
    importedName: 'sign',
    from: 'src/sign.js',
  });
  ws.index.symbols.push({
    module: 'src/alias.js',
    name: 't',
    kind: 'variable',
    line: 2,
    endLine: 2,
    exported: true,
    refCount: 0,
  });
  return ws;
}

test('bare sign resolves through the import to src/sign.js:1', async () => {
  const { call } = await connect(fixtureWorkspace());
  const out = await call('wc_goto', { symbol: 'sign' });
  expect(out).toContain('src/sign.js:1');
  expect(out).toContain('function sign(value)');
  expect(out).toContain('exported');
  expect(out).toContain('1 ref');
  expect(out).toContain('```js');
  expect(out).toContain('btoa');
  expect(out).toContain(
    'Next: wc_read src/sign.js:sign · wc_refs src/sign.js:sign',
  );
});

test('login shows params and refCount', async () => {
  const { call } = await connect(fixtureWorkspace());
  const out = await call('wc_goto', { symbol: 'login' });
  expect(out).toContain('src/api.js:2');
  expect(out).toContain('function login(user, pass)');
  expect(out).toContain('0 refs');
});

test('an alias import is followed to the real definition', async () => {
  const { call } = await connect(aliasedWorkspace());
  const out = await call('wc_goto', { symbol: 'src/alias.js:s' });
  expect(out).toContain('src/sign.js:1');
  expect(out).toContain('function sign(value)');
});

test('from resolves through the using module', async () => {
  const { call } = await connect(fixtureWorkspace());
  const out = await call('wc_goto', {
    symbol: 'sign',
    from: 'src/api.js:5',
  });
  expect(out).toContain('src/sign.js:1');
});

test('unknown names give suggestions', async () => {
  const { client } = await connect(fixtureWorkspace());
  const result = (await client.callTool({
    name: 'wc_goto',
    arguments: { symbol: 'sing' },
  })) as CallToolResult;
  expect(result.isError).toBe(true);
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  expect(text).toContain('Unknown symbol');
  expect(text).toContain('sign');
});
