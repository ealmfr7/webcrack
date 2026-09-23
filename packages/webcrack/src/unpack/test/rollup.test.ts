import { parse } from '@babel/parser';
import type { Visitor } from '@babel/traverse';
import traverse, { visitors } from '@babel/traverse';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Bundle } from '../bundle';
import { unpackRollup, type RollupModule } from '../rollup';

const FIXTURES_DIR = join(__dirname, 'rollup');
const ESBUILD_FIXTURES_DIR = join(__dirname, 'esbuild');

function unpack(code: string, merge = false): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  const visitor = unpackRollup.visitor(options) as Visitor;
  traverse(ast, merge ? visitors.merge([visitor]) : visitor);
  return options.bundle;
}

async function unpackFixture(name: string): Promise<Bundle | undefined> {
  return unpack(await readFile(join(FIXTURES_DIR, name), 'utf8'));
}

function dependenciesOf(bundle: Bundle, id: string): string[] {
  return (bundle.modules.get(id) as RollupModule).dependencies;
}

describe('rollup regions', async () => {
  // Chunk shaped like non-minified `rollup --format es` output with
  // code-splitting: a shared-chunk import header plus `// <path>` regions
  const bundle = (await unpackFixture('rollup-regions.js'))!;

  test('detects bundle with a module per region', () => {
    expect(bundle).toBeDefined();
    expect(bundle.type).toBe('rollup');
    expect(bundle.modules.size).toBe(3);
    expect([...bundle.modules.keys()]).toEqual([
      './node_modules/is-plain-obj/index.js',
      './src/utils.js',
      './src/main.js',
    ]);
  });

  test('entry is the region with the exports', () => {
    expect(bundle.entryId).toBe('./src/main.js');
    expect(bundle.modules.get('./src/main.js')!.isEntry).toBe(true);
    expect(bundle.modules.get('./src/utils.js')!.isEntry).toBe(false);
  });

  test('chunk header moves into the entry module', () => {
    const entry = bundle.modules.get('./src/main.js')!.code;
    expect(entry).toContain("from './chunk-shared.a1b2c3.js'");
    expect(entry).toContain('export {');
    expect(bundle.modules.get('./src/utils.js')!.code).not.toContain(
      'chunk-shared',
    );
  });

  test('chunk imports are recorded as entry dependencies', () => {
    expect(dependenciesOf(bundle, './src/main.js')).toEqual([
      './chunk-shared.a1b2c3.js',
    ]);
    expect(dependenciesOf(bundle, './src/utils.js')).toEqual([]);
  });

  test('module code snapshots', () => {
    for (const module of bundle.modules.values()) {
      expect(module.code).toMatchSnapshot(module.path);
    }
  });

  test('works through visitors.merge', async () => {
    const code = await readFile(join(FIXTURES_DIR, 'rollup-regions.js'), 'utf8');
    const merged = unpack(code, true);
    expect(merged?.modules.size).toBe(3);
    expect(merged?.entryId).toBe('./src/main.js');
  });
});

describe('minified vite chunk', async () => {
  // Minified Vite entry chunk: no region comments, imports from the shared
  // chunk plus a `__vitePreload(() => import(...))` dynamic import
  const bundle = (await unpackFixture('vite-chunk-min.js'))!;

  test('detects a single-module bundle', () => {
    expect(bundle).toBeDefined();
    expect(bundle.type).toBe('rollup');
    expect(bundle.modules.size).toBe(1);
    expect(bundle.entryId).toBe('index');
    const entry = bundle.modules.get('index')!;
    expect(entry.path).toBe('./index.js');
    expect(entry.isEntry).toBe(true);
  });

  test('static and dynamic chunk imports are recorded', () => {
    expect(dependenciesOf(bundle, 'index')).toEqual([
      './chunk-vendor.ABC123.js',
      './chunk-view.DEF456.js',
    ]);
  });

  test('module code snapshot', () => {
    expect(bundle.modules.get('index')!.code).toMatchSnapshot();
  });
});

describe('negative cases', () => {
  test('plain ESM is not a bundle', () => {
    expect(
      unpack(`
        import { format } from './utils.js';
        const label = format(3);
        export { label };
      `),
    ).toBeUndefined();
  });

  test('dynamic import alone is not a bundle', () => {
    // Hand-written ESM uses dynamic import() too, so it must not trigger
    expect(
      unpack(`
        const view = await import('./view.js');
        export { view };
      `),
    ).toBeUndefined();
  });

  test('single region comment is not a bundle', () => {
    expect(
      unpack(`
        // src/main.js
        console.log('hello');
      `),
    ).toBeUndefined();
  });

  test('esbuild ESM output is not a bundle', async () => {
    // Same `// src/...` comments as Rollup regions, but esbuild helpers
    const code = await readFile(
      join(ESBUILD_FIXTURES_DIR, 'esbuild-esm.js'),
      'utf8',
    );
    expect(unpack(code)).toBeUndefined();
  });

  test('esbuild CJS output is not a bundle', async () => {
    const code = await readFile(
      join(ESBUILD_FIXTURES_DIR, 'esbuild-cjs.js'),
      'utf8',
    );
    expect(unpack(code)).toBeUndefined();
  });

  test('unrelated code is not a bundle', () => {
    expect(unpack('console.log(1 + 2);')).toBeUndefined();
  });
});
