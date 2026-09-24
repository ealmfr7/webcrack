import { describe, expect, test } from 'vitest';
import type { ModuleEntry, Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

function lineFor(text: string, path: string): string {
  const line = text.split('\n').find((l) => l.startsWith(path));
  expect(line, `expected a row for ${path}`).toBeDefined();
  return line ?? '';
}

/** Fixture plus one extra untagged module. */
function withExtra(): Workspace {
  const ws = fixtureWorkspace();
  const extra: ModuleEntry = {
    path: 'src/util.js',
    bundleId: '2',
    isEntry: false,
    code: 'export const x = 1;\n',
    tags: [],
  };
  ws.modules.set(extra.path, extra);
  ws.index.symbols.push({
    module: extra.path,
    name: 'x',
    kind: 'variable',
    line: 1,
    endLine: 1,
    exported: true,
    refCount: 0,
  });
  ws.index.imports[extra.path] = [];
  return ws;
}

describe('wc_map', () => {
  test('default output lists every module with header and Next', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_map', {});
    expect(text).toContain('Workspace fixture1 · 2 modules');
    expect(text).toContain('network(1)');
    expect(text).toContain('auth(1)');
    expect(text).toContain('crypto(1)');
    const api = lineFor(text, 'src/api.js');
    expect(api).toContain('exports 1');
    expect(api).toContain('imports 1');
    expect(api).toContain('network, auth, storage');
    expect(api).toContain('entry');
    const sign = lineFor(text, 'src/sign.js');
    expect(sign).toContain('exports 1');
    expect(sign).toContain('imports 0');
    expect(sign).toContain('crypto');
    expect(sign).not.toContain('entry');
    expect(text).toContain('Next:');
    expect(text).toContain('wc_outline src/api.js');
    expect(text).toContain('wc_findings');
  });

  test('path filter: folder, exact module, and unknown path suggestions', async () => {
    const { call } = await connect(fixtureWorkspace());
    const folder = await call('wc_map', { path: 'src/' });
    expect(folder).toContain('src/api.js');
    expect(folder).toContain('src/sign.js');
    const exact = await call('wc_map', { path: 'src/api.js' });
    expect(exact).toContain('src/api.js');
    expect(exact).not.toContain('src/sign.js');
    await expect(call('wc_map', { path: 'src/ap.js' })).rejects.toThrow(
      'src/api.js',
    );
  });

  test('tag filter keeps only matching modules', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_map', { tag: 'crypto' });
    expect(text).toContain('src/sign.js');
    expect(text).not.toContain('src/api.js');
    const empty = await call('wc_map', { tag: 'dom' });
    expect(empty).toContain('0 modules');
  });

  test('sorts: path, size and refs', async () => {
    const { call } = await connect(fixtureWorkspace());
    const byPath = await call('wc_map', { sort: 'path' });
    expect(byPath.indexOf('src/api.js')).toBeLessThan(
      byPath.indexOf('src/sign.js'),
    );
    const bySize = await call('wc_map', { sort: 'size' });
    expect(bySize.indexOf('src/api.js')).toBeLessThan(
      bySize.indexOf('src/sign.js'),
    );
    const byRefs = await call('wc_map', { sort: 'refs' });
    // src/sign.js:sign has 1 inbound ref; src/api.js has none.
    expect(byRefs.indexOf('src/sign.js')).toBeLessThan(
      byRefs.indexOf('src/api.js'),
    );
    expect(lineFor(byRefs, 'src/sign.js')).toContain('1 ref');
    expect(lineFor(byRefs, 'src/api.js')).toContain('0 refs');
  });

  test('pagination footer and second page', async () => {
    const { call } = await connect(fixtureWorkspace());
    const first = await call('wc_map', { limit: 1 });
    expect(first).toContain('src/api.js');
    expect(first).not.toContain('src/sign.js');
    expect(first).toContain('More: offset=1');
    const second = await call('wc_map', { limit: 1, offset: 1 });
    expect(second).toContain('src/sign.js');
    expect(second).not.toContain('More:');
  });

  test('detail=full lists exported symbol names in a fenced block', async () => {
    const { call } = await connect(fixtureWorkspace());
    const text = await call('wc_map', { detail: 'full' });
    expect(text).toContain('```exports src/api.js');
    expect(text).toContain('login');
    expect(text).toContain('```exports src/sign.js');
    expect(text).toContain('sign');
  });

  test('untagged modules are marked', async () => {
    const { call } = await connect(withExtra());
    const text = await call('wc_map', {});
    expect(lineFor(text, 'src/util.js')).toContain('untagged');
  });

  test('output budget is respected', async () => {
    const ws = fixtureWorkspace();
    for (let i = 0; i < 500; i++) {
      const path = `gen/m${i}.js`;
      ws.modules.set(path, {
        path,
        bundleId: `gen${i}`,
        isEntry: false,
        code: `// module ${i} ${'x'.repeat(200)}\nexport const v${i} = ${i};\n`,
        tags: [],
      });
      ws.index.imports[path] = [];
    }
    const { call } = await connect(ws);
    const text = await call('wc_map', { limit: 500 });
    expect(text).toContain('truncated');
    expect(text).toContain('Next:');
  });
});
