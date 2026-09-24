import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { InterpreterInfo } from './detect.js';

export type HandlerKind =
  | 'push-const'
  | 'push-var'
  | 'store'
  | 'pop'
  | 'dup'
  | 'binop'
  | 'unop'
  | 'jump'
  | 'cond-jump'
  | 'call'
  | 'return'
  | 'get-property'
  | 'set-property'
  | 'unknown';

/** Alias kept for readability at use sites. */
export type HandlerLabelKind = HandlerKind;

export interface HandlerLabel {
  /** Case value of the labeled handler (`null` for `default`/unknown). */
  value: string | number | null;
  kind: HandlerKind;
  /** How many bytecode operand reads (`bc[pc++]`, `bc.charCodeAt(pc)`, …). */
  operands: number;
  /** Whether the operand reads go through the program counter. */
  viaPc: boolean;
  /** For `binop`/`unop`: the operator (e.g. `'+'`, `'-'`, `'!'`, `'typeof'`). */
  operator?: string;
  /** For `call`: the number of call arguments. */
  argc?: number;
  /** For `cond-jump`: the jump is taken when the tested value is truthy. */
  jumpWhenTrue?: boolean;
  /** 0..1. Ambiguous shapes stay low; `unknown` is always 0. */
  confidence: number;
}

interface Names {
  stack: string | undefined;
  pc: string | undefined;
  bc: string | undefined;
}

const CHAR_CODE_METHODS = new Set([
  'charCodeAt',
  'charAt',
  'codePointAt',
  'at',
]);

/**
 * Classify each handler case of a detected interpreter by AST pattern.
 *
 * Stack effects are recognized through the stack binding reported by
 * `detectInterpreters` (`stack.push(...)` / `stack.pop()`); program-counter
 * writes distinguish `jump` (absolute assignment) from plain operand
 * advancement (`pc++`, `pc += n`, `pc = pc + n`); anything that does not
 * match a known shape is labeled `unknown` with confidence 0 rather than
 * given a confident wrong label.
 */
export function labelHandlers(info: InterpreterInfo): HandlerLabel[] {
  const names: Names = {
    stack: info.stack?.identifier.name,
    pc: info.pc?.identifier.name,
    bc: info.bytecode?.identifier.name,
  };
  return info.handlers.map((handler) => {
    const stmts = handlerStatements(handler.path);
    const operands = countOperandReads(stmts, names);
    const viaPc =
      operands > 0 && (names.pc === undefined || readsViaPc(stmts, names));
    const label = classify(stmts, names);
    return { value: handler.value, operands, viaPc, ...label };
  });
}

/** Executable statements of one handler case, blocks flattened. */
function handlerStatements(path: NodePath): t.Statement[] {
  const node = path.node;
  if (t.isSwitchCase(node)) return flattenBlocks(node.consequent);
  if (t.isBlockStatement(node)) return flattenBlocks(node.body);
  if (t.isStatement(node)) return flattenBlocks([node]);
  if (t.isFunction(node)) {
    const { body } = node;
    if (t.isBlockStatement(body)) return flattenBlocks(body.body);
    return [t.expressionStatement(body)];
  }
  if (t.isExpression(node)) return [t.expressionStatement(node)];
  return [];
}

function flattenBlocks(stmts: t.Statement[]): t.Statement[] {
  const out: t.Statement[] = [];
  for (const stmt of stmts) {
    if (t.isBlockStatement(stmt)) out.push(...flattenBlocks(stmt.body));
    else out.push(stmt);
  }
  return out;
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/** Walk nodes without crossing function boundaries (`loc` is skipped). */
function walkStatements(
  stmts: t.Statement[],
  visit: (node: t.Node) => void,
): void {
  const visitNode = (node: t.Node): void => {
    visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (
            isNode(item) &&
            !t.isFunction(item) &&
            !t.isObjectMethod(item) &&
            !t.isClassMethod(item)
          ) {
            visitNode(item);
          }
        }
      } else if (
        isNode(value) &&
        !t.isFunction(value) &&
        !t.isObjectMethod(value) &&
        !t.isClassMethod(value)
      ) {
        visitNode(value);
      }
    }
  };
  for (const stmt of stmts) visitNode(stmt);
}

/** `pc`, `pc++`, `++pc`, `pc + n` (mirrors the detector's pcIndexName). */
function referencesPc(index: t.Expression, pc: string | undefined): boolean {
  if (t.isIdentifier(index)) {
    return pc === undefined || index.name === pc;
  }
  if (t.isUpdateExpression(index) && t.isIdentifier(index.argument)) {
    return pc === undefined || index.argument.name === pc;
  }
  return (
    t.isBinaryExpression(index) &&
    (index.operator === '+' || index.operator === '-') &&
    t.isIdentifier(index.left) &&
    (pc === undefined || index.left.name === pc)
  );
}

function isOperandRead(node: t.Node, names: Names): boolean {
  const bcOk = (obj: t.Node): boolean =>
    names.bc !== undefined
      ? t.isIdentifier(obj) && obj.name === names.bc
      : t.isIdentifier(obj);
  // `bc[pc++]` / `bc[pc]` style reads.
  if (
    t.isMemberExpression(node) &&
    node.computed &&
    t.isExpression(node.property) &&
    bcOk(node.object) &&
    referencesPc(node.property, names.pc)
  ) {
    return true;
  }
  // `bc.charCodeAt(pc)` / `charAt` / `codePointAt` / `at` style reads.
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee, { computed: false }) &&
    t.isIdentifier(node.callee.property) &&
    CHAR_CODE_METHODS.has(node.callee.property.name) &&
    bcOk(node.callee.object)
  ) {
    const [first] = node.arguments;
    return (
      first !== undefined &&
      t.isExpression(first) &&
      referencesPc(first, names.pc)
    );
  }
  return false;
}

function countOperandReads(stmts: t.Statement[], names: Names): number {
  let count = 0;
  walkStatements(stmts, (node) => {
    if (isOperandRead(node, names)) count++;
  });
  return count;
}

function readsViaPc(stmts: t.Statement[], names: Names): boolean {
  if (names.pc === undefined) return true;
  let viaPc = false;
  walkStatements(stmts, (node) => {
    if (!viaPc && isOperandRead(node, names)) viaPc = true;
  });
  return viaPc;
}

function calleeIs(
  node: t.CallExpression,
  objectName: string | undefined,
  method: string,
): boolean {
  if (!t.isMemberExpression(node.callee, { computed: false })) return false;
  if (!t.isIdentifier(node.callee.property, { name: method })) return false;
  return (
    objectName === undefined ||
    (t.isIdentifier(node.callee.object) &&
      node.callee.object.name === objectName)
  );
}

function isStackPush(node: t.Node, stack: string | undefined): boolean {
  return (
    t.isCallExpression(node) &&
    node.arguments.length > 0 &&
    calleeIs(node, stack, 'push')
  );
}

function isStackPop(node: t.Node, stack: string | undefined): boolean {
  return (
    t.isCallExpression(node) &&
    node.arguments.length === 0 &&
    calleeIs(node, stack, 'pop')
  );
}

/** True when `expr` contains a `stack.pop()` call. */
function containsPop(expr: t.Node, stack: string | undefined): boolean {
  let found = false;
  const visit = (node: t.Node): void => {
    if (found || t.isFunction(node)) return;
    if (isStackPop(node, stack)) {
      found = true;
      return;
    }
    for (const value of Object.values(node)) {
      if (found) return;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item);
        }
      } else if (isNode(value)) {
        visit(value);
      }
    }
  };
  visit(expr);
  return found;
}

interface AbsPcWrite {
  conditional: boolean;
  consequent: boolean;
  negated: boolean;
}

function isNegation(node: t.Node): boolean {
  return t.isUnaryExpression(node, { operator: '!' });
}

/** `pc = <rhs>` that moves the pc somewhere new (not an operand skip). */
function isAbsoluteTarget(rhs: t.Expression, pc: string | undefined): boolean {
  if (pc !== undefined) {
    // `pc = pc + n` / `pc = pc - n` only skips operands.
    if (t.isIdentifier(rhs) && rhs.name === pc) return false;
    if (
      t.isBinaryExpression(rhs) &&
      (rhs.operator === '+' || rhs.operator === '-') &&
      t.isIdentifier(rhs.left) &&
      rhs.left.name === pc
    ) {
      return false;
    }
  }
  return true;
}

interface PcAssign {
  absolute: boolean;
  conditional: boolean;
}

/**
 * `pc` writes inside an expression; assignments under `&&`/`?:` are
 * conditional. `+=` / `-=` / `++` / `--` only advance over operands.
 */
function findPcAssigns(
  expr: t.Node,
  pc: string | undefined,
  conditional: boolean,
  out: PcAssign[],
): void {
  if (t.isFunction(expr)) return;
  if (
    t.isAssignmentExpression(expr) &&
    t.isIdentifier(expr.left) &&
    (pc === undefined || expr.left.name === pc)
  ) {
    if (expr.operator === '=') {
      out.push({
        absolute: isAbsoluteTarget(expr.right, pc),
        conditional,
      });
    }
    return;
  }
  if (
    t.isUpdateExpression(expr) &&
    (!t.isIdentifier(expr.argument) ||
      pc === undefined ||
      expr.argument.name === pc)
  ) {
    return;
  }
  const nested = t.isLogicalExpression(expr) || t.isConditionalExpression(expr);
  for (const value of Object.values(expr)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          findPcAssigns(item, pc, conditional || nested, out);
        }
      }
    } else if (isNode(value)) {
      findPcAssigns(value, pc, conditional || nested, out);
    }
  }
}

function collectPcWrites(
  stmts: t.Statement[],
  pc: string | undefined,
  conditional: boolean,
  consequent: boolean,
  negated: boolean,
  out: AbsPcWrite[],
): void {
  for (const stmt of stmts) {
    if (t.isExpressionStatement(stmt)) {
      const assigns: PcAssign[] = [];
      findPcAssigns(stmt.expression, pc, false, assigns);
      for (const assign of assigns) {
        if (assign.absolute) {
          out.push({
            conditional: conditional || assign.conditional,
            consequent,
            negated,
          });
        }
      }
    } else if (t.isIfStatement(stmt)) {
      const innerNegated = isNegation(stmt.test) ? !negated : negated;
      collectPcWrites(
        flattenBlocks([stmt.consequent]),
        pc,
        true,
        true,
        innerNegated,
        out,
      );
      if (stmt.alternate) {
        collectPcWrites(
          flattenBlocks([stmt.alternate]),
          pc,
          true,
          false,
          innerNegated,
          out,
        );
      }
    } else if (t.isStatement(stmt) && !t.isExpressionStatement(stmt)) {
      // Control flow around a pc write makes the jump conditional.
      const inner: t.Statement[] = [];
      if (t.isBlockStatement(stmt)) inner.push(...stmt.body);
      else if (
        (t.isForStatement(stmt) ||
          t.isForInStatement(stmt) ||
          t.isForOfStatement(stmt)) &&
        t.isStatement(stmt.body)
      ) {
        inner.push(stmt.body);
      } else if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt)) {
        inner.push(stmt.body);
      } else if (t.isTryStatement(stmt)) {
        inner.push(stmt.block);
        if (stmt.handler) inner.push(stmt.handler.body);
        if (stmt.finalizer) inner.push(stmt.finalizer);
      } else if (t.isSwitchStatement(stmt)) {
        for (const c of stmt.cases) inner.push(...c.consequent);
      } else if (t.isLabeledStatement(stmt)) {
        inner.push(stmt.body);
      }
      collectPcWrites(flattenBlocks(inner), pc, true, true, negated, out);
    }
  }
}

type Classified = Pick<
  HandlerLabel,
  'kind' | 'operator' | 'argc' | 'jumpWhenTrue' | 'confidence'
>;

function unknown(): Classified {
  return { kind: 'unknown', confidence: 0 };
}

function hasReturn(stmts: t.Statement[]): boolean {
  let found = false;
  walkStatements(stmts, (node) => {
    if (t.isReturnStatement(node)) found = true;
  });
  return found;
}

function findPushes(
  stmts: t.Statement[],
  stack: string | undefined,
): t.CallExpression[] {
  const pushes: t.CallExpression[] = [];
  walkStatements(stmts, (node) => {
    if (t.isCallExpression(node) && isStackPush(node, stack)) pushes.push(node);
  });
  return pushes;
}

function classifyPushArg(arg: t.Expression, names: Names): Classified {
  // `stack.push(-5)` pushes a constant, not a negation op.
  if (
    t.isUnaryExpression(arg) &&
    (arg.operator === '-' || arg.operator === '+') &&
    t.isNumericLiteral(arg.argument)
  ) {
    return { kind: 'push-const', confidence: 0.8 };
  }
  if (isOperandRead(arg, names) || t.isLiteral(arg)) {
    // `stack.push(bc[pc++])`, `stack.push(5)`: load a constant.
    let reads = 0;
    walkStatements([t.expressionStatement(arg)], (node) => {
      if (isOperandRead(node, names)) reads++;
    });
    return { kind: 'push-const', confidence: reads > 0 ? 0.95 : 0.8 };
  }
  if (t.isBinaryExpression(arg)) {
    return { kind: 'binop', operator: arg.operator, confidence: 0.9 };
  }
  if (t.isUnaryExpression(arg)) {
    return { kind: 'unop', operator: arg.operator, confidence: 0.9 };
  }
  if (t.isAwaitExpression(arg)) {
    return { kind: 'unop', operator: 'await', confidence: 0.7 };
  }
  if (t.isCallExpression(arg)) {
    if (isStackPop(arg, names.stack)) return unknown();
    // `stack.at(-1)` reads the top without removing it: a dup.
    if (
      names.stack !== undefined &&
      t.isMemberExpression(arg.callee, { computed: false }) &&
      t.isIdentifier(arg.callee.property, { name: 'at' }) &&
      t.isIdentifier(arg.callee.object) &&
      arg.callee.object.name === names.stack
    ) {
      return { kind: 'dup', confidence: 0.85 };
    }
    return { kind: 'call', argc: arg.arguments.length, confidence: 0.85 };
  }
  if (t.isMemberExpression(arg)) {
    // `stack.push(stack[stack.length - 1])` duplicates the top of stack.
    if (
      names.stack !== undefined &&
      t.isIdentifier(arg.object) &&
      arg.object.name === names.stack
    ) {
      return { kind: 'dup', confidence: 0.85 };
    }
    return { kind: 'get-property', confidence: 0.85 };
  }
  if (t.isIdentifier(arg) || t.isThisExpression(arg)) {
    return { kind: 'push-var', confidence: 0.85 };
  }
  return unknown();
}

/** Assignments/declarators whose value comes from `stack.pop()`. */
function findPopStoreKinds(
  stmts: t.Statement[],
  names: Names,
  out: ('member' | 'ident' | null)[],
): void {
  walkStatements(stmts, (node) => {
    if (
      t.isAssignmentExpression(node) &&
      node.operator === '=' &&
      containsPop(node.right, names.stack)
    ) {
      if (t.isMemberExpression(node.left)) out.push('member');
      else if (
        t.isIdentifier(node.left) &&
        (names.pc === undefined || node.left.name !== names.pc)
      ) {
        out.push('ident');
      } else out.push(null);
    } else if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      node.init &&
      containsPop(node.init, names.stack)
    ) {
      out.push('ident');
    }
  });
}

/** Assignments that compute a value without popping the stack. */
function findRegAssigns(
  stmts: t.Statement[],
  names: Names,
  out: t.Expression[],
): void {
  walkStatements(stmts, (node) => {
    if (
      t.isAssignmentExpression(node) &&
      node.operator === '=' &&
      (t.isIdentifier(node.left) || t.isMemberExpression(node.left)) &&
      !containsPop(node.right, names.stack)
    ) {
      if (
        t.isIdentifier(node.left) &&
        names.pc !== undefined &&
        node.left.name === names.pc
      ) {
        return;
      }
      out.push(node.right);
    } else if (
      t.isVariableDeclarator(node) &&
      node.init &&
      !containsPop(node.init, names.stack) &&
      !isOperandRead(node.init, names) &&
      !t.isLiteral(node.init) &&
      !t.isIdentifier(node.init) &&
      !t.isMemberExpression(node.init)
    ) {
      out.push(node.init);
    }
  });
}

function findStandaloneCalls(
  stmts: t.Statement[],
  names: Names,
): t.CallExpression[] {
  const calls: t.CallExpression[] = [];
  for (const stmt of stmts) {
    if (!t.isExpressionStatement(stmt)) continue;
    if (!t.isCallExpression(stmt.expression)) continue;
    const expr = stmt.expression;
    if (isStackPush(expr, names.stack)) continue;
    if (isStackPop(expr, names.stack)) continue;
    if (isOperandRead(expr, names)) continue;
    // `out.push(stack.pop())` outputs the popped value: handled by the
    // pop rule, not as a call.
    if (
      t.isMemberExpression(expr.callee, { computed: false }) &&
      t.isIdentifier(expr.callee.property, { name: 'push' }) &&
      containsPop(expr, names.stack)
    ) {
      continue;
    }
    calls.push(expr);
  }
  return calls;
}

function countPops(
  stmts: t.Statement[],
  names: Names,
): { total: number; bare: number } {
  let total = 0;
  let bare = 0;
  walkStatements(stmts, (node) => {
    if (t.isCallExpression(node) && isStackPop(node, names.stack)) total++;
  });
  for (const stmt of stmts) {
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      isStackPop(stmt.expression, names.stack)
    ) {
      bare++;
    }
  }
  return { total, bare };
}

function classify(stmts: t.Statement[], names: Names): Classified {
  if (hasReturn(stmts)) return { kind: 'return', confidence: 0.95 };

  const writes: AbsPcWrite[] = [];
  collectPcWrites(stmts, names.pc, false, true, false, writes);
  if (writes.length > 0) {
    if (writes.every((w) => w.conditional)) {
      const [first] = writes;
      const unanimous = writes.every(
        (w) => w.consequent === first.consequent && w.negated === first.negated,
      );
      return {
        kind: 'cond-jump',
        jumpWhenTrue: first.consequent !== first.negated,
        confidence: unanimous ? 0.9 : 0.7,
      };
    }
    return { kind: 'jump', confidence: 0.9 };
  }

  const pushes = findPushes(stmts, names.stack);
  if (pushes.length > 0) {
    const [firstArg] = pushes[0].arguments;
    if (firstArg !== undefined && t.isExpression(firstArg)) {
      return classifyPushArg(firstArg, names);
    }
    return unknown();
  }

  const stores: ('member' | 'ident' | null)[] = [];
  findPopStoreKinds(stmts, names, stores);
  if (stores.length > 0) {
    if (stores[0] === 'member') {
      return { kind: 'set-property', confidence: 0.85 };
    }
    if (stores[0] === 'ident') {
      return { kind: 'store', confidence: 0.85 };
    }
    return unknown();
  }

  const pops = countPops(stmts, names);
  if (pops.total > 0) {
    // `out.push(stack.pop())` drops the value from the VM stack into an
    // external output; a bare `stack.pop();` discards it.
    return { kind: 'pop', confidence: pops.bare === pops.total ? 0.9 : 0.8 };
  }

  const calls = findStandaloneCalls(stmts, names);
  if (calls.length > 0) {
    return {
      kind: 'call',
      argc: calls[0].arguments.length,
      confidence: 0.8,
    };
  }

  // Register-style handlers computing into a slot without the value stack.
  const assigns: t.Expression[] = [];
  findRegAssigns(stmts, names, assigns);
  if (assigns.length > 0) {
    const rhs = assigns[0];
    if (t.isBinaryExpression(rhs)) {
      return { kind: 'binop', operator: rhs.operator, confidence: 0.8 };
    }
    if (t.isUnaryExpression(rhs)) {
      return { kind: 'unop', operator: rhs.operator, confidence: 0.8 };
    }
    if (t.isCallExpression(rhs)) {
      if (isStackPop(rhs, names.stack)) return unknown();
      return { kind: 'call', argc: rhs.arguments.length, confidence: 0.8 };
    }
    let reads = 0;
    walkStatements([t.expressionStatement(rhs)], (node) => {
      if (isOperandRead(node, names)) reads++;
    });
    if (reads > 0 || t.isMemberExpression(rhs) || t.isIdentifier(rhs)) {
      return { kind: 'store', confidence: 0.8 };
    }
  }

  return unknown();
}
