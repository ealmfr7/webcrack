import { describe, expect, test } from 'vitest';
import { webcrack } from '../src';

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
  originalLine: number;
  originalColumn: number;
}

function decodeMappings(mappings: string): Mapping[] {
  const result: Mapping[] = [];
  let originalLine = 0;
  let originalColumn = 0;
  for (const [lineIndex, line] of mappings.split(';').entries()) {
    let generatedColumn = 0;
    if (line === '') continue;
    for (const segment of line.split(',')) {
      const fields = decodeSegment(segment);
      generatedColumn += fields[0];
      if (fields.length >= 4) {
        originalLine += fields[2];
        originalColumn += fields[3];
        result.push({
          generatedLine: lineIndex,
          generatedColumn,
          originalLine,
          originalColumn,
        });
      }
    }
  }
  return result;
}

/** 0-based line count of the input; no mapping may point past it. */
function expectMappingsInRange(input: string, mappings: Mapping[]): void {
  const lineCount = input.split('\n').length;
  for (const mapping of mappings) {
    expect(mapping.originalLine).toBeLessThan(lineCount);
  }
}

describe('sourcemap positions for re-parsed (unwrapped) code', () => {
  test('Function body statements map to the Function call', async () => {
    const input =
      'var a = 1;\nFunction("\\n\\n\\n    foo(); bar();")();\nconsole.log(a);\n';
    const result = await webcrack(input, { sourceMap: true });
    expect(result.map).toBeDefined();
    const mappings = decodeMappings(result.map!.mappings);
    expectMappingsInRange(input, mappings);

    const lines = result.code.split('\n');
    const fooLine = lines.findIndex((line) => line.includes('foo();'));
    const barLine = lines.findIndex((line) => line.includes('bar();'));
    expect(fooLine).toBeGreaterThanOrEqual(0);
    expect(barLine).toBeGreaterThanOrEqual(0);
    // The Function(...)() call is on original line 2 (1-based), column 0.
    for (const line of [fooLine, barLine]) {
      const onLine = mappings.filter((m) => m.generatedLine === line);
      expect(onLine.length).toBeGreaterThan(0);
      for (const mapping of onLine) {
        expect(mapping.originalLine).toBe(1);
        expect(mapping.originalColumn).toBe(0);
      }
    }
  });

  test('packer payload statements map to the eval call', async () => {
    const packed =
      'eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};' +
      'while(c--){if(k[c]){p=p.replace(new RegExp("\\\\b"+e(c)+"\\\\b","g"),k[c])}}' +
      'return p}' +
      '("\\n\\n\\n    0(); 1();",36,2,"foo|bar".split("|"),0,{}))';
    const input = `var a = 1;\n${packed}\nconsole.log(a);\n`;
    const result = await webcrack(input, { sourceMap: true });
    expect(result.code).toContain('foo();');
    expect(result.code).toContain('bar();');
    expect(result.map).toBeDefined();
    const mappings = decodeMappings(result.map!.mappings);
    expectMappingsInRange(input, mappings);

    const lines = result.code.split('\n');
    const fooLine = lines.findIndex((line) => line.includes('foo();'));
    expect(fooLine).toBeGreaterThanOrEqual(0);
    const onLine = mappings.filter((m) => m.generatedLine === fooLine);
    expect(onLine.length).toBeGreaterThan(0);
    for (const mapping of onLine) {
      expect(mapping.originalLine).toBe(1);
      expect(mapping.originalColumn).toBe(0);
    }
  });

  test('JSON.parse replacement maps to the JSON.parse call', async () => {
    const input = 'var a = JSON.parse("[1,\\n\\n\\n2]");\nconsole.log(a);\n';
    const result = await webcrack(input, { sourceMap: true });
    expect(result.code).toContain('[1, 2]');
    expect(result.map).toBeDefined();
    const mappings = decodeMappings(result.map!.mappings);
    // The decoded string has 4 lines but the input has 3: without the fix
    // the `2` element maps to a made-up original line 4.
    expectMappingsInRange(input, mappings);
  });
});
