import { describe, expect, test } from 'vitest';
import { WcError } from '../src/format/errors';
import { searchAst } from '../src/workspace/search-ast';
import type { ModuleEntry, Workspace } from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

/** Add a bare module (no index entries needed: searchAst parses code). */
function addModule(ws: Workspace, path: string, code: string): ModuleEntry {
  const entry: ModuleEntry = {
    path,
    bundleId: path,
    isEntry: false,
    code,
    tags: [],
  };
  ws.modules.set(path, entry);
  return entry;
}

function locations(ws: Workspace, pattern: string, module?: string): string[] {
  return searchAst(ws, pattern, module).map(
    (hit) => `${hit.module}:${hit.line}`,
  );
}

describe('searchAst', () => {
  test('fetch($URL, $$REST) matches the api.js fetch call', () => {
    const hits = searchAst(fixtureWorkspace(), 'fetch($URL, $$REST)');
    expect(hits).toHaveLength(1);
    expect(hits[0].module).toBe('src/api.js');
    expect(hits[0].line).toBe(3);
    expect(hits[0].text).toContain('fetch(');
  });

  test('localStorage.setItem($K, $V) matches the storage call', () => {
    expect(
      locations(fixtureWorkspace(), 'localStorage.setItem($K, $V)'),
    ).toEqual(['src/api.js:8']);
  });

  test('{ method: "POST", $$R } matches the fetch options object', () => {
    const hits = searchAst(fixtureWorkspace(), '{ method: "POST", $$R }');
    expect(hits).toHaveLength(1);
    expect(hits[0].module).toBe('src/api.js');
    expect(hits[0].line).toBe(3);
  });

  test('$X + $X only matches structurally equal operands', () => {
    expect(locations(fixtureWorkspace(), '$X + $X')).toEqual([]);
    const ws = fixtureWorkspace();
    addModule(ws, 'src/add.js', 'const a = x + x;\nconst b = x + y;');
    expect(locations(ws, '$X + $X')).toEqual(['src/add.js:1']);
  });

  test('btoa($$A) matches one or more args, including zero', () => {
    const ws = fixtureWorkspace();
    addModule(ws, 'src/empty.js', 'btoa();');
    expect(locations(ws, 'btoa($$A)')).toEqual([
      'src/sign.js:2',
      'src/empty.js:1',
    ]);
  });

  test('module filter limits matching modules', () => {
    const ws = fixtureWorkspace();
    expect(locations(ws, 'btoa($$A)', 'src/sign.js')).toEqual([
      'src/sign.js:2',
    ]);
    expect(locations(ws, 'btoa($$A)', 'src/api.js')).toEqual([]);
    expect(() => searchAst(ws, 'btoa($$A)', 'src/missing.js')).toThrow(WcError);
  });

  test('unparseable pattern throws WcError with an example', () => {
    expect(() => searchAst(fixtureWorkspace(), 'fetch(((')).toThrow(WcError);
    try {
      searchAst(fixtureWorkspace(), 'fetch(((');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).message).toContain('Example');
    }
  });

  test('mutating module.code in place invalidates the AST cache', () => {
    const ws = fixtureWorkspace();
    expect(locations(ws, 'btoa($$A)')).toEqual(['src/sign.js:2']);
    const entry = ws.modules.get('src/sign.js');
    expect(entry).toBeDefined();
    entry!.code += '\nconst t = btoa("x");\n';
    expect(locations(ws, 'btoa($$A)')).toEqual([
      'src/sign.js:2',
      'src/sign.js:4',
    ]);
  });

  test('hit cap truncates with a notice hit', () => {
    const ws = fixtureWorkspace();
    addModule(ws, 'src/many.js', `${'foo(1);\n'.repeat(1500)}`);
    const hits = searchAst(ws, 'foo($$A)');
    expect(hits).toHaveLength(1001);
    expect(hits[1000].text).toMatch(/truncat/i);
  });
});
