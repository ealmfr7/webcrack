import { parse } from '@babel/parser';
import type { File } from '@babel/types';
import { describe, expect, test } from 'vitest';
import { detectInterpreters } from '../detect.js';
import { disassemble } from '../disasm.js';
import { labelHandlers } from '../handlers.js';

function parseJS(code: string): File {
  return parse(code, { sourceType: 'unambiguous' });
}

// Detectable switch VM with a resolvable array bytecode binding, an
// unconditional jump, and an unknown opcode (99) in the bytecode.
const PROG_JUMP = `
function run() {
  const bc = [0, 10, 99, 1, 3, 0, 2, 4];
  const stack = [];
  let pc = 0;
  const out = [];
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
      case 2:
        out.push(stack.pop());
        break;
      case 3:
        pc = bc[pc];
        break;
      case 4:
        return out;
      default:
        throw new Error('bad opcode ' + op);
    }
  }
}
`;

// Detectable switch VM with a resolvable typed-array bytecode binding and a
// conditional jump whose target is an unknown opcode.
const PROG_CJUMP = `
function run() {
  const bc = new Uint8Array([0, 1, 4, 5, 2, 3]);
  const stack = [];
  let pc = 0;
  while (true) {
    const op = bc[pc++];
    switch (op) {
      case 0:
        stack.push(bc[pc++]);
        break;
      case 1:
        stack.push(stack.pop() + stack.pop());
        break;
      case 2:
        return stack.pop();
      case 4:
        if (stack.pop()) pc = bc[pc++];
        else pc++;
        break;
      default:
        throw new Error('bad opcode ' + op);
    }
  }
}
`;

// Bytecode is a parameter, so it cannot be resolved from the AST.
const PROG_PARAM = `
function run(bc) {
  const stack = [];
  let pc = 0;
  while (true) {
    const op = bc[pc++];
    switch (op) {
      case 0:
        stack.push(bc[pc++]);
        break;
      case 1:
        return stack.pop();
      default:
        throw new Error('bad opcode ' + op);
    }
  }
}
`;

describe('disassemble', () => {
  test('disassembles operands and jump labels', () => {
    const found = detectInterpreters(parseJS(PROG_JUMP));
    expect(found).toHaveLength(1);
    const result = disassemble(found[0], labelHandlers(found[0]));

    expect(result.instructions).toEqual([
      {
        offset: 0,
        opcode: 0,
        mnemonic: 'push-const',
        operands: [10],
        unknown: false,
      },
      { offset: 2, opcode: 99, mnemonic: 'db', operands: [], unknown: true },
      { offset: 3, opcode: 1, mnemonic: 'binop', operands: [], unknown: false },
      {
        offset: 4,
        opcode: 3,
        mnemonic: 'jump',
        operands: [0],
        unknown: false,
        target: 0,
      },
      { offset: 6, opcode: 2, mnemonic: 'pop', operands: [], unknown: false },
      {
        offset: 7,
        opcode: 4,
        mnemonic: 'return',
        operands: [],
        unknown: false,
      },
    ]);
    expect(result.text).toMatchSnapshot();
    // Instructions are plain JSON data.
    expect(JSON.parse(JSON.stringify(result.instructions))).toEqual(
      result.instructions,
    );
  });

  test('disassembles a typed-array bytecode with a conditional jump', () => {
    const found = detectInterpreters(parseJS(PROG_CJUMP));
    expect(found).toHaveLength(1);
    const result = disassemble(found[0], labelHandlers(found[0]));

    expect(result.instructions).toEqual([
      {
        offset: 0,
        opcode: 0,
        mnemonic: 'push-const',
        operands: [1],
        unknown: false,
      },
      {
        offset: 2,
        opcode: 4,
        mnemonic: 'cond-jump',
        operands: [5],
        unknown: false,
        target: 5,
      },
      {
        offset: 4,
        opcode: 2,
        mnemonic: 'return',
        operands: [],
        unknown: false,
      },
      { offset: 5, opcode: 3, mnemonic: 'db', operands: [], unknown: true },
    ]);
    expect(result.text).toContain('cond-jump L_0005');
    expect(result.text).toContain('L_0005:');
    expect(result.text).toContain('db 0x3');
    expect(result.text).toMatchSnapshot();
  });

  test('accepts the bytecode explicitly', () => {
    const found = detectInterpreters(parseJS(PROG_PARAM));
    expect(found).toHaveLength(1);
    const result = disassemble(found[0], labelHandlers(found[0]), [0, 7, 1]);
    expect(result.instructions).toEqual([
      {
        offset: 0,
        opcode: 0,
        mnemonic: 'push-const',
        operands: [7],
        unknown: false,
      },
      {
        offset: 2,
        opcode: 1,
        mnemonic: 'return',
        operands: [],
        unknown: false,
      },
    ]);
  });

  test('throws a clear error when the bytecode cannot be resolved', () => {
    const found = detectInterpreters(parseJS(PROG_PARAM));
    expect(found).toHaveLength(1);
    expect(() => disassemble(found[0], labelHandlers(found[0]))).toThrow(
      /cannot resolve bytecode.*bc/,
    );
  });
});
