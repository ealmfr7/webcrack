import { describe, expect, test } from 'vitest';
import { buildIndex, indexModule, linkIndex } from '../src/workspace/indexer';
import type {
  ModuleEntry,
  ModuleIndex,
  WorkspaceIndex,
} from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

let bundleSeq = 0;

function mod(path: string, code: string): ModuleEntry {
  bundleSeq += 1;
  return { path, bundleId: String(bundleSeq), isEntry: false, code, tags: [] };
}

function single(path: string, code: string, paths?: string[]): ModuleIndex {
  return indexModule(mod(path, code), paths ?? [path]);
}

function build(files: Record<string, string>): WorkspaceIndex {
  const modules = new Map<string, ModuleEntry>();
  for (const [path, code] of Object.entries(files)) {
    modules.set(path, mod(path, code));
  }
  return buildIndex(modules);
}

function symbolsOf(
  index: { symbols: WorkspaceIndex['symbols'] },
  module: string,
) {
  return index.symbols.filter((s) => s.module === module);
}

describe('contract', () => {
  test('buildIndex reproduces the fixture index', () => {
    const ws = fixtureWorkspace();
    expect(buildIndex(ws.modules)).toEqual(ws.index);
  });
});

describe('symbols', () => {
  test('class with methods uses Class.method names', () => {
    const index = single(
      'src/client.js',
      'export class Client {\n' +
        '  request(method, url) {}\n' +
        '  static open() {}\n' +
        '}\n',
    );
    expect(index.symbols).toEqual([
      {
        module: 'src/client.js',
        name: 'Client',
        kind: 'class',
        line: 1,
        endLine: 4,
        exported: true,
        refCount: 0,
      },
      {
        module: 'src/client.js',
        name: 'Client.request',
        kind: 'method',
        line: 2,
        endLine: 2,
        params: ['method', 'url'],
        exported: true,
        refCount: 0,
      },
      {
        module: 'src/client.js',
        name: 'Client.open',
        kind: 'method',
        line: 3,
        endLine: 3,
        params: [],
        exported: true,
        refCount: 0,
      },
    ]);
  });

  test('arrow and function-expression consts are functions with params', () => {
    const index = single(
      'src/f.js',
      'export const f = (a, b) => a;\nconst g = function (x) {};\nlet count = 0;\n',
    );
    expect(index.symbols).toEqual([
      {
        module: 'src/f.js',
        name: 'f',
        kind: 'function',
        line: 1,
        endLine: 1,
        params: ['a', 'b'],
        exported: true,
        refCount: 0,
      },
      {
        module: 'src/f.js',
        name: 'g',
        kind: 'function',
        line: 2,
        endLine: 2,
        params: ['x'],
        exported: false,
        refCount: 0,
      },
      {
        module: 'src/f.js',
        name: 'count',
        kind: 'variable',
        line: 3,
        endLine: 3,
        exported: false,
        refCount: 0,
      },
    ]);
  });

  test('anonymous default exports are named default', () => {
    const fn = single('src/a.js', 'export default function () {}\n');
    expect(fn.symbols).toMatchObject([
      { name: 'default', kind: 'function', exported: true },
    ]);
    const cls = single('src/b.js', 'export default class {}\n');
    expect(cls.symbols).toMatchObject([
      { name: 'default', kind: 'class', exported: true },
    ]);
    const named = single('src/c.js', 'export default function named() {}\n');
    expect(named.symbols).toMatchObject([
      { name: 'named', kind: 'function', exported: true },
    ]);
  });

  test('export specifiers mark locals exported and read them', () => {
    const index = single(
      'src/e.js',
      'function hidden() {}\nexport { hidden };\n',
    );
    expect(symbolsOf(index, 'src/e.js')).toMatchObject([
      { name: 'hidden', kind: 'function', exported: true },
    ]);
    expect(index.refs).toEqual([
      {
        module: 'src/e.js',
        line: 2,
        name: 'hidden',
        defModule: 'src/e.js',
        defLine: 1,
        kind: 'read',
      },
    ]);
  });

  test('no locals or params leak into symbols', () => {
    const index = single(
      'src/l.js',
      'export function outer(param) {\n  const local = param;\n  return local;\n}\n',
    );
    expect(index.symbols.map((s) => s.name)).toEqual(['outer']);
  });
});

describe('imports', () => {
  const code =
    'import def, { a as b, c } from "./m.js";\n' +
    'import * as ns from "./n";\n' +
    'import other from "npm-pkg";\n' +
    'import "./m.js";\n';

  test('alias, default and namespace imports carry importedName/from', () => {
    const index = single('src/main.js', code, [
      'src/main.js',
      'src/m.js',
      'src/n.js',
    ]);
    expect(index.symbols).toEqual([
      {
        module: 'src/main.js',
        name: 'def',
        kind: 'import',
        line: 1,
        endLine: 1,
        exported: false,
        refCount: 0,
        importedName: 'default',
        from: 'src/m.js',
      },
      {
        module: 'src/main.js',
        name: 'b',
        kind: 'import',
        line: 1,
        endLine: 1,
        exported: false,
        refCount: 0,
        importedName: 'a',
        from: 'src/m.js',
      },
      {
        module: 'src/main.js',
        name: 'c',
        kind: 'import',
        line: 1,
        endLine: 1,
        exported: false,
        refCount: 0,
        importedName: 'c',
        from: 'src/m.js',
      },
      {
        module: 'src/main.js',
        name: 'ns',
        kind: 'import',
        line: 2,
        endLine: 2,
        exported: false,
        refCount: 0,
        importedName: '*',
        from: 'src/n.js',
      },
      {
        module: 'src/main.js',
        name: 'other',
        kind: 'import',
        line: 3,
        endLine: 3,
        exported: false,
        refCount: 0,
        importedName: 'default',
      },
    ]);
  });

  test('unresolvable sources keep from undefined and leave imports', () => {
    const index = single('src/main.js', code, [
      'src/main.js',
      'src/m.js',
      'src/n.js',
    ]);
    expect(index.imports).toEqual(['src/m.js', 'src/n.js']);
    // The npm source is still a string literal.
    expect(index.strings.map((s) => s.value)).toContain('npm-pkg');
  });

  test('extensionless, parent and folder-index resolution', () => {
    const index = single('src/sub/main.js', 'import { x } from "./sib";\n', [
      'src/sub/main.js',
      'src/sub/sib.js',
    ]);
    expect(index.symbols).toMatchObject([
      { name: 'x', from: 'src/sub/sib.js' },
    ]);

    const up = single('src/sub/main.js', 'import { y } from "../lib";\n', [
      'src/sub/main.js',
      'src/lib/index.js',
    ]);
    expect(up.symbols).toMatchObject([{ name: 'y', from: 'src/lib/index.js' }]);

    const miss = single('src/main.js', 'import { z } from "./nope";\n', [
      'src/main.js',
    ]);
    expect(miss.symbols).toMatchObject([{ name: 'z' }]);
    expect(miss.symbols[0]).not.toHaveProperty('from');
    expect(miss.imports).toEqual([]);
  });
});

describe('barrels', () => {
  const files = {
    'src/a.js': 'export const value = 1;\nexport default function make() {}\n',
    'src/b.js': 'export const other = 2;\n',
    'src/barrel.js':
      'export { value as v } from "./a.js";\n' +
      'export * from "./b.js";\n' +
      'export * as ns from "./a.js";\n',
    'src/user.js':
      'import { v } from "./barrel.js";\n' +
      'import { other } from "./barrel.js";\n' +
      'import { missing } from "./barrel.js";\n' +
      'import def from "./barrel.js";\n' +
      'import * as ns2 from "./barrel.js";\n' +
      'v();\n' +
      'other();\n' +
      'missing();\n' +
      'def();\n' +
      'ns2.other();\n',
  };

  test('reexport entries use exported/imported names', () => {
    const index = build(files);
    expect(index.reexports).toEqual([
      {
        module: 'src/barrel.js',
        name: 'v',
        importedName: 'value',
        from: 'src/a.js',
      },
      {
        module: 'src/barrel.js',
        name: '*',
        importedName: '*',
        from: 'src/b.js',
      },
      {
        module: 'src/barrel.js',
        name: 'ns',
        importedName: '*',
        from: 'src/a.js',
      },
    ]);
  });

  test('named and star re-exports resolve; namespace and default do not', () => {
    const index = build(files);
    const ref = (name: string) => index.refs.find((r) => r.name === name);
    expect(ref('v')).toMatchObject({
      defModule: 'src/a.js',
      defLine: 1,
      kind: 'call',
    });
    expect(ref('other')).toMatchObject({
      defModule: 'src/b.js',
      defLine: 1,
      kind: 'call',
    });
    expect(ref('missing')).not.toHaveProperty('defModule');
    // `export *` never re-exports default.
    expect(ref('def')).not.toHaveProperty('defModule');
    // Namespace member access resolves through the barrel's star export.
    expect(ref('ns2.other')).toMatchObject({
      defModule: 'src/b.js',
      defLine: 1,
      kind: 'call',
    });
  });

  test('namespace re-export is not a named export', () => {
    const index = build({
      'src/a.js': 'export const q = 1;\n',
      'src/barrel.js': 'export * as ns from "./a.js";\n',
      'src/user.js': 'import { q } from "./barrel.js";\nq();\n',
    });
    expect(index.refs.find((r) => r.name === 'q')).not.toHaveProperty(
      'defModule',
    );
  });

  test('re-export cycles terminate', () => {
    const index = build({
      'src/a.js': 'export { x } from "./b.js";\n',
      'src/b.js': 'export { x } from "./a.js";\n',
      'src/u.js': 'import { x } from "./a.js";\nx();\n',
    });
    expect(index.refs.find((r) => r.name === 'x')).not.toHaveProperty(
      'defModule',
    );
  });
});

describe('cjs', () => {
  const code =
    'const lib = require("./lib.js");\n' +
    'const fs = require("fs");\n' +
    'module.exports.run = function () {};\n' +
    'exports.helper = 1;\n';

  test('require is a *-import; exports mark exported', () => {
    const index = single('src/c.js', code, ['src/c.js', 'src/lib.js']);
    expect(index.symbols).toEqual([
      {
        module: 'src/c.js',
        name: 'lib',
        kind: 'import',
        line: 1,
        endLine: 1,
        exported: false,
        refCount: 0,
        importedName: '*',
        from: 'src/lib.js',
      },
      {
        module: 'src/c.js',
        name: 'fs',
        kind: 'import',
        line: 2,
        endLine: 2,
        exported: false,
        refCount: 0,
        importedName: '*',
      },
      {
        module: 'src/c.js',
        name: 'run',
        kind: 'variable',
        line: 3,
        endLine: 3,
        exported: true,
        refCount: 0,
      },
      {
        module: 'src/c.js',
        name: 'helper',
        kind: 'variable',
        line: 4,
        endLine: 4,
        exported: true,
        refCount: 0,
      },
    ]);
    expect(index.imports).toEqual(['src/lib.js']);
    expect(index.strings.map((s) => s.value)).toEqual(['./lib.js', 'fs']);
    expect(index.calls.map((c) => [c.line, c.callee])).toEqual([
      [1, 'require'],
      [2, 'require'],
    ]);
    expect(index.refs).toEqual([]);
  });

  test('module.exports.x sets exported on an existing symbol', () => {
    const index = single(
      'src/d.js',
      'function run() {}\nmodule.exports.run = run;\n',
    );
    expect(symbolsOf(index, 'src/d.js')).toMatchObject([
      { name: 'run', kind: 'function', exported: true },
    ]);
  });
});

describe('calls', () => {
  test('caller is the nearest named function', () => {
    const index = single(
      'src/c.js',
      'const f = () => {\n  g();\n};\nfunction g() {}\n',
    );
    expect(index.calls).toEqual([
      { module: 'src/c.js', line: 2, callee: 'g', caller: 'f' },
    ]);
  });

  test('anonymous wrappers are skipped; methods name the caller', () => {
    const index = single(
      'src/n.js',
      'function outer() {\n' +
        '  setTimeout(function () {\n' +
        '    inner();\n' +
        '  });\n' +
        '}\n' +
        'class C {\n' +
        '  m() {\n' +
        '    helper();\n' +
        '  }\n' +
        '}\n' +
        'function inner() {}\n' +
        'function helper() {}\n',
    );
    expect(index.calls).toEqual([
      { module: 'src/n.js', line: 2, callee: 'setTimeout', caller: 'outer' },
      { module: 'src/n.js', line: 3, callee: 'inner', caller: 'outer' },
      { module: 'src/n.js', line: 8, callee: 'helper', caller: 'C.m' },
    ]);
  });

  test('callee normalization: globals dotted, locals starred', () => {
    const index = single(
      'src/u.js',
      'import axios from "./ax.js";\n' +
        'import { sign } from "./s.js";\n' +
        'function local() {}\n' +
        'function demo() {\n' +
        '  JSON.stringify({});\n' +
        '  local();\n' +
        '  local.prop();\n' +
        '  axios.post("/x");\n' +
        '  sign("a");\n' +
        '  this.foo();\n' +
        '}\n',
      ['src/u.js', 'src/ax.js', 'src/s.js'],
    );
    expect(index.calls.map((c) => c.callee)).toEqual([
      'JSON.stringify',
      'local',
      '*.prop',
      'axios.post',
      'sign',
      '*.foo',
    ]);
    for (const call of index.calls) expect(call.caller).toBe('demo');
  });
});

describe('strings', () => {
  test('property keys excluded, values and sources included', () => {
    const index = single(
      'src/s.js',
      'import { x } from "./m.js";\n' +
        'const headers = { "x-sign": sign, method: "POST" };\n',
      ['src/s.js', 'src/m.js'],
    );
    expect(index.strings).toEqual([
      { module: 'src/s.js', line: 1, value: './m.js' },
      { module: 'src/s.js', line: 2, value: 'POST' },
    ]);
  });
});

describe('refs', () => {
  test('read, write and call kinds; declarations are not refs', () => {
    const index = single(
      'src/r.js',
      'function foo(a) {\n' +
        '  return a;\n' +
        '}\n' +
        'let x = 1;\n' +
        'x = 2;\n' +
        'x++;\n' +
        'foo(x);\n',
    );
    expect(index.refs).toEqual([
      {
        module: 'src/r.js',
        line: 5,
        name: 'x',
        defModule: 'src/r.js',
        defLine: 4,
        kind: 'write',
      },
      {
        module: 'src/r.js',
        line: 6,
        name: 'x',
        defModule: 'src/r.js',
        defLine: 4,
        kind: 'write',
      },
      {
        module: 'src/r.js',
        line: 7,
        name: 'foo',
        defModule: 'src/r.js',
        defLine: 1,
        kind: 'call',
      },
      {
        module: 'src/r.js',
        line: 7,
        name: 'x',
        defModule: 'src/r.js',
        defLine: 4,
        kind: 'read',
      },
    ]);
  });

  test('for-of targets and destructuring assignments are writes', () => {
    const index = single(
      'src/w.js',
      'let x;\nlet y;\nfor (x of y) {\n  ({ x } = { x: y });\n}\n',
    );
    expect(index.refs).toEqual([
      {
        module: 'src/w.js',
        line: 3,
        name: 'x',
        defModule: 'src/w.js',
        defLine: 1,
        kind: 'write',
      },
      {
        module: 'src/w.js',
        line: 3,
        name: 'y',
        defModule: 'src/w.js',
        defLine: 2,
        kind: 'read',
      },
      {
        module: 'src/w.js',
        line: 4,
        name: 'x',
        defModule: 'src/w.js',
        defLine: 1,
        kind: 'write',
      },
      {
        module: 'src/w.js',
        line: 4,
        name: 'y',
        defModule: 'src/w.js',
        defLine: 2,
        kind: 'read',
      },
    ]);
  });

  test('globals and locals are never refs', () => {
    const index = single(
      'src/g.js',
      'export function run(list) {\n  const doubled = list.map(fetch);\n  return JSON.stringify(doubled);\n}\n',
    );
    expect(index.refs).toEqual([]);
  });

  test('import refs stay unresolved in the module slice', () => {
    const index = single('src/u.js', 'import { x } from "./m.js";\nx();\n', [
      'src/u.js',
    ]);
    expect(index.refs).toEqual([
      { module: 'src/u.js', line: 2, name: 'x', kind: 'call' },
    ]);
    expect(index.refs[0]).not.toHaveProperty('defModule');
  });

  test('namespace member refs keep the dotted name', () => {
    const index = build({
      'src/sign.js': 'export function sign(v) {\n  return v;\n}\n',
      'src/use.js': 'import * as ns from "./sign.js";\nns.sign("a");\n',
    });
    expect(index.refs).toEqual([
      {
        module: 'src/use.js',
        line: 2,
        name: 'ns.sign',
        defModule: 'src/sign.js',
        defLine: 1,
        kind: 'call',
      },
    ]);
    expect(
      index.symbols.find(
        (s) => s.name === 'sign' && s.module === 'src/sign.js',
      ),
    ).toMatchObject({ refCount: 1 });
  });
});

describe('refCount', () => {
  test('counts local and cross-module refs, not the import binding', () => {
    const index = build({
      'src/a.js': 'export function f() {}\nf();\n',
      'src/b.js': 'import { f } from "./a.js";\nf();\nf();\n',
      'src/c.js': 'import { f } from "./a.js";\n',
    });
    const def = index.symbols.find(
      (s) => s.module === 'src/a.js' && s.name === 'f',
    );
    expect(def).toMatchObject({ refCount: 3 });
    for (const s of index.symbols) {
      if (s !== def) expect(s.refCount).toBe(0);
    }
  });
});

describe('linkIndex', () => {
  test('concatenates in module order and builds the imports record', () => {
    const parts = new Map<string, ModuleIndex>([
      ['src/b.js', single('src/b.js', 'export const b = 1;\n')],
      ['src/a.js', single('src/a.js', 'export const a = 1;\n')],
    ]);
    const linked = linkIndex(parts);
    expect(linked.symbols.map((s) => s.name)).toEqual(['b', 'a']);
    expect(linked.imports).toEqual({ 'src/b.js': [], 'src/a.js': [] });
  });
});

describe('lines', () => {
  test('every entry points inside its module code', () => {
    const ws = fixtureWorkspace();
    const index = buildIndex(ws.modules);
    for (const [path, entry] of ws.modules) {
      const lineCount = entry.code.split('\n').length;
      for (const sym of symbolsOf(index, path)) {
        expect(sym.line).toBeGreaterThanOrEqual(1);
        expect(sym.endLine).toBeLessThanOrEqual(lineCount);
      }
      for (const entry_ of [...index.calls, ...index.strings, ...index.refs]) {
        if (entry_.module !== path) continue;
        expect(entry_.line).toBeGreaterThanOrEqual(1);
        expect(entry_.line).toBeLessThanOrEqual(lineCount);
      }
    }
    const apiLines = ws.modules.get('src/api.js')?.code.split('\n') ?? [];
    expect(apiLines[1]).toContain('login');
    expect(apiLines[4]).toContain('sign(user)');
  });
});

describe('robustness', () => {
  test.each([
    '',
    '(((',
    'function (',
    'export default',
    'class {',
    '`${unterminated',
    '....,,,',
    '\x00\x01\x02',
  ])('hostile input %j never throws', (code) => {
    expect(() => single('src/h.js', code)).not.toThrow();
  });

  test('empty module gives an empty index', () => {
    expect(single('src/e.js', '')).toEqual({
      symbols: [],
      calls: [],
      strings: [],
      refs: [],
      imports: [],
      reexports: [],
    });
  });
});

describe('performance', () => {
  test('a ~1 MB module indexes in well under a few seconds', () => {
    const block =
      'export function fnPLACEHOLDER(a, b) {\n  return helper(a + "x" + b);\n}\n';
    const count = 16000;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push(block.replace('PLACEHOLDER', String(i)));
    }
    const code = parts.join('');
    expect(code.length).toBeGreaterThan(1_000_000);
    const started = Date.now();
    const index = single('src/big.js', code);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(index.symbols).toHaveLength(count);
    expect(index.calls).toHaveLength(count);
  });
});
