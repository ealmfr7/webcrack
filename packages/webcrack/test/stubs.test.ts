import { generate } from '@babel/generator';
import { parse } from '@babel/parser';
import { expect, test } from 'vitest';
import { applyTransform } from '../src/ast-utils';
import evalUnwrap from '../src/deobfuscate/eval-unwrap';
import packer from '../src/deobfuscate/packer';
import slicedToArray from '../src/transpile/transforms/sliced-to-array';
import spreadHelpers from '../src/transpile/transforms/spread-helpers';
import tsEnum from '../src/transpile/transforms/ts-enum';
import type { Bundle } from '../src/unpack/bundle';
import { unpackParcel } from '../src/unpack/parcel';
import { unpackRollup } from '../src/unpack/rollup';
import { unpackTurbopack } from '../src/unpack/turbopack';

// Stub unpackers expose a .visitor(options) returning an empty visitor
const unpackers = [unpackRollup, unpackParcel, unpackTurbopack];
// Stub transforms are no-op Transform objects
const transforms = [spreadHelpers, slicedToArray, tsEnum, packer, evalUnwrap];

const SAMPLE = 'var x = [1, 2, 3];\nfunction f(a) { return a + x.length; }';

test('stub unpackers return an empty visitor', () => {
  for (const unpacker of unpackers) {
    expect(unpacker.visitor({ bundle: undefined })).toEqual({});
  }
});

test('stub unpackers do not claim any bundle', () => {
  for (const unpacker of unpackers) {
    const ast = parse('var x = 1;');
    const options: { bundle: Bundle | undefined } = { bundle: undefined };
    applyTransform(ast, unpacker, options);
    expect(options.bundle).toBeUndefined();
  }
});

test('stub transforms leave code unchanged', () => {
  for (const transform of transforms) {
    const ast = parse(SAMPLE, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
    });
    const { changes } = applyTransform(ast, transform);
    expect(changes).toBe(0);
    expect(generate(ast).code).toBe(generate(parse(SAMPLE)).code);
  }
});
