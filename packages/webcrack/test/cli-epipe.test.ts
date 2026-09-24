import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { installStdoutEpipeGuard } from '../src/cli-lib';

describe('installStdoutEpipeGuard', () => {
  test('ignores EPIPE errors', () => {
    const s = new PassThrough();
    installStdoutEpipeGuard(s);
    const e = new Error('write EPIPE') as NodeJS.ErrnoException;
    e.code = 'EPIPE';
    expect(() => s.emit('error', e)).not.toThrow();
  });

  test('rethrows non-EPIPE errors', () => {
    const s = new PassThrough();
    installStdoutEpipeGuard(s);
    const e = new Error('permission denied') as NodeJS.ErrnoException;
    e.code = 'EACCES';
    expect(() => s.emit('error', e)).toThrow();
  });
});
