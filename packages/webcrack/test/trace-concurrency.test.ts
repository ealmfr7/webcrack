import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { webcrack } from '../src';

const obfuscatedSrc = await readFile(
  join(__dirname, '../src/deobfuscate/test/samples/obfuscator.io.js'),
  'utf8',
);
const stringArraySrc = await readFile(
  join(__dirname, '../src/deobfuscate/test/samples/simple-string-array.js'),
  'utf8',
);

describe('trace concurrency', () => {
  test('concurrent webcrack calls with trace keep only their own entries', async () => {
    const [concurrentA, concurrentB] = await Promise.all([
      webcrack(obfuscatedSrc, { trace: true }),
      webcrack(stringArraySrc, { trace: true }),
    ]);
    // Sanity check: the two inputs really produce different traces, so the
    // equality assertions below can tell cross-talk apart from isolation.
    expect(concurrentA.trace).toBeDefined();
    expect(concurrentB.trace).toBeDefined();
    expect(JSON.stringify(concurrentA.trace)).not.toBe(
      JSON.stringify(concurrentB.trace),
    );

    // Sequential runs are the oracle: with a module-global tracer the
    // overlapping scopes above would leak entries into each other.
    const expectedA = (await webcrack(obfuscatedSrc, { trace: true })).trace;
    const expectedB = (await webcrack(stringArraySrc, { trace: true })).trace;
    expect(concurrentA.trace).toEqual(expectedA);
    expect(concurrentB.trace).toEqual(expectedB);
  });
});
