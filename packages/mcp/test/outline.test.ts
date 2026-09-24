import { describe, expect, test } from 'vitest';
import { connect, fixtureWorkspace } from './helpers';

function setup() {
  const ws = fixtureWorkspace();
  ws.modules.set('src/multi.js', {
    path: 'src/multi.js',
    bundleId: '2',
    isEntry: false,
    code: 'import { login } from "./api.js";\nimport d from "./sign.js";\nexport function run() {}\n',
    tags: [],
  });
  ws.index.symbols.push(
    {
      module: 'src/multi.js',
      name: 'login',
      kind: 'import',
      line: 1,
      endLine: 1,
      exported: false,
      refCount: 0,
      importedName: 'login',
      from: 'src/api.js',
    },
    {
      module: 'src/multi.js',
      name: 'd',
      kind: 'import',
      line: 2,
      endLine: 2,
      exported: false,
      refCount: 0,
      importedName: 'default',
      from: 'src/sign.js',
    },
    {
      module: 'src/multi.js',
      name: 'run',
      kind: 'function',
      line: 3,
      endLine: 5,
      params: [],
      exported: true,
      refCount: 2,
    },
  );
  ws.index.imports['src/multi.js'] = ['src/api.js', 'src/sign.js'];
  ws.annotations.push({
    symbol: 'src/api.js:login',
    rename: 'checkLogin',
    note: 'handles auth',
  });
  return ws;
}

describe('wc_outline', () => {
  test('lists symbols with line, kind, params, exported, refCount and import source', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_outline', { module: 'src/api.js' });
    expect(text).toContain('src/api.js · 2 symbols (concise)');
    expect(text).toContain('1 imports (1): sign from src/sign.js');
    expect(text).toContain(
      '2-9 function login(user, pass) [exported] · refs: 0',
    );
    expect(text).toContain('```');
    expect(text).toContain('Next: wc_read src/api.js:login');

    const full = await call('wc_outline', {
      module: 'src/api.js',
      detail: 'full',
    });
    expect(full).toContain('1 import sign from src/sign.js · refs: 0');
  });

  test('shows annotations with rename and note', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_outline', { module: 'src/api.js' });
    expect(text).toContain('renamed to checkLogin');
    expect(text).toContain('handles auth');
  });

  test('a re-keyed annotation shows on the current name', async () => {
    const ws = fixtureWorkspace();
    const login = ws.index.symbols.find(
      (s) => s.module === 'src/api.js' && s.name === 'login',
    );
    expect(login).toBeDefined();
    if (login) login.name = 'checkLogin';
    ws.annotations = [];
    ws.annotations.push({
      symbol: 'src/api.js:checkLogin',
      rename: 'checkLogin',
      originalName: 'login',
      note: 'handles auth',
    });
    const { call } = await connect(ws);
    const text = await call('wc_outline', { module: 'src/api.js' });
    expect(text).toContain('function checkLogin(user, pass)');
    expect(text).toContain('originally login');
    expect(text).not.toContain('renamed to checkLogin');
    expect(text).toContain('handles auth');
  });

  test('a double rename shows the first name as originally', async () => {
    const ws = fixtureWorkspace();
    ws.modules.set('3.js', {
      path: '3.js',
      bundleId: '3',
      isEntry: false,
      code: 'export function deriveKey2() {}\n',
      tags: [],
    });
    ws.index.symbols.push({
      module: '3.js',
      name: 'deriveKey2',
      kind: 'function',
      line: 1,
      endLine: 1,
      params: [],
      exported: true,
      refCount: 0,
    });
    ws.index.imports['3.js'] = [];
    ws.annotations = [];
    ws.annotations.push({
      symbol: '3.js:deriveKey2',
      rename: 'deriveKey2',
      originalName: 'computeKey',
      note: 'key derivation',
    });
    const { call } = await connect(ws);
    const text = await call('wc_outline', { module: '3.js' });
    expect(text).toContain('function deriveKey2()');
    expect(text).toContain('originally computeKey');
    expect(text).not.toContain('renamed to deriveKey2');
    expect(text).toContain('key derivation');
  });

  test('a pre-rekey entry still shows on the new name via its rename', async () => {
    const ws = fixtureWorkspace();
    const login = ws.index.symbols.find(
      (s) => s.module === 'src/api.js' && s.name === 'login',
    );
    expect(login).toBeDefined();
    if (login) login.name = 'checkLogin';
    ws.annotations = [];
    ws.annotations.push({
      symbol: 'src/api.js:login',
      rename: 'checkLogin',
      note: 'handles auth',
    });
    const { call } = await connect(ws);
    const text = await call('wc_outline', { module: 'src/api.js' });
    expect(text).toContain('function checkLogin(user, pass)');
    expect(text).toContain('handles auth');
  });

  test('resolves ./ prefix and bundle id like the plain path', async () => {
    const { call } = await connect(setup());
    const plain = await call('wc_outline', { module: 'src/api.js' });
    expect(await call('wc_outline', { module: './src/api.js' })).toBe(plain);
    expect(await call('wc_outline', { module: '0' })).toBe(plain);
  });

  test('concise groups imports on one line, full lists everything', async () => {
    const { call } = await connect(setup());
    const concise = await call('wc_outline', { module: 'src/multi.js' });
    expect(concise).toContain(
      'imports (2): login from src/api.js, d (default from src/sign.js)',
    );
    expect(concise).toContain('3-5 function run() [exported] · refs: 2');

    const full = await call('wc_outline', {
      module: 'src/multi.js',
      detail: 'full',
    });
    expect(full).not.toContain('imports (2)');
    expect(full).toContain('1 import login from src/api.js · refs: 0');
    expect(full).toContain('2 import d (default from src/sign.js) · refs: 0');
  });

  test('paginates with limit/offset', async () => {
    const { call } = await connect(setup());
    const first = await call('wc_outline', {
      module: 'src/multi.js',
      detail: 'full',
      limit: 1,
    });
    expect(first).toContain('More: offset=1');
    const second = await call('wc_outline', {
      module: 'src/multi.js',
      detail: 'full',
      limit: 1,
      offset: 1,
    });
    expect(second).toContain('2 import d (default from src/sign.js)');
    expect(second).not.toContain('1 import login');
  });

  test('unknown module is an actionable error', async () => {
    const { call } = await connect(setup());
    await expect(call('wc_outline', { module: 'src/nope.js' })).rejects.toThrow(
      'src/api.js',
    );
  });

  test('long listings are budgeted', async () => {
    const ws = setup();
    ws.modules.set('src/big.js', {
      path: 'src/big.js',
      bundleId: '3',
      isEntry: false,
      code: '',
      tags: [],
    });
    for (let i = 0; i < 700; i++) {
      ws.index.symbols.push({
        module: 'src/big.js',
        name: `fn${i}`,
        kind: 'function',
        line: i + 1,
        endLine: i + 3,
        params: ['a', 'b'],
        exported: i % 2 === 0,
        refCount: i,
      });
    }
    const { call } = await connect(ws);
    const text = await call('wc_outline', {
      module: 'src/big.js',
      detail: 'full',
      limit: 500,
    });
    expect(text).toContain('… truncated (');
    expect(text).toContain('Next: wc_read src/big.js:fn0');
  });
});
