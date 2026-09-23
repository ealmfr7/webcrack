import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { webcrack } from '../src';

const webpackSrc = await readFile(
  join(__dirname, '../src/unpack/test/samples/webpack-4.js'),
  'utf8',
);

describe('report and graph options', () => {
  test('off by default', async () => {
    const result = await webcrack('console.log("hi");');
    expect(result.report).toBeUndefined();
    expect(result.moduleGraph).toBeUndefined();
    expect(result.callGraph).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-'));
    await result.save(dir);
    expect(await readdir(dir)).toEqual(['deobfuscated.js']);
  });

  test('report entries carry original line numbers', async () => {
    const code = '\n\nfetch("https://example.com/api");\n';
    const result = await webcrack(code, {
      report: true,
      deobfuscate: false,
      unminify: false,
      jsx: false,
      unpack: false,
    });
    expect(result.report).toBeDefined();
    expect(result.report!.urls).toEqual([
      { value: 'https://example.com/api', line: 3, column: 6 },
    ]);
    expect(result.report!.endpoints).toEqual([
      { method: 'GET', url: 'https://example.com/api', line: 3, column: 0 },
    ]);
    const allEntries = [
      ...result.report!.urls,
      ...result.report!.endpoints,
      ...result.report!.secrets,
      ...result.report!.regexes,
      ...result.report!.interesting,
    ];
    expect(allEntries.length).toBeGreaterThan(0);
    for (const entry of allEntries) {
      expect(entry.line).toBeGreaterThan(0);
    }
  });

  test('graphs present when enabled', async () => {
    const result = await webcrack(webpackSrc, { graph: true });
    expect(result.moduleGraph).toBeDefined();
    expect(result.moduleGraph!.nodes.length).toBeGreaterThan(0);
    expect(result.callGraph).toBeDefined();
  });

  test('module graph absent without a bundle', async () => {
    const result = await webcrack('function a() {}\na();', {
      graph: true,
      unpack: false,
    });
    expect(result.bundle).toBeUndefined();
    expect(result.moduleGraph).toBeUndefined();
    expect(result.callGraph).toBeDefined();
    expect(result.callGraph!.nodes.some((node) => node.id === 'a')).toBe(true);
  });

  test('save writes report and graph files', async () => {
    const result = await webcrack(webpackSrc, {
      report: true,
      graph: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-'));
    await result.save(dir);
    const files = await readdir(dir);
    for (const name of [
      'deobfuscated.js',
      'bundle.json',
      'report.json',
      'graph.modules.json',
      'graph.modules.dot',
      'graph.calls.json',
      'graph.calls.dot',
    ]) {
      expect(files).toContain(name);
    }
    expect(
      JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')),
    ).toEqual(result.report);
    expect(
      JSON.parse(await readFile(join(dir, 'graph.modules.json'), 'utf8')),
    ).toEqual({
      nodes: result.moduleGraph!.nodes,
      edges: result.moduleGraph!.edges,
    });
    for (const name of ['graph.modules.dot', 'graph.calls.dot']) {
      const dot = await readFile(join(dir, name), 'utf8');
      expect(dot.startsWith('digraph ')).toBe(true);
    }
  });

  test('save without a bundle omits module graph files', async () => {
    const result = await webcrack('console.log("hi");', {
      report: true,
      graph: true,
      unpack: false,
    });
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-'));
    await result.save(dir);
    expect((await readdir(dir)).sort()).toEqual([
      'deobfuscated.js',
      'graph.calls.dot',
      'graph.calls.json',
      'report.json',
    ]);
  });
});
