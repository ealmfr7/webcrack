import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  callGraph,
  detectInterpreters,
  extractReport,
  fingerprint,
  labelHandlers,
  matchModules,
  moduleGraph,
  renameWithLLM,
  toDot,
  unpackChunks,
  webcrack,
} from '../src';
import { SIGNATURES } from '../src/analysis/signatures/index';

const webpackSrc = await readFile(
  join(__dirname, '../src/unpack/test/samples/webpack-4.js'),
  'utf8',
);

const crc32Seed = SIGNATURES.find((s) => s.path === 'tiny-hash/crc32.js')!;
if (!crc32Seed) throw new Error('seed signature tiny-hash/crc32.js missing');

/**
 * A minimal webpack-4 bundle reusing the sample's runtime: module 0 is the
 * entry requiring module 1, module 1 holds the crc32 seed source verbatim.
 */
function seedBundle(): string {
  const head = webpackSrc
    .slice(0, webpackSrc.indexOf('})([') + '})(['.length)
    .replace('n((n.s = 2))', 'n((n.s = 0))');
  return (
    `${head}\n` +
    `function (e, t, r) {\n  const hash = r(1);\n  console.log(hash('hello'));\n},\n` +
    `function (e, t, r) {\n${crc32Seed.source}\n}\n]);`
  );
}

const minimalOptions = {
  deobfuscate: false,
  unminify: false,
  jsx: false,
  unpack: false,
} as const;

describe('named public exports', () => {
  test('all wave-6 API functions are importable by name', () => {
    for (const fn of [
      unpackChunks,
      renameWithLLM,
      extractReport,
      moduleGraph,
      callGraph,
      toDot,
      fingerprint,
      matchModules,
      detectInterpreters,
      labelHandlers,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});

describe('options off by default', () => {
  test('no map/trace and save writes only deobfuscated.js', async () => {
    const result = await webcrack('console.log("hi");');
    expect(result.map).toBeUndefined();
    expect(result.trace).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-wave6-'));
    await result.save(dir);
    expect(await readdir(dir)).toEqual(['deobfuscated.js']);
  });
});

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
    } else {
      const negate = (value & 1) === 1;
      value >>= 1;
      values.push(negate ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

interface Mapping {
  generatedLine: number;
  generatedColumn: number;
  source: number;
  originalLine: number;
  originalColumn: number;
}

function decodeMappings(mappings: string): Mapping[] {
  const result: Mapping[] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const [lineIndex, line] of mappings.split(';').entries()) {
    let generatedColumn = 0;
    if (line === '') continue;
    for (const segment of line.split(',')) {
      const fields = decodeSegment(segment);
      generatedColumn += fields[0];
      if (fields.length >= 4) {
        source += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        result.push({
          generatedLine: lineIndex,
          generatedColumn,
          source,
          originalLine,
          originalColumn,
        });
      }
    }
  }
  return result;
}

describe('sourceMap option', () => {
  test('a map entry points an identifier back to its original line', async () => {
    const input = `const greeting = 'hello';\nconsole.log(greeting);\n`;
    const result = await webcrack(input, {
      ...minimalOptions,
      sourceMap: true,
    });
    expect(result.map).toBeDefined();
    expect(result.map!.sources).toEqual(['input.js']);
    expect(result.map!.sourcesContent).toEqual([input]);

    const lines = result.code.split('\n');
    expect(lines.length).toBe(2);
    const mappings = decodeMappings(result.map!.mappings);
    expect(mappings.length).toBeGreaterThan(0);
    // The `greeting` reference on generated line 2 maps to original line 2.
    const line2 = mappings.filter((m) => m.generatedLine === 1);
    expect(line2.length).toBeGreaterThan(0);
    for (const mapping of line2) {
      expect(mapping.originalLine).toBe(1);
    }
    const greetingColumn = lines[1].indexOf('greeting');
    expect(
      line2.some(
        (m) =>
          m.generatedColumn <= greetingColumn &&
          m.originalColumn === greetingColumn,
      ),
    ).toBe(true);
  });

  test('save writes the map and appends a sourceMappingURL comment', async () => {
    const input = `console.log(1);\n`;
    const result = await webcrack(input, {
      ...minimalOptions,
      sourceMap: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-wave6-'));
    await result.save(dir);
    expect(await readdir(dir)).toEqual([
      'deobfuscated.js',
      'deobfuscated.js.map',
    ]);
    const saved = await readFile(join(dir, 'deobfuscated.js'), 'utf8');
    expect(saved.startsWith(result.code)).toBe(true);
    expect(
      saved.trimEnd().endsWith('//# sourceMappingURL=deobfuscated.js.map'),
    ).toBe(true);
    const map: unknown = JSON.parse(
      await readFile(join(dir, 'deobfuscated.js.map'), 'utf8'),
    );
    expect(map).toMatchObject({
      sources: ['input.js'],
      sourcesContent: [input],
    });
  });
});

describe('trace option', () => {
  test('entries are recorded and trace.diff is written', async () => {
    const result = await webcrack('const a = 1;\nconsole.log(a);\n', {
      ...minimalOptions,
      trace: true,
    });
    expect(result.trace).toBeDefined();
    expect(result.trace!.length).toBeGreaterThan(0);
    expect(result.trace!.map((e) => e.name)).toContain('prepare');
    for (const entry of result.trace!) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.changes).toBe('number');
      expect(typeof entry.diff).toBe('string');
    }

    const dir = await mkdtemp(join(tmpdir(), 'webcrack-api-wave6-'));
    await result.save(dir);
    expect(await readdir(dir)).toContain('trace.diff');
    const diff = await readFile(join(dir, 'trace.diff'), 'utf8');
    expect(diff).toContain('prepare');
  });
});

describe('libraryMappings option', () => {
  test('a seed-signature module is named and required by its library path', async () => {
    const result = await webcrack(seedBundle(), {
      deobfuscate: false,
      unminify: false,
      jsx: false,
      libraryMappings: true,
    });
    expect(result.bundle).toBeDefined();
    const paths = new Map(
      [...result.bundle!.modules.values()].map((m) => [m.id, m.path]),
    );
    expect(paths.get('1')).toBe('node_modules/tiny-hash/crc32.js');
    const entry = result.bundle!.modules.get('0')!;
    expect(entry.code).toContain('tiny-hash/crc32.js');
  });

  test('an explicit user mapping wins over the detected library mapping', async () => {
    const result = await webcrack(seedBundle(), {
      deobfuscate: false,
      unminify: false,
      jsx: false,
      libraryMappings: true,
      mappings: (m) => ({ 'custom/crc32.js': m.identifier('crc32') }),
    });
    expect(result.bundle).toBeDefined();
    const lib = result.bundle!.modules.get('1')!;
    expect(lib.path).toBe('node_modules/custom/crc32.js');
    const entry = result.bundle!.modules.get('0')!;
    expect(entry.code).toContain('custom/crc32.js');
    expect(entry.code).not.toContain('tiny-hash/crc32.js');
  });
});
