import { parse } from '@babel/parser';
import type { Visitor } from '@babel/traverse';
import traverse, { visitors } from '@babel/traverse';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Bundle } from '../bundle';
import { unpackEsbuild } from '../esbuild';

const FIXTURES_DIR = join(__dirname, 'esbuild');

function unpack(code: string, merge = false): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  const visitor = unpackEsbuild.visitor(options) as Visitor;
  traverse(ast, merge ? visitors.merge([visitor]) : visitor);
  return options.bundle;
}

async function unpackFixture(name: string): Promise<Bundle | undefined> {
  return unpack(await readFile(join(FIXTURES_DIR, name), 'utf8'));
}

describe('esbuild commonjs with top-level entry', async () => {
  // Real output of `esbuild src/entry.js --bundle --format=cjs` where the
  // entry is ESM and the dependency is CJS
  const bundle = (await unpackFixture('esbuild-cjs.js'))!;

  test('detects bundle with synthetic entry', () => {
    expect(bundle).toBeDefined();
    expect(bundle.type).toBe('esbuild');
    expect(bundle.modules.size).toBe(2);
    expect(bundle.entryId).toBe('./index.js');
  });

  test('keeps original paths', () => {
    expect([...bundle.modules.keys()]).toEqual(['./src/dep.js', './index.js']);
    expect(bundle.modules.get('./index.js')!.isEntry).toBe(true);
    expect(bundle.modules.get('./src/dep.js')!.isEntry).toBe(false);
  });

  test('entry keeps top-level code with rewritten requires', () => {
    const entry = bundle.modules.get('./index.js')!.code;
    expect(entry).toContain('__export(entry_exports,');
    expect(entry).toContain('__toESM(require("./src/dep.js"))');
    expect(entry).toContain('module.exports = __toCommonJS(entry_exports)');
    expect(entry).not.toContain('require_dep(');
  });

  test('module code snapshots', () => {
    for (const module of bundle.modules.values()) {
      expect(module.code).toMatchSnapshot(module.path);
    }
  });

  test('works through visitors.merge', async () => {
    const code = await readFile(join(FIXTURES_DIR, 'esbuild-cjs.js'), 'utf8');
    const merged = unpack(code, true);
    expect(merged?.modules.size).toBe(2);
    expect(merged?.entryId).toBe('./index.js');
  });
});

describe('esbuild minified', async () => {
  // Real output of `esbuild src/entry.js --bundle --format=cjs --minify`
  // with all helpers renamed to single letters
  const bundle = (await unpackFixture('esbuild-cjs-min.js'))!;

  test('detects renamed helpers and synthesizes module ids', () => {
    expect(bundle).toBeDefined();
    expect(bundle.type).toBe('esbuild');
    expect(bundle.modules.size).toBe(2);
    expect([...bundle.modules.keys()]).toEqual(['./module-0.js', './index.js']);
    expect(bundle.entryId).toBe('./index.js');
  });

  test('entry keeps top-level code with rewritten requires', () => {
    const entry = bundle.modules.get('./index.js')!.code;
    expect(entry).toContain('require("./module-0.js")');
    expect(entry).toContain('module.exports = ');
    expect(entry).not.toMatch(/\bs\(\)/);
  });

  test('module code snapshots', () => {
    for (const module of bundle.modules.values()) {
      expect(module.code).toMatchSnapshot(module.path);
    }
  });
});

describe('esbuild commonjs entry at top level', async () => {
  // Real output where every file is CJS: the entry stays top-level code
  const bundle = (await unpackFixture('esbuild-cjs-topentry.js'))!;

  test('synthetic entry with rewritten require', () => {
    expect(bundle).toBeDefined();
    expect(bundle.modules.size).toBe(2);
    expect(bundle.entryId).toBe('./index.js');
    expect(bundle.modules.get('./index.js')!.code).toContain(
      'require("./src/dep.js")',
    );
  });
});

describe('esbuild wrapper entry invocation', () => {
  test('require_x(); selects the wrapper as entry', async () => {
    const bundle = (await unpackFixture('esbuild-cjs-entry-call.js'))!;
    expect(bundle.modules.size).toBe(2);
    expect(bundle.entryId).toBe('./src/main.js');
    expect(bundle.modules.get('./src/main.js')!.isEntry).toBe(true);
    expect(bundle.modules.get('./src/main.js')!.code).toContain(
      'require("./src/dep.js")',
    );
  });

  test('module.exports = require_x(); selects the wrapper as entry', async () => {
    // Real output shape
    const bundle = (await unpackFixture('esbuild-cjs-export-entry.js'))!;
    expect(bundle.modules.size).toBe(1);
    expect(bundle.entryId).toBe('./src/dep.js');
    expect(bundle.modules.get('./src/dep.js')!.isEntry).toBe(true);
  });
});

describe('esbuild scope-hoisted esm', () => {
  test('single module bundle', async () => {
    // Real output of `esbuild src/star.js --bundle --format=cjs` with no CJS
    // dependencies: __export calls but no __commonJS wrappers
    const bundle = (await unpackFixture('esbuild-esm.js'))!;
    expect(bundle.type).toBe('esbuild');
    expect(bundle.modules.size).toBe(1);
    const module = bundle.modules.get('index')!;
    expect(module.path).toBe('./index.js');
    expect(module.isEntry).toBe(true);
    expect(bundle.entryId).toBe('index');
    expect(module.code).toMatchSnapshot();
  });

  test('legacy __esm marker without wrappers', () => {
    const bundle = unpack(`
      var __esm = (fn, res) => function __init() {
        return fn && (res = (0, fn[Object.getOwnPropertyNames(fn)[0]])(fn = 0)), res;
      };
      var init_math;
      init_math = __esm({ "src/math.js"() {} });
      init_math();
    `);
    expect(bundle?.modules.size).toBe(1);
    expect(bundle?.modules.get('index')?.isEntry).toBe(true);
  });
});

test('normalizes __require calls', () => {
  const bundle = unpack(`
    var __commonJS = (cb, mod) => function __require() {
      return mod || (0, cb[Object.getOwnPropertyNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    };
    var require_a = __commonJS({
      "a.js"(exports, module) {
        var fs = __require("fs");
        module.exports = fs;
      }
    });
    module.exports = require_a();
  `);
  const code =
    bundle?.modules.get('a.js')?.code ?? bundle?.modules.get('./a.js')?.code;
  expect(code).toContain('require("fs")');
  expect(code).not.toContain('__require(');
});

test('ignores non-esbuild code', () => {
  expect(unpack('console.log(1 + 2);')).toBeUndefined();
  // Old tsc CommonJS helper: single parameter, single-argument call
  expect(
    unpack(`
      function __export(m) { for (var p in m) if (p !== "default") m[p]; }
      __export(require("./foo"));
    `),
  ).toBeUndefined();
  expect(
    unpack(`
      var __export = (m) => { for (var p in m) console.log(p); };
      __export(require("./foo"));
    `),
  ).toBeUndefined();
  // Bare call with no helper definition at all
  expect(unpack('__export(foo);')).toBeUndefined();
});
