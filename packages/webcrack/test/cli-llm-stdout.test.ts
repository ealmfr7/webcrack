import { parse } from '@babel/parser';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { applyLLMRename } from '../src/cli-lib';
import { renameWithLLM, webcrack } from '../src/index.js';

const WEBPACK_SAMPLE = join(
  __dirname,
  '..',
  'src',
  'unpack',
  'test',
  'samples',
  'webpack-4.js',
);

const OPTIONS = { deobfuscate: false, unminify: false, jsx: false };

function prefixSuggest(prefix: string, seen: string[]) {
  return (batch: { name: string }[]) => {
    seen.push(...batch.map((binding) => binding.name));
    const mapping: Record<string, string> = {};
    for (const binding of batch) {
      mapping[binding.name] = `${prefix}${binding.name}`;
    }
    return Promise.resolve(mapping);
  };
}

describe('applyLLMRename with target code', () => {
  test('bundle input renames result.code, each binding offered once', async () => {
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');
    const result = await webcrack(code, OPTIONS);
    expect(result.bundle).toBeDefined();
    const topLevelBefore = result.code;

    // Independent oracle: the bindings offered by a single rename pass
    // over the top-level code of a fresh result for the same input.
    const fresh = await webcrack(code, OPTIONS);
    const expected: string[] = [];
    await renameWithLLM(
      parse(fresh.code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx'],
      }),
      {
        suggestNames: (batch) => {
          expected.push(...batch.map((binding) => binding.name));
          return Promise.resolve({});
        },
      },
    );
    expect(expected.length).toBeGreaterThan(0);

    const seen: string[] = [];
    const logEntries = await applyLLMRename(
      result,
      prefixSuggest('llm_', seen),
      { target: 'code' },
    );

    // Each binding offered to suggestNames exactly once (no
    // modules+code double pass).
    expect(seen.sort()).toEqual(expected.sort());
    expect(logEntries.length).toBeGreaterThan(0);
    expect(result.code).not.toBe(topLevelBefore);
    expect(result.code).toContain('llm_');
  });

  test('bundle input with target code patches save', async () => {
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');
    const result = await webcrack(code, OPTIONS);
    expect(result.bundle).toBeDefined();

    const seen: string[] = [];
    await applyLLMRename(result, prefixSuggest('llm_', seen), {
      target: 'code',
    });

    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-llm-stdout-'));
    await result.save(outDir);
    const saved = await readFile(join(outDir, 'deobfuscated.js'), 'utf8');
    expect(saved).toContain('llm_');
  });

  test('default call with bundle leaves result.code untouched', async () => {
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');
    const result = await webcrack(code, OPTIONS);
    expect(result.bundle).toBeDefined();
    const topLevelBefore = result.code;

    const seen: string[] = [];
    const logEntries = await applyLLMRename(
      result,
      prefixSuggest('renamed_', seen),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(logEntries.length).toBeGreaterThan(0);
    expect(result.code).toBe(topLevelBefore);
    let renamedModules = 0;
    for (const module of result.bundle!.modules.values()) {
      if (/renamed_/.test(module.code)) renamedModules++;
    }
    expect(renamedModules).toBeGreaterThan(0);
  });
});
