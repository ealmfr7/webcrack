import type { Report } from 'webcrack/analysis';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import type { ToolContext } from '../src/tools/define';
import { diff } from '../src/tools/diff';
import { WorkspaceStore } from '../src/workspace/store';
import type { Workspace } from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

const CRYPTO = `export function verify(input) {
  return btoa(input + "s3cr3t");
}`;

const API_V2 = `import { sign } from "./crypto.js";
export async function authenticate(user, pass) {
  const res = await fetch("https://api.example.com/v1/login", {
    method: "POST",
    headers: { "x-sign": sign(user) },
    body: JSON.stringify({ user, pass }),
  });
  localStorage.setItem("token", (await res.json()).token);
}
export async function logout(token) {
  await fetch("https://api.example.com/v2/logout", { method: "POST", body: token });
}`;

const NEW_MODULE = 'export const version = "2.0";\n';

const EMPTY_REPORT: Report = {
  urls: [],
  endpoints: [],
  secrets: [],
  regexes: [],
  interesting: [],
};

const API_V2_REPORT: Report = {
  urls: [
    { value: 'https://api.example.com/v1/login', line: 3, column: 26 },
    { value: 'https://api.example.com/v2/logout', line: 11, column: 20 },
  ],
  endpoints: [
    {
      method: 'POST',
      url: 'https://api.example.com/v1/login',
      line: 3,
      column: 20,
    },
    {
      method: 'POST',
      url: 'https://api.example.com/v2/logout',
      line: 11,
      column: 12,
    },
  ],
  secrets: [],
  regexes: [],
  interesting: [],
};

/** Clone of the fixture evolved into a "v2": module added, module renamed
 * with its identifiers renamed, one module changed, one endpoint added,
 * one secret removed, one tag dropped. */
function evolvedWorkspace(): Workspace {
  const ws = structuredClone(fixtureWorkspace());
  ws.id = 'fixture2';

  const api = need(ws.modules.get('src/api.js'), 'src/api.js');
  api.code = API_V2;
  api.tags = ['network', 'auth'];

  ws.modules.delete('src/sign.js');
  ws.modules.set('src/crypto.js', {
    path: 'src/crypto.js',
    bundleId: '1',
    isEntry: false,
    code: CRYPTO,
    tags: ['crypto'],
  });
  ws.modules.set('src/new.js', {
    path: 'src/new.js',
    bundleId: '2',
    isEntry: false,
    code: NEW_MODULE,
    tags: [],
  });

  ws.index.symbols = [
    {
      module: 'src/api.js',
      name: 'sign',
      kind: 'import',
      line: 1,
      endLine: 1,
      exported: false,
      refCount: 0,
      importedName: 'sign',
      from: 'src/crypto.js',
    },
    {
      module: 'src/api.js',
      name: 'authenticate',
      kind: 'function',
      line: 2,
      endLine: 9,
      params: ['user', 'pass'],
      exported: true,
      refCount: 0,
    },
    {
      module: 'src/api.js',
      name: 'logout',
      kind: 'function',
      line: 10,
      endLine: 12,
      params: ['token'],
      exported: true,
      refCount: 0,
    },
    {
      module: 'src/crypto.js',
      name: 'verify',
      kind: 'function',
      line: 1,
      endLine: 3,
      params: ['input'],
      exported: true,
      refCount: 1,
    },
    {
      module: 'src/new.js',
      name: 'version',
      kind: 'variable',
      line: 1,
      endLine: 1,
      exported: true,
      refCount: 0,
    },
  ];
  ws.index.calls = [
    {
      module: 'src/api.js',
      line: 3,
      callee: 'fetch',
      caller: 'authenticate',
    },
    {
      module: 'src/api.js',
      line: 5,
      callee: 'sign',
      caller: 'authenticate',
    },
    {
      module: 'src/api.js',
      line: 6,
      callee: 'JSON.stringify',
      caller: 'authenticate',
    },
    {
      module: 'src/api.js',
      line: 8,
      callee: 'localStorage.setItem',
      caller: 'authenticate',
    },
    {
      module: 'src/api.js',
      line: 8,
      callee: '*.json',
      caller: 'authenticate',
    },
    { module: 'src/api.js', line: 11, callee: 'fetch', caller: 'logout' },
    { module: 'src/crypto.js', line: 2, callee: 'btoa', caller: 'verify' },
  ];
  ws.index.strings = [
    { module: 'src/api.js', line: 1, value: './crypto.js' },
    {
      module: 'src/api.js',
      line: 3,
      value: 'https://api.example.com/v1/login',
    },
    { module: 'src/api.js', line: 4, value: 'POST' },
    { module: 'src/api.js', line: 8, value: 'token' },
    {
      module: 'src/api.js',
      line: 11,
      value: 'https://api.example.com/v2/logout',
    },
    { module: 'src/api.js', line: 11, value: 'POST' },
    { module: 'src/crypto.js', line: 2, value: 's3cr3t' },
    { module: 'src/new.js', line: 1, value: '2.0' },
  ];
  ws.index.refs = [
    {
      module: 'src/api.js',
      line: 5,
      name: 'sign',
      defModule: 'src/crypto.js',
      defLine: 1,
      kind: 'call',
    },
  ];
  ws.index.imports = {
    'src/api.js': ['src/crypto.js'],
    'src/crypto.js': [],
    'src/new.js': [],
  };

  ws.report['src/api.js'] = API_V2_REPORT;
  delete ws.report['src/sign.js'];
  ws.report['src/crypto.js'] = structuredClone(EMPTY_REPORT);
  ws.report['src/new.js'] = structuredClone(EMPTY_REPORT);

  return ws;
}

function need<T>(value: T | undefined, what: string): T {
  expect(value, `expected ${what} to exist`).toBeDefined();
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function makeCtx(): ToolContext {
  const config = loadConfig({ WEBCRACK_MCP_ROOTS: process.cwd() });
  const store = new WorkspaceStore(config);
  store.add(fixtureWorkspace());
  store.add(evolvedWorkspace());
  return { store, config, progress: () => Promise.resolve() };
}

async function diffText(
  ctx: ToolContext,
  args: {
    a: string;
    b: string;
    detail: 'concise' | 'full';
    limit: number;
    offset: number;
  },
): Promise<string> {
  const result = await diff.handler(args, ctx);
  return result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

const CONCISE = { detail: 'concise' as const, limit: 30, offset: 0 };

describe('wc_diff', () => {
  test('module changes: added, changed, renamed with renamed identifiers', async () => {
    const text = await diffText(makeCtx(), {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
    });
    expect(text).toContain('Diff fixture1 → fixture2');
    expect(text).toContain('1 added');
    expect(text).toContain('0 removed');
    expect(text).toContain('1 changed');
    expect(text).toContain('1 renamed');
    expect(text).toContain('0 unchanged');
    expect(text).toContain('`src/new.js`');
    expect(text).toContain('`src/api.js`');
    // Same structure under a new path, despite renamed identifiers.
    expect(text).toContain('`src/sign.js` => `src/crypto.js`');
    expect(text).toMatch(/Next: wc_read src\/api\.js/);
  });

  test('findings delta: endpoint and url added, secret removed masked', async () => {
    const text = await diffText(makeCtx(), {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
    });
    expect(text).toContain('Endpoints added');
    expect(text).toContain('POST https://api.example.com/v2/logout');
    expect(text).toContain('URLs added');
    expect(text).toContain('Secrets removed');
    expect(text).toContain('ht…in');
    // The raw secret value must not leak anywhere in the output.
    expect(text).not.toContain('https://api.example.com/v1/login');
  });

  test('tags delta per module', async () => {
    const text = await diffText(makeCtx(), {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
    });
    expect(text).toContain('Tags changed');
    expect(text).toContain('[network, auth, storage] → [network, auth]');
  });

  test('full detail lists symbols added and removed in changed modules', async () => {
    const ctx = makeCtx();
    const full = await diffText(ctx, {
      a: 'fixture1',
      b: 'fixture2',
      detail: 'full',
      limit: 30,
      offset: 0,
    });
    expect(full).toContain('Symbols');
    expect(full).toContain('+ `authenticate`');
    expect(full).toContain('+ `logout`');
    expect(full).toContain('- `login`');

    const concise = await diffText(ctx, {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
    });
    expect(concise).not.toContain('Symbols');
    expect(concise).not.toContain('authenticate');
  });

  test('module lists are paginated', async () => {
    const ctx = makeCtx();
    const first = await diffText(ctx, {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
      limit: 1,
    });
    expect(first).toContain('`src/new.js`');
    expect(first).toContain('More: offset=1');
    const second = await diffText(ctx, {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
      limit: 1,
      offset: 1,
    });
    expect(second).toContain('Changed modules');
    expect(second).toContain('More: offset=2');
    const last = await diffText(ctx, {
      a: 'fixture1',
      b: 'fixture2',
      ...CONCISE,
      limit: 1,
      offset: 2,
    });
    expect(last).toContain('Renamed modules');
    expect(last).not.toContain('More:');
  });

  test('the same workspace twice reports no differences', async () => {
    const text = await diffText(makeCtx(), {
      a: 'fixture1',
      b: 'fixture1',
      ...CONCISE,
    });
    expect(text).toContain('no differences');
  });

  test('an unknown workspace id is an error', async () => {
    await expect(
      diffText(makeCtx(), { a: 'missing', b: 'fixture1', ...CONCISE }),
    ).rejects.toThrow('Unknown workspace');
  });
});
