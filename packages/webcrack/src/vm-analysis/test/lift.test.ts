import { parse } from '@babel/parser';
import type { File } from '@babel/types';
import { describe, expect, test } from 'vitest';
import {
  disassemble as disassembleFromEntry,
  formatDisassembly as formatDisassemblyFromEntry,
  liftDisassembly,
} from '../../index.js';
import { detectInterpreters } from '../detect.js';
import { disassemble } from '../disasm.js';
import { labelHandlers } from '../handlers.js';
import { liftDisassembly as liftDirect } from '../lift.js';

function parseJS(code: string): File {
  return parse(code, { sourceType: 'unambiguous' });
}

// Covers every handler kind the lifter executes: constants, arithmetic,
// output, jumps, register load/store, both return shapes, and a no-op
// unknown case. Opcodes: 0 push-const, 1 add, 2 mul, 3 lt, 4 sub,
// 5 print, 6 jump, 7 cond-jump (taken when truthy), 8 get, 9 set,
// 10 return-out, 11 return-value, 12 unknown no-op.
const VM_SRC = `
function run(bc) {
  const stack = [];
  const vars = [];
  const out = [];
  let pc = 0;
  while (true) {
    const op = bc[pc++];
    switch (op) {
      case 0:
        stack.push(bc[pc++]);
        break;
      case 1: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(a + b);
        break;
      }
      case 2: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(a * b);
        break;
      }
      case 3: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(a < b);
        break;
      }
      case 4: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(a - b);
        break;
      }
      case 5:
        out.push(stack.pop());
        break;
      case 6:
        pc = bc[pc];
        break;
      case 7:
        if (stack.pop()) pc = bc[pc++];
        else pc++;
        break;
      case 8:
        stack.push(vars[bc[pc++]]);
        break;
      case 9:
        vars[bc[pc++]] = stack.pop();
        break;
      case 10:
        return out;
      case 11:
        return stack.pop();
      case 12:
        break;
      default:
        throw new Error('bad opcode ' + op);
    }
  }
}
`;

// Straight-line arithmetic with print: 6 * 7 = 42.
const BYTECODE_STRAIGHT = [0, 6, 0, 7, 2, 5, 10];

// Conditional: 3 < 4 is true, so the jump to PUSH 20 is taken.
const BYTECODE_COND = [0, 3, 0, 4, 3, 7, 11, 0, 10, 6, 13, 0, 20, 11];

// Loop: r0 = 3, r1 = 0; while (r0) { r1 += r0; r0 -= 1; } return r1 (= 6).
const BYTECODE_LOOP = [
  0, 3, 9, 0, 0, 0, 9, 1, 8, 0, 7, 15, 8, 1, 11, 8, 1, 8, 0, 1, 9, 1, 8, 0, 0,
  1, 4, 9, 0, 6, 8,
];

// Irreducible: entry jumps to both A (offset 8) and B (offset 17) of the
// A <-> B cycle, so no single loop header exists. Still terminates with
// r0 = 0 and returns 100.
const BYTECODE_TANGLED = [
  0, 2, 9, 0, 0, 1, 7, 17, 8, 0, 0, 1, 4, 9, 0, 6, 17, 8, 0, 7, 8, 8, 0, 0, 100,
  1, 11,
];

// Straight-line with an unknown no-op handler in the middle.
const BYTECODE_UNKNOWN = [0, 6, 12, 0, 7, 2, 5, 10];

function lift(bytecode: number[]): { code: string; warnings: string[] } {
  const found = detectInterpreters(parseJS(VM_SRC));
  expect(found).toHaveLength(1);
  const labels = labelHandlers(found[0]);
  const disasm = disassemble(found[0], labels, bytecode);
  return liftDirect(disasm, labels);
}

// The lifted code is a function body (top-level `return`), so it can only
// run through the Function constructor in these tests.
const runInFunction = (code: string): unknown =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(code) as () => unknown)();

function runOriginal(bytecode: number[]): unknown {
  return runInFunction(`${VM_SRC}; return run(${JSON.stringify(bytecode)});`);
}

function runLifted(code: string): unknown {
  return runInFunction(code);
}

describe('liftDisassembly', () => {
  test('labels the fixture VM as expected', () => {
    const found = detectInterpreters(parseJS(VM_SRC));
    expect(found).toHaveLength(1);
    const labels = labelHandlers(found[0]);
    expect(labels.map((l) => l.kind)).toEqual([
      'push-const',
      'binop',
      'binop',
      'binop',
      'binop',
      'pop',
      'jump',
      'cond-jump',
      'get-property',
      'set-property',
      'return',
      'return',
      'unknown',
      'unknown',
    ]);
    expect(labels.slice(1, 5).map((l) => l.operator)).toEqual([
      '+',
      '*',
      '<',
      '-',
    ]);
    expect(labels[7].jumpWhenTrue).toBe(true);
  });

  test('straight-line arithmetic with print runs identically', () => {
    const { code, warnings } = lift(BYTECODE_STRAIGHT);
    expect(warnings).toEqual([]);
    expect(runLifted(code)).toEqual(runOriginal(BYTECODE_STRAIGHT));
    expect(runLifted(code)).toEqual([42]);
  });

  test('conditional lifts to if/else and runs identically', () => {
    const { code, warnings } = lift(BYTECODE_COND);
    expect(warnings).toEqual([]);
    expect(code).toContain('if (');
    expect(code).not.toContain('switch');
    expect(runLifted(code)).toEqual(runOriginal(BYTECODE_COND));
    expect(runLifted(code)).toBe(20);
  });

  test('loop lifts to while and runs identically', () => {
    const { code, warnings } = lift(BYTECODE_LOOP);
    expect(warnings).toEqual([]);
    expect(code).toContain('while (true)');
    expect(code).toContain('break;');
    expect(code).not.toContain('switch');
    expect(runLifted(code)).toEqual(runOriginal(BYTECODE_LOOP));
    expect(runLifted(code)).toBe(6);
  });

  test('irreducible flow falls back to switch(pc) and runs identically', () => {
    const { code, warnings } = lift(BYTECODE_TANGLED);
    expect(warnings).toEqual([]);
    expect(code).toContain('switch (pc)');
    expect(runLifted(code)).toEqual(runOriginal(BYTECODE_TANGLED));
    expect(runLifted(code)).toBe(100);
  });

  test('unknown handler becomes a comment plus a warning', () => {
    const { code, warnings } = lift(BYTECODE_UNKNOWN);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unknown handler.*offset 2/);
    expect(code).toContain('unknown handler');
    expect(runLifted(code)).toEqual(runOriginal(BYTECODE_UNKNOWN));
    expect(runLifted(code)).toEqual([42]);
  });

  test('empty disassembly returns output', () => {
    const { code, warnings } = liftDirect({ instructions: [], text: '' }, []);
    expect(warnings).toEqual([]);
    expect(runLifted(code)).toEqual([]);
  });

  test('is importable from the package entry', () => {
    const found = detectInterpreters(parseJS(VM_SRC));
    expect(found).toHaveLength(1);
    const labels = labelHandlers(found[0]);
    const disasm = disassemble(found[0], labels, BYTECODE_STRAIGHT);
    // `liftDisassembly` is the entry-point import (../../index.js);
    // `liftDirect` is the module import. Both must agree on the same input.
    const fromEntry = liftDisassembly(disasm, labels);
    const fromModule = liftDirect(disasm, labels);
    expect(fromEntry.code).toBe(fromModule.code);
    expect(runLifted(fromEntry.code)).toEqual([42]);
    // The disassembler entry-point exports work on the same input.
    const redisasm = disassembleFromEntry(found[0], labels, BYTECODE_STRAIGHT);
    expect(redisasm.instructions).toEqual(disasm.instructions);
    expect(formatDisassemblyFromEntry(redisasm.instructions)).toBe(
      redisasm.text,
    );
  });
});
