import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  CallToolResult,
  Progress,
} from '@modelcontextprotocol/sdk/types.js';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { webcrack } from 'webcrack';
import { extractReport } from 'webcrack/analysis';
import { loadConfig, type Config } from '../src/config';
import { createServer } from '../src/server';
import { writeWorkspaceToCache } from '../src/workspace/cache';
import { loadSource } from '../src/workspace/loader';
import { buildIndex } from '../src/workspace/indexer';
import { tagModule } from '../src/workspace/tags';
import { WorkspaceStore, type StoreDeps } from '../src/workspace/store';
import type {
  ModuleEntry,
  Workspace,
  WorkspaceIndex,
} from '../src/workspace/types';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function corpusDir(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../webcrack/test/corpus',
  );
}

/** Dotted callee name (`a.b.c`), or `undefined` for computed shapes. */
function dotted(node: t.Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed) {
    const object = dotted(node.object);
    const prop = t.isIdentifier(node.property) ? node.property.name : undefined;
    if (object !== undefined && prop !== undefined) return `${object}.${prop}`;
  }
  return undefined;
}

/**
 * Minimal `buildIndex` stand-in while the real indexer (task B2a) is still a
 * stub: calls + strings per module, which is all `tagModule` reads. Every
 * other slice stays empty.
 */
function fakeBuildIndex(modules: Map<string, ModuleEntry>): WorkspaceIndex {
  const index: WorkspaceIndex = {
    symbols: [],
    calls: [],
    strings: [],
    refs: [],
    imports: {},
    reexports: [],
  };
  for (const module of modules.values()) {
    index.imports[module.path] = [];
    let ast;
    try {
      ast = parse(module.code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx'],
      });
    } catch {
      continue;
    }
    traverse(ast, {
      CallExpression(path) {
        const name = dotted(path.node.callee);
        if (name !== undefined) {
          index.calls.push({
            module: module.path,
            line: path.node.loc?.start.line ?? 1,
            callee: name,
          });
        }
      },
      StringLiteral(path) {
        index.strings.push({
          module: module.path,
          line: path.node.loc?.start.line ?? 1,
          value: path.node.value,
        });
      },
    });
  }
  return index;
}

function e2eDeps(): StoreDeps {
  return { webcrack, loadSource, buildIndex: fakeBuildIndex, tagModule };
}

/** `true` once the real indexer (task B2a) lands and stops throwing. */
function realIndexerAvailable(): boolean {
  try {
    buildIndex(
      new Map([
        [
          'main.js',
          {
            path: 'main.js',
            bundleId: '0',
            isEntry: true,
            code: 'const x = 1;\n',
            tags: [],
          },
        ],
      ]),
    );
    return true;
  } catch {
    return false;
  }
}

async function setup(
  deps: StoreDeps = e2eDeps(),
  reuseCacheDir?: string,
  roots: string = corpusDir(),
) {
  const cacheDir =
    reuseCacheDir ?? (await mkdtemp(join(tmpdir(), 'wc-open-test-')));
  if (reuseCacheDir === undefined) {
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
  }
  const config: Config = loadConfig({
    WEBCRACK_MCP_ROOTS: roots,
    WEBCRACK_MCP_CACHE: cacheDir,
  });
  const store = new WorkspaceStore(config, deps);
  const server = createServer(config, store);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const textOf = (result: CallToolResult): string =>
    result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');

  return {
    client,
    store,
    config,
    /** Call a tool and return its text; throws if it returned an error. */
    call: async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<string> => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      if (result.isError) throw new Error(textOf(result));
      return textOf(result);
    },
    /** Call a tool and return the raw result (for error assertions). */
    callRaw: async (
      name: string,
      args: Record<string, unknown> = {},
      options: { onprogress?: (progress: Progress) => void } = {},
    ): Promise<CallToolResult> =>
      (await client.callTool(
        { name, arguments: args },
        undefined,
        options.onprogress === undefined
          ? undefined
          : { onprogress: options.onprogress },
      )) as CallToolResult,
  };
}

const LITERAL = `fetch("https://api.example.com/v1/login", { method: "POST" }).then((r) => r.json());\n`;

test('open literal code yields a script workspace', async () => {
  const { call } = await setup();
  const text = await call('wc_open', { source: LITERAL });
  expect(text).toMatch(/^Workspace [0-9a-f]{8} · script · 1 module · /);
  expect(text).toContain('Entry: main.js');
  expect(text).toContain('Obfuscation: none detected');
  expect(text).toContain('Findings:');
  expect(text).toContain('url');
  expect(text).toContain('Top modules by tag:');
  expect(text).toContain('network');
  expect(text).toContain('main.js');
  expect(text).toContain('Next:');
  expect(text).toContain('wc_map');
}, 60_000);

test('open a corpus webpack sample, then reopen it from cache', async () => {
  const { call } = await setup();
  const source = join(corpusDir(), 'webpack-5.js');
  const first = await call('wc_open', { source });
  expect(first).toMatch(/^Workspace [0-9a-f]{8} · webpack · \d+ modules · /);
  expect(first).not.toContain('(cached)');
  expect(first).toContain('Entry: ');
  expect(first).toContain('Findings:');
  expect(first).toContain('Next: wc_map · wc_search · wc_findings');
  const second = await call('wc_open', { source });
  expect(second).toContain('(cached)');
  // Same workspace id, served from the cache.
  const id = /^Workspace ([0-9a-f]{8})/.exec(first)?.[1];
  expect(id).toBeDefined();
  expect(second).toContain(`Workspace ${id} · webpack`);
}, 60_000);

test('obfuscated corpus sample reports string-array techniques', async () => {
  const { call } = await setup();
  const text = await call('wc_open', {
    source: join(corpusDir(), 'obfuscator-default.js'),
  });
  const line = text.split('\n').find((l) => l.startsWith('Obfuscation:'));
  expect(line).toBeDefined();
  expect(line).toContain('string-array');
}, 120_000);

test('wc_workspaces lists open workspaces with a current marker', async () => {
  const { call } = await setup();
  const first = await call('wc_open', { source: LITERAL });
  const firstId = /^Workspace ([0-9a-f]{8})/.exec(first)?.[1];
  expect(firstId).toBeDefined();
  const second = await call('wc_open', {
    source: join(corpusDir(), 'webpack-5.js'),
  });
  const secondId = /^Workspace ([0-9a-f]{8})/.exec(second)?.[1];
  expect(secondId).toBeDefined();

  const text = await call('wc_workspaces', {});
  expect(text).toContain('2 open');
  expect(text).toContain(firstId);
  expect(text).toContain(secondId);
  expect(text).toContain('"<code>"');
  expect(text).toContain('(current)');
  const currentLine = text
    .split('\n')
    .find((line) => line.includes('(current)'));
  expect(currentLine).toContain(secondId);
  expect(text).toContain('Next: wc_open');
}, 60_000);

test('wc_workspaces shows cached workspaces from a fresh store', async () => {
  const first = await setup();
  await first.call('wc_open', { source: LITERAL });
  // A fresh store over the same cache dir: nothing open, one entry cached.
  const cacheDir = first.config.cacheDir;
  const config: Config = loadConfig({
    WEBCRACK_MCP_ROOTS: corpusDir(),
    WEBCRACK_MCP_CACHE: cacheDir,
  });
  const store = new WorkspaceStore(config, e2eDeps());
  const server = createServer(config, store);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = (await client.callTool({
    name: 'wc_workspaces',
    arguments: {},
  })) as CallToolResult;
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  expect(text).toContain('0 open');
  expect(text).toContain('Cached:');
  expect(text).toContain('"<code>"');
  expect(text).toContain('Next: wc_open');
}, 60_000);

test('a cached workspace reopens by id from a fresh store', async () => {
  const first = await setup();
  const opened = await first.call('wc_open', { source: LITERAL });
  const id = /^Workspace ([0-9a-f]{8})/.exec(opened)?.[1];
  expect(id).toBeDefined();
  // A new session over the same cache dir: the store is empty, but the id
  // still reopens the cached workspace.
  const second = await setup(e2eDeps(), first.config.cacheDir);
  const text = await second.call('wc_open', { source: id });
  expect(text).toContain(`Workspace ${id} · script`);
  expect(text).toContain('(cached)');
  // The reopened workspace is fully usable.
  const read = await second.call('wc_read', {
    target: 'main.js',
    workspace: id,
  });
  expect(read).toContain('fetch');
  const other = await second.call('wc_open', {
    source: 'console.log("other");\n',
  });
  const otherId = /^Workspace ([0-9a-f]{8})/.exec(other)?.[1];
  expect(otherId).toBeDefined();
  const diff = await second.call('wc_diff', { a: id, b: otherId });
  expect(diff).toContain('1 changed');
}, 60_000);

test('a cached id with refresh/options is an actionable error', async () => {
  const first = await setup();
  const opened = await first.call('wc_open', { source: LITERAL });
  const id = /^Workspace ([0-9a-f]{8})/.exec(opened)?.[1];
  expect(id).toBeDefined();
  const second = await setup(e2eDeps(), first.config.cacheDir);
  const textOf = (result: CallToolResult): string =>
    result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
  const expected =
    'refresh/options need the original source: call wc_open with the file path or URL (wc_workspaces shows it)';
  for (const args of [
    { source: id, refresh: true },
    { source: id, options: { deobfuscate: false } },
    { source: id, refresh: true, options: { unpack: true } },
  ]) {
    const result = await second.callRaw('wc_open', args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
  }
  // The failed reopens did not add a workspace to the store.
  expect(second.store.list()).toHaveLength(0);
});

test('a cached id with empty options still reopens', async () => {
  const first = await setup();
  const opened = await first.call('wc_open', { source: LITERAL });
  const id = /^Workspace ([0-9a-f]{8})/.exec(opened)?.[1];
  expect(id).toBeDefined();
  const second = await setup(e2eDeps(), first.config.cacheDir);
  const text = await second.call('wc_open', { source: id, options: {} });
  expect(text).toContain(`Workspace ${id} · script`);
  expect(text).toContain('(cached)');
});

test('an unknown 8-hex id is an actionable error, not literal code', async () => {
  const { callRaw, store } = await setup();
  const result = await callRaw('wc_open', { source: 'deadbeef' });
  expect(result.isError).toBe(true);
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  expect(text).toContain('Unknown workspace "deadbeef"');
  expect(text).toContain('wc_workspaces');
  // No junk workspace was opened from the id-as-code.
  expect(store.list()).toHaveLength(0);
});

test('an 8-hex file name keeps normal handling', async () => {
  // Relative paths resolve against the cwd (like the loader), so the file
  // must live there; roots point at the cwd so it is openable. The file is
  // removed afterwards and never committed.
  const name = join(process.cwd(), 'abcdef12');
  await writeFile(name, 'console.log("hex name");\n', 'utf8');
  cleanups.push(() => unlink(name).catch(() => {}));
  const { call } = await setup(e2eDeps(), undefined, process.cwd());
  try {
    const text = await call('wc_open', { source: 'abcdef12' });
    expect(text).toMatch(/^Workspace [0-9a-f]{8} · script · 1 module/);
    expect(text).not.toContain('(cached)');
  } finally {
    await unlink(name).catch(() => {});
  }
}, 60_000);

test('wc_workspaces suggests wc_open <id> for cached entries', async () => {
  const first = await setup();
  const opened = await first.call('wc_open', { source: LITERAL });
  const id = /^Workspace ([0-9a-f]{8})/.exec(opened)?.[1];
  expect(id).toBeDefined();
  const second = await setup(e2eDeps(), first.config.cacheDir);
  const text = await second.call('wc_workspaces', {});
  expect(text).toContain('Cached:');
  const next = text.split('\n').find((line) => line.startsWith('Next:'));
  expect(next).toBe(`Next: wc_open ${id}`);
}, 60_000);

test('overview renders fast for 2,000 modules × 100 calls', async () => {
  const first = await setup();
  const tags = [
    'network',
    'auth',
    'crypto',
    'storage',
    'dom',
    'vm',
    'vendor',
  ] as const;
  const modules = new Map<string, ModuleEntry>();
  const calls: WorkspaceIndex['calls'] = [];
  const report: Workspace['report'] = {};
  for (let i = 0; i < 2000; i++) {
    const path = `m${i}.js`;
    const code = 'var a = 1;\n';
    modules.set(path, {
      path,
      bundleId: String(i),
      isEntry: i === 0,
      code,
      tags: [...tags],
    });
    for (let j = 0; j < 100; j++) {
      calls.push({ module: path, line: 1, callee: 'fetch' });
    }
    const ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
    report[path] = extractReport(ast);
  }
  const workspace: Workspace = {
    id: 'aaaaaaaa',
    source: { kind: 'code', label: '<code>', bytes: 1 },
    original: 'var a = 1;\n',
    modules,
    index: {
      symbols: [],
      calls,
      strings: [],
      refs: [],
      imports: {},
      reexports: [],
    },
    report,
    interpreters: [],
    annotations: [],
    stats: { openMs: 5, techniques: [] },
  };
  await writeWorkspaceToCache(first.config, workspace, 'test');
  const second = await setup(e2eDeps(), first.config.cacheDir);
  const start = Date.now();
  const text = await second.call('wc_open', { source: 'aaaaaaaa' });
  const elapsed = Date.now() - start;
  expect(text).toContain('Workspace aaaaaaaa · script · 2000 modules');
  expect(text).toContain('m0.js (100 calls)');
  expect(elapsed).toBeLessThan(8000);
}, 120_000);

test('progress notifications arrive when a progressToken is sent', async () => {
  const { callRaw } = await setup();
  const seen: Progress[] = [];
  const result = await callRaw(
    'wc_open',
    { source: LITERAL },
    { onprogress: (progress) => seen.push(progress) },
  );
  expect(result.isError).toBeFalsy();
  expect(seen.length).toBeGreaterThan(0);
  for (const progress of seen) {
    expect(progress.progress).toBeGreaterThanOrEqual(0);
    expect(progress.progress).toBeLessThanOrEqual(1);
  }
}, 60_000);

test('an invalid path returns the loader actionable error', async () => {
  const { callRaw } = await setup();
  const result = await callRaw('wc_open', {
    source: 'missing/dir/nope.js',
  });
  expect(result.isError).toBe(true);
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  expect(text).toContain('File not found');
});

test.skipIf(!realIndexerAvailable())(
  'full pipeline with the real indexer (no fake buildIndex)',
  async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'wc-open-real-'));
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    const config: Config = loadConfig({
      WEBCRACK_MCP_ROOTS: corpusDir(),
      WEBCRACK_MCP_CACHE: cacheDir,
    });
    const store = new WorkspaceStore(config);
    const server = createServer(config, store);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = (await client.callTool({
      name: 'wc_open',
      arguments: { source: join(corpusDir(), 'webpack-5.js') },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(text).toMatch(/^Workspace [0-9a-f]{8} · webpack · \d+ modules · /);
    expect(text).toContain('Entry: ');
    expect(text).toContain('Findings:');
    expect(text).toContain('Next:');
  },
  120_000,
);
