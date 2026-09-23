import { parse } from '@babel/parser';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const generateCalls: unknown[][] = [];
vi.mock('../src/ast-utils/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof generatorModule>();
  return {
    ...actual,
    generate: (...args: Parameters<typeof actual.generate>) => {
      generateCalls.push(args);
      return actual.generate(...args);
    },
  };
});

import type * as generatorModule from '../src/ast-utils/generator';
import { generate } from '../src/ast-utils/generator';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
  type AsyncTransform,
  type Transform,
} from '../src/ast-utils/transform';
import { diffLines, getTracer, setTracer, withTrace } from '../src/trace';

const CODE = 'const foo = 1;\nconsole.log(foo);';

function parseCode(code: string) {
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
}

const renameFoo: Transform = {
  name: 'rename-foo',
  tags: ['safe'],
  visitor: () => ({
    Identifier(path, state) {
      if (path.node.name === 'foo') {
        path.node.name = 'bar';
        state.changes += 1;
      }
    },
  }),
};

const noop: Transform = {
  name: 'noop',
  tags: ['safe'],
  visitor: () => ({}),
};

const asyncRenameFoo: AsyncTransform = {
  name: 'async-rename-foo',
  tags: ['safe'],
  async run() {
    await Promise.resolve();
  },
  visitor: () => ({
    Identifier(path, state) {
      if (path.node.name === 'foo') {
        path.node.name = 'bar';
        state.changes += 1;
      }
    },
  }),
};

beforeEach(() => {
  generateCalls.length = 0;
  setTracer(null);
});

describe('diffLines', () => {
  test('empty inputs produce empty diff', () => {
    expect(diffLines('', '')).toBe('');
  });

  test('identical inputs produce empty diff', () => {
    expect(diffLines('a\nb', 'a\nb')).toBe('');
  });

  test('insertion', () => {
    expect(diffLines('', 'a\nb')).toBe('@@ -0,0 +1,2 @@\n+a\n+b\n');
  });

  test('deletion', () => {
    expect(diffLines('a\nb', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b\n');
  });

  test('single line replace', () => {
    expect(diffLines('a', 'b')).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n');
  });

  test('replace with context', () => {
    expect(diffLines('a\nb\nc', 'a\nX\nc')).toBe(
      '@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n',
    );
  });

  test('distant changes produce separate hunks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const before = lines.join('\n');
    const changed = [...lines];
    changed[1] = 'CHANGED2';
    changed[18] = 'CHANGED19';
    expect(diffLines(before, changed.join('\n'))).toBe(
      '@@ -1,5 +1,5 @@\n' +
        ' line1\n' +
        '-line2\n' +
        '+CHANGED2\n' +
        ' line3\n' +
        ' line4\n' +
        ' line5\n' +
        '@@ -16,5 +16,5 @@\n' +
        ' line16\n' +
        ' line17\n' +
        ' line18\n' +
        '-line19\n' +
        '+CHANGED19\n' +
        ' line20\n',
    );
  });
});

describe('tracer', () => {
  test('tracing is off by default', () => {
    expect(getTracer()).toBeNull();
  });

  test('tracing off never calls generate', () => {
    applyTransform(parseCode(CODE), renameFoo);
    applyTransforms(parseCode(CODE), [renameFoo, noop], { log: false });
    expect(generateCalls).toHaveLength(0);
  });

  test('tracing off produces identical output', () => {
    const plainAst = parseCode(CODE);
    applyTransform(plainAst, renameFoo);

    const { result: tracedCode } = withTrace(() => {
      const ast = parseCode(CODE);
      applyTransform(ast, renameFoo);
      return generate(ast);
    });
    expect(tracedCode).toBe(generate(plainAst));
  });

  test('applyTransform records name, changes and diff', () => {
    const { result, entries } = withTrace(() =>
      applyTransform(parseCode(CODE), renameFoo),
    );
    expect(result.changes).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('rename-foo');
    expect(entries[0].changes).toBe(2);
    expect(entries[0].diff).toBe(
      '@@ -1,2 +1,2 @@\n' +
        '-const foo = 1;\n' +
        '-console.log(foo);\n' +
        '+const bar = 1;\n' +
        '+console.log(bar);\n',
    );
  });

  test('unchanged code records empty diff', () => {
    const { entries } = withTrace(() => applyTransform(parseCode(CODE), noop));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ name: 'noop', changes: 0, diff: '' });
  });

  test('applyTransforms records one entry per merged batch', () => {
    const { entries } = withTrace(() =>
      applyTransforms(parseCode(CODE), [renameFoo, noop], {
        name: 'test-batch',
        log: false,
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('test-batch');
    expect(entries[0].changes).toBe(2);
    expect(entries[0].diff).toContain('+const bar = 1;');
  });

  test('applyTransforms defaults to joined transform names', () => {
    const { entries } = withTrace(() =>
      applyTransforms(parseCode(CODE), [renameFoo, noop], { log: false }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('rename-foo, noop');
  });

  test('applyTransformAsync records an entry', async () => {
    const { result, entries } = await withTrace(() =>
      applyTransformAsync(parseCode(CODE), asyncRenameFoo),
    );
    expect(result.changes).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('async-rename-foo');
    expect(entries[0].changes).toBe(2);
    expect(entries[0].diff).toContain('+const bar = 1;');
  });

  test('setTracer collects entries and null disables', () => {
    const collected: Array<{ name: string }> = [];
    try {
      setTracer((entry) => {
        collected.push(entry);
      });
      applyTransform(parseCode(CODE), renameFoo);
      expect(collected).toHaveLength(1);
      expect(collected[0].name).toBe('rename-foo');
      setTracer(null);
      applyTransform(parseCode(CODE), renameFoo);
      expect(collected).toHaveLength(1);
    } finally {
      setTracer(null);
    }
  });

  test('withTrace restores the previous tracer', () => {
    const outer = withTrace(() => {
      const inner = withTrace(() => applyTransform(parseCode(CODE), renameFoo));
      expect(inner.entries).toHaveLength(1);
      return 'done';
    });
    expect(outer.result).toBe('done');
    expect(outer.entries).toHaveLength(0);
    expect(getTracer()).toBeNull();
  });

  test('withTrace restores the tracer when fn throws', () => {
    expect(() =>
      withTrace(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getTracer()).toBeNull();
  });

  test('tracing off never calls generate for applyTransformAsync', async () => {
    await applyTransformAsync(parseCode(CODE), asyncRenameFoo);
    expect(generateCalls).toHaveLength(0);
  });

  test('overlapping async scopes receive only their own entries', async () => {
    const makeGate = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { promise, release, entered, enteredPromise };
    };
    const gateA = makeGate();
    const gateB = makeGate();

    // A starts first but finishes first: with a module-global tracer the
    // first scope to finish would reset (and steal) the other's tracer.
    const scopeA = withTrace(async () => {
      applyTransform(parseCode(CODE), renameFoo);
      gateA.entered();
      await gateA.promise;
      applyTransform(parseCode(CODE), noop);
      return 'a';
    });
    const scopeB = withTrace(async () => {
      applyTransform(parseCode(CODE), noop);
      gateB.entered();
      await gateB.promise;
      applyTransform(parseCode(CODE), renameFoo);
      return 'b';
    });

    await gateA.enteredPromise;
    await gateB.enteredPromise;

    gateA.release();
    const resultA = await scopeA;
    expect(resultA.result).toBe('a');
    expect(resultA.entries.map((entry) => entry.name)).toEqual([
      'rename-foo',
      'noop',
    ]);

    gateB.release();
    const resultB = await scopeB;
    expect(resultB.result).toBe('b');
    expect(resultB.entries.map((entry) => entry.name)).toEqual([
      'noop',
      'rename-foo',
    ]);
    expect(getTracer()).toBeNull();
  });

  test('nested async scopes collect only their own entries', async () => {
    const outer = await withTrace(async () => {
      applyTransform(parseCode(CODE), noop);
      const inner = await withTrace(async () => {
        applyTransform(parseCode(CODE), renameFoo);
        await Promise.resolve();
        return 'inner';
      });
      expect(inner.result).toBe('inner');
      expect(inner.entries.map((entry) => entry.name)).toEqual(['rename-foo']);
      applyTransform(parseCode(CODE), noop);
      return 'outer';
    });
    expect(outer.result).toBe('outer');
    expect(outer.entries.map((entry) => entry.name)).toEqual(['noop', 'noop']);
    expect(getTracer()).toBeNull();
  });
});
