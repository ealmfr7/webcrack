import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import { WcError } from '../src/format/errors';
import type { ToolContext } from '../src/tools/define';
import { trace } from '../src/tools/trace';
import { WorkspaceStore } from '../src/workspace/store';
import type { Workspace } from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

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
    expect(text).toContain('Sinks: none found.');
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
