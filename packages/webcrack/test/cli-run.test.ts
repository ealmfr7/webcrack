import { parse } from '@babel/parser';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli-lib';
import type { CliIO } from '../src/cli-lib';
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

// Fast flags shared by the rename tests below (mirrors the oracle options).
const FAST_FLAGS = ['--no-deobfuscate', '--no-unminify'];

function makeIO(): {
  io: CliIO;
  output: () => { stdout: string; stderr: string };
} {
  let stdout = '';
  let stderr = '';
  const stdoutStream = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  const stderrStream = new Writable({
    write(chunk, _encoding, callback) {
      stderr += String(chunk);
      callback();
    },
  });
  return {
    io: { stdout: stdoutStream, stderr: stderrStream },
    output: () => ({ stdout, stderr }),
  };
}

/**
 * External stub for `--llm-rename-command` (same `node -e` shape as
 * test/cli.test.ts): reads the batch JSON array from stdin, appends every
 * received binding name to `logFile` (one per line) and answers
 * `{name: 'llm_' + name}`. The log file path travels as `process.argv[1]`
 * so the `-e` script itself stays free of shell-quoting hazards.
 */
function stubSuggestCommand(logFile: string): string {
  return (
    `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{` +
    `const fs=require('node:fs');const o={};for(const x of JSON.parse(d)){` +
    `fs.appendFileSync(process.argv[1],x.name+'\\n');o[x.name]='llm_'+x.name;}` +
    `console.log(JSON.stringify(o))})" "${logFile}"`
  );
}

async function jsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => join(dir, entry));
}

describe('runCli stdout LLM rename (no -o)', () => {
  test('renames top-level code, each binding offered exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-clirun-'));
    const logFile = join(dir, 'names.log');
    const { io, output } = makeIO();
    const code = await readFile(WEBPACK_SAMPLE, 'utf8');

    await runCli(
      [
        'node',
        'webcrack',
        WEBPACK_SAMPLE,
        '--llm-rename-command',
        stubSuggestCommand(logFile),
        ...FAST_FLAGS,
      ],
      io,
    );

    expect(output().stdout).toContain('llm_');

    // Independent oracle: the bindings offered by a single renameWithLLM
    // pass over the top-level code of a fresh result for the same input and
    // options. The stub log records every received name, so multiset
    // equality proves no binding was offered twice. Names are compared as a
    // multiset (not a set) because per-scope bindings in different scopes
    // may legitimately share a name.
    const fresh = await webcrack(code, {
      deobfuscate: false,
      unminify: false,
    });
    expect(fresh.bundle).toBeDefined();
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

    const logged = (await readFile(logFile, 'utf8')).trim().split('\n');
    expect(logged.sort()).toEqual(expected.sort());
  });
});

describe('runCli -o LLM rename targets', () => {
  test('bundle input renames module files but not deobfuscated.js', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-clirun-'));
    const logFile = join(dir, 'names.log');
    const outDir = join(dir, 'out');
    const { io } = makeIO();

    await runCli(
      [
        'node',
        'webcrack',
        WEBPACK_SAMPLE,
        '-o',
        outDir,
        '-f',
        '--llm-rename-command',
        stubSuggestCommand(logFile),
        ...FAST_FLAGS,
      ],
      io,
    );

    // The rename really ran.
    expect((await readFile(logFile, 'utf8')).trim().length).toBeGreaterThan(0);

    const saved = await readFile(join(outDir, 'deobfuscated.js'), 'utf8');
    expect(saved).not.toContain('llm_');

    const moduleFiles = (await jsFiles(outDir)).filter(
      (file) => file !== join(outDir, 'deobfuscated.js'),
    );
    expect(moduleFiles.length).toBeGreaterThan(0);
    let renamedModules = 0;
    for (const file of moduleFiles) {
      if ((await readFile(file, 'utf8')).includes('llm_')) renamedModules++;
    }
    expect(renamedModules).toBeGreaterThan(0);
  });

  test('non-bundle input renames deobfuscated.js', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webcrack-clirun-'));
    const logFile = join(dir, 'names.log');
    const outDir = join(dir, 'out');
    const { io } = makeIO();

    await runCli(
      [
        'node',
        'webcrack',
        WEBPACK_SAMPLE,
        '-o',
        outDir,
        '-f',
        '--no-unpack',
        '--llm-rename-command',
        stubSuggestCommand(logFile),
        ...FAST_FLAGS,
      ],
      io,
    );

    const saved = await readFile(join(outDir, 'deobfuscated.js'), 'utf8');
    expect(saved).toContain('llm_');
  });
});

describe('runCli flag validation', () => {
  test.each([
    [
      ['--source-map', '--llm-rename-command', 'some-command'],
      /--source-map cannot be used with --llm-rename-command/,
    ],
    [['--llm-timeout', '10s'], /--llm-timeout must be a positive integer/],
  ] as Array<[string[], RegExp]>)('rejects %p', async (args, message) => {
    const { io } = makeIO();
    const error = await runCli(['node', 'webcrack', ...args], io).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ code: 'commander.error', exitCode: 1 });
    expect(String((error as Error).message)).toMatch(message);
  });
});

describe('runCli --help', () => {
  test('writes usage to stdout and rejects with exitCode 0', async () => {
    const { io, output } = makeIO();
    const error = await runCli(['node', 'webcrack', '--help'], io).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ exitCode: 0 });
    expect(output().stdout).toMatch(/Usage:/);
  });
});
