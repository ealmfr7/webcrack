import { describe, expect, test } from 'vitest';
import { WcError } from '../src/format/errors';
import {
  parseTarget,
  resolveModule,
  resolveSymbol,
} from '../src/format/target';
import { fixtureWorkspace } from './helpers';

describe('parseTarget', () => {
  test('every target form', () => {
    expect(parseTarget('src/api.js')).toEqual({
      kind: 'module',
      module: 'src/api.js',
    });
    expect(parseTarget('src/api.js:8')).toEqual({
      kind: 'line',
      module: 'src/api.js',
      line: 8,
    });
    expect(parseTarget('src/api.js:8-12')).toEqual({
      kind: 'range',
      module: 'src/api.js',
      start: 8,
      end: 12,
    });
    expect(parseTarget('src/api.js:login')).toEqual({
      kind: 'symbol',
      module: 'src/api.js',
      symbol: 'login',
    });
    expect(parseTarget('login')).toEqual({ kind: 'bare', name: 'login' });
  });

  test('splits on the last colon', () => {
    expect(parseTarget('src/api.js:8')).toMatchObject({
      module: 'src/api.js',
    });
  });

  test('rejects empty and inverted targets', () => {
    for (const bad of [
      '',
      'src/api.js:',
      ':8',
      'src/api.js:0',
      'src/api.js:8-3',
    ]) {
      expect(() => parseTarget(bad), bad).toThrow(WcError);
    }
  });
});

describe('resolveModule', () => {
  test('path with and without ./ prefix', () => {
    const ws = fixtureWorkspace();
    expect(resolveModule(ws, 'src/api.js').bundleId).toBe('0');
    expect(resolveModule(ws, './src/api.js').bundleId).toBe('0');
  });

  test('bundle id', () => {
    const ws = fixtureWorkspace();
    expect(resolveModule(ws, '0').path).toBe('src/api.js');
    expect(resolveModule(ws, '1').path).toBe('src/sign.js');
  });

  test('not found suggests candidates', () => {
    const ws = fixtureWorkspace();
    try {
      resolveModule(ws, 'src/ap.js');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).suggestions).toContain('src/api.js');
      expect((error as Error).message).toContain('src/api.js');
    }
  });
});

describe('resolveSymbol', () => {
  test('bare unique name', () => {
    expect(resolveSymbol(fixtureWorkspace(), 'login')).toMatchObject({
      module: 'src/api.js',
      name: 'login',
    });
  });

  test('module:name, with ./ prefix accepted', () => {
    expect(
      resolveSymbol(fixtureWorkspace(), './src/api.js:login'),
    ).toMatchObject({ module: 'src/api.js', line: 2 });
    expect(resolveSymbol(fixtureWorkspace(), 'src/sign.js:sign')).toMatchObject(
      { module: 'src/sign.js', line: 1 },
    );
  });

  test('ambiguous bare name lists module:name candidates', () => {
    try {
      resolveSymbol(fixtureWorkspace(), 'sign');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as Error).message).toContain('src/api.js:sign');
      expect((error as Error).message).toContain('src/sign.js:sign');
    }
  });

  test('from prefers the import target over the import line', () => {
    expect(
      resolveSymbol(fixtureWorkspace(), 'sign', 'src/api.js:5'),
    ).toMatchObject({ module: 'src/sign.js', line: 1 });
  });

  test('from prefers the definition in its own module', () => {
    expect(
      resolveSymbol(fixtureWorkspace(), 'sign', 'src/sign.js:2'),
    ).toMatchObject({ module: 'src/sign.js', line: 1 });
  });

  test('not found suggests similar names', () => {
    try {
      resolveSymbol(fixtureWorkspace(), 'logni');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).suggestions).toContain('login');
    }
    try {
      resolveSymbol(fixtureWorkspace(), 'src/api.js:logni');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).suggestions).toContain('login');
    }
  });
});
