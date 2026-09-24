import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config';
import { createServer } from '../src/server';
import { WorkspaceStore } from '../src/workspace/store';
import type { Workspace } from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

const tempDirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wc-export-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Like `connect()` in helpers.ts, but rooted at a temp dir. */
async function connectAt(root: string, ...workspaces: Workspace[]) {
  const config = loadConfig({ WEBCRACK_MCP_ROOTS: root });
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

function annotatedWorkspace(): Workspace {
  const ws = fixtureWorkspace();
  ws.annotations = [
    { symbol: 'src/api.js:login', rename: 'doLogin', note: 'entry point' },
    { symbol: 'src/sign.js:sign', note: 'hashing helper' },
  ];
  return ws;
}

describe('wc_export', () => {
  test('every include writes the expected contents', async () => {
    const root = await makeTemp();
    const ws = annotatedWorkspace();
    const { call } = await connectAt(root, ws);
    const out = join(root, 'out');

    const text = await call('wc_export', {
      workspace: 'fixture1',
      dir: out,
      include: ['code', 'report', 'notes', 'graph'],
    });

    for (const rel of [
      'modules/src/api.js',
      'modules/src/sign.js',
      'report.json',
      'notes.md',
      'modules.dot',
    ]) {
      expect(text).toContain(rel);
    }

    expect(await readFile(join(out, 'modules', 'src', 'api.js'), 'utf8')).toBe(
      ws.modules.get('src/api.js')?.code,
    );
    expect(await readFile(join(out, 'modules', 'src', 'sign.js'), 'utf8')).toBe(
      ws.modules.get('src/sign.js')?.code,
    );

    const report = JSON.parse(
      await readFile(join(out, 'report.json'), 'utf8'),
    ) as {
      report: unknown;
      interpreters: unknown;
      bundle: unknown;
      source: { label: string };
    };
    expect(report.report).toEqual(ws.report);
    expect(report.interpreters).toEqual(ws.interpreters);
    expect(report.bundle).toEqual({ type: 'esbuild', entryId: '0' });
    expect(report.source.label).toBe('<fixture>');

    const notes = await readFile(join(out, 'notes.md'), 'utf8');
    expect(notes).toContain('# Notes');
    expect(notes).toContain('## src/api.js');
    expect(notes).toContain('- login → doLogin: entry point');
    expect(notes).toContain('## src/sign.js');
    expect(notes).toContain('- sign: hashing helper');

    const dot = await readFile(join(out, 'modules.dot'), 'utf8');
    expect(dot).toContain('digraph "modules from src/api.js" {');
    expect(dot).toContain('"src/api.js" -> "src/sign.js";');
  });

  test('a double rename exports under the original name', async () => {
    const root = await makeTemp();
    const ws = fixtureWorkspace();
    ws.modules.set('3.js', {
      path: '3.js',
      bundleId: '3',
      isEntry: false,
      code: 'export function deriveKey2() {}\n',
      tags: [],
    });
    ws.index.symbols.push({
      module: '3.js',
      name: 'deriveKey2',
      kind: 'function',
      line: 1,
      endLine: 1,
      params: [],
      exported: true,
      refCount: 0,
    });
    ws.index.imports['3.js'] = [];
    ws.annotations = [
      {
        symbol: '3.js:deriveKey2',
        rename: 'deriveKey2',
        originalName: 'computeKey',
        note: 'key derivation',
      },
      { symbol: 'src/sign.js:sign', note: 'hashing helper' },
    ];
    const { call } = await connectAt(root, ws);
    const out = join(root, 'out');

    await call('wc_export', {
      workspace: 'fixture1',
      dir: out,
      include: ['notes'],
    });
    const notes = await readFile(join(out, 'notes.md'), 'utf8');
    expect(notes).toContain('- computeKey → deriveKey2: key derivation');
    expect(notes).not.toContain('deriveKey2 → deriveKey2');
    expect(notes).toContain('- sign: hashing helper');
  });

  test('default include writes code, report, notes and graph', async () => {
    const root = await makeTemp();
    const { call } = await connectAt(root, fixtureWorkspace());
    const out = join(root, 'out');

    const text = await call('wc_export', { workspace: 'fixture1', dir: out });

    expect(await readFile(join(out, 'modules', 'src', 'api.js'), 'utf8')).toBe(
      fixtureWorkspace().modules.get('src/api.js')?.code,
    );
    expect(
      JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as unknown,
    ).toMatchObject({ source: { label: '<fixture>' } });
    expect(await readFile(join(out, 'notes.md'), 'utf8')).toContain(
      'No annotations',
    );
    const dot = await readFile(join(out, 'modules.dot'), 'utf8');
    expect(dot).toContain('digraph "modules from src/api.js" {');
    expect(text).toContain('modules.dot');
  });

  test('a dir outside the roots is an error', async () => {
    const root = await makeTemp();
    const outside = await makeTemp();
    const { call } = await connectAt(root, fixtureWorkspace());

    await expect(
      call('wc_export', {
        workspace: 'fixture1',
        dir: join(outside, 'out'),
      }),
    ).rejects.toThrow('outside the allowed roots');
  });

  test('a symlink escape is an error', async () => {
    const root = await makeTemp();
    const outside = await makeTemp();
    const { call } = await connectAt(root, fixtureWorkspace());
    await symlink(outside, join(root, 'link'));

    await expect(
      call('wc_export', {
        workspace: 'fixture1',
        dir: join(root, 'link', 'sub'),
      }),
    ).rejects.toThrow('outside the allowed roots');
  });

  test('a non-empty dir needs overwrite', async () => {
    const root = await makeTemp();
    const { call } = await connectAt(root, fixtureWorkspace());
    const out = join(root, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'existing.txt'), 'keep\n', 'utf8');

    await expect(
      call('wc_export', { workspace: 'fixture1', dir: out }),
    ).rejects.toThrow('overwrite');

    const text = await call('wc_export', {
      workspace: 'fixture1',
      dir: out,
      overwrite: true,
    });
    expect(text).toContain('report.json');
    expect(await readFile(join(out, 'existing.txt'), 'utf8')).toBe('keep\n');
    expect(
      JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as unknown,
    ).toMatchObject({ source: { label: '<fixture>' } });
  });

  test(
    'a module cycle with include graph finishes quickly',
    { timeout: 15000 },
    async () => {
      const root = await makeTemp();
      const ws = fixtureWorkspace();
      ws.modules.set('src/c3.js', {
        path: 'src/c3.js',
        bundleId: 'c3',
        isEntry: false,
        code: '',
        tags: [],
      });
      ws.modules.set('src/c4.js', {
        path: 'src/c4.js',
        bundleId: 'c4',
        isEntry: false,
        code: '',
        tags: [],
      });
      ws.index.imports['src/c3.js'] = ['src/c4.js'];
      ws.index.imports['src/c4.js'] = ['src/c3.js'];
      const { call } = await connectAt(root, ws);
      const out = join(root, 'out');

      const text = await call('wc_export', {
        workspace: 'fixture1',
        dir: out,
        include: ['graph'],
      });
      expect(text).toContain('modules.dot');
      const dot = await readFile(join(out, 'modules.dot'), 'utf8');
      expect(dot).toContain('"src/c3.js" -> "src/c4.js";');
      expect(dot).toContain('"src/c4.js" -> "src/c3.js";');
    },
  );

  test('modules.dot holds every module and import edge, uncapped', async () => {
    const root = await makeTemp();
    const ws = fixtureWorkspace();
    // 250 fan-out modules plus one unreachable island: all must appear.
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
    ws.modules.set('src/island.js', {
      path: 'src/island.js',
      bundleId: 'island',
      isEntry: false,
      code: '',
      tags: [],
    });
    ws.index.imports['src/island.js'] = [];
    const { call } = await connectAt(root, ws);
    const out = join(root, 'out');

    await call('wc_export', {
      workspace: 'fixture1',
      dir: out,
      include: ['graph'],
    });
    const dot = await readFile(join(out, 'modules.dot'), 'utf8');
    expect(dot).not.toContain('capped');
    const nodes = new Set<string>();
    let edges = 0;
    const id = '((?:[^"\\\\]|\\\\.)*)';
    for (const line of dot.split('\n')) {
      const edge = new RegExp(`^  "${id}" -> "${id}";$`).exec(line);
      if (edge) {
        edges++;
        continue;
      }
      const node = new RegExp(`^  "${id}";$`).exec(line);
      if (node) nodes.add(node[1]);
    }
    // 2 fixture modules + 250 fan-out + 1 unreachable island.
    expect(nodes.size).toBe(253);
    expect(nodes.has('src/island.js')).toBe(true);
    expect(dot).toContain('"src/api.js" -> "src/sign.js";');
    // 1 fixture edge + 250 fan-out edges.
    expect(edges).toBe(251);
  });

  test('a module path traversal is sanitized', async () => {
    const root = await makeTemp();
    const ws = fixtureWorkspace();
    ws.id = 'evil';
    ws.modules.set('../evil.js', {
      path: '../evil.js',
      bundleId: '9',
      isEntry: false,
      code: 'evil();\n',
      tags: [],
    });
    const { call } = await connectAt(root, ws);

    await expect(
      call('wc_export', {
        workspace: 'evil',
        dir: join(root, 'out'),
        include: ['code'],
      }),
    ).rejects.toThrow(/\.\.|escapes|not allowed/);
    await expect(readFile(join(root, 'evil.js'), 'utf8')).rejects.toThrow();
  });
});
