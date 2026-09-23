import * as t from '@babel/types';
import type { NodePath, Scope } from '@babel/traverse';
import type { Transform } from '../../ast-utils';

// Matches `(0, helper)(...)` interop call shapes
function unwrapSequence(
  node: t.Expression | t.Super | t.V8IntrinsicIdentifier,
): t.Expression | t.Super | t.V8IntrinsicIdentifier {
  if (
    t.isSequenceExpression(node) &&
    node.expressions.length === 2 &&
    t.isNumericLiteral(node.expressions[0], { value: 0 })
  ) {
    return node.expressions[1];
  }
  return node;
}

function isExpression(node: t.Node | null | undefined): node is t.Expression {
  return t.isExpression(node);
}

// TS: __awaiter(thisArg, _arguments, P, generator)
// A non-default P (e.g. a custom Promise constructor) is silently
// dropped: the output uses the native Promise via async/await.
function isAwaiterArg(node: t.CallExpression['arguments'][number]): boolean {
  // _arguments position: void 0, undefined, `arguments`, or an identifier
  // (TS emits the outer `arguments` or `void 0` here)
  return (
    t.isUnaryExpression(node, { operator: 'void' }) || t.isIdentifier(node)
  );
}

function isPromiseArg(node: t.CallExpression['arguments'][number]): boolean {
  // P position: void 0, undefined, or a constructor identifier
  return (
    t.isUnaryExpression(node, { operator: 'void' }) || t.isIdentifier(node)
  );
}

// TS __awaiter helper shape: it drives the generator through
// `return new (P || (P = Promise))(function (resolve, reject) {...})`
function isAwaiterHelper(fn: t.Node | null | undefined): boolean {
  if (!t.isFunction(fn)) return false;
  return containsNode(fn.body, (n) => {
    if (!t.isReturnStatement(n) || !n.argument) return false;
    if (!t.isNewExpression(n.argument)) return false;
    return t.isLogicalExpression(n.argument.callee, { operator: '||' });
  });
}

// Babel _asyncToGenerator helper shape: a single-parameter function that
// returns a function producing `new Promise(...)`
function isAsyncToGeneratorHelper(fn: t.Node | null | undefined): boolean {
  if (!t.isFunction(fn) || fn.params.length !== 1) return false;
  const { body } = fn;
  return (
    containsNode(
      body,
      (n) => t.isReturnStatement(n) && !!n.argument && t.isFunction(n.argument),
    ) &&
    containsNode(
      body,
      (n) =>
        t.isNewExpression(n) && t.isIdentifier(n.callee, { name: 'Promise' }),
    )
  );
}

function resolveHelperFn(scope: Scope, name: string): t.Function | null {
  const binding = scope.getBinding(name);
  if (!binding) return null;
  const path = binding.path;
  if (path.isFunctionDeclaration() || path.isFunctionExpression()) {
    return path.node;
  }
  if (path.isVariableDeclarator() && t.isFunction(path.node.init)) {
    return path.node.init;
  }
  return null;
}

function getAwaiterGenerator(
  node: t.CallExpression,
  scope: Scope,
): t.FunctionExpression | t.ArrowFunctionExpression | null {
  if (node.arguments.length !== 4) return null;
  if (node.arguments.some((arg) => t.isSpreadElement(arg))) return null;
  const [, argsArg, promiseArg, generator] = node.arguments;
  if (!isAwaiterArg(argsArg) || !isPromiseArg(promiseArg)) return null;
  if (
    !(
      t.isFunctionExpression(generator) ||
      t.isArrowFunctionExpression(generator)
    ) ||
    !generator.generator
  ) {
    return null;
  }
  const callee = unwrapSequence(node.callee);
  if (!t.isIdentifier(callee)) return null;
  if (/awaiter/i.test(callee.name)) return generator;
  // Minified helper name: only trust it when the binding resolves to the
  // __awaiter helper definition shape.
  if (isAwaiterHelper(resolveHelperFn(scope, callee.name))) {
    return generator;
  }
  return null;
}

// A generator function, or regeneratorRuntime.mark(fn) where fn is a
// generator or a `return regeneratorRuntime.wrap(...)` machine stub.
function unwrapGeneratorLike(
  node: t.CallExpression['arguments'][number],
): t.FunctionExpression | t.ArrowFunctionExpression | null {
  if (
    (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
    (node.generator || isWrapMachineStub(node))
  ) {
    return node;
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.property, { name: 'mark' }) &&
    node.arguments.length >= 1 &&
    !t.isSpreadElement(node.arguments[0])
  ) {
    const inner = node.arguments[0];
    if (
      (t.isFunctionExpression(inner) || t.isArrowFunctionExpression(inner)) &&
      (inner.generator || isWrapMachineStub(inner))
    ) {
      return inner;
    }
  }
  return null;
}

// Babel: _asyncToGenerator(generator) or
// _asyncToGenerator(regeneratorRuntime.mark(generator))
function getAsyncToGeneratorInner(
  node: t.CallExpression,
  scope: Scope,
): t.FunctionExpression | t.ArrowFunctionExpression | null {
  if (node.arguments.length !== 1) return null;
  if (node.arguments.some((arg) => t.isSpreadElement(arg))) return null;
  const callee = unwrapSequence(node.callee);
  if (!t.isIdentifier(callee)) return null;
  if (!callee.name.includes('asyncToGenerator')) {
    // Minified helper name: only trust it when the binding resolves to
    // the _asyncToGenerator helper definition shape.
    if (!isAsyncToGeneratorHelper(resolveHelperFn(scope, callee.name))) {
      return null;
    }
  }
  return unwrapGeneratorLike(node.arguments[0]);
}

// regeneratorRuntime.wrap(innerFn [, _marked]) call
function getWrapCall(
  node: t.Node | null | undefined,
): { contextName: string; cases: t.SwitchCase[] } | null {
  if (!t.isCallExpression(node)) return null;
  if (
    !t.isMemberExpression(node.callee) ||
    node.callee.computed ||
    !t.isIdentifier(node.callee.property, { name: 'wrap' })
  ) {
    return null;
  }
  // try/catch machines carry a try-locations table: too complex
  if (node.arguments.length > 2) return null;
  const [innerFn] = node.arguments;
  if (
    !(
      t.isFunctionExpression(innerFn) || t.isArrowFunctionExpression(innerFn)
    ) ||
    innerFn.params.length !== 1 ||
    !t.isIdentifier(innerFn.params[0])
  ) {
    return null;
  }
  return getWrapMachine(innerFn);
}

// function (_context) { while (1) switch (_context.prev = _context.next) {...} }
function getWrapMachine(
  innerFn: t.FunctionExpression | t.ArrowFunctionExpression,
): { contextName: string; cases: t.SwitchCase[] } | null {
  if (!t.isBlockStatement(innerFn.body)) return null;
  if (innerFn.body.body.length !== 1) return null;
  const [only] = innerFn.body.body;
  if (!t.isWhileStatement(only)) return null;
  if (
    !t.isBooleanLiteral(only.test, { value: true }) &&
    !t.isNumericLiteral(only.test, { value: 1 })
  ) {
    return null;
  }
  // regenerator emits `while (1) switch (...) {...}` with no block
  const switchStmt = t.isBlockStatement(only.body)
    ? only.body.body.length === 1
      ? only.body.body[0]
      : null
    : only.body;
  if (!t.isSwitchStatement(switchStmt)) return null;
  const contextName = (innerFn.params[0] as t.Identifier).name;
  const { discriminant } = switchStmt;
  if (
    !t.isAssignmentExpression(discriminant, { operator: '=' }) ||
    !isContextMember(discriminant.left, contextName, 'prev') ||
    !isContextMember(discriminant.right, contextName, 'next')
  ) {
    return null;
  }
  return { contextName, cases: switchStmt.cases };
}

function isWrapMachineStub(
  node: t.FunctionExpression | t.ArrowFunctionExpression,
): boolean {
  if (!t.isBlockStatement(node.body)) return false;
  const body = node.body.body;
  const last = body.at(-1);
  return (
    t.isReturnStatement(last) &&
    body.slice(0, -1).every((stmt) => t.isVariableDeclaration(stmt)) &&
    getWrapCall(last.argument) !== null
  );
}

function isContextMember(
  node: t.Node | null | undefined,
  contextName: string,
  property: string,
): node is t.MemberExpression {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.object, { name: contextName }) &&
    t.isIdentifier(node.property, { name: property })
  );
}

function mentionsContext(node: t.Node, contextName: string): boolean {
  return containsNode(
    node,
    (n) =>
      (t.isMemberExpression(n) &&
        t.isIdentifier(n.object, { name: contextName })) ||
      (t.isIdentifier(n, { name: contextName }) && !t.isFunction(n)),
  );
}

function isAwaitWrapper(
  node: t.Node | null | undefined,
): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.property, { name: 'awrap' })
  );
}

// Convert `yield x` to `await x` inside a generator body.
// Returns false (leaving the node untouched) on `yield*`.
function convertYieldsToAwaits(
  fnPath: NodePath<t.Function>,
  generator: t.FunctionExpression | t.ArrowFunctionExpression,
): boolean {
  let hasDelegateYield = false;
  const skipNested: (inner: NodePath) => void = (inner) => {
    if (inner.node !== generator) inner.skip();
  };
  fnPath.traverse({
    Function: skipNested,
    YieldExpression(inner) {
      if (inner.node.delegate) {
        hasDelegateYield = true;
        inner.stop();
      }
    },
  });
  if (hasDelegateYield) return false;

  fnPath.traverse({
    Function: skipNested,
    YieldExpression(inner) {
      inner.replaceWith(
        t.awaitExpression(inner.node.argument ?? t.identifier('undefined')),
      );
    },
  });
  generator.async = true;
  generator.generator = false;
  return true;
}

interface PendingAwait {
  // Expression whose awaited value fills the next `.sent` read.
  // Each pending value may only be consumed once so the awaited
  // expression is never evaluated twice.
  expression: t.Expression;
  consumed: boolean;
}

type SentMatcher = (
  node: t.Node | null | undefined,
) => node is t.CallExpression | t.MemberExpression;

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

// Child nodes via visitor keys, skipping non-computed member/property
// names (an `arguments` there is not a value reference).
function childNodes(node: t.Node): t.Node[] {
  const children: t.Node[] = [];
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    if (
      (t.isMemberExpression(node) || t.isObjectProperty(node)) &&
      !node.computed &&
      (key === 'property' || key === 'key')
    ) {
      continue;
    }
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) children.push(child);
      }
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function containsNode(node: t.Node, test: (node: t.Node) => boolean): boolean {
  if (test(node)) return true;
  return childNodes(node).some((child) => containsNode(child, test));
}

// Replace a `.sent` read with `await <pending expression>`.
//
// To preserve evaluation order, the read must come first: it must be the
// whole statement expression, the whole `=` RHS, the whole variable init,
// or (for return/abrupt values passed directly) the whole value.
// Anything else bails out with false, as does a read with no pending await.
function takeSent(
  root: t.Node,
  pending: PendingAwait | null,
  isSent: SentMatcher,
): boolean {
  if (!containsNode(root, (n) => isSent(n))) return true;
  if (!pending || pending.consumed) return false;
  let target: t.Node;
  if (isSent(root)) {
    target = root;
  } else if (t.isExpressionStatement(root)) {
    const expr = root.expression;
    if (isSent(expr)) {
      target = expr;
    } else if (
      t.isAssignmentExpression(expr, { operator: '=' }) &&
      isSent(expr.right)
    ) {
      target = expr.right;
    } else {
      return false;
    }
  } else if (t.isVariableDeclaration(root) && root.declarations.length === 1) {
    const init = root.declarations[0].init;
    if (init && isSent(init)) {
      target = init;
    } else {
      return false;
    }
  } else {
    return false;
  }
  pending.consumed = true;
  const awaited = t.awaitExpression(t.cloneNode(pending.expression, true));
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    delete record[key];
  }
  Object.assign(target, awaited);
  return true;
}

// Linearize a regeneratorRuntime.wrap machine covering only straight-line
// awaits. Returns null for anything complex (branching, try/catch, ...).
function linearizeWrapMachine(
  contextName: string,
  cases: t.SwitchCase[],
): t.Statement[] | null {
  if (cases.length === 0) return null;
  const values = cases.map((c) =>
    t.isNumericLiteral(c.test) ? c.test.value : NaN,
  );
  if (values.some((v) => Number.isNaN(v))) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) return null;
  }
  const isSent: SentMatcher = (n): n is t.MemberExpression =>
    t.isMemberExpression(n) && isContextMember(n, contextName, 'sent');
  // try/catch bookkeeping (`prev`, `catch`, temp slots, ...) is out of scope
  const isForeignContextUse = (n: t.Node): boolean =>
    t.isMemberExpression(n) &&
    t.isIdentifier(n.object, { name: contextName }) &&
    !isContextMember(n, contextName, 'next') &&
    !isContextMember(n, contextName, 'sent');
  const holdsSent = (consequent: t.Statement[]): boolean =>
    consequent.some((stmt) => containsNode(stmt, (n) => isSent(n)));

  const output: t.Statement[] = [];
  let pending: PendingAwait | null = null;
  let sawAwait = false;

  for (let i = 0; i < cases.length; i++) {
    const consequent = cases[i].consequent;
    if (consequent.length === 0) return null;
    const last = consequent[consequent.length - 1];
    if (!t.isReturnStatement(last)) return null;
    const isFinal = i === cases.length - 1;

    // A pending awaited value with no `.sent` reader in this case is a
    // discarded result: emit it before this case's statements.
    if (pending && !holdsSent(consequent)) {
      output.push(t.expressionStatement(t.awaitExpression(pending.expression)));
      pending = null;
    }

    // Evaluation order: the pending await may only be consumed by the
    // first kept statement of the case (resume targets are bookkeeping).
    let seenKept = false;
    const consumable = (): PendingAwait | null => (seenKept ? null : pending);

    for (const stmt of consequent.slice(0, -1)) {
      if (
        t.isExpressionStatement(stmt) &&
        t.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
        isContextMember(stmt.expression.left, contextName, 'next') &&
        t.isNumericLiteral(stmt.expression.right)
      ) {
        // Linear resume targets only: the next case must run next.
        if (!isFinal && stmt.expression.right.value !== values[i + 1])
          return null;
        continue;
      }
      if (t.isVariableDeclaration(stmt) || t.isExpressionStatement(stmt)) {
        if (containsNode(stmt, isForeignContextUse)) return null;
        if (!takeSent(stmt, consumable(), isSent)) return null;
        if (mentionsContext(stmt, contextName)) return null;
        output.push(stmt);
        seenKept = true;
        continue;
      }
      return null;
    }

    const { argument } = last;
    // `return _context.stop()`
    if (
      t.isCallExpression(argument) &&
      isContextMember(argument.callee, contextName, 'stop')
    ) {
      continue;
    }
    // `return _context.abrupt("return", value)`
    if (
      t.isCallExpression(argument) &&
      isContextMember(argument.callee, contextName, 'abrupt') &&
      argument.arguments.length === 2 &&
      t.isStringLiteral(argument.arguments[0], { value: 'return' }) &&
      isExpression(argument.arguments[1])
    ) {
      const value = argument.arguments[1];
      if (!takeSent(value, consumable(), isSent)) return null;
      output.push(t.returnStatement(value));
      pending = null;
      continue;
    }
    // `return awrap(value)` -> held for the next `.sent` reader, or
    // emitted directly when nothing reads it
    if (isAwaitWrapper(argument)) {
      const [value] = argument.arguments;
      if (!isExpression(value)) return null;
      // Yielding the just-received value would need a temp: bail out.
      if (containsNode(value, (n) => isSent(n))) return null;
      if (!takeSent(value, consumable(), isSent)) return null;
      sawAwait = true;
      if (isFinal) {
        output.push(t.expressionStatement(t.awaitExpression(value)));
        pending = null;
      } else {
        pending = { expression: value, consumed: false };
      }
      continue;
    }
    // `return value` in the final case is the return value;
    // anywhere else it would be a sync-generator yield: bail out.
    if (isFinal && isExpression(argument)) {
      if (!takeSent(argument, consumable(), isSent)) return null;
      output.push(t.returnStatement(argument));
      pending = null;
      continue;
    }
    return null;
  }

  if (pending) {
    output.push(t.expressionStatement(t.awaitExpression(pending.expression)));
  }

  // Without any await the machine may be a sync generator: leave it alone.
  if (!sawAwait) return null;
  if (output.some((stmt) => mentionsContext(stmt, contextName))) return null;
  return output;
}

// TS helper pairing:
// function* () { return __generator(this, function (_a) { switch (_a.label) {...} }) }
// Only the simple linear chain (yields, no try/catch) is converted.
function getGeneratorMachine(
  node: t.CallExpression,
): { stateName: string; cases: t.SwitchCase[] } | null {
  if (node.arguments.length !== 2) return null;
  const body = node.arguments[1];
  if (
    !t.isFunctionExpression(body) ||
    body.params.length !== 1 ||
    !t.isIdentifier(body.params[0])
  ) {
    return null;
  }
  if (!t.isBlockStatement(body.body) || body.body.body.length !== 1)
    return null;
  const [only] = body.body.body;
  if (!t.isSwitchStatement(only)) return null;
  const stateName = body.params[0].name;
  if (!isContextMember(only.discriminant, stateName, 'label')) return null;
  return { stateName, cases: only.cases };
}

// tslib __generator opcodes we understand: 4 = yield, 2 = return,
// 7 = endfinally. Anything else (break/throw/yield*) bails out.
function linearizeGeneratorMachine(
  stateName: string,
  cases: t.SwitchCase[],
): t.Statement[] | null {
  if (cases.length === 0) return null;
  const values = cases.map((c) =>
    t.isNumericLiteral(c.test) ? c.test.value : NaN,
  );
  if (values.some((v) => Number.isNaN(v))) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) return null;
  }
  const isSent: SentMatcher = (n): n is t.CallExpression =>
    t.isCallExpression(n) &&
    isContextMember(n.callee, stateName, 'sent') &&
    n.arguments.length === 0;

  const output: t.Statement[] = [];
  let pending: PendingAwait | null = null;
  let sawYield = false;

  for (let i = 0; i < cases.length; i++) {
    const { consequent } = cases[i];
    if (consequent.length === 0) return null;
    for (const stmt of consequent) {
      if (
        containsNode(
          stmt,
          (n) =>
            t.isIfStatement(n) ||
            t.isLoop(n) ||
            t.isSwitchStatement(n) ||
            t.isTryStatement(n) ||
            t.isBreakStatement(n) ||
            t.isContinueStatement(n) ||
            t.isThrowStatement(n),
        )
      ) {
        return null;
      }
      if (
        containsNode(
          stmt,
          (n) =>
            t.isAssignmentExpression(n, { operator: '=' }) &&
            isContextMember(n.left, stateName, 'label'),
        )
      ) {
        return null;
      }
    }

    const last = consequent[consequent.length - 1];
    if (!t.isReturnStatement(last)) return null;
    const isFinal = i === cases.length - 1;

    // A pending yielded value with no `.sent()` reader in this case is a
    // discarded result: emit it before this case's statements.
    if (
      pending &&
      !consequent.some((stmt) => containsNode(stmt, (n) => isSent(n)))
    ) {
      output.push(t.expressionStatement(t.awaitExpression(pending.expression)));
      pending = null;
    }

    const head = consequent.slice(0, -1);
    // Evaluation order: the pending yield may only be consumed by the
    // first statement of the case.
    let seenKept = false;
    const consumable = (): PendingAwait | null => (seenKept ? null : pending);
    for (const stmt of head) {
      if (!takeSent(stmt, consumable(), isSent)) return null;
      if (mentionsContext(stmt, stateName)) return null;
      seenKept = true;
    }

    const { argument } = last;
    if (!t.isArrayExpression(argument) || argument.elements.length === 0)
      return null;
    const [kindNode, valueNode] = argument.elements;
    if (!t.isNumericLiteral(kindNode)) return null;
    if (valueNode && !isExpression(valueNode)) return null;
    const value = valueNode ?? t.identifier('undefined');

    if (kindNode.value === 4) {
      // yield -> held for the next `.sent()` reader, or emitted
      // directly when nothing reads it
      // Yielding the just-received value would need a temp: bail out.
      if (containsNode(value, (n) => isSent(n))) return null;
      if (!takeSent(value, consumable(), isSent)) return null;
      sawYield = true;
      if (isFinal) {
        output.push(...head, t.expressionStatement(t.awaitExpression(value)));
        pending = null;
      } else {
        output.push(...head);
        pending = { expression: value, consumed: false };
      }
    } else if (kindNode.value === 2) {
      // return
      if (!takeSent(value, consumable(), isSent)) return null;
      output.push(...head, t.returnStatement(value));
      pending = null;
    } else if (kindNode.value === 7) {
      // endfinally
      output.push(...head);
      pending = null;
    } else {
      return null;
    }
  }

  if (pending) {
    output.push(t.expressionStatement(t.awaitExpression(pending.expression)));
  }

  if (!sawYield) return null;
  if (output.some((stmt) => mentionsContext(stmt, stateName))) return null;
  return output;
}

// Build the async body for a generator function found inside an async
// helper call. Returns null when the body is too complex.
function buildAsyncBody(
  fnPath: NodePath<t.Function>,
  generator: t.FunctionExpression | t.ArrowFunctionExpression,
): t.Statement[] | null {
  if (!t.isBlockStatement(generator.body)) return null;

  // Trivially paired machines: the generator only declares hoisted
  // variables and forwards to a regeneratorRuntime.wrap / __generator
  // state machine.
  const body = generator.body.body;
  const last = body.at(-1);
  if (t.isReturnStatement(last) && t.isCallExpression(last.argument)) {
    const prefix = body.slice(0, -1);
    if (prefix.every((stmt) => t.isVariableDeclaration(stmt))) {
      // Linearize on a clone: `.sent` substitution mutates nodes, and a
      // later case may still bail out, which must leave the input intact.
      const argClone = t.cloneNode(last.argument, /* deep */ true);
      const wrap = getWrapCall(argClone);
      if (wrap) {
        const stmts = linearizeWrapMachine(wrap.contextName, wrap.cases);
        return stmts && [...prefix, ...stmts];
      }
      const machine = getGeneratorMachine(argClone);
      if (machine) {
        const stmts = linearizeGeneratorMachine(
          machine.stateName,
          machine.cases,
        );
        return stmts && [...prefix, ...stmts];
      }
    }
  }

  if (!convertYieldsToAwaits(fnPath, generator)) return null;
  if (!t.isBlockStatement(generator.body)) return null;
  return generator.body.body;
}

function unwrapApply(node: t.Expression): {
  fn: t.FunctionExpression | t.ArrowFunctionExpression;
  thisArg: t.Expression;
  args: t.Expression;
} | null {
  if (!t.isCallExpression(node)) return null;
  const { callee } = node;
  if (
    !t.isMemberExpression(callee) ||
    callee.computed ||
    !t.isIdentifier(callee.property, { name: 'apply' })
  ) {
    return null;
  }
  const { object } = callee;
  if (!t.isFunctionExpression(object) && !t.isArrowFunctionExpression(object))
    return null;
  if (!object.async) return null;
  if (node.arguments.length !== 2) return null;
  const [thisArg, args] = node.arguments;
  if (!isExpression(thisArg) || !isExpression(args)) return null;
  return { fn: object, thisArg, args };
}

// Whether the helper body can be inlined into the outer function without
// changing `this`/`arguments` semantics.
function canInlineApply(
  fn: t.FunctionExpression | t.ArrowFunctionExpression,
  thisArg: t.Expression,
  args: t.Expression,
): boolean {
  // Without parameter mapping only a parameterless body can move
  if (fn.params.length !== 0) return false;
  let usesThis = false;
  let usesArguments = false;
  const visit = (node: t.Node, isRoot: boolean): void => {
    if (!isRoot && t.isFunction(node) && !t.isArrowFunctionExpression(node)) {
      return;
    }
    if (t.isThisExpression(node)) usesThis = true;
    if (t.isIdentifier(node, { name: 'arguments' })) usesArguments = true;
    for (const child of childNodes(node)) {
      visit(child, false);
    }
  };
  visit(fn, true);

  if (usesThis && !t.isArrowFunctionExpression(fn)) {
    // Inlined `this` is the outer function's `this`
    if (!t.isThisExpression(thisArg)) return false;
  }
  if (usesArguments && !t.isArrowFunctionExpression(fn)) {
    // Inlined `arguments` is the outer function's `arguments`
    if (!t.isIdentifier(args, { name: 'arguments' })) return false;
  }
  // Dropping the `.apply()` call drops thisArg/args evaluation, so both
  // must be side-effect-free for the inline to be valid.
  if (!isPureHelperArg(thisArg) || !isPureHelperArg(args)) return false;
  return true;
}

// thisArg/args positions of the async helpers only ever carry `this`,
// `void 0`, `undefined`, `arguments`, identifiers, or plain literals.
function isPureHelperArg(node: t.Expression): boolean {
  return (
    t.isThisExpression(node) ||
    t.isIdentifier(node) ||
    (t.isUnaryExpression(node, { operator: 'void' }) &&
      t.isNumericLiteral(node.argument)) ||
    t.isNullLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isBigIntLiteral(node)
  );
}

function childFunctionPath(
  path: NodePath,
  key: string,
): NodePath<t.Function> | null {
  const child = path.get(key) as unknown as NodePath | NodePath[];
  if (Array.isArray(child)) return null;
  return child as NodePath<t.Function>;
}

export default {
  name: 'async-await',
  tags: ['safe'],
  scope: true,
  visitor() {
    return {
      CallExpression: {
        exit(path) {
          const { node } = path;

          const awaiterGenerator = getAwaiterGenerator(node, path.scope);
          if (awaiterGenerator) {
            const fnPath = childFunctionPath(path, 'arguments.3');
            if (!fnPath) return;
            const stmts = buildAsyncBody(fnPath, awaiterGenerator);
            if (!stmts) return;
            const args = node.arguments as t.Expression[];
            path.replaceWith(
              t.callExpression(
                t.memberExpression(
                  t.functionExpression(
                    null,
                    // Keep the generator params (TS emits default/rest
                    // params here); canInlineApply refuses to inline a
                    // body with params below.
                    awaiterGenerator.params,
                    t.blockStatement(stmts),
                    false,
                    true,
                  ),
                  t.identifier('apply'),
                ),
                [args[0], args[1]],
              ),
            );
            this.changes++;
            return;
          }

          const inner = getAsyncToGeneratorInner(node, path.scope);
          if (inner) {
            const arg = node.arguments[0];
            const fnPath =
              t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)
                ? childFunctionPath(path, 'arguments.0')
                : t.isCallExpression(arg)
                  ? childFunctionPath(path, 'arguments.0.arguments.0')
                  : null;
            if (!fnPath) return;
            const stmts = buildAsyncBody(fnPath, inner);
            if (!stmts) return;
            path.replaceWith(
              t.functionExpression(
                t.isFunctionExpression(inner) ? (inner.id ?? null) : null,
                inner.params as (t.Identifier | t.Pattern | t.RestElement)[],
                t.blockStatement(stmts),
                false,
                true,
              ),
            );
            this.changes++;
          }
        },
      },
      Function: {
        exit(path) {
          const { node } = path;
          if (
            (t.isClassMethod(node) || t.isClassPrivateMethod(node)) &&
            node.kind === 'constructor'
          ) {
            return;
          }
          if (
            (t.isClassMethod(node) || t.isObjectMethod(node)) &&
            (node.kind === 'get' || node.kind === 'set')
          ) {
            // `async get x()` / `async set x()` is invalid syntax
            return;
          }
          if (
            t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isObjectMethod(node) ||
            t.isClassMethod(node) ||
            t.isClassPrivateMethod(node)
          ) {
            // Collapsing into a generator wrapper would produce
            // `async function*`, which changes semantics.
            if (node.generator) return;
          }

          let returned: t.Expression;
          if (t.isBlockStatement(node.body)) {
            if (node.body.body.length !== 1) return;
            const [only] = node.body.body;
            if (!t.isReturnStatement(only) || !isExpression(only.argument))
              return;
            returned = only.argument;
          } else if (t.isArrowFunctionExpression(node)) {
            if (!isExpression(node.body)) return;
            returned = node.body;
          } else {
            return;
          }

          const applied = unwrapApply(returned);
          if (!applied) return;
          if (!t.isBlockStatement(applied.fn.body)) return;
          if (!canInlineApply(applied.fn, applied.thisArg, applied.args))
            return;

          node.async = true;
          if (
            t.isArrowFunctionExpression(node) &&
            !t.isBlockStatement(node.body)
          ) {
            node.body = t.blockStatement(applied.fn.body.body);
          } else {
            (node.body as t.BlockStatement).body = applied.fn.body.body;
          }
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
