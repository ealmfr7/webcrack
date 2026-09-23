import { parse } from '@babel/parser';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { applyTransform } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { unpackParcel } from '../parcel';

const FIXTURES_DIR = join(__dirname, 'parcel');

function unpackCode(code: string): Bundle | undefined {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  applyTransform(ast, unpackParcel, options);
  if (options.bundle) options.bundle.applyTransforms();
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

test('parcel 2: module ids, entry id and dep rewriting', async () => {
  const bundle = await unpackFixture('parcel2-basic.js');

  expect(bundle.type).toBe('parcel');
  expect(bundle.entryId).toBe('entry1hash');
  expect([...bundle.modules.keys()]).toEqual([
    'entry1hash',
    'addhash',
    'colorhash',
  ]);
  expect(bundle.modules.get('entry1hash')!.isEntry).toBe(true);
  expect(bundle.modules.get('addhash')!.isEntry).toBe(false);

  const entryCode = bundle.modules.get('entry1hash')!.code;
  expect(entryCode).toContain('require("./addhash.js")');
  expect(entryCode).toContain('require("./colorhash.js")');
  expect(entryCode).not.toContain('parcelRequire');
  expect(entryCode).toContain('module.exports');

  // Runtime helpers are noise, never modules
  expect(bundle.modules.size).toBe(3);

  expect(bundle.modules.get('entry1hash')!.path).toBe('./index.js');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('parcel 2 minified: short params renamed, helpers ignored', async () => {
  const bundle = await unpackFixture('parcel2-min.js');

  expect(bundle.type).toBe('parcel');
  expect(bundle.entryId).toBe('c3');
  expect([...bundle.modules.keys()]).toEqual(['a1', 'b2', 'c3']);
  expect(bundle.modules.get('c3')!.isEntry).toBe(true);

  const entryCode = bundle.modules.get('c3')!.code;
  expect(entryCode).toContain('require("./a1.js")');
  expect(entryCode).toContain('require("./b2.js")');
  expect(entryCode).not.toContain('parcelRequire("');
  expect(entryCode).toContain('module.exports');

  const leafCode = bundle.modules.get('a1')!.code;
  expect(leafCode).toContain('$parcel$defineInteropFlag(exports)');
  expect(leafCode).toContain('$parcel$export(exports,');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('parcel 2 without iife wrapper', () => {
  const bundle = unpackCode(
    'parcelRegister("a", function (module, exports) {\n' +
      '  var b = parcelRequire("b");\n' +
      '  module.exports = b + 1;\n' +
      '});\n' +
      'parcelRegister("b", function (module, exports) {\n' +
      '  module.exports = 41;\n' +
      '});\n' +
      'parcelRequire("a");',
  );
  expect(bundle).toBeDefined();
  expect(bundle!.entryId).toBe('a');
  expect([...bundle!.modules.keys()]).toEqual(['a', 'b']);
  expect(bundle!.modules.get('a')!.code).toContain('require("./b.js")');
});

test('parcel 1: modules, dep map paths and entry id', async () => {
  const bundle = await unpackFixture('parcel1-basic.js');

  expect(bundle.type).toBe('parcel');
  expect(bundle.entryId).toBe('entry1');
  expect([...bundle.modules.keys()]).toEqual(['entry1', 'dep1', 'dep2']);
  expect(bundle.modules.get('entry1')!.isEntry).toBe(true);
  expect(bundle.modules.get('dep1')!.isEntry).toBe(false);

  // Specifiers are rewritten to resolved paths via the dep map
  const entryCode = bundle.modules.get('entry1')!.code;
  expect(entryCode).toContain('require("./utils/add.js")');
  expect(entryCode).toContain('require("./utils/color.js")');
  expect(entryCode).toContain('module.exports');

  const middleCode = bundle.modules.get('dep2')!.code;
  expect(middleCode).toMatch(/require\("\.\/add\.js"\)/);

  expect(bundle.modules.get('entry1')!.path).toBe('index.js');

  expect(snapshotOf(bundle)).toMatchSnapshot();
});

test('parcel ignores a locally declared parcelRegister', () => {
  const bundle = unpackCode(
    'function parcelRegister(id, factory) { return factory(); }\n' +
      'parcelRegister("a", function (module, exports) {\n' +
      '  module.exports = 1;\n' +
      '});',
  );
  expect(bundle).toBeUndefined();
});

test('parcel ignores non-parcel parcelRegister shapes', () => {
  // Non-function factory
  expect(unpackCode('parcelRegister("a", "not-a-function");')).toBeUndefined();
  // 0-param factory
  expect(
    unpackCode('parcelRegister("a", function () { return 1; });'),
  ).toBeUndefined();
  // No registers at all
  expect(unpackCode('parcelRequire("a");')).toBeUndefined();
  // Unrelated code
  expect(unpackCode('console.log("hello");')).toBeUndefined();
});

test('parcel 1 ignores non-parcel iife shapes', () => {
  // Empty modules object
  expect(
    unpackCode(
      '(function (modules, cache, entry, globalName) {})({}, {}, []);',
    ),
  ).toBeUndefined();
  // 3-param prelude is browserify's shape, not parcel's
  expect(
    unpackCode(
      '(function (files, cache, entryIds) {})({ 1: [function () {}, {}] }, {}, [1]);',
    ),
  ).toBeUndefined();
});
