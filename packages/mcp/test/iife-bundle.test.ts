import { describe, expect, test } from 'vitest';
import { buildIndex } from '../src/workspace/indexer';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

const CODE = [
  'var _yt_player = {};',
  '(function(g) {',
  '  function kZ() {',
  '    return "/api/" + "log";',
  '  }',
  '  function p6X(url) {',
  '    return fetch(url);',
  '  }',
  '  function run() {',
  '    return p6X(kZ());',
  '  }',
  '  run();',
  '})(_yt_player);',
].join('\n');

function wrappedWorkspace(code = CODE): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.clear();
  ws.modules.set('player.js', {
    path: 'player.js',
    bundleId: '0',
    isEntry: true,
    code,
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  return ws;
}

function symbolsAt(ws: Workspace): string[] {
  return ws.index.symbols.map((s) => `${s.kind} ${s.name}@${s.line}`);
}

describe('classic IIFE bundle', () => {
  test('outline, goto and refs see the enclosed declarations', async () => {
    const ws = wrappedWorkspace();
    expect(ws.index.symbols.map((s) => s.name)).toEqual([
      '_yt_player',
      'kZ',
      'p6X',
      'run',
    ]);
    const { call } = await connect(ws);
    expect(await call('wc_outline', { module: 'player.js' })).toContain(
      'function p6X(url)',
    );
    expect(await call('wc_goto', { symbol: 'p6X' })).toContain('player.js:6');
    expect(await call('wc_refs', { symbol: 'p6X' })).toContain('player.js:10');
  });

  test('trace crosses a return and reports fetch on its seed line', async () => {
    const { call } = await connect(wrappedWorkspace());
    const flow = await call('wc_trace', {
      value: '/api/',
      direction: 'forward',
      depth: 6,
    });
    expect(flow).toContain('player.js:4  return');
    expect(flow).toContain('player.js:10  call');
    expect(flow).toContain('fetch at player.js:7');
    const sink = await call('wc_trace', {
      value: 'player.js:7',
      direction: 'backward',
    });
    expect(sink).toContain('fetch at player.js:7');
  });

  test('.call(this) wrappers and UMD factories are indexed too', () => {
    const called = wrappedWorkspace(
      [
        '(function (g) {',
        '  var p6X = function (a) {};',
        '}).call(this, _yt);',
      ].join('\n'),
    );
    expect(symbolsAt(called)).toEqual(['function p6X@2']);
    const umd = wrappedWorkspace(
      [
        '!function (e, t) {',
        '  var wrap = 1;',
        '}(this, function (ie, e) {',
        '  function jq(sel) {}',
        '});',
      ].join('\n'),
    );
    expect(symbolsAt(umd)).toEqual(['variable wrap@2', 'function jq@4']);
  });

  test('Closure style `var x;` then `x = function` defines x at the assignment', async () => {
    const ws = wrappedWorkspace(
      [
        '(function (g) {',
        '  var p6X, other;',
        '  var keep;',
        '  p6X = function (f) {',
        '    return fetch(f);',
        '  };',
        '  keep = 5;',
        '  g.run = function () {',
        '    p6X("/x");',
        '  };',
        '})(_yt);',
      ].join('\n'),
    );
    expect(symbolsAt(ws)).toEqual([
      'function p6X@4',
      'variable other@2',
      'variable keep@3',
      'function g.run@8',
    ]);
    const { call } = await connect(ws);
    expect(await call('wc_goto', { symbol: 'p6X' })).toContain('player.js:4');
    expect(await call('wc_refs', { symbol: 'p6X' })).toContain('player.js:9');
  });

  test('the same name in two scopes is resolved by `from`, or qualified by @line', async () => {
    const ws = wrappedWorkspace(
      [
        'function f() { return 1; }',
        '(function () {',
        '  function f() { return 2; }',
        '  f();',
        '})();',
        'f();',
      ].join('\n'),
    );
    const { call } = await connect(ws);
    expect(
      await call('wc_goto', { symbol: 'f', from: 'player.js:4' }),
    ).toContain('player.js:3');
    expect(
      await call('wc_goto', { symbol: 'f', from: 'player.js:6' }),
    ).toContain('player.js:1');
    await expect(call('wc_refs', { symbol: 'f' })).rejects.toThrow(
      /`player\.js:f@1`, `player\.js:f@3`/,
    );
    expect(await call('wc_goto', { symbol: 'player.js:f@3' })).toContain(
      'player.js:3',
    );
    const refs = await call('wc_refs', { symbol: 'player.js:f@3' });
    expect(refs).toContain('player.js:4');
    expect(refs).not.toContain('player.js:6');
  });

  test('from selects the closest preceding assignment in one scope', async () => {
    const ws = wrappedWorkspace(
      [
        'function outer() {',
        '  let readAsync;',
        '  readAsync = () => 1;',
        '  readAsync = () => fetch("/data");',
        '  return readAsync();',
        '}',
      ].join('\n'),
    );
    const { call } = await connect(ws);
    expect(
      await call('wc_goto', { symbol: 'readAsync', from: 'player.js:5' }),
    ).toContain('player.js:4');
  });

  test('sendBeacon is a sink', async () => {
    const ws = wrappedWorkspace(
      ['(function () {', '  navigator.sendBeacon("/log", data);', '})();'].join(
        '\n',
      ),
    );
    const { call } = await connect(ws);
    expect(
      await call('wc_trace', { value: 'player.js:2', direction: 'backward' }),
    ).toContain('sendBeacon at player.js:2');
  });

  test('namespace functions resolve through goto, refs and trace parameters', async () => {
    const ws = wrappedWorkspace(
      [
        'var player = {};',
        '(function (g) {',
        '  g.TYQ = async function (url) {',
        '    return fetch(url);',
        '  };',
        '  function run() {',
        '    return g.TYQ("/api/log");',
        '  }',
        '  run();',
        '})(player);',
      ].join('\n'),
    );
    const { call } = await connect(ws);
    expect(await call('wc_goto', { symbol: 'g.TYQ' })).toContain('player.js:3');
    expect(await call('wc_goto', { symbol: 'TYQ' })).toContain('player.js:3');
    const refs = await call('wc_refs', { symbol: 'g.TYQ' });
    expect(refs).toContain('player.js:7');
    expect(refs).not.toContain('player.js:3  write');
    const trace = await call('wc_trace', {
      value: 'player.js:4',
      direction: 'backward',
    });
    expect(trace).toContain('player.js:7  arg');
    expect(trace).toContain('"/api/log"');
  });

  test('goto follows an alias assigned to a namespace member', async () => {
    const ws = wrappedWorkspace(
      [
        '(function (g) {',
        '  function real(url) { return fetch(url); }',
        '  g.send = real;',
        '  g.send("/x");',
        '})(player);',
      ].join('\n'),
    );
    const { call } = await connect(ws);
    expect(await call('wc_goto', { symbol: 'g.send' })).toContain(
      'player.js:2',
    );
    expect(await call('wc_refs', { symbol: 'g.send' })).toContain(
      'player.js:4',
    );
  });

  test('backward trace shows bounded, approximate property writes', async () => {
    const ws = wrappedWorkspace(
      [
        'function send(x) { return fetch(x); }',
        'function load(input) {',
        '  this.videoData = input;',
        '  this.videoData = "/api/log";',
        '  return send(this.videoData);',
        '}',
      ].join('\n'),
    );
    const { call } = await connect(ws);
    const result = await call('wc_trace', {
      value: 'player.js:1',
      direction: 'backward',
      maxSteps: 20,
    });
    expect(result).toContain('player.js:4  assign');
    expect(result).toContain('player.js:3  assign');
    expect(result).toContain('Property .videoData: 2 nearby writes shown');
    expect(result).toContain('Matches are approximate');
  });
});
