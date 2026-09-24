import { describe, expect, test } from 'vitest';
import { connect, fixtureWorkspace } from './helpers';

const LONG_LINE = `${'a'.repeat(500)}NEEDLE${'b'.repeat(200)}`;

function setup() {
  const ws = fixtureWorkspace();
  ws.modules.set('src/alias.js', {
    path: 'src/alias.js',
    bundleId: '2',
    isEntry: false,
    code: 'import { sign as s } from "./sign.js";\nconsole.log(s("x"));\n',
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
  ws.index.imports['src/alias.js'] = ['src/sign.js'];
  ws.annotations.push({
    symbol: 'src/api.js:login',
    rename: 'checkLogin',
    note: 'handles auth',
  });
  // A long original line (line 13) that has no module counterpart.
  ws.original = `${ws.original}\n${LONG_LINE}`;
  const big = Array.from(
    { length: 600 },
    (_, i) => `const v${i} = ${i}; // padding to grow the module body`,
  ).join('\n');
  ws.modules.set('src/big.js', {
    path: 'src/big.js',
    bundleId: '3',
    isEntry: false,
    code: big,
    tags: [],
  });
  ws.index.imports['src/big.js'] = [];
  return ws;
}

describe('wc_read clean', () => {
  test('module target returns the whole module, fenced and numbered', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'src/api.js' });
    expect(text).toContain('src/api.js:1-9 (clean)');
    expect(text).toContain('```js');
    expect(text).toContain('1 │ import { sign } from "./sign.js";');
    expect(text).toContain('Next: wc_outline src/api.js');
  });

  test('./ prefix and bundle id resolve like the plain path', async () => {
    const { call } = await connect(setup());
    const plain = await call('wc_read', { target: 'src/api.js' });
    expect(await call('wc_read', { target: './src/api.js' })).toBe(plain);
    const sign = await call('wc_read', { target: 'src/sign.js' });
    expect(await call('wc_read', { target: '1' })).toBe(sign);
  });

  test('line target applies ± context', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', {
      target: 'src/api.js:5',
      context: 2,
    });
    expect(text).toContain('src/api.js:3-7 (clean)');
    expect(text).toContain('5 │');
    expect(text).toContain('sign(user)');
    expect(text).not.toContain('9 │');
  });

  test('range target is exact', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'src/api.js:3-4' });
    expect(text).toContain('src/api.js:3-4 (clean)');
    expect(text).toContain('3 │');
    expect(text).toContain('4 │');
    expect(text).not.toContain('5 │');
  });

  test('module:symbol shows signature, notes and a Refs line', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'src/api.js:login' });
    expect(text).toContain(
      'src/api.js:2-9 (clean) · function login(user, pass)',
    );
    expect(text).toContain(
      'Note on login: renamed to checkLogin · handles auth',
    );
    expect(text).toContain(
      'Refs: called/referenced from 0 places (wc_refs src/api.js:login)',
    );
    expect(text).toContain('Next: wc_refs src/api.js:login');
  });

  test('bare symbol resolves to its definition', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'login' });
    expect(text).toContain('src/api.js:2-9 (clean)');
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
    const text = await call('wc_read', { target: 'src/api.js:checkLogin' });
    expect(text).toContain(
      'Note on checkLogin: originally login · handles auth',
    );
    expect(text).not.toContain('renamed to checkLogin');
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
    const text = await call('wc_read', { target: '3.js:deriveKey2' });
    expect(text).toContain(
      'Note on deriveKey2: originally computeKey · key derivation',
    );
    expect(text).not.toContain('renamed to deriveKey2');
  });

  test('an old name still reads the current symbol through the annotation', async () => {
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
    const text = await call('wc_read', { target: 'src/api.js:login' });
    expect(text).toContain('src/api.js:2-9 (clean)');
    expect(text).toContain('handles auth');
  });

  test('alias import is followed to its definition', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'src/alias.js:s' });
    expect(text).toContain('src/sign.js:1-3 (clean) · function sign(value)');
    expect(text).toContain('return btoa(value + "s3cr3t");');
  });

  test('out-of-range lines give an actionable error', async () => {
    const { call } = await connect(setup());
    await expect(call('wc_read', { target: 'src/api.js:99' })).rejects.toThrow(
      'src/api.js has 9 lines; valid range 1-9.',
    );
  });

  test('whole modules over budget are truncated with a range hint', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', { target: 'src/big.js' });
    expect(text).toContain('src/big.js:1-600 (clean)');
    expect(text).toContain('… truncated (');
    expect(text).toContain('smaller line range');
  });
});

describe('wc_read raw', () => {
  test('N reads the original input by its own line numbers', async () => {
    const { call } = await connect(setup());
    // The fixture original is API + '\n' + SIGN, so original line 10 is
    // sign.js line 1 — raw and module numbers do not line up.
    const text = await call('wc_read', {
      target: '10',
      view: 'raw',
      context: 0,
    });
    expect(text).toContain('original:10-10 (raw)');
    expect(text).toContain('10 │ export function sign(value) {');
  });

  test('N-M and raw:N-M ranges', async () => {
    const { call } = await connect(setup());
    const range = await call('wc_read', {
      target: '10-11',
      view: 'raw',
    });
    expect(range).toContain('original:10-11 (raw)');
    expect(range).toContain('11 │');
    const prefixed = await call('wc_read', {
      target: 'raw:10-12',
      view: 'raw',
    });
    expect(prefixed).toContain('original:10-12 (raw)');
    expect(prefixed).toContain('12 │ }');
  });

  test('anything else in raw mode is an actionable error', async () => {
    const { call } = await connect(setup());
    await expect(
      call('wc_read', { target: 'src/api.js:1', view: 'raw' }),
    ).rejects.toThrow('Invalid raw target');
    await expect(
      call('wc_read', { target: 'login', view: 'raw' }),
    ).rejects.toThrow('N-M');
  });

  test('out-of-range raw lines give an actionable error', async () => {
    const { call } = await connect(setup());
    await expect(
      call('wc_read', { target: '99', view: 'raw' }),
    ).rejects.toThrow('Original input has 13 lines; valid range 1-13.');
  });

  test('lines longer than 400 chars are cut', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', {
      target: '13',
      view: 'raw',
      context: 0,
    });
    expect(text).not.toContain('NEEDLE');
    expect(text).toContain(`… (+${LONG_LINE.length - 400} chars)`);
  });

  test('column centers a 400-char window on single-line targets', async () => {
    const { call } = await connect(setup());
    const text = await call('wc_read', {
      target: '13',
      view: 'raw',
      context: 0,
      column: 503,
    });
    expect(text).toContain('NEEDLE');
    expect(text).toContain(`(+${LONG_LINE.length - 400} chars)`);
  });
});
