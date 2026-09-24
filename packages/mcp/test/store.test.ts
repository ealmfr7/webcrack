import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { webcrack } from 'webcrack';
import type { Config } from '../src/config';
import { WcError } from '../src/format/errors';
import { collectFindings, summarizeFindings } from '../src/workspace/findings';
import { buildIndex as realBuildIndex } from '../src/workspace/indexer';
import { WorkspaceStore, type StoreDeps } from '../src/workspace/store';
import { detectTechniques } from '../src/workspace/techniques';
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
    detectTechniques,
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

test('open fills stats.techniques for an obfuscated corpus sample', async () => {
  const config = await makeConfig();
  const code = await readFile(
    new URL(
      '../../webcrack/test/corpus/obfuscator-default.js',
      import.meta.url,
    ),
    'utf8',
  );
  const store = new WorkspaceStore(
    config,
    testDeps({
      loadSource: (): Promise<LoadedSource> =>
        Promise.resolve({
          kind: 'code',
          label: '<obfuscator-default>',
          code,
          bytes: code.length,
        }),
    }),
  );
  const { workspace } = await store.open(code, {}, progressRecorder().fn);
  expect(workspace.stats.techniques.length).toBeGreaterThan(0);
  expect(workspace.stats.techniques).toContain('string-array (rotated)');
});

test('findings.json is written on open and read back on reopen', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const { workspace } = await store.open(
    'eval("x");',
    {},
    progressRecorder().fn,
  );
  expect(workspace.findings?.['main.js']?.map((f) => f.title)).toContain(
    'eval()',
  );
  const raw = JSON.parse(
    await readFile(
      join(config.cacheDir, workspace.id, 'findings.json'),
      'utf8',
    ),
  ) as unknown;
  expect(raw).toEqual(workspace.findings);

  const cached = new WorkspaceStore(
    config,
    testDeps({
      webcrack: () => {
        throw new Error('must come from the disk cache');
      },
    }),
  );
  const second = await cached.open('eval("x");', {}, progressRecorder().fn);
  expect(second.cached).toBe(true);
  expect(second.workspace.findings).toEqual(workspace.findings);
  expect(
    collectFindings(second.workspace, 'sinks').map((f) => f.title),
  ).toContain('eval()');
});

test('a cache without findings.json still loads and falls back', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const first = await store.open('eval("x");', {}, progressRecorder().fn);
  expect(first.workspace.findings).toBeDefined();
  await rm(join(config.cacheDir, first.workspace.id, 'findings.json'));
  const second = await store.open('eval("x");', {}, progressRecorder().fn);
  expect(second.cached).toBe(true);
  expect(second.workspace.findings).toBeUndefined();
  // Queries parse on demand, so nothing is lost.
  expect(
    collectFindings(second.workspace, 'sinks').map((f) => f.title),
  ).toContain('eval()');
});

test("commit recomputes the changed module's findings", async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, testDeps());
  const { workspace } = await store.open(
    'eval("x");',
    {},
    progressRecorder().fn,
  );
  expect(workspace.findings?.['main.js']?.map((f) => f.line)).toEqual([1]);
  const mod = workspace.modules.get('main.js');
  if (!mod) throw new Error('open did not create main.js');
  mod.code = '\n\neval("x");';
  await store.commit(workspace, ['main.js']);
  expect(workspace.findings?.['main.js']?.map((f) => f.line)).toEqual([3]);
  expect(collectFindings(workspace, 'sinks').map((f) => f.line)).toEqual([3]);
  const persisted = JSON.parse(
    await readFile(
      join(config.cacheDir, workspace.id, 'findings.json'),
      'utf8',
    ),
  ) as Record<string, Array<{ line: number }>>;
  expect(persisted['main.js']?.map((f) => f.line)).toEqual([3]);
});

test('a webcrack parse error becomes an actionable WcError', async () => {
  const config = await makeConfig();
  const parseError = Object.assign(new SyntaxError('Unexpected token (1:6)'), {
    code: 'BABEL_PARSER_SYNTAX_ERROR',
  });
  const store = new WorkspaceStore(
    config,
    testDeps({ webcrack: () => Promise.reject(parseError) }),
  );
  let error: unknown;
  try {
    await store.open('not [javascript', {}, progressRecorder().fn);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WcError);
  const message = (error as WcError).message;
  expect(message).toContain('(1:6)');
  expect(message).toMatch(/javascript/i);
  expect(message).toMatch(/path or URL/);
  expect(message).toMatch(/deobfuscate/);
  expect(store.list()).toEqual([]);
});

test('a non-parse webcrack failure passes through unwrapped', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(
    config,
    testDeps({ webcrack: () => Promise.reject(new Error('boom')) }),
  );
  let error: unknown;
  try {
    await store.open('var a = 1;', {}, progressRecorder().fn);
  } catch (caught) {
    error = caught;
  }
  expect(error).not.toBeInstanceOf(WcError);
  expect((error as Error).message).toBe('boom');
});

test('cached reopen + summarize of a ~2 MB bundle stays well under 1 s', async () => {
  const config = await makeConfig();
  const MODULE_COUNT = 500;
  // Realistic module shape: one sink plus ~160 small statements (~4 KB).
  const filler = Array.from(
    { length: 165 },
    (_, j) => `const q${j} = ${j} * 31 + 7;`,
  ).join('\n');
  const moduleCodes = Array.from(
    { length: MODULE_COUNT },
    (_, i) =>
      `function f${i}(arg) { return eval("m${i}") + arg; }\nf${i}(1);\n${filler}\n`,
  );
  const totalBytes = moduleCodes.reduce((sum, code) => sum + code.length, 0);
  expect(totalBytes).toBeGreaterThan(2 * 1024 * 1024);
  const source = moduleCodes.join('\n');
  const bundleModules = new Map(
    moduleCodes.map((code, i) => [
      String(i),
      {
        id: String(i),
        path: `mod${i}.js`,
        isEntry: i === 0,
        code,
      },
    ]),
  );
  const deps = testDeps({
    loadSource: (): Promise<LoadedSource> =>
      Promise.resolve({
        kind: 'code',
        label: '<synthetic>',
        code: source,
        bytes: source.length,
      }),
    webcrack: (() =>
      Promise.resolve({
        code: source,
        bundle: { type: 'webpack', entryId: '0', modules: bundleModules },
        save: () => Promise.resolve(),
      })) as unknown as StoreDeps['webcrack'],
  });
  const store = new WorkspaceStore(config, deps);
  const first = await store.open(source, {}, progressRecorder().fn);
  expect(first.workspace.findings).toBeDefined();
  expect(Object.keys(first.workspace.findings ?? {})).toHaveLength(
    MODULE_COUNT,
  );

  const cached = new WorkspaceStore(
    config,
    testDeps({
      webcrack: () => {
        throw new Error('must come from the disk cache');
      },
    }),
  );
  const startedAt = Date.now();
  const second = await cached.open(source, {}, progressRecorder().fn);
  const summary = summarizeFindings(second.workspace);
  const elapsedMs = Date.now() - startedAt;
  expect(second.cached).toBe(true);
  expect(summary.counts.sinks).toBe(MODULE_COUNT);
  expect(elapsedMs).toBeLessThan(1000);
});

const THREE_MODULES: Record<string, string> = {
  'a.js': 'export function alpha() { return 1; }\n',
  'b.js':
    'import { alpha } from "./a.js";\nexport function beta() { return alpha(); }\nbeta();\n',
  'c.js': 'import { beta } from "./b.js";\nbeta();\n',
};

/** Deps with the real indexer (so `commit` takes the incremental path) and
 * a fake `webcrack` that unpacks to the given files. */
function realIndexDeps(files: Record<string, string>): StoreDeps {
  const bundleModules = new Map(
    Object.entries(files).map(([path, code], i) => [
      String(i),
      { id: String(i), path, isEntry: i === 0, code },
    ]),
  );
  return testDeps({
    buildIndex: realBuildIndex,
    webcrack: (() =>
      Promise.resolve({
        code: '<bundle>',
        bundle: { type: 'webpack', entryId: '0', modules: bundleModules },
        save: () => Promise.resolve(),
      })) as unknown as StoreDeps['webcrack'],
  });
}

function moduleCode(
  workspace: { modules: Map<string, { code: string }> },
  path: string,
): string {
  const module = workspace.modules.get(path);
  if (!module) throw new Error(`open did not create ${path}`);
  return module.code;
}

test('incremental commit matches a full rebuild after a rename', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, realIndexDeps(THREE_MODULES));
  const source = JSON.stringify(THREE_MODULES);
  const { workspace } = await store.open(source, {}, progressRecorder().fn);
  expect(workspace.index).toEqual(realBuildIndex(workspace.modules));

  const renamed = moduleCode(workspace, 'b.js').replaceAll('beta', 'gamma');
  const module = workspace.modules.get('b.js');
  if (!module) throw new Error('open did not create b.js');
  module.code = renamed;
  await store.commit(workspace, ['b.js']);
  expect(workspace.index).toEqual(realBuildIndex(workspace.modules));
  expect(
    workspace.index.symbols
      .filter((symbol) => symbol.module === 'b.js')
      .map((symbol) => symbol.name),
  ).toContain('gamma');
  // The deep-equal above already pins every cross-module ref; spot-check
  // that c.js still references the old name.
  expect(
    workspace.index.refs.some(
      (ref) => ref.module === 'c.js' && ref.name === 'beta',
    ),
  ).toBe(true);
});

test('commit after a cache load matches a full rebuild, then stays incremental', async () => {
  const config = await makeConfig();
  const source = JSON.stringify(THREE_MODULES);
  const store = new WorkspaceStore(config, realIndexDeps(THREE_MODULES));
  await store.open(source, {}, progressRecorder().fn);

  // A fresh store has no kept parts: the workspace comes from the disk
  // cache, so the first commit falls back to a full rebuild and seeds.
  const cached = new WorkspaceStore(
    config,
    testDeps({
      buildIndex: realBuildIndex,
      webcrack: () => {
        throw new Error('must come from the disk cache');
      },
    }),
  );
  const second = await cached.open(source, {}, progressRecorder().fn);
  expect(second.cached).toBe(true);
  const aModule = second.workspace.modules.get('a.js');
  if (!aModule) throw new Error('open did not create a.js');
  aModule.code = 'export function alpha2() { return 2; }\n';
  await cached.commit(second.workspace, ['a.js']);
  expect(second.workspace.index).toEqual(
    realBuildIndex(second.workspace.modules),
  );

  // The next commit reuses the seeded parts.
  const bModule = second.workspace.modules.get('b.js');
  if (!bModule) throw new Error('open did not create b.js');
  bModule.code = bModule.code.replaceAll('beta', 'gamma');
  await cached.commit(second.workspace, ['b.js']);
  expect(second.workspace.index).toEqual(
    realBuildIndex(second.workspace.modules),
  );
});

test('a note-only commit rewrites annotations without touching module files', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, realIndexDeps(THREE_MODULES));
  const { workspace } = await store.open(
    JSON.stringify(THREE_MODULES),
    {},
    progressRecorder().fn,
  );
  const moduleFiles = [...workspace.modules.keys()].map((path) =>
    join(config.cacheDir, workspace.id, 'modules', path),
  );
  const before = await Promise.all(
    moduleFiles.map((file) => stat(file).then((info) => info.mtimeMs)),
  );

  workspace.annotations.push({ symbol: 'a.js:alpha', note: 'look here' });
  await store.commit(workspace, []);

  const after = await Promise.all(
    moduleFiles.map((file) => stat(file).then((info) => info.mtimeMs)),
  );
  expect(after).toEqual(before);
  const persisted = JSON.parse(
    await readFile(
      join(config.cacheDir, workspace.id, 'annotations.json'),
      'utf8',
    ),
  ) as unknown;
  expect(persisted).toEqual(workspace.annotations);
  expect(workspace.index).toEqual(realBuildIndex(workspace.modules));
});

test('commit repairs a cache missing original.js', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, realIndexDeps(THREE_MODULES));
  const source = JSON.stringify(THREE_MODULES);
  const { workspace } = await store.open(source, {}, progressRecorder().fn);
  await rm(join(config.cacheDir, workspace.id, 'original.js'));
  await store.commit(workspace, ['a.js']);
  const cached = new WorkspaceStore(
    config,
    testDeps({
      buildIndex: realBuildIndex,
      webcrack: () => {
        throw new Error('must come from the disk cache');
      },
    }),
  );
  const second = await cached.open(source, {}, progressRecorder().fn);
  expect(second.cached).toBe(true);
  expect(second.workspace.original).toBe(workspace.original);
});

test('commit drops a deleted module from the index and the cache', async () => {
  const config = await makeConfig();
  const store = new WorkspaceStore(config, realIndexDeps(THREE_MODULES));
  const { workspace } = await store.open(
    JSON.stringify(THREE_MODULES),
    {},
    progressRecorder().fn,
  );
  workspace.modules.delete('c.js');
  await store.commit(workspace, ['c.js']);
  expect(workspace.index).toEqual(realBuildIndex(workspace.modules));
  expect(
    workspace.index.symbols.some((symbol) => symbol.module === 'c.js'),
  ).toBe(false);
  expect(workspace.findings?.['c.js']).toBeUndefined();
  await expect(
    readFile(join(config.cacheDir, workspace.id, 'modules', 'c.js'), 'utf8'),
  ).rejects.toThrow();

  // The pruned cache still reopens cleanly.
  const cached = new WorkspaceStore(
    config,
    testDeps({
      buildIndex: realBuildIndex,
      webcrack: () => {
        throw new Error('must come from the disk cache');
      },
    }),
  );
  const second = await cached.open(
    JSON.stringify(THREE_MODULES),
    {},
    progressRecorder().fn,
  );
  expect(second.cached).toBe(true);
  expect([...second.workspace.modules.keys()].sort()).toEqual(['a.js', 'b.js']);
});

test('a rename commit on a ~1,000-module workspace stays well under 3 s', async () => {
  const config = await makeConfig();
  const MODULE_COUNT = 1000;
  const filler = Array.from(
    { length: 40 },
    (_, j) => `const q${j} = ${j} * 31 + 7;`,
  ).join('\n');
  const files: Record<string, string> = {};
  for (let i = 0; i < MODULE_COUNT; i++) {
    files[`mod${i}.js`] =
      `import { f0 } from "./mod0.js";\n` +
      `export function f${i}(arg) { return f0(arg) + ${i}; }\n` +
      `f${i}(1);\n${filler}\n`;
  }
  files['mod0.js'] =
    `export function f0(arg) { return arg; }\n` + `f0(1);\n${filler}\n`;
  const store = new WorkspaceStore(config, realIndexDeps(files));
  const { workspace } = await store.open(
    JSON.stringify(Object.keys(files)),
    {},
    progressRecorder().fn,
  );
  expect(workspace.modules.size).toBe(MODULE_COUNT);

  const target = workspace.modules.get('mod500.js');
  if (!target) throw new Error('open did not create mod500.js');
  target.code = target.code.replaceAll('f500', 'renamed500');
  const commitStartedAt = Date.now();
  await store.commit(workspace, ['mod500.js']);
  const commitMs = Date.now() - commitStartedAt;

  const fullStartedAt = Date.now();
  const full = realBuildIndex(workspace.modules);
  const fullMs = Date.now() - fullStartedAt;

  expect(workspace.index).toEqual(full);
  expect(commitMs).toBeLessThan(3000);
  expect(fullMs).toBeGreaterThan(commitMs * 2);
});

test('techniques survive reopening without calling the detector again', async () => {
  const config = await makeConfig();
  let calls = 0;
  const seen: Array<{ clean: string[]; interpreterCount: number }> = [];
  const store = new WorkspaceStore(
    config,
    testDeps({
      detectTechniques: (original, cleanModules, interpreters) => {
        calls++;
        seen.push({
          clean: cleanModules,
          interpreterCount: interpreters?.length ?? -1,
        });
        return detectTechniques(original, cleanModules, interpreters);
      },
    }),
  );
  const code = `function load() {
  if ('0x3f2a' === '0x7b1c') {
    init();
  } else {
    fallback();
  }
}`;
  const first = await store.open(code, {}, progressRecorder().fn);
  expect(calls).toBe(1);
  expect(first.workspace.stats.techniques).toEqual(['dead-code-injection']);
  // The detector saw the deobfuscated modules and the open-time
  // interpreters, not just the raw source.
  expect(seen[0]?.clean).toEqual([code]);
  expect(seen[0]?.interpreterCount).toBeGreaterThanOrEqual(0);
  const second = await store.open(code, {}, progressRecorder().fn);
  expect(second.cached).toBe(true);
  expect(calls).toBe(1);
  expect(second.workspace.stats.techniques).toEqual(
    first.workspace.stats.techniques,
  );
});

test('code outside a small embedded bundle is kept as bundle-host.js', async () => {
  const host = [
    'function app() { return "compositeStoryId"; }',
    ...Array.from({ length: 200 }, (_, i) => `var filler${i} = ${i};`),
  ].join('\n');
  const cases: Array<[string, Map<string, unknown>]> = [
    [
      'tiny bundle',
      new Map([
        [
          '0',
          { id: '0', path: './0.js', isEntry: true, code: 'exports.a = 1;' },
        ],
      ]),
    ],
    ['no modules', new Map<string, unknown>()],
  ];
  for (const [label, bundleModules] of cases) {
    const config = await makeConfig();
    const deps = testDeps({
      buildIndex: realBuildIndex,
      loadSource: (): Promise<LoadedSource> =>
        Promise.resolve({
          kind: 'code',
          label: '<synthetic>',
          code: host,
          bytes: host.length,
        }),
      webcrack: (() =>
        Promise.resolve({
          code: host,
          bundle: { type: 'webpack', entryId: '0', modules: bundleModules },
          save: () => Promise.resolve(),
        })) as unknown as StoreDeps['webcrack'],
    });
    const { workspace } = await new WorkspaceStore(config, deps).open(
      host,
      {},
      progressRecorder().fn,
    );
    expect(moduleCode(workspace, 'bundle-host.js'), label).toContain(
      'compositeStoryId',
    );
    expect(workspace.modules.size, label).toBe(bundleModules.size + 1);
  }
});

test('a bundle covering the code does not duplicate it as bundle-host.js', async () => {
  const config = await makeConfig();
  const { workspace } = await new WorkspaceStore(
    config,
    realIndexDeps({ 'a.js': 'export const alpha = 1;\n' }),
  ).open('<bundle>', {}, progressRecorder().fn);
  expect([...workspace.modules.keys()]).toEqual(['a.js']);
});
