import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { installEpipeGuard } from '../src/cli-lib';

describe('installEpipeGuard', () => {
  for (const kind of ['stdout-like', 'stderr-like'] as const) {
    test(`ignores EPIPE errors (${kind})`, () => {
      const s = new PassThrough();
      installEpipeGuard(s);
      const e = new Error('write EPIPE') as NodeJS.ErrnoException;
      e.code = 'EPIPE';
      expect(() => s.emit('error', e)).not.toThrow();
    });

    test(`rethrows non-EPIPE errors (${kind})`, () => {
      const s = new PassThrough();
      installEpipeGuard(s);
      const e = new Error('permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      expect(() => s.emit('error', e)).toThrow();
    });
  }
});
