import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Report } from 'webcrack/analysis';
import { loadConfig } from '../src/config';
import { createServer } from '../src/server';
import { WorkspaceStore } from '../src/workspace/store';
import type { Workspace } from '../src/workspace/types';

/**
 * Connect a client to a fresh server. Pass workspaces to preload them, so a
 * tool can be developed and tested without wc_open / the indexer.
 */
export async function connect(...workspaces: Workspace[]) {
  const config = loadConfig({ WEBCRACK_MCP_ROOTS: process.cwd() });
  const store = new WorkspaceStore(config);
  for (const workspace of workspaces) store.add(workspace);

  const server = createServer(config, store);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    store,
    /** Call a tool and return its text; throws if it returned an error. */
    call: async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<string> => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      const text = result.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      if (result.isError) throw new Error(text);
      return text;
    },
  };
}

const API = `import { sign } from "./sign.js";
export async function login(user, pass) {
  const res = await fetch("https://api.example.com/v1/login", {
    method: "POST",
    headers: { "x-sign": sign(user) },
    body: JSON.stringify({ user, pass }),
  });
  localStorage.setItem("token", (await res.json()).token);
}`;

const SIGN = `export function sign(value) {
  return btoa(value + "s3cr3t");
}`;

// `extractReport()` run on each module's clean code above (real output,
// captured 2026-09-24 via a throwaway vitest file inside packages/webcrack
// parsing each const with @babel/parser and calling extractReport).
const API_REPORT: Report = {
  urls: [
    {
      value: 'https://api.example.com/v1/login',
      line: 3,
      column: 26,
    },
  ],
  endpoints: [
    {
      method: 'POST',
      url: 'https://api.example.com/v1/login',
      line: 3,
      column: 20,
    },
  ],
  secrets: [
    {
      value: 'https://api.example.com/v1/login',
      rule: 'generic-high-entropy',
      line: 3,
      column: 26,
    },
  ],
  regexes: [],
  interesting: [],
};

const SIGN_REPORT: Report = {
  urls: [],
  endpoints: [],
  secrets: [],
  regexes: [],
  interesting: [],
};

/**
 * A small hand-built workspace (two modules) matching the Workspace contract.
 * The indexer (M1.2) must produce equivalent data for the same code.
 *
 * Indexing rules (see also the JSDoc on `workspace/types.ts`):
 * - strings: every string literal, INCLUDING the import source
 *   (`'./sign.js'`), but EXCLUDING object property keys (`"x-sign"`,
 *   `"method"`, `"headers"`, `"body"` contribute nothing).
 * - symbols: top-level bindings only (the `sign` import, `login`, and
 *   `sign.js:sign`); no locals (`res`), no params (`user`, `pass`, `value`).
 * - refs: uses of module-level bindings (defined or imported), resolved
 *   post-link. Declaration sites and the import-specifier line are NOT refs;
 *   uses of globals (`fetch`, `btoa`) and locals are not recorded either
 *   (call sites cover them). The single ref is the `sign(user)` call on
 *   `api.js:5`, linked through the import to `sign.js:1` — hence
 *   `sign.js:sign` has `refCount` 1 while the `api.js` import binding
 *   itself has `refCount` 0 (nothing points at the import line anymore).
 * - calls: `caller` is the nearest enclosing NAMED function. Callee roots
 *   that are globals or import bindings give the dotted name (`fetch`,
 *   `sign`, `JSON.stringify`, `localStorage.setItem`, `btoa`); a root that
 *   is a local binding gives `*.<prop>` (`(await res.json())` → `*.json`).
 */
export function fixtureWorkspace(): Workspace {
  return {
    id: 'fixture1',
    source: {
      kind: 'code',
      label: '<fixture>',
      bytes: API.length + SIGN.length,
    },
    original: `${API}\n${SIGN}`,
    bundle: { type: 'esbuild', entryId: 'src/api.js' },
    modules: new Map([
      [
        'src/api.js',
        {
          path: 'src/api.js',
          bundleId: '0',
          isEntry: true,
          code: API,
          tags: ['network', 'auth', 'storage'],
        },
      ],
      [
        'src/sign.js',
        {
          path: 'src/sign.js',
          bundleId: '1',
          isEntry: false,
          code: SIGN,
          tags: ['crypto'],
        },
      ],
    ]),
    index: {
      symbols: [
        {
          module: 'src/api.js',
          name: 'sign',
          kind: 'import',
          line: 1,
          endLine: 1,
          exported: false,
          refCount: 0,
        },
        {
          module: 'src/api.js',
          name: 'login',
          kind: 'function',
          line: 2,
          endLine: 9,
          params: ['user', 'pass'],
          exported: true,
          refCount: 0,
        },
        {
          module: 'src/sign.js',
          name: 'sign',
          kind: 'function',
          line: 1,
          endLine: 3,
          params: ['value'],
          exported: true,
          refCount: 1,
        },
      ],
      calls: [
        { module: 'src/api.js', line: 3, callee: 'fetch', caller: 'login' },
        { module: 'src/api.js', line: 5, callee: 'sign', caller: 'login' },
        {
          module: 'src/api.js',
          line: 6,
          callee: 'JSON.stringify',
          caller: 'login',
        },
        {
          module: 'src/api.js',
          line: 8,
          callee: 'localStorage.setItem',
          caller: 'login',
        },
        { module: 'src/api.js', line: 8, callee: '*.json', caller: 'login' },
        { module: 'src/sign.js', line: 2, callee: 'btoa', caller: 'sign' },
      ],
      strings: [
        { module: 'src/api.js', line: 1, value: './sign.js' },
        {
          module: 'src/api.js',
          line: 3,
          value: 'https://api.example.com/v1/login',
        },
        { module: 'src/api.js', line: 4, value: 'POST' },
        { module: 'src/api.js', line: 8, value: 'token' },
        { module: 'src/sign.js', line: 2, value: 's3cr3t' },
      ],
      refs: [
        {
          module: 'src/api.js',
          line: 5,
          name: 'sign',
          defModule: 'src/sign.js',
          defLine: 1,
          kind: 'call',
        },
      ],
      imports: { 'src/api.js': ['src/sign.js'], 'src/sign.js': [] },
    },
    report: {
      'src/api.js': API_REPORT,
      'src/sign.js': SIGN_REPORT,
    },
    interpreters: [],
    annotations: [],
    stats: { openMs: 0, techniques: [] },
  };
}
