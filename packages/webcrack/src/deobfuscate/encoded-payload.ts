import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AsyncTransform } from '../ast-utils';
import { generate } from '../ast-utils';
import type { Sandbox } from './vm';

/**
 * Decodes JSFuck/JJEncode/AAEncode-style payloads wrapped in a `Function`
 * constructor invocation, e.g. `[]["filter"]["constructor"](<expr>)()`,
 * `<x>.constructor(<expr>)()` or `Function(<expr>)()`.
 *
 * Only the payload expression `<expr>` is evaluated, and only in the
 * sandbox. The outer call is never executed: when `<expr>` is
 * side-effect-free (literals, arrays/objects, operators and property
 * access — no calls, assignments or references to user bindings) it is
 * evaluated to a string and the whole call is rewritten as
 * `Function("<decoded>")()`, which the `evalUnwrap` pass splices open on
 * the next iteration of the unwrap loop.
 */
export default {
  name: 'encoded-payload',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    if (!sandbox) return;

    const candidates: NodePath<t.CallExpression>[] = [];
    traverse(ast, {
      CallExpression(path) {
        if (asPayloadInvocation(path) !== null) candidates.push(path);
      },
    });

    for (const path of candidates) {
      // A previous replacement may have removed or altered this node.
      if (path.removed || !t.isCallExpression(path.node)) continue;
      const invocation = asPayloadInvocation(path);
      if (invocation === null) continue;
      const { payload, scope, directFunction } = invocation;

      // Bare `Function("<static>")()` is `evalUnwrap`'s job; rewriting it
      // here would only add a redundant change to the unwrap loop.
      if (directFunction && getStaticString(payload) !== undefined) continue;

      const decoded = await decodePayload(payload, scope, sandbox);
      if (decoded === undefined) continue;

      path.replaceWith(
        t.callExpression(
          t.callExpression(t.identifier('Function'), [
            t.stringLiteral(decoded),
          ]),
          [],
        ),
      );
      state.changes++;
    }
  },
} satisfies AsyncTransform<Sandbox>;

interface PayloadInvocation {
  /** The single payload argument of the inner constructor call. */
  payload: t.Expression;
  scope: NodePath['scope'];
  /** Whether the inner call targets the bare `Function` identifier. */
  directFunction: boolean;
}

/**
 * Matches `<inner>(...)` calls with no arguments whose callee is a
 * single-argument constructor call: `Function(<expr>)` or
 * `<x>.constructor(<expr>)` (dot or statically-known computed access).
 * Returns the payload expression, or null for anything else. In
 * particular multi-argument `Function("a", "body")` constructions (which
 * declare parameters) and `new Function(...)` are left alone.
 */
function asPayloadInvocation(
  path: NodePath<t.CallExpression>,
): PayloadInvocation | null {
  if (path.node.arguments.length !== 0) return null;
  const callee = path.get('callee');
  if (!callee.isCallExpression()) return null;
  if (callee.node.arguments.length !== 1) return null;

  const innerCallee = callee.get('callee');
  let directFunction = false;
  if (innerCallee.isIdentifier({ name: 'Function' })) {
    // A shadowed `Function` is some user value, not the constructor.
    if (path.scope.getBinding('Function')) return null;
    directFunction = true;
  } else if (innerCallee.isMemberExpression()) {
    // `.constructor` or a computed access statically known to select
    // `constructor` (`["constructor"]`, `["con" + "structor"]`, ...).
    if (!isConstructorAccess(innerCallee.node)) return null;
  } else {
    return null;
  }

  const payload = callee.node.arguments[0];
  if (!t.isExpression(payload)) return null;
  return { payload, scope: path.scope, directFunction };
}

function isConstructorAccess(node: t.MemberExpression): boolean {
  if (!node.computed) {
    return t.isIdentifier(node.property, { name: 'constructor' });
  }
  return getStaticString(node.property) === 'constructor';
}

/**
 * Statically known strings: string literals, untagged template literals
 * without expressions, and `+` concatenations of those. Anything else
 * would have to be evaluated, which this helper never does.
 */
function getStaticString(node: t.Node | null | undefined): string | undefined {
  if (node == null) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length > 0) return undefined;
    let result = '';
    for (const quasi of node.quasis) {
      if (quasi.value.cooked === undefined) return undefined;
      result += quasi.value.cooked;
    }
    return result;
  }
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = getStaticString(node.left);
    if (left === undefined) return undefined;
    const right = getStaticString(node.right);
    if (right === undefined) return undefined;
    return left + right;
  }
  return undefined;
}

// Globals that are safe to read while evaluating a payload: non-writable
// data properties of the global object. Anything else (including a
// shadowed one, which has a binding) is rejected below.
const SAFE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);

/**
 * Whether evaluating `node` can have no observable side effects: only
 * literals, arrays/objects, operators and property access on those, with
 * no calls, assignments, `this`/`arguments`/`eval` or references to user
 * bindings. Anything not explicitly allowed is rejected.
 */
function isPurePayload(
  node: t.Node | null | undefined,
  scope: NodePath['scope'],
): boolean {
  if (node == null) return true;
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isRegExpLiteral(node) ||
    t.isBigIntLiteral(node)
  ) {
    return true;
  }
  if (t.isIdentifier(node)) {
    return SAFE_GLOBALS.has(node.name) && !scope.getBinding(node.name);
  }
  if (t.isTemplateLiteral(node)) {
    return (
      node.quasis.every((quasi) => quasi.value.cooked !== undefined) &&
      node.expressions.every(
        (expression) =>
          t.isExpression(expression) && isPurePayload(expression, scope),
      )
    );
  }
  if (t.isArrayExpression(node)) {
    return node.elements.every(
      (element) =>
        element === null ||
        (t.isSpreadElement(element)
          ? isPurePayload(element.argument, scope)
          : isPurePayload(element, scope)),
    );
  }
  if (t.isObjectExpression(node)) {
    return node.properties.every((property) => {
      if (t.isSpreadElement(property)) {
        return isPurePayload(property.argument, scope);
      }
      if (t.isObjectProperty(property)) {
        const key = property.computed
          ? isPurePayload(property.key, scope)
          : t.isIdentifier(property.key) ||
            t.isStringLiteral(property.key) ||
            t.isNumericLiteral(property.key);
        return key && isPurePayload(property.value, scope);
      }
      // Object methods are not invoked by creating the object, but they
      // are outside the documented payload shape, so reject them.
      return false;
    });
  }
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return isPurePayload(node.left, scope) && isPurePayload(node.right, scope);
  }
  if (t.isConditionalExpression(node)) {
    return (
      isPurePayload(node.test, scope) &&
      isPurePayload(node.consequent, scope) &&
      isPurePayload(node.alternate, scope)
    );
  }
  if (t.isSequenceExpression(node)) {
    return node.expressions.every((expression) =>
      isPurePayload(expression, scope),
    );
  }
  if (t.isUnaryExpression(node)) {
    // `delete` mutates its operand; `typeof`/`void` and the arithmetic
    // operators only read theirs.
    return node.operator !== 'delete' && isPurePayload(node.argument, scope);
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!isPurePayload(node.object, scope)) return false;
    // `obj.#field` can only appear inside a class, where evaluating the
    // payload could observe class state; reject private access outright.
    if (t.isPrivateName(node.property)) return false;
    if (node.computed) return isPurePayload(node.property, scope);
    return true;
  }
  if (t.isParenthesizedExpression(node)) {
    return isPurePayload(node.expression, scope);
  }
  return false;
}

async function decodePayload(
  payload: t.Expression,
  scope: NodePath['scope'],
  sandbox: Sandbox,
): Promise<string | undefined> {
  // A statically known payload needs no sandbox round-trip; the rewrite
  // in run() hands it to `evalUnwrap` as `Function("...")()`.
  const staticString = getStaticString(payload);
  if (staticString !== undefined) return staticString;

  if (!isPurePayload(payload, scope)) return undefined;

  let decoded: unknown;
  try {
    decoded = await sandbox(`(${generate(payload)})`);
  } catch {
    // Payloads that throw (or time out) in the sandbox are left untouched.
    return undefined;
  }
  return typeof decoded === 'string' ? decoded : undefined;
}
