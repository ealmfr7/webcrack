import { parse } from '@babel/parser';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { applyTransform } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { unpackMetro } from '../metro';

const FIXTURES_DIR = join(__dirname, 'metro');

function unpackCode(code: string): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  applyTransform(ast, unpackMetro, options);
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

test('metro 7-param: module ids, entry id and dep rewriting', async () => {
  const bundle = await unpackFixture('metro-basic.js');

  expect(bundle.entryId).toBe('0');
  expect([...bundle.modules.keys()]).toEqual(['0', '1', '2']);
  expect(bundle.modules.get('0')!.isEntry).toBe(true);
  expect(bundle.modules.get('1')!.isEntry).toBe(false);

  const entryCode = bundle.modules.get('0')!.code;
  expect(entryCode).toContain('require(1)');
  expect(entryCode).toContain('require(2)');
  expect(entryCode).not.toContain('_$$_REQUIRE');
  expect(entryCode).not.toContain('_dependencyMap');
  expect(entryCode).toContain('module.exports');

  const leafCode = bundle.modules.get('1')!.code;
  expect(leafCode).toContain('module.exports');

  expect(bundle.modules.get('0')!.path).toBe('./index.js');
  expect(bundle.modules.get('1')!.path).toBe('./utils/add.js');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('metro 5/6-param factories', async () => {
  const bundle = await unpackFixture('metro-legacy.js');

  expect(bundle.entryId).toBe('10');
  expect([...bundle.modules.keys()]).toEqual(['10', '11', '12']);
  expect(bundle.modules.get('10')!.isEntry).toBe(true);

  // 5-param with dependencyMap
  const entryCode = bundle.modules.get('10')!.code;
  expect(entryCode).toContain('require(11)');
  expect(entryCode).not.toContain('dependencyMap');
  expect(entryCode).toContain('module.exports');

  // 6-param with dependencyMap
  const middleCode = bundle.modules.get('11')!.code;
  expect(middleCode).toContain('require(12)');
  expect(middleCode).not.toContain('dependencyMap');

  // 6-param without dependencyMap (positional fallback, no crash)
  const leafCode = bundle.modules.get('12')!.code;
  expect(leafCode).toContain('exports.default');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('metro 7-param minified: importDefault/importAll are not require', async () => {
  const bundle = await unpackFixture('metro-min.js');

  expect(bundle.entryId).toBe('0');
  expect([...bundle.modules.keys()]).toEqual(['0', '5', '6', '7']);

  const code = bundle.modules.get('0')!.code;
  expect(code).toContain('importDefault(5)');
  expect(code).toContain('require(6)');
  expect(code).toContain('importAll(7)');
  // The importDefault call must not be rewritten to require(5)
  expect(code).not.toContain('require(5)');
  expect(code).not.toContain('d[');
  expect(code).not.toContain('_dependencyMap');
  // Dev-bundle verbose name 2nd arg is dropped by the rewrite
  expect(code).not.toContain('"six"');
  expect(code).toContain('module.exports');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('metro ignores a locally declared __d', () => {
  const bundle = unpackCode(
    'function __d(f, n) { return f(); }\n' +
      '__d(function (global, require, module, exports, dependencyMap) {\n' +
      '  module.exports = 1;\n' +
      '}, 0, []);',
  );
  expect(bundle).toBeUndefined();
});

test('metro ignores non-metro __d shapes', () => {
  // 0-param factory, no deps array
  expect(
    unpackCode('__d(function () { console.log(1); }, 1);'),
  ).toBeUndefined();
  // 2-param factory even with a deps array
  expect(
    unpackCode('__d(function (a, b) { return a(b[0]); }, 2, [3]);'),
  ).toBeUndefined();
  // Locally assigned __d
  expect(
    unpackCode(
      'var __d = function (f, x) {};\n' +
        '__d(function (a, b) { return a(b[0]); }, 2, [3]);',
    ),
  ).toBeUndefined();
});
