import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import { WcError } from '../src/format/errors';
import type { ToolContext } from '../src/tools/define';
import { trace } from '../src/tools/trace';
import { WorkspaceStore } from '../src/workspace/store';
import { buildIndex } from '../src/workspace/indexer';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

/** Call `trace.handler` directly with a store holding the workspace. */
async function runTrace(
  ws: Workspace,
  args: {
    value: string;
    direction?: 'backward' | 'forward' | 'both';
    depth?: number;
    maxSteps?: number;
  },
): Promise<string> {
  const config = loadConfig({ WEBCRACK_MCP_ROOTS: process.cwd() });
  const store = new WorkspaceStore(config);
  store.add(ws);
  const ctx: ToolContext = {
    store,
    config,
    progress: () => Promise.resolve(),
  };
  const result = await trace.handler(
    {
      workspace: undefined,
      value: args.value,
      direction: args.direction ?? 'both',
      depth: args.depth ?? 4,
      maxSteps: args.maxSteps ?? 40,
    },
    ctx,
  );
  return result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

/** Numbered `N. module:line  role` step headers in the output. */
function stepHeaders(text: string): string[] {
  return text.split('\n').filter((line) => /^\d+\. \S+:\d+ {2}\S+$/.test(line));
}

const URLS = `const API_BASE = "https://api.example.com";
export function buildUrl(path, token) {
  return API_BASE + "/v1/" + path + "?token=" + token;
}
export function load(token) {
  return send(buildUrl("/data", token));
}
export function send(url) {
  return fetch(url);
}`;

/** Fixture plus a module where a URL is concatenated in one function and sent by another. */
function withConcat(): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.set('src/urls.js', {
    path: 'src/urls.js',
    bundleId: '2',
    isEntry: false,
    code: URLS,
    tags: ['network'],
  });
  ws.index.symbols.push(
    {
      module: 'src/urls.js',
      name: 'buildUrl',
      kind: 'function',
      line: 2,
      endLine: 4,
      params: ['path', 'token'],
      exported: true,
      refCount: 1,
    },
    {
      module: 'src/urls.js',
      name: 'load',
      kind: 'function',
      line: 5,
      endLine: 7,
      params: ['token'],
      exported: true,
      refCount: 0,
    },
    {
      module: 'src/urls.js',
      name: 'send',
      kind: 'function',
      line: 8,
      endLine: 10,
      params: ['url'],
      exported: true,
      refCount: 1,
    },
  );
  ws.index.calls.push(
    { module: 'src/urls.js', line: 6, callee: 'buildUrl', caller: 'load' },
    { module: 'src/urls.js', line: 6, callee: 'send', caller: 'load' },
    { module: 'src/urls.js', line: 9, callee: 'fetch', caller: 'send' },
  );
  ws.index.strings.push(
    { module: 'src/urls.js', line: 1, value: 'https://api.example.com' },
    { module: 'src/urls.js', line: 3, value: '/v1/' },
    { module: 'src/urls.js', line: 3, value: '?token=' },
    { module: 'src/urls.js', line: 6, value: '/data' },
  );
  ws.index.refs.push(
    {
      module: 'src/urls.js',
      line: 6,
      name: 'buildUrl',
      defModule: 'src/urls.js',
      defLine: 2,
      kind: 'call',
    },
    {
      module: 'src/urls.js',
      line: 6,
      name: 'send',
      defModule: 'src/urls.js',
      defLine: 8,
      kind: 'call',
    },
  );
  ws.index.imports['src/urls.js'] = [];
  return ws;
}

describe('wc_trace forward from a string literal', () => {
  test('fixture login URL flows into fetch', async () => {
    const text = await runTrace(fixtureWorkspace(), {
      value: 'https://api.example.com/v1/login',
      direction: 'forward',
    });
    expect(text).toContain('src/api.js:3  seed');
    expect(text).toContain('src/api.js:3  call');
    expect(text).toContain('src/api.js:3  sink');
    expect(text).toContain('fetch at src/api.js:3');
    expect(text).toMatch(/Next: wc_read src\/api\.js:3$/);
  });

  test('snippets are fenced', async () => {
    const text = await runTrace(fixtureWorkspace(), {
      value: 'https://api.example.com/v1/login',
      direction: 'forward',
    });
    expect(text).toContain('```js');
    expect(text).toContain('fetch("https://api.example.com/v1/login"');
  });
});

describe('wc_trace backward', () => {
  test('token value traces back through setItem to res.json()', async () => {
    const text = await runTrace(fixtureWorkspace(), {
      value: 'token',
      direction: 'backward',
    });
    expect(text).toContain('localStorage.setItem');
    expect(text).toContain('res.json');
    expect(text).toContain('src/api.js:3  init');
    expect(text).toContain('localStorage.setItem at src/api.js:8');
  });

  test('module:line seeds the identifiers on that line', async () => {
    const text = await runTrace(fixtureWorkspace(), {
      value: 'src/api.js:8',
      direction: 'backward',
    });
    expect(text).toContain('res.json');
    expect(text).toContain('src/api.js:3  init');
  });

  test('identifier resolves through resolveSymbol', async () => {
    const text = await runTrace(fixtureWorkspace(), {
      value: 'src/sign.js:sign',
      direction: 'backward',
    });
    expect(text).toContain('src/sign.js:1  seed');
  });
});

describe('wc_trace across functions', () => {
  test('concatenated URL flows through buildUrl into fetch', async () => {
    const text = await runTrace(withConcat(), {
      value: 'https://api.example.com',
      direction: 'forward',
    });
    expect(text).toContain('src/urls.js:3  return');
    expect(text).toContain('src/urls.js:6  call');
    expect(text).toContain('src/urls.js:8  param');
    expect(text).toContain('fetch at src/urls.js:9');
  });

  test('backward from the fetch line rebuilds the concatenation', async () => {
    const text = await runTrace(withConcat(), {
      value: 'src/urls.js:9',
      direction: 'backward',
    });
    expect(text).toContain('src/urls.js:6  call');
    expect(text).toContain('buildUrl');
    expect(text).toContain('API_BASE');
  });
});

describe('wc_trace caps', () => {
  test('maxSteps truncates with a note', async () => {
    const text = await runTrace(withConcat(), {
      value: 'https://api.example.com',
      direction: 'forward',
      maxSteps: 2,
    });
    expect(stepHeaders(text).length).toBeLessThanOrEqual(2);
    expect(text).toContain('stopped early');
  });

  test('depth 1 stops before crossing into the sender', async () => {
    const shallow = await runTrace(withConcat(), {
      value: 'https://api.example.com',
      direction: 'forward',
      depth: 1,
    });
    expect(shallow).toContain('stopped early');
    expect(shallow).not.toContain('fetch at src/urls.js:9');
    const deep = await runTrace(withConcat(), {
      value: 'https://api.example.com',
      direction: 'forward',
      depth: 4,
    });
    expect(deep).toContain('fetch at src/urls.js:9');
  });
});

describe('wc_trace errors', () => {
  test('unknown value suggests similar names', async () => {
    await expect(
      runTrace(fixtureWorkspace(), { value: 'logni' }),
    ).rejects.toThrow(/login/);
  });

  test('a JSON-quoted value with escaped quotes resolves to the literal', async () => {
    const ws = fixtureWorkspace();
    ws.modules.set('quoted.js', {
      path: 'quoted.js',
      bundleId: '9',
      isEntry: false,
      code: 'fetch("say \\"hi\\"");',
      tags: [],
    });
    ws.index = buildIndex(ws.modules);
    const output = await runTrace(ws, {
      value: JSON.stringify('say "hi"'),
      direction: 'forward',
    });
    expect(output).toContain('fetch at quoted.js:1');
  });
});

test('a sink line starts from its arguments rather than a helper callee', async () => {
  const ws = fixtureWorkspace();
  ws.modules.set('beacon.js', {
    path: 'beacon.js',
    bundleId: '9',
    isEntry: false,
    code: [
      'function td() { return navigator; }',
      'function send(k, G) {',
      '  return td().sendBeacon(k.toString(), G.Bk());',
      '}',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  const result = await runTrace(ws, {
    value: 'beacon.js:3',
    direction: 'backward',
  });
  expect(result).toContain('2 seeds.');
  expect(result).toContain('sendBeacon at beacon.js:3');
  expect(result).toContain('beacon.js:2  param');
  expect(result).not.toContain('beacon.js:1  init');
});

test('backward trace crosses a direct callback through its invoker', async () => {
  const ws = fixtureWorkspace();
  ws.modules.set('callback.js', {
    path: 'callback.js',
    bundleId: '10',
    isEntry: false,
    code: [
      'function each(callback) {',
      '  const payload = "message";',
      '  callback("/log", payload);',
      '}',
      'function report() {',
      '  each((url, body) => {',
      '    fetch(url.toString(), body.Bk());',
      '  });',
      '}',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  const result = await runTrace(ws, {
    value: 'callback.js:7',
    direction: 'backward',
  });
  expect(result).toContain('callback.js:3  arg');
  expect(result).toContain('callback.js:2  init');
  expect(result).toContain('"message"');
});

test('backward trace finds block-scoped values passed to a callback sink', async () => {
  const ws = fixtureWorkspace();
  ws.modules.set('blocks.js', {
    path: 'blocks.js',
    bundleId: '11',
    isEntry: false,
    code: [
      'function invoke(callback) {',
      '  for (let i = 0; i < 1; i++) {',
      '    let body = "payload";',
      '    callback("/log", body);',
      '  }',
      '}',
      'invoke((url, data) => navigator.sendBeacon(url, data));',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  const result = await runTrace(ws, {
    value: 'blocks.js:7',
    direction: 'backward',
    maxSteps: 30,
  });
  expect(result).toContain('blocks.js:3  init');
  expect(result).toContain('"payload"');
});

/** Module building an `Authorization` header from `"Bearer " + token`. */
const BEARER = `export function callApi(token) {
  const fallback = "Bearer ";
  return fetch("https://api.example.com/v1/data", {
    headers: { Authorization: "Bearer " + token },
  });
}`;

/** Fixture plus the bearer module (`"Bearer "` indexed twice, as in a real bundle). */
function withBearer(): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.set('src/auth.js', {
    path: 'src/auth.js',
    bundleId: '2',
    isEntry: false,
    code: BEARER,
    tags: ['network', 'auth'],
  });
  ws.index.symbols.push({
    module: 'src/auth.js',
    name: 'callApi',
    kind: 'function',
    line: 1,
    endLine: 6,
    params: ['token'],
    exported: true,
    refCount: 0,
  });
  ws.index.calls.push({
    module: 'src/auth.js',
    line: 3,
    callee: 'fetch',
    caller: 'callApi',
  });
  ws.index.strings.push(
    { module: 'src/auth.js', line: 2, value: 'Bearer ' },
    {
      module: 'src/auth.js',
      line: 3,
      value: 'https://api.example.com/v1/data',
    },
    { module: 'src/auth.js', line: 4, value: 'Bearer ' },
  );
  ws.index.imports['src/auth.js'] = [];
  return ws;
}

describe('wc_trace values with surrounding whitespace', () => {
  test('trailing-space value matches the exact literal and traces forward', async () => {
    const text = await runTrace(withBearer(), {
      value: 'Bearer ',
      direction: 'forward',
    });
    expect(text).toContain('2 seeds.');
    expect(text).toContain('src/auth.js:2  seed');
    expect(text).toContain('src/auth.js:4  seed');
    expect(text).toContain('Bearer');
  });

  test('suggestions are unique and show whitespace visibly', async () => {
    const err: unknown = await runTrace(withBearer(), {
      value: 'Bearar',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WcError);
    const suggestions = (err as WcError).suggestions;
    expect(suggestions).toContain('Bearer ');
    expect(new Set(suggestions).size).toBe(suggestions.length);
    expect((err as WcError).message).toContain(JSON.stringify('Bearer '));
  });
});

test('approximate property writes are labelled assign~ and capped at three', async () => {
  const ws = fixtureWorkspace();
  ws.modules.clear();
  ws.modules.set('p.js', {
    path: 'p.js',
    bundleId: '0',
    isEntry: true,
    code: [
      'a.url = "/1";',
      'b.url = "/2";',
      'c.url = "/3";',
      'd.url = "/4";',
      'e.url = "/5";',
      'function send(o) {',
      '  fetch(o.url);',
      '}',
    ].join('\n'),
    tags: [],
  });
  ws.index = buildIndex(ws.modules);
  const { call } = await connect(ws);
  const out = await call('wc_trace', {
    value: 'p.js:7',
    direction: 'backward',
  });
  const approx = out.split('\n').filter((line) => line.endsWith('  assign~'));
  expect(approx).toHaveLength(3);
  expect(out).not.toMatch(/p\.js:\d+ {2}assign$/m);
  expect(out).toContain('shown as `assign~`');
});
