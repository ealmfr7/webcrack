import { parse } from '@babel/parser';
import type { File } from '@babel/types';
import { expect, test } from 'vitest';
import { generate } from '../src/ast-utils/generator';
import {
  renameWithLLM,
  type LLMBindingInfo,
  type RenameLLMOptions,
  type SuggestNames,
} from '../src/transforms/rename-llm';

async function run(
  input: string,
  suggestNames: SuggestNames,
  options?: Partial<Pick<RenameLLMOptions, 'batchSize' | 'filter'>>,
) {
  const ast: File = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  const log = await renameWithLLM(ast, { suggestNames, ...options });
  return { code: generate(ast), log };
}

function fromMap(map: Record<string, string>): SuggestNames {
  return (batch: LLMBindingInfo[]) => {
    const result: Record<string, string> = {};
    for (const info of batch) {
      if (map[info.name] !== undefined) result[info.name] = map[info.name];
    }
    return Promise.resolve(result);
  };
}

test('renames bindings and returns a deterministic log', async () => {
  const { code, log } = await run(
    'function _0xabc(a, b) { return a + b; }',
    fromMap({ _0xabc: 'add', a: 'first', b: 'second' }),
  );
  expect(code).toBe(
    'function add(first, second) {\n  return first + second;\n}',
  );
  expect(log).toEqual([
    { from: '_0xabc', to: 'add', kind: 'hoisted' },
    { from: 'a', to: 'first', kind: 'param' },
    { from: 'b', to: 'second', kind: 'param' },
  ]);

  // Same input + same callback -> identical log and output
  const again = await run(
    'function _0xabc(a, b) { return a + b; }',
    fromMap({ _0xabc: 'add', a: 'first', b: 'second' }),
  );
  expect(again.log).toEqual(log);
  expect(again.code).toBe(code);
});

test('batches callback calls', async () => {
  const seen: string[][] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(batch.map((info) => info.name));
    return Promise.resolve({});
  };
  const { log } = await run(
    'var a = 1; var b = 2; var c = 3; var d = 4; var e = 5;',
    suggestNames,
    { batchSize: 2 },
  );
  expect(seen).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  expect(log).toEqual([]);
});

test('invalid and reserved suggestions are skipped', async () => {
  const { code, log } = await run(
    'var a = 1; var b = 2; var c = 3; var d = 4; var e = 5;',
    fromMap({
      a: '123bad',
      b: 'class',
      c: '',
      d: 'has-dash',
      e: 'valid',
    }),
  );
  expect(code).toBe(
    'var a = 1;\nvar b = 2;\nvar c = 3;\nvar d = 4;\nvar valid = 5;',
  );
  expect(log).toEqual([{ from: 'e', to: 'valid', kind: 'var' }]);
});

test('colliding suggestions get a suffix', async () => {
  const { code, log } = await run(
    'var a = 1; var b = 2; console.log(a, b);',
    fromMap({ a: 'value', b: 'value' }),
  );
  expect(code).toBe(
    'var value = 1;\nvar value2 = 2;\nconsole.log(value, value2);',
  );
  expect(log).toEqual([
    { from: 'a', to: 'value', kind: 'var' },
    { from: 'b', to: 'value2', kind: 'var' },
  ]);
});

test('already-descriptive names are never offered', async () => {
  const seen: string[] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(...batch.map((info) => info.name));
    return Promise.resolve({ descriptive: 'renamed', a: 'alpha' });
  };
  const { code } = await run(
    'var descriptive = 1; var a = 2; console.log(descriptive, a);',
    suggestNames,
  );
  expect(seen).toEqual(['a']);
  expect(code).toBe(
    'var descriptive = 1;\nvar alpha = 2;\nconsole.log(descriptive, alpha);',
  );
});

test('exports are never renamed', async () => {
  const seen: string[] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(...batch.map((info) => info.name));
    return Promise.resolve({ a: 'alpha', b: 'beta' });
  };
  const { code, log } = await run(
    'export const a = 1; const b = a + 1; console.log(b);',
    suggestNames,
  );
  expect(seen).toEqual(['b']);
  expect(code).toBe(
    'export const a = 1;\nconst beta = a + 1;\nconsole.log(beta);',
  );
  expect(log).toEqual([{ from: 'b', to: 'beta', kind: 'const' }]);
});

test('globals are never renamed', async () => {
  const seen: string[] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(...batch.map((info) => info.name));
    return Promise.resolve({});
  };
  const { code } = await run('var x = yyy + 1; console.log(x);', suggestNames);
  expect(seen).toEqual(['x']);
  expect(code).toBe('var x = yyy + 1;\nconsole.log(x);');
});

test('shadowing stays correct', async () => {
  const { code, log } = await run(
    'var a = 1; function f(a) { return a; } console.log(a);',
    fromMap({ a: 'value' }),
  );
  expect(code).toBe(
    'var value = 1;\nfunction f(value2) {\n  return value2;\n}\nconsole.log(value);',
  );
  expect(log).toEqual([
    { from: 'a', to: 'value', kind: 'var' },
    { from: 'a', to: 'value2', kind: 'param' },
  ]);
});

test('callback errors leave the failed batch unapplied', async () => {
  let calls = 0;
  const suggestNames: SuggestNames = (batch) => {
    calls++;
    if (calls === 2) return Promise.reject(new Error('LLM unavailable'));
    return Promise.resolve(
      Object.fromEntries(batch.map((info) => [info.name, `n_${info.name}`])),
    );
  };
  const { code, log } = await run(
    'var a = 1; var b = 2; var c = 3; var d = 4;',
    suggestNames,
    { batchSize: 2 },
  );
  // First batch applied, failed second batch skipped, AST still valid
  expect(code).toBe('var n_a = 1;\nvar n_b = 2;\nvar c = 3;\nvar d = 4;');
  expect(log).toEqual([
    { from: 'a', to: 'n_a', kind: 'var' },
    { from: 'b', to: 'n_b', kind: 'var' },
  ]);
});

test('a throwing callback leaves the AST identical', async () => {
  const input = 'var a = 1; function f(b) { return a + b; }';
  const { code, log } = await run(input, () =>
    Promise.reject(new Error('LLM unavailable')),
  );
  expect(log).toEqual([]);
  const expected: File = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
  expect(code).toBe(generate(expected));
});

test('filter excludes bindings', async () => {
  const { code, log } = await run(
    'function f(a) { var b = a; return b; }',
    fromMap({ a: 'first', b: 'second' }),
    { filter: (info) => info.kind !== 'param' },
  );
  expect(code).toBe('function f(a) {\n  var second = a;\n  return second;\n}');
  expect(log).toEqual([{ from: 'b', to: 'second', kind: 'var' }]);
});

test('unknown suggestion keys are ignored', async () => {
  const { code, log } = await run('var a = 1;', () =>
    Promise.resolve({
      nope: 'whatever',
    }),
  );
  expect(code).toBe('var a = 1;');
  expect(log).toEqual([]);
});

test('batchSize 0 is clamped to 1', async () => {
  const seen: string[][] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(batch.map((info) => info.name));
    return Promise.resolve({});
  };
  await run('var a = 1; var b = 2; var c = 3;', suggestNames, {
    batchSize: 0,
  });
  expect(seen).toEqual([['a'], ['b'], ['c']]);
});

test('non-finite batchSize falls back to the default', async () => {
  const seen: string[][] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(batch.map((info) => info.name));
    return Promise.resolve({});
  };
  await run('var a = 1; var b = 2; var c = 3;', suggestNames, {
    batchSize: NaN,
  });
  expect(seen).toEqual([['a', 'b', 'c']]);
});

test('import bindings are never renamed', async () => {
  const seen: string[] = [];
  const suggestNames: SuggestNames = (batch) => {
    seen.push(...batch.map((info) => info.name));
    return Promise.resolve({ x: 'ex', a: 'alpha' });
  };
  const { code, log } = await run(
    'import x from "./mod.js"; var a = 1; console.log(x, a);',
    suggestNames,
  );
  expect(seen).toEqual(['a']);
  expect(code).toContain('import x from');
  expect(code).toContain('alpha');
  expect(log).toEqual([{ from: 'a', to: 'alpha', kind: 'var' }]);
});

test('callback receives name, kind, context and scope info', async () => {
  let received: LLMBindingInfo[] = [];
  await run('var a = 1;', (batch) => {
    received = batch;
    return Promise.resolve({});
  });
  expect(received).toHaveLength(1);
  expect(received[0].name).toBe('a');
  expect(received[0].kind).toBe('var');
  expect(received[0].context).toContain('a=1');
  expect(received[0].scopeType).toBe('Program');
});
