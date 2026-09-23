import { parse } from '@babel/parser';
import type { File } from '@babel/types';
import { describe, expect, test } from 'vitest';
import { detectInterpreters } from '../detect.js';
import { labelHandlers, type HandlerLabel } from '../handlers.js';

function parseJS(code: string): File {
  return parse(code, { sourceType: 'unambiguous' });
}

// Mirrors STACK_VM in ./detect.test.ts (duplicated instead of imported so
// this file does not re-register that file's tests on import).
const STACK_VM = `
function run(bc) {
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

// Mirrors STACK_VM_MIN in ./detect.test.ts (see comment above).
const STACK_VM_MIN = `function r(b){var s=[],p=0,o=[];for(;;){var k=b[p++];switch(k){case 0:s.push(b[p++]);break;case 1:s.push(s.pop()+s.pop());break;case 2:o.push(s.pop());break;case 3:p=b[p];break;case 4:return o;}}}`;

// Register-style handlers: slots in `regs` plus stack/variable effects so
// every non-stack kind has a representative.
const REG_VM = `
function run(bc, mode) {
  const stack = [];
  const regs = [0, 0];
  const g = {};
  let tmp = 0;
  let pc = 0;
  while (true) {
    const op = bc[pc++];
    switch (op) {
      case 0:
        stack.push(bc[pc++]);
        break;
      case 1:
        tmp = stack.pop();
        break;
      case 2:
        stack.push(mode);
        break;
      case 3: {
        const fn = stack.pop();
        stack.push(fn(stack.pop()));
        break;
      }
      case 4:
        if (stack.pop()) pc = bc[pc++];
        else pc++;
        break;
      case 5:
        if (stack.pop()) pc++;
        else pc = bc[pc++];
        break;
      case 6:
        stack.push(stack[stack.length - 1]);
        break;
      case 7:
        stack.push(-stack.pop());
        break;
      case 8:
        stack.push(g.obj);
        break;
      case 9:
        g.obj = stack.pop();
        break;
      case 10:
        regs[0] = bc[pc++];
        break;
      case 11:
        return stack.pop();
      default:
        throw new Error('bad opcode ' + op);
    }
  }
}
`;

function labelsFor(code: string): HandlerLabel[] {
  const found = detectInterpreters(parseJS(code));
  expect(found).toHaveLength(1);
  return labelHandlers(found[0]);
}

describe('labelHandlers', () => {
  test('labels the hand-written stack VM', () => {
    const labels = labelsFor(STACK_VM);
    expect(labels.map((l) => l.kind)).toEqual([
      'push-const',
      'binop',
      'pop',
      'jump',
      'return',
      'unknown',
    ]);
    expect(labels.map((l) => l.value)).toEqual([0, 1, 2, 3, 4, null]);

    const [pushConst, binop, pop, jump, ret, unknown] = labels;
    expect(pushConst.operands).toBe(1);
    expect(pushConst.viaPc).toBe(true);
    expect(binop.operator).toBe('+');
    expect(binop.operands).toBe(0);
    expect(binop.viaPc).toBe(false);
    expect(pop.operands).toBe(0);
    expect(jump.operands).toBe(1);
    expect(jump.viaPc).toBe(true);
    expect(ret.operands).toBe(0);
    expect(unknown.confidence).toBe(0);
    for (const label of labels.slice(0, -1)) {
      expect(label.confidence).toBeGreaterThan(0);
    }
  });

  test('minified variant gets the same labels', () => {
    const plain = labelsFor(STACK_VM);
    const minified = labelsFor(STACK_VM_MIN);
    expect(minified.map((l) => l.kind)).toEqual(
      plain.slice(0, -1).map((l) => l.kind),
    );
    expect(minified.map((l) => l.operands)).toEqual(
      plain.slice(0, -1).map((l) => l.operands),
    );
    expect(minified.map((l) => l.viaPc)).toEqual(
      plain.slice(0, -1).map((l) => l.viaPc),
    );
    expect(minified[1].operator).toBe('+');
  });

  test('labels register-style handlers', () => {
    const labels = labelsFor(REG_VM);
    expect(labels.map((l) => l.kind)).toEqual([
      'push-const',
      'store',
      'push-var',
      'call',
      'cond-jump',
      'cond-jump',
      'dup',
      'unop',
      'get-property',
      'set-property',
      'store',
      'return',
      'unknown',
    ]);

    const call = labels[3];
    expect(call.argc).toBe(1);

    const jumpIfTrue = labels[4];
    expect(jumpIfTrue.jumpWhenTrue).toBe(true);
    expect(jumpIfTrue.operands).toBe(1);
    expect(jumpIfTrue.viaPc).toBe(true);

    const jumpIfFalse = labels[5];
    expect(jumpIfFalse.jumpWhenTrue).toBe(false);
    expect(jumpIfFalse.operands).toBe(1);

    expect(labels[6].operands).toBe(0);
    expect(labels[7].operator).toBe('-');
    expect(labels[10].operands).toBe(1);
    expect(labels[10].viaPc).toBe(true);
    expect(labels.at(-1)?.confidence).toBe(0);
  });

  test('labels if-chain dispatch bodies', () => {
    const labels = labelsFor(`
function run(bc) {
  const stack = [];
  let pc = 0;
  while (true) {
    const op = bc[pc++];
    if (op === 0) {
      stack.push(bc[pc++]);
    } else if (op === 1) {
      stack.push(stack.pop() + stack.pop());
    } else if (op === 2) {
      return stack.pop();
    } else {
      throw new Error('bad opcode');
    }
  }
}
`);
    expect(labels.map((l) => l.kind)).toEqual([
      'push-const',
      'binop',
      'return',
      'unknown',
    ]);
    expect(labels.map((l) => l.value)).toEqual([0, 1, 2, null]);
  });

  test('labels handler-table functions', () => {
    const labels = labelsFor(`
function run(bc) {
  const stack = [];
  let pc = 0;
  const handlers = [
    () => stack.push(bc[pc++]),
    () => stack.push(stack.pop() + stack.pop()),
    () => stack.pop(),
  ];
  while (true) {
    const op = bc[pc++];
    handlers[op]();
  }
}
`);
    expect(labels.map((l) => l.kind)).toEqual([
      'push-const',
      'binop',
      'pop',
    ]);
  });

  test('confidences stay in range', () => {
    for (const code of [STACK_VM, STACK_VM_MIN, REG_VM]) {
      for (const label of labelsFor(code)) {
        expect(label.confidence).toBeGreaterThanOrEqual(0);
        expect(label.confidence).toBeLessThanOrEqual(1);
        if (label.kind === 'unknown') {
          expect(label.confidence).toBe(0);
        }
      }
    }
  });
});
