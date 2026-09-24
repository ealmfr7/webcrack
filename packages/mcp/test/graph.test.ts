import { describe, expect, test } from 'vitest';
import { buildModulesGraph } from '../src/tools/graph';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

/** The tool prepends a header line and appends a `Next:` line around json. */
interface GraphJson {
  nodes: Record<string, unknown>[];
  edges: { from: string; to: string }[];
}

/** The tool prepends a header line and appends a `Next:` line around json. */
function graphJson(text: string): GraphJson {
  return JSON.parse(
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ) as GraphJson;
}

/** Declared nodes and `from -> to` edges in a dot body. */
function dotGraph(text: string): {
  nodes: Set<string>;
  edges: { from: string; to: string }[];
} {
  const nodes = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  const id = '((?:[^"\\\\]|\\\\.)*)';
  for (const line of text.split('\n')) {
    const edge = new RegExp(`^  "${id}" -> "${id}";$`).exec(line);
    if (edge) {
      edges.push({ from: edge[1], to: edge[2] });
      continue;
    }
    const node = new RegExp(`^  "${id}";$`).exec(line);
    if (node) nodes.add(node[1]);
  }
  return { nodes, edges };
}

function noBundleFirstModule(): Workspace {
  const ws = fixtureWorkspace();
  ws.bundle = undefined;
  for (const entry of ws.modules.values()) entry.isEntry = false;
  return ws;
}

describe('wc_graph modules', () => {
  test('default root is the bundle entry (id 0 -> src/api.js)', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_graph', { kind: 'modules' });
    expect(text).toContain('modules graph from src/api.js');
    expect(text).toContain('src/api.js');
    expect(text).toContain('src/sign.js');
    expect(text).toMatch(/Next: wc_outline src\/api\.js · wc_map/);
  });

  test('root accepts a bundle id', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_graph', { kind: 'modules', root: '0' });
    expect(text).toContain('modules graph from src/api.js');
  });

  test('json has nodes, edges and reverse importedBy', async () => {
    const { call } = await connect(fixtureWorkspace());
    const graph = graphJson(
      await call('wc_graph', { kind: 'modules', format: 'json' }),
    );
    const ids = graph.nodes.map((n) => n['id']);
    expect(ids).toEqual(expect.arrayContaining(['src/api.js', 'src/sign.js']));
    expect(graph.edges).toContainEqual({
      from: 'src/api.js',
      to: 'src/sign.js',
    });
    const sign = graph.nodes.find((n) => n['id'] === 'src/sign.js');
    expect(sign?.['importedBy']).toEqual(['src/api.js']);
  });

  test('dot quotes the graph name and every node id', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_graph', { kind: 'modules', format: 'dot' });
    expect(text).toContain('digraph "modules from src/api.js" {');
    expect(text).toContain('"src/api.js" -> "src/sign.js";');
  });

  test('dot escapes quotes in ids', async () => {
    const ws = fixtureWorkspace();
    ws.modules.set('src/we"ird.js', {
      path: 'src/we"ird.js',
      bundleId: '2',
      isEntry: false,
      code: '',
      tags: [],
    });
    ws.index.imports['src/api.js']?.push('src/we"ird.js');
    ws.index.imports['src/we"ird.js'] = [];
    const { call } = await connect(ws);
    const text = await call('wc_graph', { kind: 'modules', format: 'dot' });
    expect(text).toContain('"src/we\\"ird.js"');
  });

  test('unknown root suggests candidates', async () => {
    const { call } = await connect(fixtureWorkspace());
    await expect(
      call('wc_graph', { kind: 'modules', root: 'src/ap.js' }),
    ).rejects.toThrow('src/api.js');
  });

  test('no bundle falls back to the first module', async () => {
    const { call } = await connect(noBundleFirstModule());
    const text = await call('wc_graph', { kind: 'modules' });
    expect(text).toContain('modules graph from src/api.js');
  });

  test('node cap keeps every edge endpoint inside the graph', async () => {
    const ws = fixtureWorkspace();
    for (let i = 0; i < 250; i++) {
      const path = `src/fan${i}.js`;
      ws.modules.set(path, {
        path,
        bundleId: `fan${i}`,
        isEntry: false,
        code: '',
        tags: [],
      });
      ws.index.imports['src/api.js']?.push(path);
      ws.index.imports[path] = [];
    }
    const { call } = await connect(ws);
    const text = await call('wc_graph', {
      kind: 'modules',
      format: 'dot',
      depth: 1,
    });
    expect(text).toContain('(capped)');
    const graph = dotGraph(text);
    expect(graph.nodes.size).toBe(200);
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.from)).toBe(true);
      expect(graph.nodes.has(edge.to)).toBe(true);
    }
  });

  test(
    'a module cycle terminates and keeps the back edge',
    { timeout: 5000 },
    async () => {
      const ws = fixtureWorkspace();
      for (const [path, id] of [
        ['src/c3.js', 'c3'],
        ['src/c4.js', 'c4'],
      ] as const) {
        ws.modules.set(path, {
          path,
          bundleId: id,
          isEntry: false,
          code: '',
          tags: [],
        });
      }
      ws.index.imports['src/c3.js'] = ['src/c4.js'];
      ws.index.imports['src/c4.js'] = ['src/c3.js'];
      const graph = buildModulesGraph(ws, 'src/c3.js', Number.MAX_SAFE_INTEGER);
      expect(graph.nodes.size).toBe(2);
      expect(graph.edges).toContainEqual({
        from: 'src/c3.js',
        to: 'src/c4.js',
      });
      expect(graph.edges).toContainEqual({
        from: 'src/c4.js',
        to: 'src/c3.js',
      });
      const { call } = await connect(ws);
      const text = await call('wc_graph', {
        kind: 'modules',
        root: 'src/c3.js',
        depth: 6,
      });
      expect(text).toContain('↺');
    },
  );

  test(
    'a 30-node complete digraph at depth 6 finishes with all nodes and edges',
    { timeout: 10000 },
    async () => {
      const ws = fixtureWorkspace();
      const ids = Array.from({ length: 30 }, (_, i) => `src/dense${i}.js`);
      for (const id of ids) {
        ws.modules.set(id, {
          path: id,
          bundleId: id,
          isEntry: false,
          code: '',
          tags: [],
        });
        ws.index.imports[id] = ids.filter((other) => other !== id);
      }
      const start = Date.now();
      const graph = buildModulesGraph(ws, ids[0], 6);
      expect(Date.now() - start).toBeLessThan(5000);
      expect(graph.nodes.size).toBe(30);
      expect(graph.edges).toHaveLength(30 * 29);
      const { call } = await connect(ws);
      const text = await call('wc_graph', {
        kind: 'modules',
        root: ids[0],
        format: 'dot',
        depth: 6,
      });
      // The dot body is cut by the output budget on 870 edges, so the
      // exact edge count is asserted on the builder above; here the tool
      // must return promptly with the full 30-node header.
      expect(text).toContain('(depth 6, 30 nodes)');
      const dot = dotGraph(text);
      expect(dot.nodes.size).toBe(30);
      expect(dot.edges.length).toBeGreaterThan(30);
    },
  );
});

describe('wc_graph calls', () => {
  test('login resolves sign, globals stay leaves', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_graph', { kind: 'calls', root: 'login' });
    expect(text).toContain('calls graph from src/api.js:login');
    expect(text).toContain('src/sign.js:sign');
    for (const leaf of [
      'fetch',
      'JSON.stringify',
      'localStorage.setItem',
      '*.json',
    ]) {
      expect(text).toContain(leaf);
    }
    // Default depth 2 also reaches sign's own callee.
    expect(text).toContain('btoa');
    expect(text).toMatch(
      /Next: wc_read src\/api\.js:login · wc_refs src\/api\.js:login/,
    );
  });

  test('depth cuts the graph', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_graph', {
      kind: 'calls',
      root: 'login',
      depth: 1,
    });
    expect(text).toContain('src/sign.js:sign');
    expect(text).not.toContain('btoa');
  });

  test('cycles are marked instead of recursing', async () => {
    const ws = fixtureWorkspace();
    ws.index.calls.push({
      module: 'src/sign.js',
      line: 2,
      callee: 'login',
      caller: 'sign',
    });
    const { call } = await connect(ws);
    const text = await call('wc_graph', {
      kind: 'calls',
      root: 'login',
      depth: 4,
    });
    expect(text).toContain('↺');
  });

  test('calls need a root symbol', async () => {
    const { call } = await connect(fixtureWorkspace());
    await expect(call('wc_graph', { kind: 'calls' })).rejects.toThrow(
      'needs a root',
    );
  });

  test('unknown root suggests candidates', async () => {
    const { call } = await connect(fixtureWorkspace());
    await expect(
      call('wc_graph', { kind: 'calls', root: 'logni' }),
    ).rejects.toThrow('login');
  });

  test('node cap keeps every edge endpoint inside the graph', async () => {
    const ws = fixtureWorkspace();
    for (let i = 0; i < 250; i++) {
      ws.index.calls.push({
        module: 'src/api.js',
        line: 5,
        callee: `fanCall${i}`,
        caller: 'login',
      });
    }
    const { call } = await connect(ws);
    const text = await call('wc_graph', {
      kind: 'calls',
      root: 'login',
      format: 'dot',
      depth: 1,
    });
    expect(text).toContain('(capped)');
    const graph = dotGraph(text);
    expect(graph.nodes.size).toBe(200);
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.from)).toBe(true);
      expect(graph.nodes.has(edge.to)).toBe(true);
    }
  });

  test('json lists resolved nodes and leaf callees', async () => {
    const { call } = await connect(fixtureWorkspace());
    const graph = graphJson(
      await call('wc_graph', {
        kind: 'calls',
        root: 'src/api.js:login',
        format: 'json',
      }),
    );
    const ids = graph.nodes.map((n) => n['id']);
    expect(ids).toEqual(
      expect.arrayContaining([
        'src/api.js:login',
        'src/sign.js:sign',
        'fetch',
        '*.json',
      ]),
    );
    expect(graph.edges).toContainEqual({
      from: 'src/api.js:login',
      to: 'src/sign.js:sign',
    });
    const sign = graph.nodes.find((n) => n['id'] === 'src/sign.js:sign');
    expect(sign).toMatchObject({ module: 'src/sign.js', line: 1 });
  });
});
