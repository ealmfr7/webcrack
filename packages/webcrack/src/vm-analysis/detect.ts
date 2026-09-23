import traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export type InterpreterDispatchKind = 'switch' | 'if-chain' | 'handler-table';

export interface InterpreterHandler {
  /** Case value (`number`/`string` literal) or `null` for `default`/unknown. */
  value: string | number | null;
  /** The `SwitchCase` path, the branch consequent, or the handler element. */
  path: NodePath;
}

export interface InterpreterInfo {
  /** The interpreter loop (`while (true)`, `for (;;)`, `while (pc < len)`). */
  loop: NodePath<t.WhileStatement | t.ForStatement>;
  /** The dispatch statement inside the loop. */
  dispatch: NodePath<t.SwitchStatement | t.IfStatement | t.ExpressionStatement>;
  dispatchKind: InterpreterDispatchKind;
  /** Expression the dispatch branches on (switch discriminant, `if` subject, table index). */
  opcode: NodePath<t.Expression>;
  /** Program-counter binding, when it resolves to a real binding. */
  pc: Binding | undefined;
  /** Bytecode array/string binding, when it resolves to a real binding. */
  bytecode: Binding | undefined;
  /** Value-stack binding, when a push/pop array is evident in the loop. */
  stack: Binding | undefined;
  /** Handler cases (`case` value -> body path). */
  handlers: InterpreterHandler[];
}

/**
 * Identify VM interpreter loops: an endless (`while (true)` / `for (;;)`) or
 * pc-bounded (`while (pc < len)`) loop whose body dispatches on an opcode
 * read from a bytecode array/string through an incrementing program counter
 * (`bc[pc++]`, `bc[pc]` with a separate `pc += n`).
 *
 * The dispatch is either a `switch (opcode)`, an `if`/`else if` chain
 * comparing the opcode against literals, or a handler-table call such as
 * `handlers[opcode](...)`.
 *
 * Loops produced by the `control-flow-switch` deobfuscation target
 * (obfuscator.io `"1|0|2".split("|")` sequence switches) are deliberately
 * *not* reported: their discriminant indexes a string built by
 * `<pipe-separated digits>.split("|")`, not a bytecode array.
 */
export function detectInterpreters(
  ast: t.File | t.Program | t.Node,
): InterpreterInfo[] {
  const results: InterpreterInfo[] = [];
  traverse(ast, {
    WhileStatement(loopPath) {
      const found = analyzeLoop(loopPath);
      if (found) results.push(...found);
    },
    ForStatement(loopPath) {
      const found = analyzeLoop(loopPath);
      if (found) results.push(...found);
    },
  });
  return results;
}

function analyzeLoop(
  loopPath: NodePath<t.WhileStatement | t.ForStatement>,
): InterpreterInfo[] {
  if (!isInterpreterLoop(loopPath.node)) return [];

  // Collect dispatch candidates inside the loop, ignoring nested functions
  // and nested loops (their switches belong to another level).
  const switches: NodePath<t.SwitchStatement>[] = [];
  const ifs: NodePath<t.IfStatement>[] = [];
  const calls: NodePath<t.ExpressionStatement>[] = [];
  loopPath.traverse({
    Function(path) {
      path.skip();
    },
    WhileStatement(path) {
      path.skip();
    },
    ForStatement(path) {
      path.skip();
    },
    SwitchStatement(path) {
      switches.push(path);
    },
    IfStatement(path) {
      ifs.push(path);
    },
    ExpressionStatement(path) {
      calls.push(path);
    },
  });

  // Shallowest candidate first so handler-level switches lose to the dispatch.
  const byDepth = <P extends NodePath>(paths: P[]): P[] =>
    [...paths].sort((a, b) => depthOf(a, loopPath) - depthOf(b, loopPath));

  for (const switchPath of byDepth(switches)) {
    const info = analyzeSwitch(loopPath, switchPath);
    if (info) return [info];
  }
  for (const ifPath of byDepth(ifs)) {
    // Only top-level chains: skip `else if` links, the chain head is visited too.
    if (ifPath.parentPath?.isIfStatement()) continue;
    const info = analyzeIfChain(loopPath, ifPath);
    if (info) return [info];
  }
  for (const callPath of byDepth(calls)) {
    const info = analyzeHandlerTable(loopPath, callPath);
    if (info) return [info];
  }
  return [];
}

function depthOf(path: NodePath, stop: NodePath): number {
  let depth = 0;
  let current: NodePath | null = path;
  while (current && current !== stop) {
    depth++;
    current = current.parentPath;
  }
  return depth;
}

/**
 * Endless (`while (true)`, `for (;;)`) or pc-bounded (`while (pc < len)`,
 * `for (; pc < len;)`) loops only.
 */
function isInterpreterLoop(node: t.WhileStatement | t.ForStatement): boolean {
  if (t.isWhileStatement(node)) {
    return isTruthyTest(node.test) || isPcBound(node.test);
  }
  if (node.test == null) return true;
  return isTruthyTest(node.test) || isPcBound(node.test);
}

function isTruthyTest(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value === true;
  if (t.isNumericLiteral(test)) return test.value !== 0;
  if (
    t.isUnaryExpression(test) &&
    test.operator === '!' &&
    t.isNumericLiteral(test.argument)
  ) {
    return test.argument.value === 0;
  }
  // `while ([])`, `while (!![])`, ...
  if (t.isArrayExpression(test)) return true;
  if (
    t.isUnaryExpression(test) &&
    (test.operator === '!' || test.operator === 'void')
  ) {
    return true;
  }
  if (t.isIdentifier(test, { name: 'true' })) return true;
  return false;
}

/** `pc < len`, `pc <= len` (also `!=`/`!==` clock-style bounds). */
function isPcBound(test: t.Expression): boolean {
  return (
    t.isBinaryExpression(test) &&
    ['<', '<=', '!=', '!=='].includes(test.operator) &&
    t.isIdentifier(test.left)
  );
}

interface PcRead {
  pcName: string;
  /** Bytecode object name when the read is `bc[...]` / `bc.charCodeAt(...)`. */
  bcName: string | undefined;
  /** Path of the read expression itself. */
  readPath: NodePath<t.Expression>;
}

/** `bc[pc]` / `bc[pc++]` style read, or `undefined` when not one. */
function matchMemberRead(
  node: t.Node,
): { pcName: string; bcName: string | undefined } | undefined {
  if (!t.isMemberExpression(node)) return undefined;
  if (!node.computed || !t.isExpression(node.property)) return undefined;
  const pcName = pcIndexName(node.property);
  if (!pcName) return undefined;
  return {
    pcName,
    bcName: t.isIdentifier(node.object) ? node.object.name : undefined,
  };
}

/** `bc.charCodeAt(pc)` / `charAt` / `codePointAt` / `at` style read. */
function matchCallRead(
  node: t.Node,
): { pcName: string; bcName: string | undefined } | undefined {
  if (!t.isCallExpression(node)) return undefined;
  if (
    !t.isMemberExpression(node.callee, { computed: false }) ||
    !t.isExpression(node.callee.property) ||
    !t.isIdentifier(node.callee.property) ||
    !['charCodeAt', 'charAt', 'codePointAt', 'at'].includes(
      node.callee.property.name,
    )
  ) {
    return undefined;
  }
  const [first] = node.arguments;
  if (!first || !t.isExpression(first)) return undefined;
  const pcName = pcIndexName(first);
  if (!pcName) return undefined;
  return {
    pcName,
    bcName: t.isIdentifier(node.callee.object)
      ? node.callee.object.name
      : undefined,
  };
}

/**
 * Find a pc-indexed bytecode read inside an expression:
 * `bc[pc++]`, `bc[pc]`, `bc.charCodeAt(pc)` / `charAt` / `codePointAt`.
 */
function findPcRead(
  exprPath: NodePath<t.Expression>,
  loopPath: NodePath,
): PcRead | undefined {
  // `traverse` visits children but never the starting node itself, so check
  // the root expression first (e.g. `var op = bc[pc++]`).
  const check = (
    node: t.Node,
    readPath: NodePath<t.Expression>,
  ): PcRead | undefined => {
    const match = matchMemberRead(node) ?? matchCallRead(node);
    if (match && isPcIncremented(loopPath, match.pcName)) {
      return { ...match, readPath };
    }
    return undefined;
  };
  const root = check(exprPath.node, exprPath);
  if (root) return root;

  let found: PcRead | undefined;
  exprPath.traverse({
    Function(path) {
      path.skip();
    },
    MemberExpression(path) {
      if (!found) found = check(path.node, path);
    },
    CallExpression(path) {
      if (!found) found = check(path.node, path);
    },
  });
  return found;
}

/** Name of the pc if `index` reads it (`pc`, `pc++`, `++pc`, `pc + n`). */
function pcIndexName(index: t.Expression): string | undefined {
  if (t.isIdentifier(index)) return index.name;
  if (t.isUpdateExpression(index) && t.isIdentifier(index.argument)) {
    return index.argument.name;
  }
  if (
    t.isBinaryExpression(index) &&
    (index.operator === '+' || index.operator === '-') &&
    t.isIdentifier(index.left)
  ) {
    return index.left.name;
  }
  return undefined;
}

/** `pc++`, `++pc`, `pc += n`, `pc = pc + n`, `pc = ...` anywhere in the loop. */
function isPcIncremented(loopPath: NodePath, pcName: string): boolean {
  let found = false;
  loopPath.traverse({
    Function(path) {
      path.skip();
    },
    WhileStatement(path) {
      if (path !== loopPath) path.skip();
    },
    ForStatement(path) {
      if (path !== loopPath) path.skip();
    },
    UpdateExpression(path) {
      if (!found && t.isIdentifier(path.node.argument, { name: pcName })) {
        found = true;
      }
    },
    AssignmentExpression(path) {
      if (!found && t.isIdentifier(path.node.left, { name: pcName })) {
        found = true;
      }
    },
  });
  return found;
}

/**
 * Resolve `var op = <pc read>` / `op = <pc read>` assignments of an opcode
 * variable inside the loop body.
 */
function resolveOpcodeVar(
  loopPath: NodePath,
  name: string,
): PcRead | undefined {
  let found: PcRead | undefined;
  loopPath.traverse({
    Function(path) {
      path.skip();
    },
    WhileStatement(path) {
      if (path !== loopPath) path.skip();
    },
    ForStatement(path) {
      if (path !== loopPath) path.skip();
    },
    VariableDeclarator(path) {
      if (
        !found &&
        t.isIdentifier(path.node.id, { name }) &&
        path.node.init &&
        t.isExpression(path.node.init)
      ) {
        const initPath = path.get('init') as NodePath<t.Expression>;
        found = findPcRead(initPath, loopPath);
        if (!found && t.isIdentifier(path.node.init)) {
          // `var op = pc` alias: pc itself must still be incremented.
          if (isPcIncremented(loopPath, path.node.init.name)) {
            found = {
              pcName: path.node.init.name,
              bcName: undefined,
              readPath: initPath,
            };
          }
        }
      }
    },
    AssignmentExpression(path) {
      if (
        !found &&
        t.isIdentifier(path.node.left, { name }) &&
        t.isExpression(path.node.right)
      ) {
        const rightPath = path.get('right');
        found = findPcRead(rightPath, loopPath);
      }
    },
  });
  return found;
}

/** True when `node` is (or binds to) `<digits(|digits)*>.split("|")`. */
function isSplitPipeSequence(
  node: t.Node | null | undefined,
  scope: NodePath['scope'],
): boolean {
  const isSplitPipeCall = (n: t.Node): boolean =>
    t.isCallExpression(n) &&
    t.isMemberExpression(n.callee) &&
    t.isIdentifier(n.callee.property, { name: 'split' }) &&
    n.arguments.length === 1 &&
    t.isStringLiteral(n.arguments[0], { value: '|' }) &&
    t.isStringLiteral(n.callee.object) &&
    /^\d+(\|\d+)*$/.test(n.callee.object.value);
  if (!node) return false;
  if (isSplitPipeCall(node)) return true;
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name);
    const init = binding?.path;
    if (
      init?.isVariableDeclarator() &&
      init.node.init &&
      isSplitPipeCall(init.node.init)
    ) {
      return true;
    }
  }
  return false;
}

function caseValue(test: t.SwitchCase['test']): string | number | null {
  if (t.isNumericLiteral(test)) return test.value;
  if (t.isStringLiteral(test)) return test.value;
  return null;
}

function analyzeSwitch(
  loopPath: NodePath<t.WhileStatement | t.ForStatement>,
  switchPath: NodePath<t.SwitchStatement>,
): InterpreterInfo | undefined {
  const cases = switchPath.node.cases;
  // A one- or two-branch switch is a conditional, not an interpreter.
  if (cases.length < 3) return undefined;

  const discriminantPath = switchPath.get('discriminant');

  let read: PcRead | undefined = findPcRead(discriminantPath, loopPath);
  if (!read && t.isIdentifier(discriminantPath.node)) {
    read = resolveOpcodeVar(loopPath, discriminantPath.node.name);
  }
  if (!read) return undefined;

  // Exclude obfuscator.io control-flow switches: their discriminant indexes
  // a `"<n>|<m>|...".split("|")` sequence rather than a bytecode array.
  const discriminant = discriminantPath.node;
  if (
    t.isMemberExpression(discriminant) &&
    t.isExpression(discriminant.object) &&
    isSplitPipeSequence(discriminant.object, switchPath.scope)
  ) {
    return undefined;
  }
  if (read.bcName && isSplitPipeSequence(read.readPath.node, loopPath.scope)) {
    return undefined;
  }
  if (
    read.bcName &&
    isSplitPipeSequence(
      loopPath.scope.getBinding(read.bcName)?.path.node ?? null,
      loopPath.scope,
    )
  ) {
    return undefined;
  }

  const casePaths = switchPath.get('cases');
  const handlers: InterpreterHandler[] = casePaths.map((casePath) => ({
    value: caseValue(casePath.node.test),
    path: casePath,
  }));

  return {
    loop: loopPath,
    dispatch: switchPath,
    dispatchKind: 'switch',
    opcode: discriminantPath,
    pc: loopPath.scope.getBinding(read.pcName),
    bytecode:
      read.bcName !== undefined
        ? loopPath.scope.getBinding(read.bcName)
        : undefined,
    stack: findStackBinding(loopPath),
    handlers,
  };
}

function ifTestValue(
  test: t.Expression,
): { name: string; value: string | number } | undefined {
  if (t.isBinaryExpression(test) && ['==', '==='].includes(test.operator)) {
    const { left, right } = test;
    if (t.isIdentifier(left) && t.isLiteral(right)) {
      const value =
        t.isNumericLiteral(right) || t.isStringLiteral(right)
          ? right.value
          : undefined;
      if (value !== undefined) return { name: left.name, value };
    }
    if (t.isIdentifier(right) && t.isLiteral(left)) {
      const value =
        t.isNumericLiteral(left) || t.isStringLiteral(left)
          ? left.value
          : undefined;
      if (value !== undefined) return { name: right.name, value };
    }
  }
  return undefined;
}

function analyzeIfChain(
  loopPath: NodePath<t.WhileStatement | t.ForStatement>,
  ifPath: NodePath<t.IfStatement>,
): InterpreterInfo | undefined {
  // Walk the `else if` spine collecting `op === <lit>` branches.
  const branches: { value: string | number | null; path: NodePath }[] = [];
  let opcodeName: string | undefined;
  let current: NodePath<t.IfStatement> | null = ifPath;
  let testPath: NodePath<t.Expression> | undefined;
  while (current) {
    const test = current.get('test');
    const parsed = ifTestValue(test.node);
    if (!parsed) return undefined;
    if (opcodeName === undefined) {
      opcodeName = parsed.name;
      testPath = test;
    } else if (parsed.name !== opcodeName) {
      return undefined;
    }
    branches.push({
      value: parsed.value,
      path: current.get('consequent'),
    });
    if (current.node.alternate && t.isIfStatement(current.node.alternate)) {
      current = current.get('alternate') as NodePath<t.IfStatement>;
    } else {
      if (current.node.alternate) {
        branches.push({
          value: null,
          path: current.get('alternate') as NodePath,
        });
      }
      current = null;
    }
  }
  // A single `if/else` is a conditional, not an interpreter.
  if (branches.length < 3 || !opcodeName || !testPath) return undefined;

  let read = findPcRead(testPath, loopPath);
  read ??= resolveOpcodeVar(loopPath, opcodeName);
  if (!read) return undefined;
  if (
    read.bcName &&
    isSplitPipeSequence(
      loopPath.scope.getBinding(read.bcName)?.path.node ?? null,
      loopPath.scope,
    )
  ) {
    return undefined;
  }

  // The opcode subject is the compared identifier inside the first test.
  let opcodePath: NodePath<t.Expression> = testPath;
  const left = (testPath.get('left') ?? null) as NodePath<t.Expression> | null;
  const right = (testPath.get('right') ??
    null) as NodePath<t.Expression> | null;
  if (left?.isIdentifier()) opcodePath = left;
  else if (right?.isIdentifier()) opcodePath = right;

  return {
    loop: loopPath,
    dispatch: ifPath,
    dispatchKind: 'if-chain',
    opcode: opcodePath,
    pc: loopPath.scope.getBinding(read.pcName),
    bytecode:
      read.bcName !== undefined
        ? loopPath.scope.getBinding(read.bcName)
        : undefined,
    stack: findStackBinding(loopPath),
    handlers: branches.map((b) => ({
      value: b.value ?? null,
      path: b.path,
    })),
  };
}

function analyzeHandlerTable(
  loopPath: NodePath<t.WhileStatement | t.ForStatement>,
  exprPath: NodePath<t.ExpressionStatement>,
): InterpreterInfo | undefined {
  const expr = exprPath.get('expression');
  const callPath = expr.isCallExpression()
    ? expr
    : expr.isAssignmentExpression()
      ? expr.get('right')
      : null;
  if (!callPath?.isCallExpression()) return undefined;
  const callee = callPath.get('callee') as NodePath<t.Expression>;
  if (!callee.isMemberExpression() || !callee.node.computed) return undefined;
  const property = callee.get('property') as NodePath<t.Expression>;
  if (!t.isExpression(property.node)) return undefined;

  let read = findPcRead(property, loopPath);
  const tableIndex: NodePath<t.Expression> = property;
  if (!read && t.isIdentifier(property.node)) {
    read = resolveOpcodeVar(loopPath, property.node.name);
  }
  if (!read) return undefined;

  const object = callee.get('object');
  const tableName = object.isIdentifier() ? object.node.name : undefined;
  const tableBinding = tableName
    ? loopPath.scope.getBinding(tableName)
    : undefined;

  const handlers: InterpreterHandler[] = [];
  const init = tableBinding?.path;
  if (init?.isVariableDeclarator() && t.isArrayExpression(init.node.init)) {
    const elements = init.get('init') as NodePath<t.ArrayExpression>;
    const elementPaths = elements.get('elements') as NodePath[];
    for (const [index, el] of elementPaths.entries()) {
      if (el.node !== null && !t.isSpreadElement(el.node)) {
        handlers.push({ value: index, path: el });
      }
    }
  }
  if (handlers.length === 0) {
    // Table not statically enumerable; still an interpreter dispatch.
    handlers.push({ value: null, path: exprPath });
  }

  return {
    loop: loopPath,
    dispatch: exprPath,
    dispatchKind: 'handler-table',
    opcode: tableIndex,
    pc: loopPath.scope.getBinding(read.pcName),
    bytecode:
      read.bcName !== undefined
        ? loopPath.scope.getBinding(read.bcName)
        : undefined,
    stack: findStackBinding(loopPath),
    handlers,
  };
}

/**
 * Find an array used as a value stack in the loop: an identifier with at
 * least one `.push(...)` and (a `.pop()` or a second `.push(...)`).
 */
function findStackBinding(loopPath: NodePath): Binding | undefined {
  const pushes = new Map<string, number>();
  const pops = new Map<string, number>();
  loopPath.traverse({
    Function(path) {
      path.skip();
    },
    WhileStatement(path) {
      if (path !== loopPath) path.skip();
    },
    ForStatement(path) {
      if (path !== loopPath) path.skip();
    },
    CallExpression(path) {
      const { node } = path;
      if (
        t.isMemberExpression(node.callee, { computed: false }) &&
        t.isIdentifier(node.callee.object) &&
        t.isIdentifier(node.callee.property)
      ) {
        const name = node.callee.object.name;
        if (node.callee.property.name === 'push') {
          pushes.set(name, (pushes.get(name) ?? 0) + 1);
        } else if (
          node.callee.property.name === 'pop' &&
          node.arguments.length === 0
        ) {
          pops.set(name, (pops.get(name) ?? 0) + 1);
        }
      }
    },
  });
  for (const [name, pushCount] of pushes) {
    if (pushCount >= 1 && ((pops.get(name) ?? 0) >= 1 || pushCount >= 2)) {
      const binding = loopPath.scope.getBinding(name);
      if (binding) return binding;
    }
  }
  return undefined;
}
