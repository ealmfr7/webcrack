import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  applyLLMRename,
  commandSuggestNames,
  runMultiInput,
  validateLLMFlags,
} from '../src/cli-lib';
import { renameWithLLM, webcrack } from '../src/index.js';

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

describe('validateLLMFlags', () => {
  test('rejects --source-map combined with --llm-rename-command', () => {
    expect(
      validateLLMFlags({
        sourceMap: true,
        llmRenameCommand: 'llm-rename',
        llmTimeout: 30000,
      }),
    ).toMatch(/--source-map.*--llm-rename-command/);
  });

  test.each(['abc', Number.NaN, 0, -5])(
    'rejects --llm-timeout %p',
    (llmTimeout) => {
      expect(
        validateLLMFlags({ llmRenameCommand: 'llm-rename', llmTimeout }),
      ).toBe('--llm-timeout must be a positive integer');
    },
  );

  test('accepts valid flag combinations', () => {
    expect(validateLLMFlags({})).toBeUndefined();
    expect(validateLLMFlags({ sourceMap: true })).toBeUndefined();
    expect(
      validateLLMFlags({ llmRenameCommand: 'llm-rename', llmTimeout: 30000 }),
    ).toBeUndefined();
  });
});

describe('applyLLMRename with bundle', () => {
  const WEBPACK_SAMPLE = join(
    __dirname,
    '..',
    'src',
    'unpack',
    'test',
    'samples',
    'webpack-4.js',
  );

  test('offers each module binding to suggestNames exactly once', async () => {
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');
    const options = { deobfuscate: false, unminify: false, jsx: false };
    const result = await webcrack(code, options);
    expect(result.bundle).toBeDefined();

    // Independent oracle: the bindings offered by a single rename pass
    // over each module of a fresh result for the same input.
    const fresh = await webcrack(code, options);
    const expected: string[] = [];
    for (const module of fresh.bundle!.modules.values()) {
      await renameWithLLM(module.ast, {
        suggestNames: (batch) => {
          expected.push(...batch.map((binding) => binding.name));
          return Promise.resolve({});
        },
      });
    }
    expect(expected.length).toBeGreaterThan(0);

    const actual: string[] = [];
    const logEntries = await applyLLMRename(result, (batch) => {
      actual.push(...batch.map((binding) => binding.name));
      return Promise.resolve({});
    });
    expect(actual.sort()).toEqual(expected.sort());
    expect(logEntries).toEqual([]);
  });

  test('renames module code without touching the top-level code', async () => {
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');
    const result = await webcrack(code, {
      deobfuscate: false,
      unminify: false,
      jsx: false,
    });
    expect(result.bundle).toBeDefined();
    const topLevelBefore = result.code;
    const logEntries = await applyLLMRename(result, (batch) => {
      const mapping: Record<string, string> = {};
      for (const binding of batch) {
        mapping[binding.name] = `renamed_${binding.name}`;
      }
      return Promise.resolve(mapping);
    });
    expect(logEntries.length).toBeGreaterThan(0);
    expect(result.code).toBe(topLevelBefore);
    let renamedModules = 0;
    for (const module of result.bundle!.modules.values()) {
      if (/renamed_/.test(module.code)) renamedModules++;
    }
    expect(renamedModules).toBeGreaterThan(0);
  });
});

describe('commandSuggestNames early exit', () => {
  test('reports the exit code when the command exits without reading stdin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const suggest = commandSuggestNames(
        `node -e "process.stdin.destroy();process.exit(3)"`,
        10000,
      );
      await expect(
        suggest([
          { name: 'a', kind: 'param', context: 'a', scopeType: 'Function' },
        ]),
      ).rejects.toThrow(/exited with code 3/);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
