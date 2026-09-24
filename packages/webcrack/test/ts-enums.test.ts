import { parse } from '@babel/parser';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { runCli, toWebcrackOptions } from '../src/cli-lib';
import { webcrack } from '../src/index.js';

// A compiled TypeScript enum (tsc emit) followed by a use.
const ENUM_CODE = `
var WireType;
(function (WireType) {
  WireType[WireType["Varint"] = 0] = "Varint";
  WireType[WireType["Bit64"] = 1] = "Bit64";
})(WireType || (WireType = {}));
console.log(WireType.Varint);
`;

test('by default the output stays JavaScript (no TypeScript enum)', async () => {
  const { code } = await webcrack(ENUM_CODE);
  expect(code).not.toMatch(/\benum\s+WireType\b/);
  expect(() => parse(code, { sourceType: 'unambiguous' })).not.toThrow();
});

test('tsEnums: true restores the TypeScript enum', async () => {
  const { code } = await webcrack(ENUM_CODE, { tsEnums: true });
  expect(code).toMatch(/\benum\s+WireType\s*\{/);
  expect(code).toContain('Varint = 0');
});

test('--ts-enums maps to the tsEnums option', async () => {
  expect(toWebcrackOptions({ tsEnums: true }).tsEnums).toBe(true);
  expect(toWebcrackOptions({}).tsEnums).toBeUndefined();

  const dir = await mkdtemp(join(tmpdir(), 'webcrack-tsenums-'));
  const input = join(dir, 'in.js');
  await writeFile(input, ENUM_CODE);
  const run = async (...flags: string[]): Promise<string> => {
    let stdout = '';
    const sink = (onChunk: (s: string) => void) =>
      new Writable({
        write(chunk, _encoding, callback) {
          onChunk(String(chunk));
          callback();
        },
      });
    await runCli(['node', 'webcrack', ...flags, input], {
      stdout: sink((s) => (stdout += s)),
      stderr: sink(() => {}),
    });
    return stdout;
  };
  expect(await run('--ts-enums')).toMatch(/\benum\s+WireType\b/);
  expect(await run()).not.toMatch(/\benum\s+WireType\b/);
});
