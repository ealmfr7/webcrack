import { Readable, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { runCli, type CliIO } from '../src/cli-lib';

function makeIO(stdinChunks: string[]): {
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
    io: {
      stdout: stdoutStream,
      stderr: stderrStream,
      stdin: Readable.from(stdinChunks),
    },
    output: () => ({ stdout, stderr }),
  };
}

// NOTE: these tests pass an explicit `stdin` stream via `io.stdin`. If
// `runCli` fell back to reading `process.stdin` instead (e.g. `readStdin`
// using `process.stdin` unconditionally), the injected chunks would be
// ignored and the CLI would block waiting on the real process stdin — under
// vitest that inherited stdin never receives EOF, so the test would hang
// until the runner times out rather than fail quickly.
describe('runCli stdin input', () => {
  test('reads code from io.stdin when no file is given', async () => {
    const { io, output } = makeIO(['var a=1']);
    await runCli(['node', 'webcrack'], io);
    expect(output().stdout).toBe('var a = 1;\n');
  });

  test('reads multi-chunk io.stdin', async () => {
    const { io, output } = makeIO(['var a', '=1']);
    await runCli(['node', 'webcrack'], io);
    expect(output().stdout).toBe('var a = 1;\n');
  });
});
