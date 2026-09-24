import { parse } from '@babel/parser';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { applyTransform } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { unpackTurbopack } from '../turbopack';
import { unpackAST } from '../index';

const FIXTURES_DIR = join(__dirname, 'turbopack');

function unpackCode(code: string): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  applyTransform(ast, unpackTurbopack, options);
  return options.bundle;
}

async function unpackFixture(name: string): Promise<Bundle> {
  const code = await readFile(join(FIXTURES_DIR, name), 'utf8');
  const bundle = unpackCode(code);
  expect(bundle).toBeDefined();
  return bundle!;
}

function snapshotOf(bundle: Bundle) {
  return {
    type: (bundle as { type: string }).type,
    entryId: bundle.entryId,
    modules: Array.from(bundle.modules.values(), (module) => ({
      id: module.id,
      path: module.path,
      isEntry: module.isEntry,
      code: module.code,
    })),
  };
}

describe('turbopack object-keyed chunk', async () => {
  const bundle = await unpackFixture('turbopack-basic.js');

  test('detects bundle with one module per entry', () => {
    expect(bundle.type).toBe('turbopack');
    expect(bundle.modules.size).toBe(3);
    expect(bundle.entryId).toBe(
      '[project]/src/greet.js [app-client] (ecmascript)',
    );
    expect(bundle.modules.get(bundle.entryId)!.isEntry).toBe(true);
  });

  test('derives paths from the [project] keys', () => {
    expect(
      bundle.modules.get('[project]/src/greet.js [app-client] (ecmascript)')!
        .path,
    ).toBe('./src/greet.js');
    expect(
      bundle.modules.get('[project]/src/name.js [app-client] (ecmascript)')!
        .path,
    ).toBe('./src/name.js');
    expect(
      bundle.modules.get('[project]/src/extra.js [app-client] (ecmascript)')!
        .path,
    ).toBe('./src/extra.js');
  });

  test('rewrites require calls to resolved paths', () => {
    const entry = bundle.modules.get(bundle.entryId)!.code;
    expect(entry).toContain('require("./src/name.js")');
    expect(entry).not.toContain('__turbopack_require__("');
    // External requires keep their specifier
    expect(entry).toContain('require("node:fs")');
    // Cross-chunk ids are left untouched
    const nameCode = bundle.modules.get(
      '[project]/src/name.js [app-client] (ecmascript)',
    )!.code;
    expect(nameCode).toContain('__turbopack_require__(99999)');
  });

  test('rewrites dynamic imports to resolved paths', () => {
    const entry = bundle.modules.get(bundle.entryId)!.code;
    expect(entry).toContain('import("./src/extra.js")');
    expect(entry).not.toContain('__turbopack_import__');
  });

  test('module code snapshots', () => {
    expect(snapshotOf(bundle)).toMatchSnapshot();
  });
});

describe('turbopack minified numeric-id chunk', async () => {
  const bundle = await unpackFixture('turbopack-min.js');

  test('detects numeric ids with synthesized paths', () => {
    expect(bundle.type).toBe('turbopack');
    expect([...bundle.modules.keys()]).toEqual(['5', '6', '7']);
    expect(bundle.entryId).toBe('5');
    expect(bundle.modules.get('5')!.path).toBe('./5.js');
    expect(bundle.modules.get('5')!.isEntry).toBe(true);
  });

  test('rewrites e.r/e.i calls where resolvable', () => {
    const code = bundle.modules.get('5')!.code;
    expect(code).toContain('require("./6.js")');
    expect(code).toContain('import("./7.js")');
    expect(code).not.toContain('e.r(6)');
    expect(code).not.toContain('e.i(7)');
    // Externals are left untouched
    expect(code).toContain('e.r("node:events")');
  });

  test('module code snapshots', () => {
    expect(snapshotOf(bundle)).toMatchSnapshot();
  });
});

describe('turbopack array chunk', async () => {
  const bundle = await unpackFixture('turbopack-array.js');

  test('uses the index as module id and skips holes', () => {
    expect(bundle.type).toBe('turbopack');
    expect([...bundle.modules.keys()]).toEqual(['0', '2']);
    expect(bundle.entryId).toBe('0');
    expect(bundle.modules.get('0')!.path).toBe('./0.js');
    expect(bundle.modules.get('2')!.path).toBe('./2.js');
  });

  test('rewrites requires across the index gap', () => {
    expect(bundle.modules.get('0')!.code).toContain('require("./2.js")');
  });

  test('module code snapshots', () => {
    expect(snapshotOf(bundle)).toMatchSnapshot();
  });
});

test('turbopack single-context param with inner destructure', () => {
  const bundle = unpackCode(`
    (globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["c.js", {
      "[project]/a.js [app-client] (ecmascript)": ((__turbopack_context__) => {
        "use strict";
        var { r: __turbopack_require__, m: module, e: exports } = __turbopack_context__;
        var b = __turbopack_require__("[project]/b.js [app-client] (ecmascript)");
        exports.a = "a" + b.b;
      }),
      "[project]/b.js [app-client] (ecmascript)": ((__turbopack_context__) => {
        "use strict";
        var { e: exports } = __turbopack_context__;
        exports.b = "b";
      }),
    }]);
  `);
  expect(bundle?.type).toBe('turbopack');
  expect(bundle?.modules.size).toBe(2);
  const entry = bundle!.modules.get(
    '[project]/a.js [app-client] (ecmascript)',
  )!;
  expect(entry.path).toBe('./a.js');
  expect(entry.code).toContain('require("./b.js")');
  expect(entry.code).not.toContain('__turbopack_context__');
  expect(entry.code).not.toContain('__turbopack_require__("');
});

test('turbopack same file in two layers gets unique paths', () => {
  const bundle = unpackCode(`
    (globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["c.js", {
      "[project]/src/x.js [app-client] (ecmascript)": ((e) => { e.e.v = 1; }),
      "[project]/src/x.js [app-ssr] (ecmascript)": ((e) => { e.e.v = 2; }),
    }]);
  `);
  const paths = [...bundle!.modules.values()].map((module) => module.path);
  expect(paths).toEqual(['./src/x.js', './src/x-1.js']);
});

test('turbopack claims chunks through the merged unpacker', () => {
  const ast = parse(
    '(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["c.js", {"[project]/a.js [app-client] (ecmascript)": ((e) => { e.e.v = 1; })}]);',
    { sourceType: 'unambiguous', allowReturnOutsideFunction: true },
  );
  expect(unpackAST(ast)?.type).toBe('turbopack');
});

test('turbopack does not claim webpack chunks', () => {
  const webpack = unpackCode(
    '(window.webpackChunk_N_E = window.webpackChunk_N_E || []).push([[0], {0: function(module, exports, require) { module.exports = 1; }}]);',
  );
  expect(webpack).toBeUndefined();

  const ast = parse(
    '(window.webpackChunk_N_E = window.webpackChunk_N_E || []).push([[0], {0: function(module, exports, require) { module.exports = 1; }}]);',
    { sourceType: 'unambiguous', allowReturnOutsideFunction: true },
  );
  expect(unpackAST(ast)?.type).toBe('webpack');
});

test('turbopack ignores non-module pushes', () => {
  expect(unpackCode('console.log(1 + 2);')).toBeUndefined();
  // Chunk-list manifests carry no module factories
  expect(
    unpackCode(
      '(globalThis.TURBOPACK_CHUNK_LISTS = globalThis.TURBOPACK_CHUNK_LISTS || []).push({ path: "x", included: [1] });',
    ),
  ).toBeUndefined();
  // Empty or factory-less containers
  expect(
    unpackCode(
      '(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["c.js", {}]);',
    ),
  ).toBeUndefined();
  expect(
    unpackCode(
      '(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["c.js", { url: "https://example.com/x.js" }]);',
    ),
  ).toBeUndefined();
});
