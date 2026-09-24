import * as t from '@babel/types';
import type { InterpreterInfo } from './detect.js';
import type { HandlerLabel } from './handlers.js';

export interface DisassembledInstruction {
  /** Byte offset of the opcode within the bytecode. */
  offset: number;
  /** Opcode value (`null` never occurs from real bytecode; kept for JSON). */
  opcode: number | string | null;
  /** Handler kind (e.g. `'push-const'`), or `'db'` for unknown opcodes. */
  mnemonic: string;
  /** Raw operand bytes following the opcode. */
  operands: number[];
  /** True for unknown opcodes and `unknown`-kind handlers. */
  unknown: boolean;
  /** Jump target offset, for `jump`/`cond-jump` with at least one operand. */
  target?: number;
}

export interface Disassembly {
  instructions: DisassembledInstruction[];
  text: string;
}

/** Bytecode passed explicitly instead of resolving it from the AST. */
export type BytecodeInput = number[] | Uint8Array | string;

const TYPED_ARRAYS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
]);

/**
 * Linear disassembly of a detected VM interpreter's bytecode.
 *
 * The bytecode is either passed explicitly or resolved from
 * `info.bytecode` (a literal array/string/typed-array initializer). Each
 * byte is decoded as an opcode looked up in `labels` (by `value`); the
 * following `label.operands` bytes become its operands. Handlers labeled
 * `unknown` consume no operands and are flagged, and opcodes without a
 * handler are emitted raw as `db 0x..`.
 *
 * Jump (`jump`/`cond-jump`) operands render as `L_0000` labels.
 */
export function disassemble(
  info: InterpreterInfo,
  labels: HandlerLabel[],
  bytecode?: BytecodeInput,
): Disassembly {
  const bytes =
    bytecode !== undefined ? fromInput(bytecode) : fromBinding(info);
  const byValue = new Map<string | number, HandlerLabel>();
  for (const label of labels) {
    if (label.value !== null && !byValue.has(label.value)) {
      byValue.set(label.value, label);
    }
  }

  const instructions: DisassembledInstruction[] = [];
  let pc = 0;
  while (pc < bytes.length) {
    const offset = pc;
    const opcode = bytes[pc++];
    const label = byValue.get(opcode);
    if (label === undefined) {
      instructions.push({
        offset,
        opcode,
        mnemonic: 'db',
        operands: [],
        unknown: true,
      });
      continue;
    }
    if (label.kind === 'unknown') {
      instructions.push({
        offset,
        opcode,
        mnemonic: label.kind,
        operands: [],
        unknown: true,
      });
      continue;
    }
    const operands = bytes.slice(pc, pc + label.operands);
    pc += operands.length;
    const instruction: DisassembledInstruction = {
      offset,
      opcode,
      mnemonic: label.kind,
      operands,
      unknown: false,
    };
    if (
      (label.kind === 'jump' || label.kind === 'cond-jump') &&
      operands.length > 0
    ) {
      instruction.target = operands[0];
    }
    instructions.push(instruction);
  }

  return { instructions, text: formatDisassembly(instructions) };
}

/** Render instructions as a text listing with `L_0000` jump labels. */
export function formatDisassembly(
  instructions: DisassembledInstruction[],
): string {
  const targets = new Set<number>();
  for (const instruction of instructions) {
    if (instruction.target !== undefined) targets.add(instruction.target);
  }
  const lines: string[] = [];
  for (const instruction of instructions) {
    if (targets.has(instruction.offset)) {
      lines.push(`${labelName(instruction.offset)}:`);
    }
    lines.push(
      `${padOffset(instruction.offset)}: ${formatInstruction(instruction)}`,
    );
  }
  return lines.join('\n');
}

function formatInstruction(instruction: DisassembledInstruction): string {
  if (instruction.mnemonic === 'db') {
    const value =
      typeof instruction.opcode === 'number'
        ? `0x${instruction.opcode.toString(16)}`
        : String(instruction.opcode);
    return `db ${value}`;
  }
  if (
    (instruction.mnemonic === 'jump' || instruction.mnemonic === 'cond-jump') &&
    instruction.target !== undefined
  ) {
    return `${instruction.mnemonic} ${labelName(instruction.target)}`;
  }
  const parts = [instruction.mnemonic];
  if (instruction.operands.length > 0) {
    parts.push(instruction.operands.join(' '));
  }
  return parts.join(' ');
}

function labelName(offset: number): string {
  return `L_${String(offset).padStart(4, '0')}`;
}

function padOffset(offset: number): string {
  return String(offset).padStart(4, '0');
}

function fromInput(bytecode: BytecodeInput): number[] {
  if (typeof bytecode === 'string') return stringBytes(bytecode);
  return [...bytecode];
}

function stringBytes(value: string): number[] {
  const out: number[] = [];
  for (const char of value) out.push(char.codePointAt(0) ?? 0);
  return out;
}

function fromBinding(info: InterpreterInfo): number[] {
  const name = info.bytecode?.identifier.name;
  const init = bindingInit(info);
  const bytes = init === undefined ? undefined : literalBytes(init);
  if (bytes === undefined) {
    throw new Error(
      name === undefined
        ? 'disassemble: cannot resolve bytecode (no bytecode binding); pass bytecode explicitly'
        : `disassemble: cannot resolve bytecode for "${name}" (expected a literal array/string/typed-array initializer); pass bytecode explicitly`,
    );
  }
  return bytes;
}

function bindingInit(info: InterpreterInfo): t.Node | undefined {
  const { path } = info.bytecode ?? {};
  if (path?.isVariableDeclarator()) {
    return path.node.init ?? undefined;
  }
  return undefined;
}

/** Literal `[...]`, `"..."`, `` `...` ``, `new Uint8Array([...])`, `X.from([...])`. */
function literalBytes(init: t.Node): number[] | undefined {
  if (t.isArrayExpression(init)) return arrayBytes(init.elements);
  if (t.isStringLiteral(init)) return stringBytes(init.value);
  if (
    t.isTemplateLiteral(init) &&
    init.expressions.length === 0 &&
    init.quasis.length === 1 &&
    init.quasis[0] !== undefined
  ) {
    return stringBytes(init.quasis[0].value.cooked ?? '');
  }
  if (
    t.isNewExpression(init) &&
    t.isIdentifier(init.callee) &&
    TYPED_ARRAYS.has(init.callee.name) &&
    init.arguments.length === 1
  ) {
    const [first] = init.arguments;
    if (first !== undefined && t.isArrayExpression(first)) {
      return arrayBytes(first.elements);
    }
  }
  if (
    t.isCallExpression(init) &&
    t.isMemberExpression(init.callee, { computed: false }) &&
    t.isIdentifier(init.callee.property, { name: 'from' }) &&
    init.arguments.length >= 1
  ) {
    const [first] = init.arguments;
    if (first !== undefined && t.isArrayExpression(first)) {
      return arrayBytes(first.elements);
    }
  }
  return undefined;
}

function arrayBytes(
  elements: (t.ArrayExpression['elements'][number] | null)[],
): number[] | undefined {
  const out: number[] = [];
  for (const element of elements) {
    if (t.isNumericLiteral(element)) {
      out.push(element.value);
    } else if (
      t.isUnaryExpression(element, { operator: '-' }) &&
      t.isNumericLiteral(element.argument)
    ) {
      out.push(-element.argument.value);
    } else if (
      t.isUnaryExpression(element, { operator: '+' }) &&
      t.isNumericLiteral(element.argument)
    ) {
      out.push(element.argument.value);
    } else {
      return undefined;
    }
  }
  return out;
}
