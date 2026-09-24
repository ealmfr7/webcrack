import { describe, expect, test } from 'vitest';
import { WcError } from '../src/format/errors';
import {
  matchModules,
  parseTarget,
  resolveModule,
  resolveSymbol,
  resolveTarget,
  resolveThroughImport,
  symbolsByName,
} from '../src/format/target';
import type {
  CallSite,
  ModuleEntry,
  RefEntry,
  SymbolEntry,
  Workspace,
  WorkspaceReexportEntry,
} from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

interface ModuleParts {
  symbols?: SymbolEntry[];
  calls?: CallSite[];
  refs?: RefEntry[];
  imports?: string[];
  reexports?: Omit<WorkspaceReexportEntry, 'module'>[];
}

/**
 * Clone the fixture and add whole modules: extra index entries plus the
 * `ModuleEntry` and `imports` edges. The fixture's own arrays are never
 * edited here (M1.2's contract test compares against them).
 */
function withModules(
  specs: ({ path: string; bundleId: string; code?: string } & ModuleParts)[],
): Workspace {
  const ws = fixtureWorkspace();
  for (const { path, bundleId, code, ...parts } of specs) {
    const entry: ModuleEntry = {
      path,
      bundleId,
      isEntry: false,
      code: code ?? '',
      tags: [],
    };
    ws.modules.set(path, entry);
    ws.index.symbols.push(...(parts.symbols ?? []));
    ws.index.calls.push(...(parts.calls ?? []));
    ws.index.refs.push(...(parts.refs ?? []));
    ws.index.imports[path] = parts.imports ?? [];
    ws.index.reexports.push(
      ...(parts.reexports ?? []).map((re) => ({ ...re, module: path })),
    );
  }
  return ws;
}

function sym(
  module: string,
  name: string,
  extra: Partial<SymbolEntry> = {},
): SymbolEntry {
  return {
    module,
    name,
    kind: 'function',
    line: 1,
    endLine: 3,
    exported: true,
    refCount: 0,
    ...extra,
  };
}

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

  test('dotted method names are symbols, not paths', () => {
    expect(parseTarget('Client.request')).toEqual({
      kind: 'bare',
      name: 'Client.request',
    });
    expect(parseTarget('foo.bar')).toEqual({ kind: 'bare', name: 'foo.bar' });
    // A non-JS extension is not a path either.
    expect(parseTarget('foo.json')).toEqual({
      kind: 'bare',
      name: 'foo.json',
    });
  });

  test('JS extensions and backslashes are paths', () => {
    for (const mod of [
      'a.js',
      'a.mjs',
      'a.cjs',
      'a.jsx',
      'a.ts',
      'a.tsx',
      'src\\api.js',
    ]) {
      expect(parseTarget(mod), mod).toEqual({ kind: 'module', module: mod });
    }
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

  test('bare name prefers the real definition over import bindings', () => {
    expect(resolveSymbol(fixtureWorkspace(), 'sign')).toMatchObject({
      module: 'src/sign.js',
      line: 1,
    });
  });

  test('bare single import binding follows to its target', () => {
    const ws = withModules([
      {
        path: 'src/alias.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/alias.js', 's', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'sign',
            from: 'src/sign.js',
          }),
        ],
      },
    ]);
    expect(resolveSymbol(ws, 's')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
  });

  test('module:name on an import binding follows to its target', () => {
    expect(resolveSymbol(fixtureWorkspace(), 'src/api.js:sign')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
  });

  test('ambiguous bare name lists only real definitions', () => {
    const ws = withModules([
      {
        path: 'src/other.js',
        bundleId: '2',
        symbols: [sym('src/other.js', 'sign')],
      },
    ]);
    try {
      resolveSymbol(ws, 'sign');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as Error).message).toContain('src/sign.js:sign');
      expect((error as Error).message).toContain('src/other.js:sign');
      expect((error as Error).message).not.toContain('src/api.js:sign');
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

describe('resolveThroughImport', () => {
  test('aliased import follows importedName', () => {
    const ws = withModules([
      {
        path: 'src/alias.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/alias.js', 's', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'sign',
            from: 'src/sign.js',
          }),
        ],
      },
    ]);
    expect(resolveThroughImport(ws, 'src/alias.js', 's')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
    expect(resolveSymbol(ws, 's', 'src/alias.js:1')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
  });

  test('default import follows the default export', () => {
    const ws = withModules([
      {
        path: 'src/hasdefault.js',
        bundleId: '2',
        symbols: [
          sym('src/hasdefault.js', 'default', {
            kind: 'function',
            exported: true,
          }),
        ],
      },
      {
        path: 'src/usedef.js',
        bundleId: '3',
        imports: ['src/hasdefault.js'],
        symbols: [
          sym('src/usedef.js', 'd', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'default',
            from: 'src/hasdefault.js',
          }),
        ],
      },
    ]);
    expect(resolveThroughImport(ws, 'src/usedef.js', 'd')).toMatchObject({
      module: 'src/hasdefault.js',
      name: 'default',
    });
  });

  test('barrel re-export resolves transitively', () => {
    const ws = withModules([
      {
        path: 'src/barrel.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        reexports: [
          { name: 'sign', importedName: 'sign', from: 'src/sign.js' },
        ],
      },
      {
        path: 'src/viabarrel.js',
        bundleId: '3',
        imports: ['src/barrel.js'],
        symbols: [
          sym('src/viabarrel.js', 'sign', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'sign',
            from: 'src/barrel.js',
          }),
        ],
      },
    ]);
    expect(resolveThroughImport(ws, 'src/viabarrel.js', 'sign')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
    expect(resolveSymbol(ws, 'sign', 'src/viabarrel.js:2')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
  });

  test('export * as ns is a namespace, not a star re-export', () => {
    const ws = withModules([
      {
        path: 'src/x.js',
        bundleId: '2',
        symbols: [sym('src/x.js', 'foo')],
      },
      {
        path: 'src/barrel.js',
        bundleId: '3',
        imports: ['src/x.js'],
        reexports: [{ name: 'ns', importedName: '*', from: 'src/x.js' }],
      },
      {
        path: 'src/user.js',
        bundleId: '4',
        imports: ['src/barrel.js'],
        symbols: [
          sym('src/user.js', 'foo', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'foo',
            from: 'src/barrel.js',
          }),
          sym('src/user.js', 'ns', {
            kind: 'import',
            line: 2,
            endLine: 2,
            exported: false,
            importedName: 'ns',
            from: 'src/barrel.js',
          }),
        ],
      },
    ]);
    // `foo` is not re-exported by the barrel, and `ns` itself is a
    // namespace, so neither follows anywhere.
    expect(resolveThroughImport(ws, 'src/user.js', 'foo')).toBeUndefined();
    expect(resolveThroughImport(ws, 'src/user.js', 'ns')).toBeUndefined();
  });

  test('export * never re-exports default', () => {
    const ws = withModules([
      {
        path: 'src/x.js',
        bundleId: '2',
        symbols: [
          sym('src/x.js', 'default', {
            kind: 'function',
            exported: true,
          }),
          sym('src/x.js', 'foo'),
        ],
      },
      {
        path: 'src/barrel.js',
        bundleId: '3',
        imports: ['src/x.js'],
        reexports: [{ name: '*', importedName: '*', from: 'src/x.js' }],
      },
      {
        path: 'src/user.js',
        bundleId: '4',
        imports: ['src/barrel.js'],
        symbols: [
          sym('src/user.js', 'd', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'default',
            from: 'src/barrel.js',
          }),
          sym('src/user.js', 'foo', {
            kind: 'import',
            line: 2,
            endLine: 2,
            exported: false,
            importedName: 'foo',
            from: 'src/barrel.js',
          }),
        ],
      },
    ]);
    expect(resolveThroughImport(ws, 'src/user.js', 'd')).toBeUndefined();
    expect(resolveThroughImport(ws, 'src/user.js', 'foo')).toMatchObject({
      module: 'src/x.js',
      name: 'foo',
    });
  });

  test('re-export cycles terminate', () => {
    const ws = withModules([
      {
        path: 'src/cycA.js',
        bundleId: '2',
        imports: ['src/cycB.js'],
        reexports: [
          { name: 'loop', importedName: 'loop', from: 'src/cycB.js' },
        ],
      },
      {
        path: 'src/cycB.js',
        bundleId: '3',
        imports: ['src/cycA.js'],
        reexports: [
          { name: 'loop', importedName: 'loop', from: 'src/cycA.js' },
        ],
      },
      {
        path: 'src/cycuse.js',
        bundleId: '4',
        imports: ['src/cycA.js'],
        symbols: [
          sym('src/cycuse.js', 'loop', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'loop',
            from: 'src/cycA.js',
          }),
        ],
      },
    ]);
    expect(resolveThroughImport(ws, 'src/cycuse.js', 'loop')).toBeUndefined();
  });

  test('import-only bare name dedupes to one target', () => {
    const ws = withModules([
      {
        path: 'src/m1.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/m1.js', 'shared', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'sign',
            from: 'src/sign.js',
          }),
        ],
      },
      {
        path: 'src/m2.js',
        bundleId: '3',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/m2.js', 'shared', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: 'sign',
            from: 'src/sign.js',
          }),
        ],
      },
    ]);
    expect(resolveSymbol(ws, 'shared')).toMatchObject({
      module: 'src/sign.js',
      name: 'sign',
    });
  });
});

describe('namespace imports', () => {
  function namespaced(): Workspace {
    return withModules([
      {
        path: 'src/nsuse.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/nsuse.js', 'ns', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: '*',
            from: 'src/sign.js',
          }),
          sym('src/nsuse.js', 'run', {
            kind: 'function',
            line: 2,
            endLine: 4,
            params: [],
          }),
        ],
        refs: [
          {
            module: 'src/nsuse.js',
            line: 3,
            name: 'ns.sign',
            defModule: 'src/sign.js',
            defLine: 1,
            kind: 'call',
          },
        ],
        calls: [
          { module: 'src/nsuse.js', line: 3, callee: 'ns.sign', caller: 'run' },
        ],
      },
    ]);
  }

  test('member access refs the exported symbol, callee keeps the dotted name', () => {
    const ws = namespaced();
    const ref = ws.index.refs.find((r) => r.name === 'ns.sign');
    expect(ref).toMatchObject({
      module: 'src/nsuse.js',
      defModule: 'src/sign.js',
      defLine: 1,
      kind: 'call',
    });
    const call = ws.index.calls.find((c) => c.callee === 'ns.sign');
    expect(call).toMatchObject({ module: 'src/nsuse.js', caller: 'run' });
  });

  test('bare namespace root is the import binding, not the export', () => {
    const ws = namespaced();
    expect(resolveSymbol(ws, 'ns')).toMatchObject({
      module: 'src/nsuse.js',
      kind: 'import',
    });
    expect(resolveThroughImport(ws, 'src/nsuse.js', 'ns')).toBeUndefined();
  });
});

describe('CJS and method naming', () => {
  test('require is a *-import; module.exports.x is an exported variable', () => {
    const ws = withModules([
      {
        path: 'src/cjs.js',
        bundleId: '2',
        imports: ['src/sign.js'],
        symbols: [
          sym('src/cjs.js', 'x', {
            kind: 'import',
            line: 1,
            endLine: 1,
            exported: false,
            importedName: '*',
            from: 'src/sign.js',
          }),
        ],
      },
      {
        path: 'src/legacy.js',
        bundleId: '3',
        symbols: [
          sym('src/legacy.js', 'y', { kind: 'variable', exported: true }),
        ],
      },
    ]);
    expect(resolveSymbol(ws, 'src/cjs.js:x')).toMatchObject({
      kind: 'import',
      importedName: '*',
      from: 'src/sign.js',
    });
    expect(resolveSymbol(ws, 'src/legacy.js:y')).toMatchObject({
      kind: 'variable',
      exported: true,
    });
  });

  test('dotted method name resolves as a bare symbol', () => {
    const ws = withModules([
      {
        path: 'src/client.js',
        bundleId: '2',
        symbols: [
          sym('src/client.js', 'Client.request', {
            kind: 'method',
            line: 4,
            endLine: 10,
            params: ['method', 'url'],
          }),
        ],
      },
    ]);
    expect(resolveSymbol(ws, 'Client.request')).toMatchObject({
      module: 'src/client.js',
      kind: 'method',
    });
    expect(resolveTarget(ws, 'Client.request')).toMatchObject({
      module: 'src/client.js',
      start: 4,
      end: 10,
    });
  });
});

describe('resolveTarget', () => {
  test('every target form', () => {
    const ws = fixtureWorkspace();
    expect(resolveTarget(ws, 'src/api.js')).toEqual({ module: 'src/api.js' });
    expect(resolveTarget(ws, 'src/api.js:8')).toEqual({
      module: 'src/api.js',
      start: 8,
      end: 8,
    });
    expect(resolveTarget(ws, 'src/api.js:8-9')).toEqual({
      module: 'src/api.js',
      start: 8,
      end: 9,
    });
    const qualified = resolveTarget(ws, 'src/api.js:login');
    expect(qualified.module).toBe('src/api.js');
    expect(qualified.start).toBe(2);
    expect(qualified.end).toBe(9);
    expect(qualified.symbol?.name).toBe('login');
    const bare = resolveTarget(ws, 'login');
    expect(bare.module).toBe('src/api.js');
    expect(bare.symbol?.name).toBe('login');
  });

  test('bare bundle id resolves to the module', () => {
    const ws = fixtureWorkspace();
    expect(resolveTarget(ws, '1')).toEqual({ module: 'src/sign.js' });
    // Symbol-first: a bare symbol never falls through to modules.
    expect(resolveTarget(ws, 'login').symbol).toBeDefined();
  });

  test('line/range beyond the module throws an actionable error', () => {
    const ws = fixtureWorkspace();
    // src/api.js has 9 lines; src/sign.js has 3.
    for (const bad of ['src/api.js:10', 'src/api.js:8-10', 'src/sign.js:4']) {
      try {
        resolveTarget(ws, bad);
        expect.unreachable(bad);
      } catch (error) {
        expect(error).toBeInstanceOf(WcError);
        expect((error as Error).message).toMatch(/has \d+ lines/);
        expect((error as Error).message).toContain('valid range 1-');
      }
    }
    try {
      resolveTarget(ws, 'src/api.js:10');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(
        'src/api.js has 9 lines; valid range 1-9.',
      );
    }
  });

  test('errors carry suggestions', () => {
    const ws = fixtureWorkspace();
    try {
      resolveTarget(ws, 'logni');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).suggestions).toContain('login');
    }
    try {
      resolveTarget(ws, 'src/nope.js');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as Error).message).toContain('src/api.js');
    }
  });
});

describe('fixture', () => {
  test('entryId is the bundle id', () => {
    expect(fixtureWorkspace().bundle).toEqual({
      type: 'esbuild',
      entryId: '0',
    });
  });
});

describe('matchModules', () => {
  test('undefined filter matches all modules', () => {
    const ws = fixtureWorkspace();
    expect(
      matchModules(ws)
        .map((m) => m.path)
        .sort(),
    ).toEqual(['src/api.js', 'src/sign.js']);
  });

  test('exact path, ./ prefix, and bundle id', () => {
    const ws = fixtureWorkspace();
    expect(matchModules(ws, 'src/api.js').map((m) => m.path)).toEqual([
      'src/api.js',
    ]);
    expect(matchModules(ws, './src/api.js').map((m) => m.path)).toEqual([
      'src/api.js',
    ]);
    expect(matchModules(ws, '1').map((m) => m.path)).toEqual(['src/sign.js']);
  });

  test('folder prefix matches every module under it', () => {
    const ws = withModules([
      { path: 'lib/util.js', bundleId: '2', code: 'export {};\n' },
    ]);
    expect(
      matchModules(ws, 'src/')
        .map((m) => m.path)
        .sort(),
    ).toEqual(['src/api.js', 'src/sign.js']);
    expect(matchModules(ws, 'lib').map((m) => m.path)).toEqual(['lib/util.js']);
  });

  test('no match throws with suggestions', () => {
    const ws = fixtureWorkspace();
    try {
      matchModules(ws, 'src/ap.js');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WcError);
      expect((error as WcError).suggestions).toContain('src/api.js');
    }
  });
});

describe('symbolsByName', () => {
  test('groups symbols by name and memoizes per workspace', () => {
    const ws = fixtureWorkspace();
    const grouped = symbolsByName(ws);
    expect(
      grouped
        .get('sign')
        ?.map((s) => s.module)
        .sort(),
    ).toEqual(['src/api.js', 'src/sign.js']);
    expect(grouped.get('login')?.map((s) => s.module)).toEqual(['src/api.js']);
    expect(grouped.get('missing')).toBeUndefined();
    expect(symbolsByName(ws)).toBe(grouped);
  });
});
