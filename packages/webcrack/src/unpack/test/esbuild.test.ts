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

describe('esbuild commonjs', async () => {
  const bundle = (await unpackFixture('esbuild-cjs.js'))!;

  test('detects bundle', () => {
    expect(bundle).toBeDefined();
    expect(bundle.type).toBe('esbuild');
    expect(bundle.modules.size).toBe(3);
    expect(bundle.entryId).toBe('./src/index.js');
  });

  test('keeps original paths', () => {
    expect([...bundle.modules.values()].map((m) => m.path)).toEqual([
      './src/math.js',
      './src/greet.js',
      './src/index.js',
    ]);
    expect(bundle.modules.get('./src/index.js')!.isEntry).toBe(true);
    expect(bundle.modules.get('./src/math.js')!.isEntry).toBe(false);
  });

  test('rewrites require calls', () => {
    const greet = bundle.modules.get('./src/greet.js')!.code;
    expect(greet).toContain('__toESM(require("./src/math.js"))');
    expect(greet).not.toContain('require_math(');

    const index = bundle.modules.get('./src/index.js')!.code;
    expect(index).toContain('__toESM(require("./src/greet.js"))');
    expect(index).toContain('require("fs")');
    expect(index).not.toContain('__require(');
    expect(index).not.toContain('require_greet(');
  });

  test('module code snapshots', () => {
    for (const module of bundle.modules.values()) {
      expect(module.code).toMatchSnapshot(module.path);
    }
  });

  test('works through visitors.merge', async () => {
    const code = await readFile(join(FIXTURES_DIR, 'esbuild-cjs.js'), 'utf8');
    const merged = unpack(code, true);
    expect(merged?.modules.size).toBe(3);
    expect(merged?.entryId).toBe('./src/index.js');
  });
});

describe('esbuild scope-hoisted esm', () => {
  test('single module bundle', async () => {
    const bundle = (await unpackFixture('esbuild-esm.js'))!;
    expect(bundle.type).toBe('esbuild');
    expect(bundle.modules.size).toBe(1);
    const module = bundle.modules.get('index')!;
    expect(module.path).toBe('./index.js');
    expect(module.isEntry).toBe(true);
    expect(bundle.entryId).toBe('index');
    expect(module.code).toMatchSnapshot();
  });

  test('__esm marker without wrappers', () => {
    const bundle = unpack(`
      var __esm = (fn, res) => function __init() {
        return fn && (res = (0, fn[Object.getOwnPropertyNames(fn)[0]])(fn = 0)), res;
      };
      var init_math;
      function add(a, b) { return a + b; }
      init_math = __esm(() => { add; });
      init_math();
      console.log(add(1, 2));
    `);
    expect(bundle?.modules.size).toBe(1);
    expect(bundle?.modules.get('index')?.isEntry).toBe(true);
  });
});

test('ignores non-esbuild code', () => {
  expect(unpack('console.log(1 + 2);')).toBeUndefined();
  expect(
    unpack('(function () { var __export = 1; return __export; })();'),
  ).toBeUndefined();
});
