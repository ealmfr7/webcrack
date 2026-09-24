import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import { createServer } from '../src/server';
import { buildIndex } from '../src/workspace/indexer';
import { WorkspaceStore } from '../src/workspace/store';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Server over a workspace with the real indexer, writing cache to temp. */
async function connectReal(ws: Workspace) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wc-refs-rename-test-'));
  cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
  const config = loadConfig({
    WEBCRACK_MCP_ROOTS: process.cwd(),
    WEBCRACK_MCP_CACHE: cacheDir,
  });
  const store = new WorkspaceStore(config);
  store.add(ws);

  const server = createServer(config, store);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    const text = result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    if (result.isError) throw new Error(text);
    return text;
  };
  return { call, ws };
}

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

/** Fixture rebuilt through the real indexer, plus a same-module caller of
 * `sign` and a namespace-import module using `ns.sign(v)`. */
function withRenameCallers(): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.set('src/sign.js', {
    path: 'src/sign.js',
    bundleId: '1',
    isEntry: false,
    code: `export function sign(value) {
  return btoa(value + "s3cr3t");
}
export function verifyLocal(v) {
  return sign(v);
}`,
    tags: ['crypto'],
  });
  ws.modules.set('src/ns.js', {
    path: 'src/ns.js',
    bundleId: '2',
    isEntry: false,
    code: `import * as ns from "./sign.js";
export function verify(v) {
  return ns.sign(v);
}`,
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
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

  test('same-line declarations do not share callers', async () => {
    const ws = fixtureWorkspace();
    ws.modules.set('src/consts.js', {
      path: 'src/consts.js',
      bundleId: '2',
      isEntry: false,
      code: `export const a = 1, b = 2;
export function useA() {
  return a;
}
export function useB() {
  return b;
}`,
      tags: [],
    });
    ws.index = buildIndex(ws.modules);
    const { call } = await connectReal(ws);

    const textA = await call('wc_refs', { symbol: 'src/consts.js:a' });
    expect(textA).toContain('1 caller');
    expect(textA).toContain('src/consts.js:3  read');
    expect(textA).toContain('return a;');
    expect(textA).not.toContain('return b;');

    const textB = await call('wc_refs', { symbol: 'src/consts.js:b' });
    expect(textB).toContain('1 caller');
    expect(textB).toContain('src/consts.js:6  read');
    expect(textB).toContain('return b;');
    expect(textB).not.toContain('return a;');
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

  test('callees resolve against the replaced index after a rename', async () => {
    const ws = fixtureWorkspace();
    const { call } = await connect(ws);
    const before = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
    });
    expect(before).toContain('src/api.js:5  sign → src/sign.js:1');
    // Simulate store.commit after renaming sign → fetchUser: same workspace
    // object, new index object with symbols, calls, and refs renamed together.
    const renamed = (name: string): string =>
      name === 'sign' ? 'fetchUser' : name;
    ws.index = {
      ...ws.index,
      symbols: ws.index.symbols.map((s) => {
        if (s.name !== 'sign') return s;
        const next = { ...s, name: 'fetchUser' };
        if (next.importedName === 'sign') next.importedName = 'fetchUser';
        return next;
      }),
      calls: ws.index.calls.map((c) => ({ ...c, callee: renamed(c.callee) })),
      refs: ws.index.refs.map((r) => ({ ...r, name: renamed(r.name) })),
    };
    const after = await call('wc_refs', {
      symbol: 'login',
      direction: 'callees',
    });
    expect(after).toContain('src/api.js:5  fetchUser → src/sign.js:1');
    expect(after).not.toContain('fetchUser (unresolved)');
  });

  describe('wc_refs after wc_annotate rename', () => {
    test('renaming an exported fn keeps cross-module refs resolving', async () => {
      const ws = fixtureWorkspace();
      // Real index so the rename commit reindexes real code.
      ws.index = buildIndex(ws.modules);
      const { call } = await connectReal(ws);

      const before = await call('wc_refs', { symbol: 'sign' });
      expect(before).toContain('src/api.js:5  call  in login');

      // The rename keeps `sign` as a stable export alias
      // (`export { renamedFn as sign }`); the importer is untouched.
      await call('wc_annotate', {
        symbol: 'src/sign.js:sign',
        name: 'renamedFn',
      });
      expect(ws.modules.get('src/api.js')?.code).toContain(
        'import { sign } from "./sign.js";',
      );

      // The exact bug symptom: the importer ref lost its defModule.
      const importerRef = ws.index.refs.find(
        (r) => r.module === 'src/api.js' && r.line === 5,
      );
      expect(importerRef).toMatchObject({
        name: 'sign',
        defModule: 'src/sign.js',
        defLine: 1,
      });
      expect(
        ws.index.symbols.find(
          (s) => s.module === 'src/sign.js' && s.name === 'renamedFn',
        ),
        // The importer call only: the kept `export { renamedFn as sign }`
        // alias is not a ref.
      ).toMatchObject({ refCount: 1 });

      // User-visible through the tools: the importer's call still resolves
      // to the renamed definition, and the definition reads back.
      const callees = await call('wc_refs', {
        symbol: 'login',
        direction: 'callees',
      });
      expect(callees).toContain('src/api.js:5  sign → src/sign.js:1');
      const read = await call('wc_read', { target: 'src/sign.js:renamedFn' });
      expect(read).toContain('function renamedFn');
    });

    test('renaming an exported fn keeps named, namespace, and same-module callers', async () => {
      const ws = withRenameCallers();
      const { call } = await connectReal(ws);

      await call('wc_annotate', {
        symbol: 'src/sign.js:sign',
        name: 'renamedFn',
      });

      const text = await call('wc_refs', { symbol: 'renamedFn' });
      expect(text).toContain(
        '`renamedFn` defined at src/sign.js:1 (function, exported) — 3 callers',
      );
      expect(text).toContain('Callers of `renamedFn` (3):');
      // Named import, still using the kept `sign` alias.
      expect(text).toContain('src/api.js:5  call  in login');
      // Namespace import, still `ns.sign(v)`.
      expect(text).toContain('src/ns.js:3  call  in verify');
      // Same-module caller, renamed to `renamedFn(v)`.
      expect(text).toContain('src/sign.js:5  call  in verifyLocal');
      // The kept `export { renamedFn as sign };` alias (line 7) is not a
      // use, so it is not listed.
      expect(text).not.toContain('src/sign.js:7');
    });

    test('the kept export alias is not listed as a caller', async () => {
      const ws = withRenameCallers();
      const { call } = await connectReal(ws);

      await call('wc_annotate', {
        symbol: 'src/sign.js:sign',
        name: 'renamedFn',
      });

      const text = await call('wc_refs', { symbol: 'renamedFn' });
      // Only genuine uses: the named and namespace importers plus the
      // same-module call.
      expect(text).toContain('src/api.js:5  call  in login');
      expect(text).toContain('src/ns.js:3  call  in verify');
      expect(text).toContain('src/sign.js:5  call  in verifyLocal');
      expect(text).not.toContain('src/sign.js:7');
    });
  });

  test('a non-WcError during callee resolution propagates', async () => {
    const ws = fixtureWorkspace();
    const { call } = await connect(ws);
    // An unexpected failure mid-resolution is a real bug: it must surface as
    // an error, not render as `(unresolved)`.
    const binding = ws.index.symbols.find((s) => s.kind === 'import');
    if (!binding) throw new Error('fixture must have an import binding');
    Object.defineProperty(binding, 'from', {
      configurable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    await expect(
      call('wc_refs', { symbol: 'login', direction: 'callees' }),
    ).rejects.toThrow('boom');
  });
});
