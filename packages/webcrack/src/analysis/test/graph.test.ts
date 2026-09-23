import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { callGraph, moduleGraph, toDot, toJSON } from '../graph';
import type { Graph } from '../graph';
import { Bundle } from '../../unpack/bundle';
import { unpackAST } from '../../unpack/index';
import { Module } from '../../unpack/module';

const CORPUS_DIR = join(__dirname, '..', '..', '..', 'test', 'corpus');

function parseFile(code: string): t.File {
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
}

async function unpackCorpus(name: string): Promise<Bundle> {
  const code = await readFile(join(CORPUS_DIR, name), 'utf8');
  const bundle = unpackAST(parseFile(code));
  if (!bundle) throw new Error(`failed to unpack ${name}`);
  return bundle;
}

function testBundle(
  type: Bundle['type'],
  entryId: string,
  files: [id: string, code: string, isEntry?: boolean][],
): Bundle {
  const modules = new Map<string, Module>();
  for (const [id, code, isEntry] of files) {
    const mod = new Module(id, parseFile(code), isEntry ?? id === entryId);
    modules.set(id, mod);
  }
  return new Bundle(type, entryId, modules);
}

// Minimal DOT validity check: balanced braces, every quoted string closed,
// no raw newline inside a quoted string, no unescaped quote.
function expectValidDot(dot: string): void {
  expect(dot.startsWith('digraph')).toBe(true);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < dot.length; i++) {
    const ch = dot[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      else if (ch === '\n' || ch === '\r') {
        throw new Error(`raw newline inside DOT string at offset ${i}`);
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
  }
  expect(inString).toBe(false);
  expect(depth).toBe(0);
}

describe('moduleGraph', () => {
  test('webpack bundle', async () => {
    const bundle = await unpackCorpus('webpack-5.js');
    expect(bundle.type).toBe('webpack');
    const graph = moduleGraph(bundle);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain(bundle.entryId);
    expect(graph.nodes.find((n) => n.id === bundle.entryId)?.isEntry).toBe(
      true,
    );
    // Entry requires its dependency; every edge endpoint is a known node.
    const nodeIds = new Set(ids);
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
    expect(graph.edges.length).toBeGreaterThan(0);
    // Nodes and edges are sorted.
    expect(ids).toEqual([...ids].sort());
  });

  test('browserify bundle', async () => {
    const bundle = await unpackCorpus('browserify.js');
    expect(bundle.type).toBe('browserify');
    const graph = moduleGraph(bundle);
    // sum.js requires ./reduce and ./add
    const sum = [...bundle.modules.values()].find((m) =>
      m.code.includes('function sum'),
    )!;
    const targets = graph.edges
      .filter((e) => e.from === sum.id)
      .map((e) => e.to)
      .sort();
    expect(targets).toHaveLength(2);
    for (const to of targets) {
      expect(graph.nodes.some((n) => n.id === to)).toBe(true);
    }
    // No external nodes: all specifiers resolve inside the bundle.
    expect(graph.nodes.some((n) => n.external)).toBe(false);
  });

  test('esbuild bundle', async () => {
    const bundle = await unpackCorpus('esbuild-iife.js');
    expect(bundle.type).toBe('esbuild');
    const graph = moduleGraph(bundle);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      from: './index.js',
      to: './src/dep.js',
    });
  });

  test('unresolved deps become external nodes', () => {
    const bundle = testBundle('webpack', '1', [
      ['1', `const fs = require("fs"); const a = require("./a");`, true],
      ['2', `module.exports = 1;`],
    ]);
    // Give module 2 the path ./a.js so ./a resolves to it.
    bundle.modules.get('2')!.path = './a.js';
    const graph = moduleGraph(bundle);
    const external = graph.nodes.find((n) => n.id === 'external:fs');
    expect(external).toMatchObject({ label: 'fs', external: true });
    expect(graph.edges).toContainEqual({
      from: '1',
      to: 'external:fs',
      label: 'fs',
    });
    expect(graph.edges).toContainEqual({
      from: '1',
      to: '2',
      label: './a',
    });
  });

  test('import/export forms are collected', () => {
    const bundle = testBundle('webpack', '1', [
      [
        '1',
        `import x from "./x.js"; export * from "./y.js"; const d = import("./z.js");`,
        true,
      ],
      ['2', `export default 1;`],
      ['3', `export const y = 2;`],
      ['4', `export const z = 3;`],
    ]);
    bundle.modules.get('2')!.path = './x.js';
    bundle.modules.get('3')!.path = './y.js';
    bundle.modules.get('4')!.path = './z.js';
    const graph = moduleGraph(bundle);
    const targets = graph.edges
      .filter((e) => e.from === '1')
      .map((e) => e.to)
      .sort();
    expect(targets).toEqual(['2', '3', '4']);
  });
});

describe('callGraph', () => {
  test('recursion is a self edge', () => {
    const graph = callGraph(
      parseFile(`function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }`),
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(['fact']);
    expect(graph.edges).toEqual([{ from: 'fact', to: 'fact', label: 'fact' }]);
  });

  test('arrows bound to identifiers and unresolved callees', () => {
    const graph = callGraph(
      parseFile(`
        const add = (a, b) => a + b;
        const total = add(1, 2) + missing(3);
      `),
    );
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['<toplevel>', 'add', 'external:missing']);
    expect(graph.edges).toContainEqual({
      from: '<toplevel>',
      to: 'add',
      label: 'add',
    });
    expect(graph.edges).toContainEqual({
      from: '<toplevel>',
      to: 'external:missing',
      label: 'missing',
    });
    expect(graph.nodes.find((n) => n.id === 'external:missing')).toMatchObject({
      external: true,
    });
  });

  test('methods resolve via owner and this', () => {
    const graph = callGraph(
      parseFile(`
        const o = {
          m() { return this.n(1); },
          n(x) { return x; },
        };
        class A {
          run() { helper(); }
        }
        function helper() {}
        o.m();
        new A().run();
      `),
    );
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.has('o.m')).toBe(true);
    expect(byId.has('o.n')).toBe(true);
    expect(byId.has('A.run')).toBe(true);
    expect(graph.edges).toContainEqual({
      from: 'o.m',
      to: 'o.n',
      label: 'this.n',
    });
    expect(graph.edges).toContainEqual({
      from: 'A.run',
      to: 'helper',
      label: 'helper',
    });
    expect(graph.edges).toContainEqual({
      from: '<toplevel>',
      to: 'o.m',
      label: 'o.m',
    });
  });

  test('shadowing resolves to the inner definition', () => {
    const graph = callGraph(
      parseFile(`
        function foo() { return 1; }
        function bar() {
          function foo() { return 2; }
          return foo();
        }
      `),
    );
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'bar',
      'bar.foo',
      'foo',
    ]);
    expect(graph.edges).toEqual([{ from: 'bar', to: 'bar.foo', label: 'foo' }]);
  });

  test('functions nested in methods are qualified', () => {
    const graph = callGraph(
      parseFile(`
        const o = {
          m() {
            function helper() { return 1; }
            return helper();
          },
        };
      `),
    );
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['o.m', 'o.m.helper']);
    expect(graph.edges).toEqual([
      { from: 'o.m', to: 'o.m.helper', label: 'helper' },
    ]);
  });

  test('assignment-bound functions', () => {
    const graph = callGraph(
      parseFile(`
        let go;
        go = function () { go(); };
      `),
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(['go']);
    expect(graph.edges).toEqual([{ from: 'go', to: 'go', label: 'go' }]);
  });
});

describe('serializers', () => {
  const graph: Graph = {
    nodes: [
      { id: 'b', label: 'b' },
      { id: 'a', label: 'a' },
      { id: 'external:fs', label: 'fs', external: true },
    ],
    edges: [
      { from: 'b', to: 'a', label: 'x' },
      { from: 'a', to: 'external:fs', label: 'fs' },
    ],
  };

  test('toJSON is deterministic regardless of input order', () => {
    const shuffled: Graph = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(toJSON(shuffled)).toBe(toJSON(graph));
    const parsed = JSON.parse(toJSON(graph)) as {
      nodes: { id: string }[];
    };
    expect(parsed.nodes.map((n) => n.id)).toEqual(['a', 'b', 'external:fs']);
    expect(toJSON(graph).endsWith('\n')).toBe(true);
  });

  test('toDot escapes labels and is valid DOT', () => {
    const tricky: Graph = {
      nodes: [{ id: 'a"b\nc\\d', label: 'say "hi"\nbye\\' }],
      edges: [
        { from: 'a"b\nc\\d', to: 'external:e', label: 'we"ird\nlabel' },
        { from: 'a"b\nc\\d', to: 'external:e' },
      ],
    };
    const dot = toDot(tricky);
    expect(dot).toContain('say \\"hi\\"\\nbye\\\\');
    expectValidDot(dot);
  });

  test('toDot of a real module graph is valid DOT', async () => {
    const bundle = await unpackCorpus('browserify.js');
    expectValidDot(toDot(moduleGraph(bundle)));
  });
});
