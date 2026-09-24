import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config';
import { createServer } from '../src/server';
import { readWorkspaceFromCache } from '../src/workspace/cache';
import { WorkspaceStore } from '../src/workspace/store';
import type {
  ModuleEntry,
  SymbolEntry,
  Workspace,
  WorkspaceIndex,
} from '../src/workspace/types';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const API = `import { sign } from "./sign.js";
export async function login(user, pass) {
  const res = await fetch("https://api.example.com/v1/login", {
    method: "POST",
    headers: { "x-sign": sign(user) },
    body: JSON.stringify({ user, pass }),
  });
  localStorage.setItem("token", (await res.json()).token);
}`;

const SIGN = `function sign(value) {
  return btoa(value + "s3cr3t");
}
export { sign };
export const alias = { sign };`;

const RENAMED_SIGN = `function hmacSign(value) {
  return btoa(value + "s3cr3t");
}
export { hmacSign as sign };
export const alias = { sign: hmacSign };`;

/** Placeholder report: replaced by the real extractReport on commit. */
const PLACEHOLDER_REPORT = {
  marker: true,
} as unknown as Workspace['report'][string];

function moduleEntry(
  path: string,
  code: string,
  bundleId: string,
  isEntry: boolean,
): ModuleEntry {
  return { path, bundleId, isEntry, code, tags: [] };
}

/**
 * Two-module workspace in the shape of test/helpers.ts's fixture (top-level
 * bindings, one cross-module ref through an import). `sign.js` declares
 * `sign` with a bare `export { sign }` specifier plus a shorthand use, so a
 * rename keeps every existing line number.
 */
function fixtureWorkspace(): Workspace {
  return {
    id: 'annotate-fixture',
    source: { kind: 'code', label: '<annotate-fixture>', bytes: 1 },
    original: `${API}\n${SIGN}`,
    modules: new Map([
      ['api.js', moduleEntry('api.js', API, '0', true)],
      ['sign.js', moduleEntry('sign.js', SIGN, '1', false)],
    ]),
    index: {
      symbols: [
        {
          module: 'api.js',
          name: 'sign',
          kind: 'import',
          line: 1,
          endLine: 1,
          exported: false,
          refCount: 0,
          importedName: 'sign',
          from: 'sign.js',
        },
        {
          module: 'api.js',
          name: 'login',
          kind: 'function',
          line: 2,
          endLine: 9,
          params: ['user', 'pass'],
          exported: true,
          refCount: 0,
        },
        {
          module: 'sign.js',
          name: 'sign',
          kind: 'function',
          line: 1,
          endLine: 3,
          params: ['value'],
          exported: true,
          refCount: 1,
        },
        {
          module: 'sign.js',
          name: 'alias',
          kind: 'variable',
          line: 5,
          endLine: 5,
          exported: true,
          refCount: 0,
        },
      ],
      calls: [
        { module: 'sign.js', line: 2, callee: 'btoa', caller: 'sign' },
        { module: 'api.js', line: 5, callee: 'sign', caller: 'login' },
      ],
      strings: [{ module: 'sign.js', line: 2, value: 's3cr3t' }],
      refs: [
        {
          module: 'api.js',
          line: 5,
          name: 'sign',
          defModule: 'sign.js',
          defLine: 1,
          kind: 'call',
        },
      ],
      imports: { 'api.js': ['sign.js'], 'sign.js': [] },
      reexports: [],
    },
    report: { 'api.js': PLACEHOLDER_REPORT, 'sign.js': PLACEHOLDER_REPORT },
    interpreters: [],
    annotations: [],
    stats: { openMs: 0, techniques: [] },
  };
}

/** Minimal workspace for the error-path tests (rename never reaches commit). */
function tinyWorkspace(
  path: string,
  code: string,
  symbols: SymbolEntry[],
  extraModules: Array<[string, string]> = [],
): Workspace {
  const modules = new Map<string, ModuleEntry>([
    [path, moduleEntry(path, code, '0', true)],
  ]);
  for (const [extraPath, extraCode] of extraModules) {
    modules.set(extraPath, moduleEntry(extraPath, extraCode, '1', false));
  }
  return {
    id: `annotate-${path}`,
    source: { kind: 'code', label: '<tiny>', bytes: code.length },
    original: code,
    modules,
    index: {
      symbols,
      calls: [],
      strings: [],
      refs: [],
      imports: {},
      reexports: [],
    },
    report: {},
    interpreters: [],
    annotations: [],
    stats: { openMs: 0, techniques: [] },
  };
}

/**
 * The real indexer (M1.2) is still a stub on this base, so the fake stands
 * in for it: it records its inputs and applies caller-registered renames to
 * a clone of the starting index, mirroring what the real buildIndex would
 * produce (renamed defined symbol, stable export, untouched importer refs).
 */
function fakeBuildIndex(base: WorkspaceIndex) {
  const calls: Array<Map<string, ModuleEntry>> = [];
  const renames = new Map<string, string>();
  return {
    calls,
    rename: (module: string, oldName: string, newName: string): void => {
      renames.set(`${module}:${oldName}`, newName);
    },
    buildIndex: (modules: Map<string, ModuleEntry>): WorkspaceIndex => {
      calls.push(modules);
      const clone: WorkspaceIndex = structuredClone(base);
      for (const symbol of clone.symbols) {
        const renamed = renames.get(`${symbol.module}:${symbol.name}`);
        if (renamed !== undefined) symbol.name = renamed;
      }
      return clone;
    },
  };
}

async function setup(ws: Workspace) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wc-annotate-test-'));
  cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
  const config: Config = loadConfig({
    WEBCRACK_MCP_ROOTS: process.cwd(),
    WEBCRACK_MCP_CACHE: cacheDir,
  });
  const fake = fakeBuildIndex(ws.index);
  const tagged: string[] = [];
  const store = new WorkspaceStore(config, {
    webcrack: () => Promise.reject(new Error('not used by commit')),
    loadSource: () => Promise.reject(new Error('not used by commit')),
    buildIndex: fake.buildIndex,
    tagModule: (module) => {
      tagged.push(module.path);
      return [];
    },
  });
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
  return { call, config, store, ws, fake, tagged };
}

describe('wc_annotate', () => {
  test('renames sign.js:sign to hmacSign, keeping the export name stable', async () => {
    const { call, ws, fake, tagged } = await setup(fixtureWorkspace());
    fake.rename('sign.js', 'sign', 'hmacSign');

    const text = await call('wc_annotate', {
      symbol: 'sign.js:sign',
      name: 'hmacSign',
    });
    expect(text).toContain('Renamed sign.js:sign → hmacSign');
    expect(text).toContain('3 sites in sign.js');
    expect(text).toContain('Next: wc_read sign.js:hmacSign');

    // The defining module is rewritten; the importer is untouched and its
    // import still resolves against the stable export name.
    expect(ws.modules.get('sign.js')?.code).toBe(RENAMED_SIGN);
    expect(ws.modules.get('api.js')?.code).toBe(API);
    expect(ws.modules.get('api.js')?.code).toContain(
      'import { sign } from "./sign.js";',
    );

    // commit() reindexed through the (fake) buildIndex and retagged.
    expect(fake.calls.length).toBeGreaterThan(0);
    expect([...fake.calls[0].keys()].sort()).toEqual(['api.js', 'sign.js']);
    expect(tagged).toContain('sign.js');
    const renamed = ws.index.symbols.find(
      (symbol) => symbol.module === 'sign.js' && symbol.name === 'hmacSign',
    );
    expect(renamed).toMatchObject({
      exported: true,
      refCount: 1,
    });
    expect(
      ws.index.refs.find(
        (ref) => ref.module === 'api.js' && ref.name === 'sign',
      ),
    ).toMatchObject({ defModule: 'sign.js', defLine: 1 });

    // The renamed symbol reads back through the fresh index.
    const read = await call('wc_read', { target: 'sign.js:hmacSign' });
    expect(read).toContain('function hmacSign');

    // The annotation is keyed by the original binding.
    expect(ws.annotations).toEqual([
      { symbol: 'sign.js:sign', rename: 'hmacSign' },
    ]);

    // Only the changed module's report was recomputed (real extractReport).
    expect(ws.report['sign.js']).toHaveProperty('urls');
    expect(ws.report['api.js']).toBe(PLACEHOLDER_REPORT);
  });

  test('existing lines keep their numbers (no code regeneration)', async () => {
    const { call, ws, fake } = await setup(fixtureWorkspace());
    fake.rename('sign.js', 'sign', 'hmacSign');
    const before = ws.modules.get('sign.js')?.code?.split('\n') ?? [];
    await call('wc_annotate', { symbol: 'sign.js:sign', name: 'hmacSign' });
    const after = ws.modules.get('sign.js')?.code?.split('\n') ?? [];
    // Same line count; untouched lines are byte-identical.
    expect(after.length).toBe(before.length);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  test('export function form strips export and appends a stable alias', async () => {
    const code = `export function sign(value) {
  return btoa(value + "s3cr3t");
}`;
    const ws = tinyWorkspace('sign.js', code, [
      {
        module: 'sign.js',
        name: 'sign',
        kind: 'function',
        line: 1,
        endLine: 3,
        params: ['value'],
        exported: true,
        refCount: 0,
      },
    ]);
    const { call, ws: after } = await setup(ws);
    const text = await call('wc_annotate', {
      symbol: 'sign.js:sign',
      name: 'hmacSign',
    });
    expect(text).toContain('Renamed sign.js:sign → hmacSign');
    const renamed = after.modules.get('sign.js')?.code ?? '';
    // Existing lines keep number and content (minus the edit on line 1);
    // the stable export is appended, shifting nothing.
    expect(renamed).toBe(
      'function hmacSign(value) {\n' +
        '  return btoa(value + "s3cr3t");\n' +
        '}\n' +
        'export { hmacSign as sign };\n',
    );
  });

  test('multi-declarator exports keep their siblings exported', async () => {
    const code = `export const sign = (v) => v, other = 1;`;
    const ws = tinyWorkspace('multi.js', code, [
      {
        module: 'multi.js',
        name: 'sign',
        kind: 'variable',
        line: 1,
        endLine: 1,
        exported: true,
        refCount: 0,
      },
    ]);
    const { call, ws: after } = await setup(ws);
    await call('wc_annotate', { symbol: 'multi.js:sign', name: 'hmacSign' });
    expect(after.modules.get('multi.js')?.code).toBe(
      'const hmacSign = (v) => v, other = 1;\nexport { hmacSign as sign, other };\n',
    );
  });

  test('a note only records the annotation without touching code', async () => {
    const { call, ws, fake } = await setup(fixtureWorkspace());
    const text = await call('wc_annotate', {
      symbol: 'sign',
      from: 'api.js:5',
      note: 'HMAC with a hardcoded pepper',
    });
    expect(text).toContain('Note recorded on sign.js:sign');
    expect(text).toContain('Next: wc_read sign.js:sign');
    expect(ws.modules.get('sign.js')?.code).toBe(SIGN);
    expect(ws.modules.get('api.js')?.code).toBe(API);
    expect(ws.annotations).toEqual([
      { symbol: 'sign.js:sign', note: 'HMAC with a hardcoded pepper' },
    ]);
    // A note-only change still reindexes and persists.
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  test('a later rename updates the existing annotation instead of adding one', async () => {
    const { call, ws, fake } = await setup(fixtureWorkspace());
    await call('wc_annotate', {
      symbol: 'sign.js:sign',
      note: 'HMAC with a hardcoded pepper',
    });
    // Register the rename only now: the note-only commit above reindexed
    // the still-unrenamed code, mirroring what the real indexer would do.
    fake.rename('sign.js', 'sign', 'hmacSign');
    await call('wc_annotate', { symbol: 'sign.js:sign', name: 'hmacSign' });
    expect(ws.annotations).toEqual([
      {
        symbol: 'sign.js:sign',
        rename: 'hmacSign',
        note: 'HMAC with a hardcoded pepper',
      },
    ]);
  });

  test('renamed code and annotations persist in the cache', async () => {
    const { call, config, ws, fake } = await setup(fixtureWorkspace());
    fake.rename('sign.js', 'sign', 'hmacSign');
    await call('wc_annotate', { symbol: 'sign.js:sign', name: 'hmacSign' });

    const cached = await readWorkspaceFromCache(config, ws.id);
    expect(cached).toBeDefined();
    expect(cached?.modules.get('sign.js')?.code).toBe(RENAMED_SIGN);
    expect(cached?.modules.get('api.js')?.code).toBe(API);
    expect(cached?.annotations).toEqual([
      { symbol: 'sign.js:sign', rename: 'hmacSign' },
    ]);
    expect(
      cached?.index.symbols.find(
        (symbol) => symbol.module === 'sign.js' && symbol.name === 'hmacSign',
      ),
    ).toBeDefined();
  });

  test('requires at least one of name or note', async () => {
    const { call } = await setup(fixtureWorkspace());
    await expect(
      call('wc_annotate', { symbol: 'sign.js:sign' }),
    ).rejects.toThrow('at least one of "name"');
  });

  test('rejects an invalid identifier without touching anything', async () => {
    const { call, ws, fake } = await setup(fixtureWorkspace());
    await expect(
      call('wc_annotate', { symbol: 'sign.js:sign', name: '9-lives' }),
    ).rejects.toThrow('not a valid JavaScript identifier');
    expect(ws.modules.get('sign.js')?.code).toBe(SIGN);
    expect(ws.annotations).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test('rejects a rename colliding with a binding in the same scope', async () => {
    const { call, ws, fake } = await setup(fixtureWorkspace());
    await expect(
      call('wc_annotate', { symbol: 'sign.js:sign', name: 'alias' }),
    ).rejects.toThrow('"alias" is already declared');
    expect(ws.modules.get('sign.js')?.code).toBe(SIGN);
    expect(ws.annotations).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test('rejects a rename colliding in a child scope where it is used', async () => {
    const code = `function sign(value) {
  const hmacSign = value;
  return sign(hmacSign);
}
export { sign };`;
    const ws = tinyWorkspace('shadow.js', code, [
      {
        module: 'shadow.js',
        name: 'sign',
        kind: 'function',
        line: 1,
        endLine: 4,
        params: ['value'],
        exported: true,
        refCount: 0,
      },
    ]);
    const { call } = await setup(ws);
    await expect(
      call('wc_annotate', { symbol: 'shadow.js:sign', name: 'hmacSign' }),
    ).rejects.toThrow('"hmacSign" is already declared in a scope');
  });

  test('rejects renaming an import with its definition location', async () => {
    const code = `const cfg = require("./cfg.js");
module.exports.run = () => cfg;`;
    const ws = tinyWorkspace(
      'cjs.js',
      code,
      [
        {
          module: 'cjs.js',
          name: 'cfg',
          kind: 'import',
          line: 1,
          endLine: 1,
          exported: false,
          refCount: 0,
          importedName: '*',
          from: 'cfg.js',
        },
      ],
      [['cfg.js', 'module.exports = {};']],
    );
    const { call } = await setup(ws);
    await expect(
      call('wc_annotate', { symbol: 'cjs.js:cfg', name: 'config' }),
    ).rejects.toThrow('Rename it at its definition: cfg.js:*');
  });

  test('unknown symbols stay actionable', async () => {
    const { call } = await setup(fixtureWorkspace());
    await expect(
      call('wc_annotate', { symbol: 'sign.js:nope', name: 'x' }),
    ).rejects.toThrow('Unknown symbol "nope"');
  });
});
