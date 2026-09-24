import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { perInputDirNames, runMultiInput } from '../src/cli-lib';
import type { SuggestNames } from '../src/index.js';

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

const MINIMAL_FLAGS = {
  deobfuscate: false,
  unminify: false,
  jsx: false,
};

function silenceWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/**
 * A fake `suggestNames` that prefixes every suggested binding with `q_` and
 * records any binding that was already renamed (i.e. renamed twice).
 */
function countingSuggestNames(renamedTwice: string[]): SuggestNames {
  return (batch) => {
    const result: Record<string, string> = {};
    for (const binding of batch) {
      if (binding.name.startsWith('q_')) renamedTwice.push(binding.name);
      result[binding.name] = `q_${binding.name}`;
    }
    return Promise.resolve(result);
  };
}

describe('perInputDirNames', () => {
  test('first occurrence keeps the bare name, later ones get a suffix', () => {
    expect(
      perInputDirNames(['a/chunk.js', 'b/chunk.js', 'c/chunk.js']),
    ).toEqual(['chunk', 'chunk-2', 'chunk-3']);
  });

  test('distinct names are unchanged', () => {
    expect(
      perInputDirNames(['webpack-runtime.js', 'webpack-chunk-a.js']),
    ).toEqual(['webpack-runtime', 'webpack-chunk-a']);
  });

  test('names clashing with reserved entries get a suffix', () => {
    expect(perInputDirNames(['1.js'], ['1.js'])).toEqual(['1-2']);
    expect(perInputDirNames(['1.js'], ['1'])).toEqual(['1-2']);
    expect(perInputDirNames(['src/index.js'], ['src'])).toEqual(['index']);
  });

  test('suffixed candidates also avoid reserved entries', () => {
    expect(perInputDirNames(['chunk.js', 'other.js'], ['chunk-2'])).toEqual([
      'chunk',
      'other',
    ]);
    expect(
      perInputDirNames(['chunk.js', 'chunk.js'], ['chunk', 'chunk-2']),
    ).toEqual(['chunk-3', 'chunk-4']);
  });
});

describe('runMultiInput output directories', () => {
  test('same-basename inputs land in distinct dirs with their own output', async () => {
    const warn = silenceWarnings();
    try {
      const outDir = await mkdtemp(join(tmpdir(), 'webcrack-multi-'));
      await runMultiInput(
        [
          { name: 'a/chunk.js', code: `console.log('from-a');` },
          { name: 'b/chunk.js', code: `console.log('from-b');` },
        ],
        outDir,
        MINIMAL_FLAGS,
      );

      const first = await readFile(
        join(outDir, 'chunk', 'deobfuscated.js'),
        'utf8',
      );
      const second = await readFile(
        join(outDir, 'chunk-2', 'deobfuscated.js'),
        'utf8',
      );
      expect(first).toContain('from-a');
      expect(first).not.toContain('from-b');
      expect(second).toContain('from-b');
      expect(second).not.toContain('from-a');
    } finally {
      warn.mockRestore();
    }
  });

  test('per-input dir clashing with a bundle module file gets a suffix', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-multi-'));
    const { bundle } = await runMultiInput(
      [
        {
          name: 'webpack-runtime.js',
          code: await fixture('webpack-runtime.js'),
        },
        {
          name: 'webpack-chunk-a.js',
          code: await fixture('webpack-chunk-a.js'),
        },
        // The merged bundle contains a `./index.js` module file, so this
        // input must not take the `index` directory.
        { name: 'index.js', code: `console.log('lone');` },
      ],
      outDir,
      MINIMAL_FLAGS,
    );

    expect(bundle).toBeDefined();
    const segments = [...bundle!.modules.values()].map(
      (m) => m.path.replace(/^\.\//, '').split('/')[0],
    );
    // Sanity check: the clash this test exercises really exists.
    expect(segments).toContain('index.js');

    const entries = await readdir(outDir);
    expect(entries).toContain('index-2');
    // The bundle module file is untouched by the per-input outputs.
    const moduleFile = await readFile(join(outDir, 'index.js'), 'utf8');
    expect(moduleFile).not.toContain('lone');
    const perInput = await readFile(
      join(outDir, 'index-2', 'deobfuscated.js'),
      'utf8',
    );
    expect(perInput).toContain('lone');
  });
});

describe('runMultiInput LLM rename runs once per piece of code', () => {
  test('without a bundle each input is renamed once', async () => {
    const warn = silenceWarnings();
    try {
      const renamedTwice: string[] = [];
      const outDir = await mkdtemp(join(tmpdir(), 'webcrack-multi-'));
      const { bundle, results } = await runMultiInput(
        [
          {
            name: 'a.js',
            code: 'function f(){var a=1;var b=2;return a+b;}console.log(f());',
          },
          {
            name: 'b.js',
            code: 'function g(){var c=3;var d=4;return c+d;}console.log(g());',
          },
        ],
        outDir,
        MINIMAL_FLAGS,
        countingSuggestNames(renamedTwice),
      );

      expect(bundle).toBeUndefined();
      expect(results[0].code).toContain('q_a');
      expect(results[1].code).toContain('q_c');
      expect(renamedTwice).toEqual([]);
      for (const dir of ['a', 'b']) {
        const saved = await readFile(
          join(outDir, dir, 'deobfuscated.js'),
          'utf8',
        );
        expect(saved).toContain('q_');
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('with a bundle only the merged modules are renamed', async () => {
    const renamedTwice: string[] = [];
    const outDir = await mkdtemp(join(tmpdir(), 'webcrack-multi-'));
    // Give module 2 a short binding so the merged-bundle rename has a real
    // candidate (`renameWithLLM` only renames mangled names).
    const runtime = (await fixture('webpack-runtime.js')).replace(
      `module.exports = 'hello';`,
      `var a = 'hello'; module.exports = a;`,
    );
    const suggestNames = countingSuggestNames(renamedTwice);
    const seenBatches: string[][] = [];
    const recordingSuggestNames: SuggestNames = async (batch) => {
      seenBatches.push(batch.map((b) => b.name));
      return suggestNames(batch);
    };
    const { bundle, results } = await runMultiInput(
      [
        { name: 'webpack-runtime.js', code: runtime },
        {
          name: 'webpack-chunk-a.js',
          code: await fixture('webpack-chunk-a.js'),
        },
      ],
      outDir,
      MINIMAL_FLAGS,
      recordingSuggestNames,
    );

    expect(bundle).toBeDefined();
    // The merged-bundle rename really ran.
    expect(seenBatches.flat()).toContain('a');
    const moduleCode = [...bundle!.modules.values()]
      .map((m) => m.code)
      .join('\n');
    expect(moduleCode).toContain('q_a');
    // The per-input results keep their pre-merge code: renaming happened
    // exactly once, on the merged bundle.
    for (const result of results) {
      expect(result.code).not.toContain('q_');
    }
    expect(renamedTwice).toEqual([]);
  });
});
