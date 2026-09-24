import { parse } from '@babel/parser';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { unpackChunks } from '../multi-chunk';

const FIXTURES_DIR = join(__dirname, 'multi-chunk');

async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), 'utf8');
}

describe('webpack runtime + chunks', async () => {
  const { bundle, unresolved, warnings } = unpackChunks([
    await readFixture('webpack-runtime.js'),
    await readFixture('webpack-chunk-a.js'),
    await readFixture('webpack-chunk-b.js'),
  ]);

  test('merges into a single webpack bundle', () => {
    expect(bundle).toBeDefined();
    expect(bundle!.type).toBe('webpack');
    expect([...bundle!.modules.keys()].sort()).toEqual(['1', '10', '11', '2']);
  });

  test('entry comes from the runtime file', () => {
    expect(bundle!.entryId).toBe('1');
    expect(bundle!.modules.get('1')!.isEntry).toBe(true);
    expect(bundle!.modules.get('10')!.isEntry).toBe(false);
  });

  test('cross-chunk requires are resolved', () => {
    const entry = bundle!.modules.get('1')!.code;
    expect(entry).toContain('require("./10.js")');
    expect(entry).not.toContain('webcrack:missing');
    const lazy = bundle!.modules.get('10')!.code;
    expect(lazy).toContain('require("./11.js")');
    expect(lazy).not.toContain('webcrack:missing');
  });

  test('reports the still-missing id', () => {
    expect(unresolved).toEqual(['./999.js']);
  });

  test('first input wins on duplicate ids', () => {
    expect(bundle!.modules.get('2')!.code).toContain("'hello'");
    expect(bundle!.modules.get('2')!.code).not.toContain('shadowed');
    expect(warnings).toContain("duplicate module id '2' from input #2 ignored");
  });
});

describe('turbopack multi-chunk', async () => {
  const { bundle, unresolved, warnings } = unpackChunks([
    await readFixture('turbopack-runtime.js'),
    await readFixture('turbopack-chunk.js'),
  ]);

  test('merges into a single turbopack bundle', () => {
    expect(bundle).toBeDefined();
    expect(bundle!.type).toBe('turbopack');
    expect(bundle!.modules.size).toBe(3);
  });

  test('entry comes from the runtime file', () => {
    expect(bundle!.entryId).toBe(
      '[project]/src/greet.js [app-client] (ecmascript)',
    );
    expect(
      bundle!.modules.get('[project]/src/extra.js [app-client] (ecmascript)')!
        .isEntry,
    ).toBe(false);
  });

  test('cross-chunk import is resolved', () => {
    const greet = bundle!.modules.get(bundle!.entryId)!.code;
    expect(greet).toContain('import("./extra.js")');
    expect(greet).not.toContain('__turbopack_import__');
    expect(greet).toContain('require("./name.js")');
  });

  test('reports the still-missing id', () => {
    expect(unresolved).toEqual(['99999']);
    expect(warnings).toEqual([]);
  });
});

describe('rollup multi-chunk', async () => {
  const { bundle, unresolved } = unpackChunks([
    await readFixture('rollup-entry.js'),
    await readFixture('rollup-shared.js'),
  ]);

  test('merges into a single rollup bundle', () => {
    expect(bundle).toBeDefined();
    expect(bundle!.type).toBe('rollup');
    expect([...bundle!.modules.keys()].sort()).toEqual([
      './src/main.js',
      './src/other.js',
      './src/shared.js',
      './src/utils.js',
    ]);
  });

  test('entry comes from the entry chunk', () => {
    expect(bundle!.entryId).toBe('./src/main.js');
  });

  test('cross-chunk import is resolved, missing chunk reported', () => {
    const main = bundle!.modules.get('./src/main.js')!.code;
    expect(main).toContain('from "./shared.js"');
    expect(unresolved).toEqual(['./chunk-vendor.a1b2c3.js']);
  });
});

test('unknown files are ignored with a warning', async () => {
  const { bundle, warnings } = unpackChunks([
    await readFixture('unknown.js'),
    await readFixture('webpack-chunk-a.js'),
  ]);
  expect(bundle).toBeDefined();
  expect(bundle!.type).toBe('webpack');
  expect([...bundle!.modules.keys()]).toEqual(['10']);
  expect(warnings).toEqual([
    'input #0: no known chunk format detected, ignored',
  ]);
});

test('no recognizable input yields no bundle', async () => {
  const { bundle, unresolved, warnings } = unpackChunks([
    await readFixture('unknown.js'),
  ]);
  expect(bundle).toBeUndefined();
  expect(unresolved).toEqual([]);
  expect(warnings).toHaveLength(1);
});

test('accepts mixed string and File inputs', async () => {
  const runtime = await readFixture('webpack-runtime.js');
  const chunkFile = parse(await readFixture('webpack-chunk-a.js'), {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const { bundle } = unpackChunks([runtime, chunkFile]);
  expect(bundle).toBeDefined();
  expect([...bundle!.modules.keys()].sort()).toEqual(['1', '10', '2']);
});

test('plain require of a missing relative path is unresolved', () => {
  // Rollup chunks pass require() calls through with no webcrack:missing
  // marker, so only the relink fallback can report them.
  const entry = `import './chunk-vendor.a1b2c3.js';

// src/main.js
const missing = require("./plain-missing.js");
console.log(missing);

export { missing };
`;
  const shared = `// src/shared.js
export const shared = 1;
`;
  const { bundle, unresolved } = unpackChunks([entry, shared]);
  expect(bundle).toBeDefined();
  expect(bundle!.type).toBe('rollup');
  expect(unresolved).toContain('./plain-missing.js');
});

test('accepts parsed File inputs', async () => {
  const files = await Promise.all(
    ['webpack-runtime.js', 'webpack-chunk-a.js'].map(async (name) =>
      parse(await readFixture(name), {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        plugins: ['jsx'],
      }),
    ),
  );
  const { bundle } = unpackChunks(files);
  expect(bundle).toBeDefined();
  expect([...bundle!.modules.keys()].sort()).toEqual(['1', '10', '2']);
});
