import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  applyLLMRename,
  commandSuggestNames,
  runMultiInput,
} from '../src/cli-lib';
import { webcrack } from '../src/index.js';

const MULTI_CHUNK_DIR = join(
  __dirname,
  '..',
  'src',
  'unpack',
  'test',
  'multi-chunk',
);

async function fixture(name: string): Promise<string> {
  return readFile(join(MULTI_CHUNK_DIR, name), 'utf8');
}

describe('commandSuggestNames', () => {
  test('maps a batch through the external command', async () => {
    const suggest = commandSuggestNames(
      `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o={};for(const x of JSON.parse(d))o[x.name]='renamed_'+x.name;console.log(JSON.stringify(o))})"`,
      10000,
    );
    await expect(
      suggest([
        { name: 'a', kind: 'param', context: 'a', scopeType: 'Function' },
        { name: 'b', kind: 'let', context: 'b', scopeType: 'Block' },
      ]),
    ).resolves.toEqual({ a: 'renamed_a', b: 'renamed_b' });
  });

  async function rejectsWithWarning(
    command: string,
    timeoutMs: number,
    pattern: RegExp,
  ): Promise<void> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const suggest = commandSuggestNames(command, timeoutMs);
      await expect(
        suggest([
          { name: 'a', kind: 'param', context: 'a', scopeType: 'Function' },
        ]),
      ).rejects.toThrow(pattern);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }

  test('non-zero exit rejects with a warning', async () => {
    await rejectsWithWarning(
      `node -e "console.error('boom');process.exit(1)"`,
      10000,
      /exited with code 1/,
    );
  });

  test('invalid JSON rejects with a warning', async () => {
    await rejectsWithWarning(
      `node -e "console.log('not json')"`,
      10000,
      /JSON/,
    );
  });

  test('timeout rejects with a warning', async () => {
    await rejectsWithWarning(
      `node -e "setTimeout(()=>console.log('{}'),5000)"`,
      300,
      /timed out/,
    );
  }, 15000);
});

describe('applyLLMRename', () => {
  test('renames top-level code and patches save', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-cli-'));
    const result = await webcrack(
      'function f(){var a=1;var b=2;return a+b;}console.log(f());',
      { unpack: false, deobfuscate: false, unminify: false, jsx: false },
    );
    await applyLLMRename(result, () =>
      Promise.resolve({ a: 'first', b: 'second' }),
    );
    expect(result.code).toContain('first');
    expect(result.code).toContain('second');
    await result.save(outDir);
    const saved = await readFile(join(outDir, 'deobfuscated.js'), 'utf8');
    expect(saved).toBe(result.code);
  });
});

describe('runMultiInput', () => {
  test('merges two webpack chunks into one bundle', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-cli-'));
    const { bundle, results } = await runMultiInput(
      [
        {
          name: 'webpack-runtime.js',
          code: await fixture('webpack-runtime.js'),
        },
        {
          name: 'webpack-chunk-a.js',
          code: await fixture('webpack-chunk-a.js'),
        },
      ],
      outDir,
      {
        deobfuscate: false,
        unminify: false,
        jsx: false,
        report: true,
        graph: true,
      },
    );

    expect(results).toHaveLength(2);
    expect(bundle).toBeDefined();
    expect(bundle!.type).toBe('webpack');
    expect([...bundle!.modules.keys()].sort()).toEqual(['1', '10', '2']);

    const bundleJson = JSON.parse(
      await readFile(join(outDir, 'bundle.json'), 'utf8'),
    ) as { modules: unknown[] };
    expect(bundleJson.modules).toHaveLength(3);
  });

  test('writes per-input report and graph files', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-cli-'));
    await runMultiInput(
      [
        {
          name: 'webpack-runtime.js',
          code: await fixture('webpack-runtime.js'),
        },
        {
          name: 'webpack-chunk-a.js',
          code: await fixture('webpack-chunk-a.js'),
        },
      ],
      outDir,
      {
        deobfuscate: false,
        unminify: false,
        jsx: false,
        report: true,
        graph: true,
      },
    );

    for (const dir of ['webpack-runtime', 'webpack-chunk-a']) {
      const files = await readdir(join(outDir, dir));
      expect(files).toContain('deobfuscated.js');
      expect(files).toContain('report.json');
      expect(files).toContain('graph.calls.json');
      expect(files).toContain('graph.calls.dot');
    }
  });
});
