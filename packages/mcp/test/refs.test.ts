import { describe, expect, test } from 'vitest';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

/** Fixture plus a namespace-import module using `ns.sign(v)`. */
function withNamespace(): Workspace {
  const ws = fixtureWorkspace();
  const code = `import * as ns from "./sign.js";
export function verify(v) {
  return ns.sign(v);
}`;
  ws.modules.set('src/ns.js', {
    path: 'src/ns.js',
    bundleId: '2',
    isEntry: false,
    code,
    tags: [],
  });
  ws.index.symbols.push(
    {
      module: 'src/ns.js',
      name: 'ns',
      kind: 'import',
      line: 1,
      endLine: 1,
      exported: false,
      refCount: 0,
      importedName: '*',
      from: 'src/sign.js',
    },
    {
      module: 'src/ns.js',
      name: 'verify',
      kind: 'function',
      line: 2,
      endLine: 4,
      params: ['v'],
      exported: true,
      refCount: 0,
    },
  );
  ws.index.refs.push({
    module: 'src/ns.js',
    line: 3,
    name: 'ns.sign',
    defModule: 'src/sign.js',
    defLine: 1,
    kind: 'call',
  });
  ws.index.calls.push({
    module: 'src/ns.js',
    line: 3,
    callee: 'ns.sign',
    caller: 'verify',
  });
  ws.index.imports['src/ns.js'] = ['src/sign.js'];
  return ws;
}

describe('wc_refs callers', () => {
  test('bare sign resolves through the import to src/sign.js:1', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_refs', { symbol: 'sign' });
    expect(text).toContain('`sign` defined at src/sign.js:1');
    expect(text).toContain('1 caller');
    expect(text).toContain('src/api.js:5  call  in login');
    expect(text).toContain('```js\nheaders: { "x-sign": sign(user) },\n```');
    expect(text).toMatch(
      /Next: wc_read src\/api\.js:5 · wc_graph kind=calls root=src\/sign\.js:sign$/,
    );
  });

  test('namespace member refs (ns.sign) count as callers', async () => {
    const { call } = await connect(withNamespace());
    const text = await call('wc_refs', { symbol: 'sign' });
    expect(text).toContain('2 callers');
    expect(text).toContain('src/api.js:5  call  in login');
    expect(text).toContain('src/ns.js:3  call  in verify');
    expect(text).toContain('```js\nreturn ns.sign(v);\n```');
  });

  test('from resolves through the using module', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_refs', {
      symbol: 'sign',
      from: 'src/api.js:5',
    });
    expect(text).toContain('`sign` defined at src/sign.js:1');
  });

  test('symbol with 0 refs gives a helpful message plus Next', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_refs', { symbol: 'login' });
    expect(text).toContain('0 callers');
    expect(text).toContain('No recorded uses');
    expect(text).toContain('Next: wc_graph kind=calls root=src/api.js:login');
  });

  test('unknown symbol suggests similar names', async () => {
    const { call } = await connect(fixtureWorkspace());
    await expect(call('wc_refs', { symbol: 'sgin' })).rejects.toThrow(/sign/);
  });
});

describe('wc_refs callees', () => {
  test('login calls fetch, sign, JSON.stringify, localStorage.setItem, *.json', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
    });
    expect(text).toContain('`login` defined at src/api.js:2');
    expect(text).toContain('5 callees');
    expect(text).toContain('src/api.js:3  fetch (unresolved)');
    expect(text).toContain('src/api.js:5  sign → src/sign.js:1');
    expect(text).toContain('src/api.js:6  JSON.stringify (unresolved)');
    expect(text).toContain('src/api.js:8  localStorage.setItem (unresolved)');
    expect(text).toContain('src/api.js:8  *.json (unresolved)');
    expect(text).toMatch(
      /Next: wc_read src\/api\.js:3 · wc_graph kind=calls root=src\/api\.js:login$/,
    );
  });

  test('callees paginate', async () => {
    const { call } = await connect(fixtureWorkspace());
    const first = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
      limit: 2,
    });
    expect(first).toContain('src/api.js:5  sign → src/sign.js:1');
    expect(first).not.toContain('*.json');
    expect(first).toContain('Showing 1-2 of 5. More: offset=2');
    const second = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
      limit: 2,
      offset: 2,
    });
    expect(second).not.toContain('src/api.js:5  sign');
    expect(second).toContain('localStorage.setItem');
    expect(second).toContain('Showing 3-4 of 5. More: offset=4');
    const last = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
      limit: 2,
      offset: 4,
    });
    expect(last).toContain('src/api.js:8  *.json (unresolved)');
    expect(last).not.toContain('More: offset=');
  });

  test('all shows both sections', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_refs', {
      symbol: 'login',
      direction: 'all',
    });
    expect(text).toContain('0 callers, 5 callees');
    expect(text).toContain('Callers of `login` (0):');
    expect(text).toContain('Callees of `login` (5):');
    expect(text).toContain('src/api.js:5  sign → src/sign.js:1');
  });
});
