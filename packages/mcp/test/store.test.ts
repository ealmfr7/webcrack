import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { webcrack } from 'webcrack';
import type { Config } from '../src/config';
import { WcError } from '../src/format/errors';
import { WorkspaceStore, type StoreDeps } from '../src/workspace/store';
import type { LoadedSource, WorkspaceIndex } from '../src/workspace/types';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function makeConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wc-store-test-'));
  cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
  return {
    roots: [process.cwd()],
    cacheDir,
    maxInputBytes: 20 * 1024 * 1024,
    timeoutMs: 30_000,
    outputBudget: 20_000,
    ...overrides,
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

/** Fakes for loadSource/buildIndex/tagModule, so these tests pass while the
 * real loader/indexer/tags are still stubs on other branches. */
function testDeps(overrides: Partial<StoreDeps> = {}): StoreDeps {
  return {
    webcrack: (code: string) =>
      Promise.resolve({
        code,
        bundle: undefined,
        save: () => Promise.resolve(),
      }),
    loadSource: (source: string): Promise<LoadedSource> =>
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

function progressRecorder() {
  const calls: Array<{ fraction: number; message?: string }> = [];
  return {
    calls,
    fn: (fraction: number, message?: string): Promise<void> => {
      calls.push({ fraction, message });
      return Promise.resolve();
    },
  };
}

function expectIncreasing(fractions: number[]): void {
  expect(fractions.length).toBeGreaterThan(0);
  for (const fraction of fractions) {
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1);
  }
  for (let i = 1; i < fractions.length; i++) {
    expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
  }
  expect(fractions[fractions.length - 1]).toBe(1);
}

test('no-bundle input becomes a single main.js module', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const progress = progressRecorder();
  const { workspace, cached } = await store.open(
    'console.log("hi");',
    {},
    progress.fn,
  );
  expect(cached).toBe(false);
  expect(workspace.bundle).toBeUndefined();
  expect([...workspace.modules.keys()]).toEqual(['main.js']);
  const main = workspace.modules.get('main.js');
  expect(main).toMatchObject({
    path: 'main.js',
    bundleId: '0',
    isEntry: true,
  });
  expect(main?.code).toBe('console.log("hi");');
  expect(workspace.report['main.js']).toBeDefined();
  expect(workspace.stats.techniques).toEqual([]);
  expect(typeof workspace.stats.openMs).toBe('number');
  expectIncreasing(progress.calls.map((call) => call.fraction));
  expect(store.get(workspace.id)).toBe(workspace);
});

test('browserify sample unpacks to modules without a ./ prefix', async () => {
  const config = await makeConfig();
  const code = await readFile(
    new URL('../../webcrack/test/corpus/browserify.js', import.meta.url),
    'utf8',
  );
  const tagged: string[] = [];
  const store = new WorkspaceStore(
    config,
    testDeps({
      webcrack,
      loadSource: (): Promise<LoadedSource> =>
        Promise.resolve({
          kind: 'code',
          label: '<browserify>',
          code,
          bytes: code.length,
        }),
      tagModule: (module) => {
        tagged.push(module.path);
        return [];
      },
    }),
  );
  const { workspace } = await store.open(code, {}, progressRecorder().fn);
  expect(workspace.bundle?.type).toBe('browserify');
  const paths = [...workspace.modules.keys()];
  expect(paths.length).toBeGreaterThan(1);
  for (const path of paths) {
    expect(path.startsWith('./')).toBe(false);
  }
  for (const [key, module] of workspace.modules) {
    expect(module.path).toBe(key);
  }
  const entry = [...workspace.modules.values()].find(
    (module) => module.isEntry,
  );
  expect(entry).toBeDefined();
  expect(entry?.bundleId).toBe(workspace.bundle?.entryId);
  expect(workspace.modules.has('index.js')).toBe(true);
  expect(tagged.sort()).toEqual([...paths].sort());
});

test('reopen hits the cache without calling webcrack', async () => {
  const config = await makeConfig();
  let calls = 0;
  const store = new WorkspaceStore(
    config,
    testDeps({
      webcrack: (code: string) => {
        calls++;
        return Promise.resolve({
          code,
          bundle: undefined,
          save: () => Promise.resolve(),
        });
      },
    }),
  );
  const missProgress = progressRecorder();
  const first = await store.open('var a = 1;', {}, missProgress.fn);
  expect(first.cached).toBe(false);
  expect(calls).toBe(1);
  expectIncreasing(missProgress.calls.map((call) => call.fraction));

  const hitProgress = progressRecorder();
  const second = await store.open('var a = 1;', {}, hitProgress.fn);
  expect(second.cached).toBe(true);
  expect(calls).toBe(1);
  expect(second.workspace).toEqual(first.workspace);
  expect([...second.workspace.modules.keys()]).toEqual([
    ...first.workspace.modules.keys(),
  ]);
  expectIncreasing(hitProgress.calls.map((call) => call.fraction));

  const third = await store.open(
    'var a = 1;',
    { refresh: true },
    progressRecorder().fn,
  );
  expect(third.cached).toBe(false);
  expect(calls).toBe(2);
});

test('corrupt cache is treated as a miss and rebuilt', async () => {
  const config = await makeConfig();
  let calls = 0;
  const store = new WorkspaceStore(
    config,
    testDeps({
      webcrack: (code: string) => {
        calls++;
        return Promise.resolve({
          code,
          bundle: undefined,
          save: () => Promise.resolve(),
        });
      },
    }),
  );
  const first = await store.open('var a = 1;', {}, progressRecorder().fn);
  expect(calls).toBe(1);
  await writeFile(
    join(config.cacheDir, first.workspace.id, 'index.json'),
    'not json',
    'utf8',
  );
  const second = await store.open('var a = 1;', {}, progressRecorder().fn);
  expect(second.cached).toBe(false);
  expect(calls).toBe(2);
  expect(second.workspace.modules.get('main.js')?.code).toBe(
    first.workspace.modules.get('main.js')?.code,
  );
});

test('path traversal in a module path is rejected', async () => {
  const config = await makeConfig();
  const evilBundle = {
    type: 'webpack',
    entryId: 'evil',
    modules: new Map([
      [
        'evil',
        {
          id: 'evil',
          path: '../../evil.js',
          isEntry: true,
          code: 'var a = 1;',
        },
      ],
    ]),
  };
  const store = new WorkspaceStore(
    config,
    testDeps({
      webcrack: ((code: string) =>
        Promise.resolve({
          code,
          bundle: evilBundle,
          save: () => Promise.resolve(),
        })) as unknown as StoreDeps['webcrack'],
    }),
  );
  let error: unknown;
  try {
    await store.open('var a = 1;', {}, progressRecorder().fn);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WcError);
  expect((error as WcError).message).toMatch(/"\.\." segments are not allowed/);
  expect(store.list()).toEqual([]);
  expect(await readdir(config.cacheDir)).toEqual([]);
});

test('listCached returns newest-first summaries and skips corrupt entries', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const first = await store.open('var a = 1;', {}, progressRecorder().fn);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await store.open('var b = 2;', {}, progressRecorder().fn);
  const summaries = await store.listCached();
  expect(summaries.map((summary) => summary.id)).toEqual([
    second.workspace.id,
    first.workspace.id,
  ]);
  expect(summaries[0]).toMatchObject({ kind: 'code', moduleCount: 1 });
  expect(typeof summaries[0]?.openedAt).toBe('string');
  await writeFile(
    join(config.cacheDir, first.workspace.id, 'meta.json'),
    '{broken',
    'utf8',
  );
  const rest = await store.listCached();
  expect(rest.map((summary) => summary.id)).toEqual([second.workspace.id]);
});

test('a hung webcrack run fails with an actionable timeout error', async () => {
  const config = await makeConfig({ timeoutMs: 50 });
  const store = new WorkspaceStore(
    config,
    testDeps({ webcrack: () => new Promise<never>(() => {}) }),
  );
  let error: unknown;
  try {
    await store.open('var a = 1;', {}, progressRecorder().fn);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WcError);
  expect((error as WcError).message).toMatch(/timed out after 50 ms/);
  expect((error as WcError).message).toMatch(/WEBCRACK_MCP_TIMEOUT_MS/);
  expect(store.list()).toEqual([]);
});

const VM_CODE = `var bytecode = [0, 1, 2];
var pc = 0;
var stack = [];
while (true) {
  var opcode = bytecode[pc++];
  switch (opcode) {
    case 0:
      stack.push(1);
      break;
    case 1:
      stack.push(2);
      break;
    case 2:
      stack.push(3);
      break;
    default:
      break;
  }
  if (pc >= bytecode.length) {
    break;
  }
}`;

test("modules with an interpreter get the 'vm' tag", async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const { workspace } = await store.open(VM_CODE, {}, progressRecorder().fn);
  expect(workspace.interpreters.length).toBeGreaterThan(0);
  const hit = workspace.interpreters[0];
  expect(hit).toMatchObject({ module: 'main.js', dispatchKind: 'switch' });
  expect(hit?.pc).toBe('pc');
  expect(hit?.bytecode).toBe('bytecode');
  expect(hit?.stack).toBe('stack');
  expect(workspace.modules.get('main.js')?.tags).toContain('vm');
});
