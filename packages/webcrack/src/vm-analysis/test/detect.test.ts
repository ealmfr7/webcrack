import { parse } from '@babel/parser';
import type { File } from '@babel/types';
import { describe, expect, test } from 'vitest';
import { detectInterpreters } from '../detect.js';

function parseJS(code: string): File {
  return parse(code, { sourceType: 'unambiguous' });
}

// Hand-written tiny stack VM: push/add/print/jmp/halt, `bc[pc++]` reads.
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

// Same VM, minified: single-letter names, for(;;), numeric switch.
const STACK_VM_MIN = `function r(b){var s=[],p=0,o=[];for(;;){var k=b[p++];switch(k){case 0:s.push(b[p++]);break;case 1:s.push(s.pop()+s.pop());break;case 2:o.push(s.pop());break;case 3:p=b[p];break;case 4:return o;}}}`;

// Same VM shape but with a two-step read (`bc[pc]` + `pc += 1`) and a
// pc-bounded loop.
const STACK_VM_BOUNDED = `
function run(bc) {
  const stack = [];
  let pc = 0;
  const out = [];
  while (pc < bc.length) {
    const op = bc[pc];
    pc += 1;
    switch (op) {
      case 0:
        stack.push(bc[pc]);
        pc += 1;
        break;
      case 1:
        stack.push(stack.pop() + stack.pop());
        break;
      case 2:
        out.push(stack.pop());
        break;
      default:
        return out;
    }
  }
  return out;
}
`;

// obfuscator.io control-flow switch: must NOT be detected.
const CF_SWITCH = `
function f(x) {
  var d = "0|2|1".split("|");
  var e = 0;
  while (true) {
    switch (d[e++]) {
      case "0":
        x.foo();
        break;
      case "1":
        x.bar();
        break;
      case "2":
        x.baz();
        break;
    }
    break;
  }
}
`;

// Plain switch-in-loop state machine without pc-indexed reads.
const STATE_MACHINE = `
function f(s) {
  let state = 'a';
  while (state !== 'done') {
    switch (state) {
      case 'a':
        s.one();
        state = 'b';
        break;
      case 'b':
        s.two();
        state = 'c';
        break;
      case 'c':
        s.three();
        state = 'done';
        break;
    }
  }
}
`;

// Regular code: switch outside any loop, plus an unrelated counting loop.
const REGULAR = `
function f(x) {
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    total += x[i];
  }
  switch (total % 3) {
    case 0:
      return 'zero';
    case 1:
      return 'one';
    default:
      return 'other';
  }
}
`;

describe('detectInterpreters', () => {
  test('detects hand-written stack VM', () => {
    const found = detectInterpreters(parseJS(STACK_VM));
    expect(found).toHaveLength(1);
    const [info] = found;
    expect(info.dispatchKind).toBe('switch');
    expect(info.loop.isWhileStatement()).toBe(true);
    expect(info.dispatch.isSwitchStatement()).toBe(true);
    expect(info.pc?.identifier.name).toBe('pc');
    expect(info.bytecode?.identifier.name).toBe('bc');
    expect(info.stack?.identifier.name).toBe('stack');
    expect(info.opcode.isIdentifier({ name: 'op' })).toBe(true);
    expect(info.handlers.map((h) => h.value)).toEqual([0, 1, 2, 3, 4, null]);
    for (const handler of info.handlers) {
      expect(handler.path.isSwitchCase()).toBe(true);
    }
  });

  test('detects minified stack VM', () => {
    const found = detectInterpreters(parseJS(STACK_VM_MIN));
    expect(found).toHaveLength(1);
    const [info] = found;
    expect(info.dispatchKind).toBe('switch');
    expect(info.pc?.identifier.name).toBe('p');
    expect(info.bytecode?.identifier.name).toBe('b');
    expect(info.stack?.identifier.name).toBe('s');
    expect(info.handlers.map((h) => h.value)).toEqual([0, 1, 2, 3, 4]);
  });

  test('detects pc-bounded loop with two-step pc increment', () => {
    const found = detectInterpreters(parseJS(STACK_VM_BOUNDED));
    expect(found).toHaveLength(1);
    const [info] = found;
    expect(info.dispatchKind).toBe('switch');
    expect(info.pc?.identifier.name).toBe('pc');
    expect(info.bytecode?.identifier.name).toBe('bc');
    expect(info.stack?.identifier.name).toBe('stack');
    expect(info.handlers.map((h) => h.value)).toEqual([0, 1, 2, null]);
  });

  test('detects if-chain dispatch', () => {
    const found = detectInterpreters(
      parseJS(`
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
`),
    );
    expect(found).toHaveLength(1);
    const [info] = found;
    expect(info.dispatchKind).toBe('if-chain');
    expect(info.pc?.identifier.name).toBe('pc');
    expect(info.bytecode?.identifier.name).toBe('bc');
    expect(info.handlers.map((h) => h.value)).toEqual([0, 1, 2, null]);
  });

  test('detects handler-table dispatch', () => {
    const found = detectInterpreters(
      parseJS(`
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
`),
    );
    expect(found).toHaveLength(1);
    const [info] = found;
    expect(info.dispatchKind).toBe('handler-table');
    expect(info.pc?.identifier.name).toBe('pc');
    expect(info.bytecode?.identifier.name).toBe('bc');
    expect(info.handlers.map((h) => h.value)).toEqual([0, 1, 2]);
  });

  test('ignores obfuscator.io control-flow switch', () => {
    expect(detectInterpreters(parseJS(CF_SWITCH))).toHaveLength(0);
  });

  test('ignores state machine switch without pc-indexed reads', () => {
    expect(detectInterpreters(parseJS(STATE_MACHINE))).toHaveLength(0);
  });

  test('ignores regular code', () => {
    expect(detectInterpreters(parseJS(REGULAR))).toHaveLength(0);
  });
});
