import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { describe, expect, test } from 'vitest';
import { generate, generateWithMap } from '../generator';

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_CHARS.indexOf(char);
    if (digit === -1) {
      throw new Error(`Invalid base64 character in mapping: ${char}`);
    }
    value |= (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
    } else {
      const isNegative = (value & 1) === 1;
      value >>>= 1;
      values.push(isNegative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

interface DecodedMapping {
  generatedLine: number;
  generatedColumn: number;
  source: number | null;
  originalLine: number | null;
  originalColumn: number | null;
}

function decodeMappings(mappings: string): DecodedMapping[] {
  const result: DecodedMapping[] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const [lineIndex, line] of mappings.split(';').entries()) {
    let generatedColumn = 0;
    if (line === '') continue;
    for (const segment of line.split(',')) {
      const fields = decodeVlqSegment(segment);
      generatedColumn += fields[0];
      const mapping: DecodedMapping = {
        generatedLine: lineIndex,
        generatedColumn,
        source: null,
        originalLine: null,
        originalColumn: null,
      };
      if (fields.length >= 4) {
        source += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        mapping.source = source;
        mapping.originalLine = originalLine;
        mapping.originalColumn = originalColumn;
      }
      result.push(mapping);
    }
  }
  return result;
}

describe('generateWithMap', () => {
  test('emits a valid version 3 source map with sourcesContent', () => {
    const source = 'const answer = 40 + 2;\nconsole.log(answer);\n';
    const ast = parse(source);
    const { code, map } = generateWithMap(ast, {
      sourceFileName: 'input.js',
      sourceContent: source,
    });

    expect(code).toBe(generate(ast));
    expect(map.version).toBe(3);
    expect(map.sources).toContain('input.js');
    expect(Array.isArray(map.names)).toBe(true);
    expect(typeof map.mappings).toBe('string');
    expect(map.mappings.length).toBeGreaterThan(0);
    expect(map.sourcesContent).toEqual([source]);
  });

  test('works without sourceContent', () => {
    const ast = parse('const a = 1;\n');
    const { map } = generateWithMap(ast, { sourceFileName: 'input.js' });

    expect(map.version).toBe(3);
    expect(map.sources).toContain('input.js');
    // No original code was provided, so no source content is embedded.
    expect((map.sourcesContent ?? []).every((content) => content == null)).toBe(
      true,
    );
    expect(decodeMappings(map.mappings).length).toBeGreaterThan(0);
  });

  test('maps generated positions back to original positions after rename', () => {
    const source = 'const foo = 1;\nconsole.log(foo);\n';
    const ast = parse(source);
    traverse(ast, {
      Program(path) {
        path.scope.rename('foo', 'bar');
      },
    });

    const { code, map } = generateWithMap(ast, {
      sourceFileName: 'input.js',
      sourceContent: source,
    });
    expect(code).toBe('const bar = 1;\nconsole.log(bar);');

    const mappings = decodeMappings(map.mappings);
    const sourceIndex = map.sources.indexOf('input.js');
    expect(sourceIndex).toBeGreaterThanOrEqual(0);

    // `foo` declarator id was at line 1, column 6 (1-based line, 0-based column)
    // in the input; the renamed `bar` must map back there.
    const declaration = mappings.filter(
      (m) =>
        m.source === sourceIndex &&
        m.originalLine === 0 &&
        m.originalColumn === 6,
    );
    expect(declaration.length).toBeGreaterThan(0);
    for (const m of declaration) {
      const line = code.split('\n')[m.generatedLine];
      expect(line.slice(m.generatedColumn, m.generatedColumn + 3)).toBe('bar');
    }

    // `foo` reference was at line 2, column 12 in the input.
    const reference = mappings.filter(
      (m) =>
        m.source === sourceIndex &&
        m.originalLine === 1 &&
        m.originalColumn === 12,
    );
    expect(reference.length).toBeGreaterThan(0);
    for (const m of reference) {
      const line = code.split('\n')[m.generatedLine];
      expect(line.slice(m.generatedColumn, m.generatedColumn + 3)).toBe('bar');
    }
  });

  test('generate() output is unchanged (no source map by default)', () => {
    const ast = parse('const answer = 40 + 2;\nconsole.log(answer);\n');
    expect(generate(ast)).toBe('const answer = 40 + 2;\nconsole.log(answer);');
  });
});
