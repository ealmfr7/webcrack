import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { webcrack } from 'webcrack';
import type { Report } from 'webcrack/analysis';
import { loadConfig, type Config } from '../src/config';
import { createServer } from '../src/server';
import { WorkspaceStore, type StoreDeps } from '../src/workspace/store';
import type { Workspace, WorkspaceIndex } from '../src/workspace/types';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const OBF = [
  'var table = ["hello", "world"];',
  'function greet() {',
  '  var flag = !0;',
  '  return table[0] + " " + table[1] + flag;',
  '}',
  'var seq = (1, 2, 3);',
  '',
  '// trailing note',
].join('\n');

const EMPTY_REPORT: Report = {
  urls: [],
  endpoints: [],
  secrets: [],
  regexes: [],
  interesting: [],
};

function obfWorkspace(): Workspace {
  return {
    id: 'deob1',
    source: { kind: 'code', label: '<obf>', bytes: OBF.length },
    original: OBF,
    modules: new Map([
      [
        'obf.js',
        {
          path: 'obf.js',
          bundleId: '0',
          isEntry: true,
          code: OBF,
          tags: [],
        },
      ],
    ]),
    index: {
      symbols: [
        {
          module: 'obf.js',
          name: 'greet',
          kind: 'function',
          line: 2,
          endLine: 5,
          params: [],
          exported: false,
          refCount: 0,
        },
      ],
      calls: [],
      strings: [],
      refs: [],
      imports: { 'obf.js': [] },
      reexports: [],
    },
    report: { 'obf.js': EMPTY_REPORT },
    interpreters: [],
    annotations: [],
    stats: { openMs: 0, techniques: [] },
  };
}

const EMPTY_INDEX: WorkspaceIndex = {
  symbols: [],
  calls: [],
  strings: [],
  refs: [],
  imports: {},
  reexports: [],
};

function fakeDeps(overrides: Partial<StoreDeps> = {}): StoreDeps {
  return {
    webcrack,
    loadSource: (source: string) =>
      Promise.resolve({
        kind: 'code',
        label: source.slice(0, 32),
        code: source,
        bytes: source.length,
      }),
    buildIndex: () => EMPTY_INDEX,
    tagModule: () => [],
    ...overrides,
  };
}

function fakeWebcrack(
  transform: (code: string) => string,
  onCall?: (code: string, options: Record<string, unknown>) => void,
): StoreDeps['webcrack'] {
  return ((code: string, options: Record<string, unknown>) => {
    onCall?.(code, options);
    return Promise.resolve({
      code: transform(code),
      bundle: undefined,
      save: () => Promise.resolve(),
    });
  }) as unknown as StoreDeps['webcrack'];
}

interface Harness {
  client: Client;
  store: WorkspaceStore;
  config: Config;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
}

async function setup(deps: Partial<StoreDeps>): Promise<Harness> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wc-deob-'));
  cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
  const config = loadConfig({
    WEBCRACK_MCP_ROOTS: process.cwd(),
    WEBCRACK_MCP_CACHE: cacheDir,
  });
  const store = new WorkspaceStore(config, fakeDeps(deps));
  store.add(obfWorkspace());
  const server = createServer(config, store);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    store,
    config,
    call: async (name, args = {}) => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      const text = result.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      if (result.isError) throw new Error(text);
      return text;
    },
  };
}

describe('wc_deobfuscate', () => {
  test('a symbol shows a header and a unified diff', async () => {
    const { call } = await setup({});
    const text = await call('wc_deobfuscate', { target: 'obf.js:greet' });
    expect(text).toContain('wc_deobfuscate obf.js:greet');
    expect(text).toContain('passes: deobfuscate, unminify');
    expect(text).toMatch(/· \d+ ms/);
    expect(text).toContain('```diff');
    expect(text).toContain('-  var flag = !0;');
    expect(text).toContain('+  var flag = true;');
    expect(text).toContain('Next: wc_deobfuscate obf.js:greet apply=true');
  });

  test('real webcrack output lands in the diff for a range', async () => {
    const { call } = await setup({});
    const text = await call('wc_deobfuscate', { target: 'obf.js:6-6' });
    expect(text).toContain('-var seq = (1, 2, 3);');
    expect(text).toContain('+var seq = 3;');
  });

  test('a range is widened to the enclosing statements', async () => {
    const seen: string[] = [];
    const { call } = await setup({
      webcrack: fakeWebcrack(
        (code) => `${code}\n// decoded`,
        (code) => {
          seen.push(code);
        },
      ),
    });
    // Line 4 sits inside `greet` (lines 2-5): the slice is the whole function.
    const text = await call('wc_deobfuscate', { target: 'obf.js:4-4' });
    expect(seen).toEqual([
      'function greet() {\n  var flag = !0;\n  return table[0] + " " + table[1] + flag;\n}',
    ]);
    expect(text).toContain('+// decoded');
  });

  test('a range over no statement is an actionable error', async () => {
    const { call } = await setup({
      webcrack: fakeWebcrack((code) => code),
    });
    await expect(
      call('wc_deobfuscate', { target: 'obf.js:7-7' }),
    ).rejects.toThrow('range must cover whole statements; use module:symbol');
  });

  test('a passes subset reaches webcrack as flags', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { call } = await setup({
      webcrack: fakeWebcrack(
        (code) => code,
        (_code, options) => {
          seen.push(options);
        },
      ),
    });
    await call('wc_deobfuscate', {
      target: 'obf.js:6-6',
      passes: ['mangle', 'jsx'],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      unpack: false,
      deobfuscate: false,
      unminify: false,
      jsx: true,
      mangle: true,
      renameHeuristics: false,
    });
    expect(seen[0]?.['sandbox']).toBeTypeOf('function');
  });

  test('an invalid pass name is a zod error', async () => {
    const { call } = await setup({});
    await expect(
      call('wc_deobfuscate', { target: 'obf.js', passes: ['nope'] }),
    ).rejects.toThrow(/Invalid|invalid/);
  });

  test('apply mutates the code, rebuilds the index and rewrites the cache', async () => {
    const buildIndexCalls: unknown[] = [];
    const tagModuleCalls: unknown[] = [];
    const { call, store, config } = await setup({
      webcrack: fakeWebcrack((code) => code.replace('!0', 'true')),
      buildIndex: (modules: unknown) => {
        buildIndexCalls.push(modules);
        return EMPTY_INDEX;
      },
      tagModule: (module, index) => {
        tagModuleCalls.push([module, index]);
        return ['network'];
      },
    });
    const text = await call('wc_deobfuscate', {
      target: 'obf.js:3-3',
      apply: true,
    });
    expect(text).toContain('applied; reindexed; cache updated');
    expect(text).toContain('Next: wc_read obf.js');

    const ws = store.get('deob1');
    const module = ws.modules.get('obf.js');
    expect(module?.code).toContain('var flag = true;');
    expect(module?.code).toContain('var seq = (1, 2, 3);');
    expect(module?.code).toContain('function greet() {');
    // store.commit reindexed (via the injected buildIndex spy) …
    expect(buildIndexCalls).toHaveLength(1);
    // … refreshed the report and tags for the changed module …
    expect(ws.report['obf.js']).toBeDefined();
    expect(tagModuleCalls).toHaveLength(1);
    expect(module?.tags).toContain('network');
    // … and left interpreters consistent (no VM in this fixture).
    expect(
      ws.interpreters.filter((info) => info.module === 'obf.js'),
    ).toHaveLength(0);

    const cached = await readFile(
      join(config.cacheDir, 'deob1', 'modules', 'obf.js'),
      'utf8',
    );
    expect(cached).toBe(module?.code);
  });

  test('a hung webcrack run fails with a timeout error', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'wc-deob-timeout-'));
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    const config = loadConfig({
      WEBCRACK_MCP_ROOTS: process.cwd(),
      WEBCRACK_MCP_CACHE: cacheDir,
      WEBCRACK_MCP_TIMEOUT_MS: '50',
    });
    const store = new WorkspaceStore(
      config,
      fakeDeps({ webcrack: () => new Promise<never>(() => {}) }),
    );
    store.add(obfWorkspace());
    const server = createServer(config, store);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = (await client.callTool({
      name: 'wc_deobfuscate',
      arguments: { target: 'obf.js:6-6' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    const text = result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(text).toMatch(/timed out after 50 ms/);
  });

  test('expression evaluates a decoder call against the whole module', async () => {
    const { call, store } = await setup({});
    store.get('deob1').modules.set('dec.js', {
      path: 'dec.js',
      bundleId: '1',
      isEntry: false,
      code: 'var _0xabc = ["hello", "world"];\nfunction _0x1a2b(i) { return _0xabc[i]; }\n',
      tags: [],
    });
    // The range names line 2 but the string table lives on line 1: the
    // whole module is preloaded, not the slice.
    const text = await call('wc_deobfuscate', {
      target: 'dec.js:2-2',
      expression: '_0x1a2b(0) + " " + _0x1a2b(1)',
    });
    expect(text).toContain('expression in dec.js (sandbox)');
    expect(text).toContain('```\nhello world\n```');
    expect(text).toContain('Next: wc_read dec.js · wc_annotate dec.js:<name>');
  });

  test('expression without a target evaluates against empty code', async () => {
    const { call } = await setup({});
    const text = await call('wc_deobfuscate', { expression: '1 + 1' });
    expect(text).toContain('expression in (no module) (sandbox)');
    expect(text).toContain('```\n2\n```');
  });

  test('expression without a target emits no invalid Next hint', async () => {
    const { call } = await setup({});
    const text = await call('wc_deobfuscate', { expression: '1 + 1' });
    // The body label may say "(no module)", but the Next line must not
    // point at a module that does not exist.
    expect(text).not.toMatch(/\nNext:.*\(no module\)/);
    expect(text).not.toContain('wc_read (no module)');
    expect(text).not.toContain('wc_annotate (no module)');
  });

  test('an injected expression is rejected', async () => {
    const { call } = await setup({});
    await expect(
      call('wc_deobfuscate', {
        target: 'obf.js',
        expression: '1)}; process.exit(); //',
      }),
    ).rejects.toThrow('Invalid expression');
  });

  // NOTE: no test for an injected failing sandbox factory: evaluateInModule
  // accepts one via opts.sandboxFactory, but deobfuscate has no deps channel
  // for it (StoreDeps in workspace/store.ts carries only webcrack/loadSource/
  // buildIndex/tagModule, and store.ts is out of scope for this task), so
  // there is nothing to inject through.
  test.skip('an injected failing sandbox factory surfaces sandbox errors', () => {});
});
