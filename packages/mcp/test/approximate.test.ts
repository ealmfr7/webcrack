import { expect, test } from 'vitest';
import { buildIndex } from '../src/workspace/indexer';
import { connect, fixtureWorkspace } from './helpers';

test('unindexed names yield bounded, labelled locations in goto, refs and trace', async () => {
  const ws = fixtureWorkspace();
  ws.modules.clear();
  ws.modules.set('dynamic.js', {
    path: 'dynamic.js',
    bundleId: '0',
    isEntry: true,
    code: [
      'const holder = make({',
      '  mystery() { return fetch("/x"); },',
      '});',
      'holder.mystery();',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  expect(ws.index.symbols.some((s) => s.name === 'mystery')).toBe(false);
  const { call } = await connect(ws);
  const goto = await call('wc_goto', { symbol: 'mystery' });
  expect(goto).toContain('Approximate matches');
  expect(goto).toContain('dynamic.js:2  definition');
  const refs = await call('wc_refs', { symbol: 'mystery' });
  expect(refs).toContain('dynamic.js:4  use');
  const trace = await call('wc_trace', {
    value: 'mystery',
    direction: 'backward',
  });
  expect(trace).toContain('Approximate text matches');
  expect(trace).toContain('dynamic.js:2');
});

test('plain property writes are not symbols; goto on them falls back to approximate writes', async () => {
  const ws = fixtureWorkspace();
  ws.modules.clear();
  ws.modules.set('ns.js', {
    path: 'ns.js',
    bundleId: '0',
    isEntry: true,
    code: [
      '(function (g) {',
      '  g.load = function (f) { return f; };',
      '  function helper() {}',
      '  g.alias = helper;',
      '  g.count = 5;',
      '  function Player(v) { this.videoData = v; this.loading = true; this.run = g.load; }',
      '  if (g.count == 5) g.load(1);',
      '})(ns);',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  const names = ws.index.symbols.map((s) => s.name);
  expect(names).toEqual(expect.arrayContaining(['g.load', 'Player']));
  expect(names).not.toContain('g.count');
  expect(names).not.toContain('this.videoData');
  expect(names).not.toContain('this.loading');
  // An alias needs a callable target; `this.videoData = v` is a value write.
  expect(names).toContain('g.alias');
  const { call } = await connect(ws);
  const goto = await call('wc_goto', { symbol: 'videoData' });
  expect(goto).toContain('Approximate matches');
  expect(goto).toContain('ns.js:6  definition');
  // `g.count == 5` is a comparison, not a definition.
  const count = await call('wc_goto', { symbol: 'count' });
  expect(count).toContain('ns.js:5  definition');
  expect(count).not.toContain('ns.js:7  definition');
});
