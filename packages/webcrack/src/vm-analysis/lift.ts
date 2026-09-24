import type { DisassembledInstruction, Disassembly } from './disasm.js';
import type { HandlerKind, HandlerLabel } from './handlers.js';

/** Output of {@link liftDisassembly}. */
export interface LiftResult {
  /**
   * Standalone JavaScript program text. It declares its own `stack`,
   * `output` (values produced by `pop` handlers) and — when register-style
   * handlers are used — a `vars` register file, so it runs as a function
   * body (top-level `return` allowed, e.g. via `new Function(code)()`).
   */
  code: string;
  /** One entry per unknown handler, dangling jump, or missing operand. */
  warnings: string[];
}

interface Resolved {
  node: DisassembledInstruction;
  kind: HandlerKind;
  operator?: string;
  argc?: number;
  jumpWhenTrue?: boolean;
}

interface Block {
  /** Byte offset of the first instruction. */
  start: number;
  instrs: Resolved[];
  /** Successor block starts. */
  succ: number[];
}

interface LiftCtx {
  warnings: string[];
  temps: number;
  usesVars: boolean;
}

interface Edge {
  from: number;
  to: number;
}

const KINDS: ReadonlySet<string> = new Set([
  'push-const',
  'push-var',
  'store',
  'pop',
  'dup',
  'binop',
  'unop',
  'jump',
  'cond-jump',
  'call',
  'return',
  'get-property',
  'set-property',
  'unknown',
]);

function isKind(value: string): value is HandlerKind {
  return KINDS.has(value);
}

/**
 * Translate a VM disassembly back into JavaScript (experimental).
 *
 * Instructions are split into basic blocks at jump targets, then each block
 * is symbolically executed over an abstract value stack: straight-line
 * `push`/`binop` chains fold into single expressions, while values that flow
 * across blocks stay on a runtime `stack` array, which keeps the output
 * correct even when the static stack depth is ambiguous.
 *
 * Reducible flow is structured: a single natural loop becomes `while (true)`
 * with `break`, acyclic branches become `if`/`else`. Anything else
 * (multi-entry loops, several loops, unresolvable joins) falls back to a
 * `while (true)` + `switch (pc)` dispatcher, which is always correct.
 *
 * Handler semantics come from `labels` matched by opcode value (as in
 * `disassemble`); when omitted, the instruction mnemonic is used instead.
 * Indexed property handlers (`vars[N]`, operand `N`) are treated as a
 * register file; `pop` handlers append to `output`; a `return` with values
 * on the stack returns the top value, otherwise it returns `output`.
 * Unknown (`db`/`unknown`) handlers are emitted as comments and reported in
 * `warnings` without affecting the stack.
 */
export function liftDisassembly(
  disasm: Disassembly,
  labels: HandlerLabel[] = [],
): LiftResult {
  const warnings: string[] = [];
  const byValue = new Map<string | number, HandlerLabel>();
  for (const label of labels) {
    if (label.value !== null && !byValue.has(label.value)) {
      byValue.set(label.value, label);
    }
  }
  const instrs = disasm.instructions.map((node) =>
    resolveInstr(node, byValue, warnings),
  );
  const blocks = buildBlocks(instrs, warnings);
  const ctx: LiftCtx = { warnings, temps: 0, usesVars: false };
  const entryDepths = computeEntryDepths(blocks);

  let body: string[];
  try {
    body = structure(blocks, ctx, entryDepths);
  } catch (error) {
    if (!(error instanceof Unstructured)) throw error;
    body = emitDispatcher(blocks, ctx, entryDepths);
  }

  const code = [
    '// Lifted from VM disassembly (experimental).',
    'const stack = [];',
    'const output = [];',
    ...(ctx.usesVars ? ['const vars = [];'] : []),
    ...body,
  ].join('\n');
  return { code, warnings };
}

function resolveInstr(
  node: DisassembledInstruction,
  byValue: Map<string | number, HandlerLabel>,
  warnings: string[],
): Resolved {
  const label =
    typeof node.opcode === 'number' || typeof node.opcode === 'string'
      ? byValue.get(node.opcode)
      : undefined;
  if (label !== undefined && label.kind !== 'unknown' && !node.unknown) {
    return {
      node,
      kind: label.kind,
      operator: label.operator,
      argc: label.argc,
      jumpWhenTrue: label.jumpWhenTrue,
    };
  }
  if (node.unknown || label?.kind === 'unknown') {
    warnings.push(
      `unknown handler for opcode ${formatOpcode(node.opcode)} at offset ${node.offset}`,
    );
    return { node, kind: 'unknown' };
  }
  if (isKind(node.mnemonic)) {
    return { node, kind: node.mnemonic };
  }
  warnings.push(
    `unknown handler for opcode ${formatOpcode(node.opcode)} at offset ${node.offset}`,
  );
  return { node, kind: 'unknown' };
}

function formatOpcode(opcode: number | string | null): string {
  if (typeof opcode === 'number') return `0x${opcode.toString(16)}`;
  return String(opcode);
}

function isControl(kind: HandlerKind): boolean {
  return kind === 'jump' || kind === 'cond-jump' || kind === 'return';
}

function buildBlocks(instrs: Resolved[], warnings: string[]): Block[] {
  if (instrs.length === 0) return [];
  const byOffset = new Map<number, number>();
  instrs.forEach((instr, index) => byOffset.set(instr.node.offset, index));

  const leaders = new Set<number>([0]);
  instrs.forEach((instr, index) => {
    if (instr.node.target !== undefined) {
      const targetIndex = byOffset.get(instr.node.target);
      if (targetIndex !== undefined) leaders.add(targetIndex);
    }
    if (isControl(instr.kind) && index + 1 < instrs.length) {
      leaders.add(index + 1);
    }
  });

  const blocks: Block[] = [];
  const blockOf = new Map<number, Block>();
  let current: Block | undefined;
  instrs.forEach((instr, index) => {
    if (leaders.has(index) || current === undefined) {
      current = { start: instr.node.offset, instrs: [], succ: [] };
      blocks.push(current);
      blockOf.set(current.start, current);
    }
    current.instrs.push(instr);
  });

  blocks.forEach((block, blockIndex) => {
    const last = block.instrs.at(-1);
    if (last === undefined) return;
    const next =
      blockIndex + 1 < blocks.length ? blocks[blockIndex + 1].start : undefined;
    if (last.kind === 'jump' || last.kind === 'cond-jump') {
      const target = last.node.target;
      if (target !== undefined && blockOf.has(target)) {
        block.succ =
          next === undefined || last.kind === 'jump'
            ? [target]
            : [target, next];
      } else {
        if (target !== undefined) {
          warnings.push(
            `dangling jump target ${target} at offset ${last.node.offset}`,
          );
        }
        block.succ =
          last.kind === 'cond-jump' && next !== undefined ? [next] : [];
      }
    } else if (last.kind === 'return') {
      block.succ = [];
    } else if (next !== undefined) {
      block.succ = [next];
    } else {
      block.succ = [];
    }
  });
  return blocks;
}

/** Net stack effect of one instruction (pops count negative). */
function stackEffect(instr: Resolved): number {
  switch (instr.kind) {
    case 'push-const':
    case 'push-var':
    case 'get-property':
    case 'dup':
      return 1;
    case 'binop':
      return -1;
    case 'unop':
      return 0;
    case 'pop':
    case 'store':
    case 'set-property':
    case 'cond-jump':
    case 'return':
      return -1;
    case 'call':
      return -(instr.argc ?? 0);
    default:
      return 0;
  }
}

/**
 * Abstract stack depth at each reachable block entry. Joins with disagreeing
 * depths yield `undefined`, in which case `return` falls back to a runtime
 * check.
 */
function computeEntryDepths(blocks: Block[]): Map<number, number | undefined> {
  const depths = new Map<number, number | undefined>();
  if (blocks.length === 0) return depths;
  const byStart = new Map(blocks.map((block) => [block.start, block]));
  const entry = blocks[0].start;
  depths.set(entry, 0);
  const queue: number[] = [entry];
  let budget = blocks.length * blocks.length + 1;
  while (queue.length > 0 && budget-- > 0) {
    const start = queue.shift() as number;
    const depth = depths.get(start);
    const block = byStart.get(start);
    if (block === undefined) continue;
    let current = depth;
    for (const instr of block.instrs) {
      if (current === undefined) break;
      current = Math.max(0, current + stackEffect(instr));
    }
    for (const succ of block.succ) {
      if (!byStart.has(succ)) continue;
      if (!depths.has(succ)) {
        depths.set(succ, current);
        queue.push(succ);
      } else if (depths.get(succ) !== current) {
        // A second visit only enqueues when it changes the outcome.
        if (depths.get(succ) !== undefined) {
          depths.set(succ, undefined);
          queue.push(succ);
        }
      }
    }
  }
  return depths;
}

class Unstructured extends Error {}

/** Structured (`if`/`while`) emission, or throw {@link Unstructured}. */
function structure(
  blocks: Block[],
  ctx: LiftCtx,
  entryDepths: Map<number, number | undefined>,
): string[] {
  if (blocks.length === 0) return ['return output;'];
  const byStart = new Map(blocks.map((block) => [block.start, block]));
  const entry = blocks[0].start;
  const reachable = visitReachable(byStart, entry);
  const backEdges = findBackEdges(byStart, reachable, entry);

  if (backEdges.length === 0) {
    const postdom = computePostdom(byStart, reachable);
    const emitted = new Set<number>();
    const out: string[] = [];
    emitFrom(
      entry,
      new Set(),
      undefined,
      byStart,
      postdom,
      ctx,
      entryDepths,
      emitted,
      out,
      0,
    );
    return out;
  }

  // A single natural loop only; anything else uses the dispatcher.
  const headers = new Set(backEdges.map((edge) => edge.to));
  if (headers.size !== 1) throw new Unstructured();
  const header = [...headers][0];
  const loop = naturalLoop(byStart, header, backEdges);
  for (const start of reachable) {
    if (loop.has(start)) continue;
    for (const succ of byStart.get(start)?.succ ?? []) {
      if (loop.has(succ) && succ !== header) throw new Unstructured();
    }
  }

  const postdom = computePostdom(byStart, reachable);
  const emitted = new Set<number>();
  const out: string[] = [];
  // Prefix: everything before the loop, stopping at the header.
  emitFrom(
    entry,
    new Set([header]),
    complementOf(loop, reachable),
    byStart,
    postdom,
    ctx,
    entryDepths,
    emitted,
    out,
    0,
  );

  const headerBlock = byStart.get(header);
  if (headerBlock === undefined) throw new Unstructured();
  const last = headerBlock.instrs.at(-1);
  if (last?.kind !== 'cond-jump' || headerBlock.succ.length !== 2) {
    throw new Unstructured();
  }
  const taken = headerBlock.succ[0];
  const fallthrough = headerBlock.succ[1];
  const takenInLoop = loop.has(taken);
  const fallthroughInLoop = loop.has(fallthrough);
  // Canonical header only: one successor drives the body, the other exits.
  if (takenInLoop === fallthroughInLoop) throw new Unstructured();
  const bodyStart = takenInLoop ? taken : fallthrough;
  const exitStart = takenInLoop ? fallthrough : taken;
  out.push('while (true) {');
  const sym: string[] = [];
  for (const instr of headerBlock.instrs.slice(0, -1)) {
    emitStackInstr(instr, sym, ctx, out, 1);
  }
  const cond = sym.length > 0 ? (sym.pop() as string) : 'stack.pop()';
  flushStack(sym, out, 1);
  const exitTaken = exitStart === taken;
  out.push(`  if (${exitTaken ? cond : `!(${cond})`}) break;`);
  emitFrom(
    bodyStart,
    new Set([header]),
    loop,
    byStart,
    postdom,
    ctx,
    entryDepths,
    emitted,
    out,
    1,
  );
  out.push('}');
  emitted.add(header);
  emitFrom(
    exitStart,
    new Set(),
    undefined,
    byStart,
    postdom,
    ctx,
    entryDepths,
    emitted,
    out,
    0,
  );
  return out;
}

function complementOf(loop: Set<number>, reachable: Set<number>): Set<number> {
  return new Set([...reachable].filter((start) => !loop.has(start)));
}

function visitReachable(
  byStart: Map<number, Block>,
  entry: number,
): Set<number> {
  const seen = new Set<number>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const block = byStart.get(queue.shift() as number);
    for (const succ of block?.succ ?? []) {
      if (!seen.has(succ) && byStart.has(succ)) {
        seen.add(succ);
        queue.push(succ);
      }
    }
  }
  return seen;
}

function findBackEdges(
  byStart: Map<number, Block>,
  reachable: Set<number>,
  entry: number,
): Edge[] {
  const edges: Edge[] = [];
  const state = new Map<number, 'open' | 'closed'>();
  const visit = (start: number): void => {
    state.set(start, 'open');
    for (const succ of byStart.get(start)?.succ ?? []) {
      if (!reachable.has(succ)) continue;
      if (state.get(succ) === 'open') edges.push({ from: start, to: succ });
      else if (!state.has(succ)) visit(succ);
    }
    state.set(start, 'closed');
  };
  visit(entry);
  return edges;
}

function naturalLoop(
  byStart: Map<number, Block>,
  header: number,
  backEdges: Edge[],
): Set<number> {
  const loop = new Set<number>([header]);
  const queue = backEdges
    .filter((edge) => edge.to === header)
    .map((edge) => edge.from);
  for (const start of queue) loop.add(start);
  while (queue.length > 0) {
    const start = queue.shift() as number;
    const preds = [...byStart.values()]
      .filter((block) => block.succ.includes(start))
      .map((block) => block.start);
    for (const pred of preds) {
      if (!loop.has(pred)) {
        loop.add(pred);
        queue.push(pred);
      }
    }
  }
  return loop;
}

/** Post-dominator sets over reachable blocks. */
function computePostdom(
  byStart: Map<number, Block>,
  reachable: Set<number>,
): Map<number, Set<number>> {
  const nodes = [...reachable];
  const postdom = new Map<number, Set<number>>();
  for (const node of nodes) postdom.set(node, new Set(nodes));
  const exits = nodes.filter(
    (node) => (byStart.get(node)?.succ.length ?? 0) === 0,
  );
  for (const exit of exits) postdom.set(exit, new Set([exit]));
  let changed = true;
  let budget = nodes.length * nodes.length + 1;
  while (changed && budget-- > 0) {
    changed = false;
    for (const node of nodes) {
      if (exits.includes(node)) continue;
      const succs = (byStart.get(node)?.succ ?? []).filter((succ) =>
        reachable.has(succ),
      );
      if (succs.length === 0) continue;
      let next = new Set(postdom.get(succs[0]));
      for (const succ of succs.slice(1)) {
        next = new Set(
          [...next].filter((candidate) => postdom.get(succ)?.has(candidate)),
        );
      }
      next.add(node);
      const prev = postdom.get(node) as Set<number>;
      if (
        prev.size !== next.size ||
        [...next].some((candidate) => !prev.has(candidate))
      ) {
        postdom.set(node, next);
        changed = true;
      }
    }
  }
  return postdom;
}

/** Nearest common post-dominator of both `cond-jump` successors. */
function joinOf(
  block: Block,
  postdom: Map<number, Set<number>>,
): number | undefined {
  const taken = block.succ[0];
  const fallthrough = block.succ[1];
  if (taken === undefined || fallthrough === undefined) return undefined;
  if (taken === fallthrough) return taken;
  const common = [...(postdom.get(taken) ?? [])].filter((candidate) =>
    postdom.get(fallthrough)?.has(candidate),
  );
  // The join is the common post-dominator post-dominated by all the others.
  for (const candidate of common) {
    if (
      common.every(
        (other) => other === candidate || postdom.get(other)?.has(candidate),
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

function emitFrom(
  start: number,
  stop: Set<number>,
  allowed: Set<number> | undefined,
  byStart: Map<number, Block>,
  postdom: Map<number, Set<number>>,
  ctx: LiftCtx,
  entryDepths: Map<number, number | undefined>,
  emitted: Set<number>,
  out: string[],
  indent: number,
): void {
  let current: number | undefined = start;
  while (current !== undefined && !stop.has(current)) {
    const block = byStart.get(current);
    if (block === undefined) throw new Unstructured();
    if (allowed !== undefined && !allowed.has(current)) {
      throw new Unstructured();
    }
    if (emitted.has(current)) throw new Unstructured();
    emitted.add(current);
    const sym: string[] = [];
    const last = block.instrs.at(-1);
    const body = isControl(last?.kind ?? 'unknown')
      ? block.instrs.slice(0, -1)
      : block.instrs;
    for (const instr of body) {
      emitStackInstr(instr, sym, ctx, out, indent);
    }
    if (last?.kind === 'jump') {
      flushStack(sym, out, indent);
      current = block.succ[0];
      continue;
    }
    if (last?.kind === 'cond-jump') {
      const taken = block.succ[0];
      const fallthrough = block.succ[1];
      if (taken === undefined || fallthrough === undefined) {
        throw new Unstructured();
      }
      const cond = sym.length > 0 ? (sym.pop() as string) : 'stack.pop()';
      flushStack(sym, out, indent);
      const join = joinOf(block, postdom);
      if (join === undefined || stop.has(join)) throw new Unstructured();
      const jumpWhenTrue = last.jumpWhenTrue ?? true;
      const thenStart = jumpWhenTrue ? taken : fallthrough;
      const elseStart = jumpWhenTrue ? fallthrough : taken;
      const pad = '  '.repeat(indent);
      const thenLines: string[] = [];
      const elseLines: string[] = [];
      const branchStop = new Set([...stop, join]);
      emitFrom(
        thenStart,
        branchStop,
        allowed,
        byStart,
        postdom,
        ctx,
        entryDepths,
        emitted,
        thenLines,
        indent + 1,
      );
      if (elseStart !== join) {
        emitFrom(
          elseStart,
          branchStop,
          allowed,
          byStart,
          postdom,
          ctx,
          entryDepths,
          emitted,
          elseLines,
          indent + 1,
        );
      }
      if (thenStart === join) {
        if (elseLines.length === 0) {
          current = join;
          continue;
        }
        out.push(`${pad}if (!(${cond})) {`);
        out.push(...elseLines);
        out.push(`${pad}}`);
      } else if (elseLines.length === 0) {
        out.push(`${pad}if (${cond}) {`);
        out.push(...thenLines);
        out.push(`${pad}}`);
      } else {
        out.push(`${pad}if (${cond}) {`);
        out.push(...thenLines);
        out.push(`${pad}} else {`);
        out.push(...elseLines);
        out.push(`${pad}}`);
      }
      current = join;
      continue;
    }
    if (last?.kind === 'return') {
      emitReturn(sym, entryDepths.get(current), out, indent);
      return;
    }
    flushStack(sym, out, indent);
    current = block.succ[0];
  }
}

/** Fallback: `while (true)` + `switch (pc)` dispatcher over all blocks. */
function emitDispatcher(
  blocks: Block[],
  ctx: LiftCtx,
  entryDepths: Map<number, number | undefined>,
): string[] {
  if (blocks.length === 0) return ['return output;'];
  const out: string[] = [];
  out.push('let pc = 0;');
  out.push('while (true) {');
  out.push('  switch (pc) {');
  for (const block of blocks) {
    out.push(`    case ${block.start}: {`);
    const sym: string[] = [];
    const last = block.instrs.at(-1);
    const body = isControl(last?.kind ?? 'unknown')
      ? block.instrs.slice(0, -1)
      : block.instrs;
    for (const instr of body) {
      emitStackInstr(instr, sym, ctx, out, 3);
    }
    if (last?.kind === 'jump') {
      flushStack(sym, out, 3);
      const target = block.succ[0];
      if (target === undefined) out.push('      return output;');
      else out.push(`      pc = ${target};`, '      break;');
    } else if (last?.kind === 'cond-jump') {
      const taken = block.succ[0];
      const fallthrough = block.succ[1];
      const cond = sym.length > 0 ? (sym.pop() as string) : 'stack.pop()';
      flushStack(sym, out, 3);
      const jumpWhenTrue = last.jumpWhenTrue ?? true;
      const thenTarget = jumpWhenTrue ? taken : fallthrough;
      const elseTarget = jumpWhenTrue ? fallthrough : taken;
      out.push(`      if (${cond}) {`);
      if (thenTarget === undefined) out.push('        return output;');
      else out.push(`        pc = ${thenTarget};`, '        break;');
      out.push('      } else {');
      if (elseTarget === undefined) out.push('        return output;');
      else out.push(`        pc = ${elseTarget};`, '        break;');
      out.push('      }');
    } else if (last?.kind === 'return') {
      emitReturn(sym, entryDepths.get(block.start), out, 3);
    } else {
      flushStack(sym, out, 3);
      const next = block.succ[0];
      if (next === undefined) out.push('      return output;');
      else out.push(`      pc = ${next};`, '      break;');
    }
    out.push('    }');
  }
  out.push('    default: return output;');
  out.push('  }');
  out.push('}');
  return out;
}

function flushStack(sym: string[], out: string[], indent: number): void {
  const pad = '  '.repeat(indent);
  for (const expr of sym.splice(0)) {
    out.push(`${pad}stack.push(${expr});`);
  }
}

function freshTemp(ctx: LiftCtx): string {
  return `_t${ctx.temps++}`;
}

function varsName(instr: Resolved, ctx: LiftCtx): string {
  ctx.usesVars = true;
  return `vars[${instr.node.operands[0] ?? 0}]`;
}

function emitReturn(
  sym: string[],
  entryDepth: number | undefined,
  out: string[],
  indent: number,
): void {
  const pad = '  '.repeat(indent);
  if (sym.length > 0) {
    const top = sym.pop() as string;
    sym.length = 0;
    out.push(`${pad}return (${top});`);
  } else if (entryDepth !== undefined && entryDepth > 0) {
    out.push(`${pad}return stack.pop();`);
  } else if (entryDepth === 0) {
    out.push(`${pad}return output;`);
  } else {
    out.push(`${pad}return (stack.length > 0 ? stack.pop() : output);`);
  }
}

/**
 * One non-control instruction. `sym` is the block-local abstract stack of
 * pure expression strings; anything that must survive the block is flushed
 * to the runtime `stack` first.
 */
function emitStackInstr(
  instr: Resolved,
  sym: string[],
  ctx: LiftCtx,
  out: string[],
  indent: number,
): void {
  const pad = '  '.repeat(indent);
  const { node } = instr;
  switch (instr.kind) {
    case 'push-const': {
      const [value] = node.operands;
      if (value === undefined) {
        ctx.warnings.push(`push-const at offset ${node.offset} has no operand`);
      }
      sym.push(JSON.stringify(value ?? 0));
      return;
    }
    case 'push-var':
    case 'get-property': {
      sym.push(varsName(instr, ctx));
      return;
    }
    case 'store':
    case 'set-property': {
      // Earlier reads of the same register would go stale, so spill first.
      if (sym.some((expr) => expr.includes('vars['))) {
        flushStack(sym, out, indent);
        out.push(`${pad}${varsName(instr, ctx)} = stack.pop();`);
      } else if (sym.length > 0) {
        out.push(`${pad}${varsName(instr, ctx)} = ${sym.pop() as string};`);
      } else {
        out.push(`${pad}${varsName(instr, ctx)} = stack.pop();`);
      }
      return;
    }
    case 'dup': {
      if (sym.length > 0) sym.push(sym.at(-1) as string);
      else out.push(`${pad}stack.push(stack[stack.length - 1]);`);
      return;
    }
    case 'pop': {
      const value = sym.length > 0 ? (sym.pop() as string) : 'stack.pop()';
      out.push(`${pad}output.push(${value});`);
      return;
    }
    case 'binop': {
      const operator = instr.operator ?? '+';
      if (instr.operator === undefined) {
        ctx.warnings.push(`binop at offset ${node.offset} has no operator`);
      }
      if (sym.length >= 2) {
        const right = sym.pop() as string;
        const left = sym.pop() as string;
        sym.push(`(${left} ${operator} ${right})`);
      } else {
        flushStack(sym, out, indent);
        const right = freshTemp(ctx);
        const left = freshTemp(ctx);
        out.push(
          `${pad}{ const ${right} = stack.pop(); const ${left} = stack.pop(); stack.push((${left} ${operator} ${right})); }`,
        );
      }
      return;
    }
    case 'unop': {
      const operator = instr.operator ?? '!';
      if (instr.operator === undefined) {
        ctx.warnings.push(`unop at offset ${node.offset} has no operator`);
      }
      const applied =
        operator === 'typeof' || operator === 'void' || operator === 'await'
          ? `${operator} `
          : operator;
      if (sym.length >= 1) {
        sym.push(`(${applied}${sym.pop() as string})`);
      } else {
        flushStack(sym, out, indent);
        out.push(`${pad}stack.push((${applied}stack.pop()));`);
      }
      return;
    }
    case 'call': {
      const argc = instr.argc ?? 0;
      flushStack(sym, out, indent);
      const args: string[] = [];
      const first = freshTemp(ctx);
      for (let index = 0; index < argc; index++) {
        const temp = index === 0 ? first : freshTemp(ctx);
        args.push(temp);
      }
      // Pops run last-argument-first so evaluation order matches the VM.
      for (const temp of [...args].reverse()) {
        out.push(`${pad}const ${temp} = stack.pop();`);
      }
      const callee = freshTemp(ctx);
      out.push(`${pad}const ${callee} = stack.pop();`);
      out.push(`${pad}stack.push(${callee}(${args.join(', ')}));`);
      return;
    }
    case 'unknown': {
      flushStack(sym, out, indent);
      out.push(
        `${pad}/* unknown handler for opcode ${formatOpcode(node.opcode)} at offset ${node.offset} */`,
      );
      return;
    }
    case 'jump':
    case 'cond-jump':
    case 'return': {
      // Stripped by the caller; reaching here means a corrupt block.
      throw new Error(`cannot lift control instruction ${instr.kind} here`);
    }
    default: {
      const exhaustive: never = instr.kind;
      throw new Error(`cannot lift ${exhaustive as string}`);
    }
  }
}
