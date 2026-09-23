import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AsyncTransform } from '../ast-utils';
import { generate } from '../ast-utils';
import type { Sandbox } from './vm';

/**
 * Decodes real JJEncode output, e.g.
 * `V=~[];V={___:++V,...};...;V.$(V.$(V.$$+"\""+...+"\"")())();`
 * (the encoder variable is user-chosen, not necessarily `$`).
 *
 * A block is a run of consecutive statements in one statement list:
 * `V=~[]`, then `V={<object>}`, then zero or more `V...=...`
 * assignments, then a final `V.$(V.$(<payload>)())();` call. Every
 * preamble statement must match the encoder's expression grammar
 * exactly (only the encoder variable, literals, `~`/`!`/`+`/`-`,
 * `++V`, `+` and member access / object literals built from those —
 * no calls, no other identifiers), otherwise the block is skipped and
 * nothing reaches the sandbox.
 *
 * Decoding evaluates only the payload-building part in the sandbox:
 * the preamble plus the inner `V.$(<payload>)()` expression, which
 * returns the decoded source without executing it. The whole block is
 * then rewritten as `Function("<decoded>")()`, which `evalUnwrap`
 * splices open on the next iteration of the unwrap loop.
 */
export default {
  name: 'jjencode',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    if (!sandbox) return;

    const bodies: NodePath<t.Statement>[][] = [];
    traverse(ast, {
      Program(path) {
        bodies.push(path.get('body'));
      },
      BlockStatement(path) {
        bodies.push(path.get('body'));
      },
    });

    for (const body of bodies) {
      let index = 0;
      while (index < body.length) {
        const block = matchBlock(body, index);
        if (block === null) {
          index++;
          continue;
        }
        const decoded = await decodeBlock(block, sandbox);
        if (decoded === undefined) {
          index = block.end + 1;
          continue;
        }
        const [first, ...rest] = block.paths;
        if (first.removed || rest.some((path) => path.removed)) {
          index = block.end + 1;
          continue;
        }
        first.replaceWith(
          t.callExpression(
            t.callExpression(t.identifier('Function'), [
              t.stringLiteral(decoded),
            ]),
            [],
          ),
        );
        for (const path of rest) path.remove();
        state.changes++;
        index = block.end + 1;
      }
    }
  },
} satisfies AsyncTransform<Sandbox>;

interface EncodedBlock {
  /** Statement paths of the whole block (preamble + final call). */
  paths: NodePath<t.Statement>[];
  /** Index of the final call statement within the scanned body. */
  end: number;
  /** The inner `V.$(<payload>)()` expression, evaluating to the source. */
  payload: t.CallExpression;
}

/**
 * Matches a block starting at `body[index]`: `V=~[]`, then
 * `V={<object>}`, then `V...=...` assignments, then the final
 * `V.$(V.$(<payload>)())();` call. Returns null when any part is
 * missing, names a different variable, or has a user binding.
 */
function matchBlock(
  body: NodePath<t.Statement>[],
  index: number,
): EncodedBlock | null {
  const name = asInitAssignment(body[index]);
  if (name === null) return null;
  const scope = body[index].scope;
  // A declared `V` (or `Function`) means this is user code sharing the
  // name, not encoder output; the replacement below would break it.
  if (scope.getBinding(name) || scope.getBinding('Function')) return null;

  const second = body[index + 1];
  if (
    second === undefined ||
    asPreambleAssignment(second, name) !== 'object' ||
    second.removed
  ) {
    return null;
  }

  let end = index + 2;
  while (
    end < body.length &&
    !body[end].removed &&
    asPreambleAssignment(body[end], name) !== null
  ) {
    end++;
  }
  const final = body[end];
  if (final === undefined || final.removed) return null;
  const payload = asFinalCall(final, name);
  if (payload === null) return null;
  return { paths: body.slice(index, end + 1), end, payload };
}

/**
 * `V=~[]`: the signature first statement of encoder output. Returns
 * the variable name, or null for anything else.
 */
function asInitAssignment(path: NodePath<t.Statement>): string | null {
  if (path.removed || !path.isExpressionStatement()) return null;
  const expression = path.node.expression;
  if (
    !t.isAssignmentExpression(expression, { operator: '=' }) ||
    !t.isIdentifier(expression.left) ||
    !t.isUnaryExpression(expression.right, { operator: '~' }) ||
    !t.isArrayExpression(expression.right.argument) ||
    expression.right.argument.elements.length !== 0
  ) {
    return null;
  }
  return expression.left.name;
}

/**
 * A preamble `V...=...` assignment matching the encoder grammar.
 * Returns `'object'` when the value is an object literal (required for
 * the second statement), `'assign'` otherwise, or null when the
 * statement has any other shape.
 */
function asPreambleAssignment(
  path: NodePath<t.Statement>,
  name: string,
): 'object' | 'assign' | null {
  if (path.removed || !path.isExpressionStatement()) return null;
  const expression = path.node.expression;
  if (
    !t.isAssignmentExpression(expression, { operator: '=' }) ||
    !isEncoderTarget(expression.left, name) ||
    !t.isExpression(expression.right) ||
    !isEncoderExpression(expression.right, name)
  ) {
    return null;
  }
  return t.isObjectExpression(expression.right) ? 'object' : 'assign';
}

/**
 * The final `V.$(V.$(<payload>)())();` statement. Returns the inner
 * `V.$(<payload>)()` call, which evaluates to the decoded source, or
 * null for any other shape. The payload itself must match the encoder
 * grammar; the two calls are fixed to the encoder's `V.$` helper.
 */
function asFinalCall(
  path: NodePath<t.Statement>,
  name: string,
): t.CallExpression | null {
  if (path.removed || !path.isExpressionStatement()) return null;
  const outer = path.node.expression;
  if (!t.isCallExpression(outer) || outer.arguments.length !== 0) return null;
  const inner = outer.callee;
  if (
    !t.isCallExpression(inner) ||
    inner.arguments.length !== 1 ||
    !isDollarMember(inner.callee, name)
  ) {
    return null;
  }
  const payload = inner.arguments[0];
  if (!t.isCallExpression(payload) || payload.arguments.length !== 0) {
    return null;
  }
  const factory = payload.callee;
  if (
    !t.isCallExpression(factory) ||
    factory.arguments.length !== 1 ||
    !isDollarMember(factory.callee, name)
  ) {
    return null;
  }
  const source = factory.arguments[0];
  if (!t.isExpression(source) || !isEncoderExpression(source, name)) {
    return null;
  }
  return payload;
}

function isDollarMember(node: t.Node | null | undefined, name: string) {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.object, { name }) &&
    t.isIdentifier(node.property, { name: '$' })
  );
}

/**
 * Assignment targets of the encoder grammar: the encoder variable
 * itself or member expressions rooted in it (`V`, `V.$_`, `V[x]`).
 */
function isEncoderTarget(node: t.Node | null | undefined, name: string) {
  if (t.isIdentifier(node)) return node.name === name;
  if (!t.isMemberExpression(node)) return false;
  if (!isEncoderTarget(node.object, name)) return false;
  if (t.isPrivateName(node.property)) return false;
  if (node.computed) {
    return (
      t.isExpression(node.property) && isEncoderExpression(node.property, name)
    );
  }
  return t.isIdentifier(node.property);
}

/**
 * Whether evaluating `node` only reads the encoder variable and has no
 * other observable effects: the variable itself, literals, `[]`,
 * `~`/`!`/`+`/`-`, prefix `++V`, `+`, `=` assignments to encoder
 * targets, and member access / object literals built from those. No
 * calls, no other identifiers, no `this` or functions — anything not
 * explicitly allowed is rejected, so arbitrary program statements can
 * never reach the sandbox through this check.
 */
function isEncoderExpression(
  node: t.Node | null | undefined,
  name: string,
): boolean {
  if (node == null) return true;
  if (t.isIdentifier(node)) return node.name === name;
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
  if (t.isArrayExpression(node)) {
    return node.elements.every(
      (element) =>
        element === null ||
        (t.isExpression(element) && isEncoderExpression(element, name)),
    );
  }
  if (t.isObjectExpression(node)) {
    return node.properties.every((property) => {
      if (!t.isObjectProperty(property)) return false;
      const key = property.computed
        ? t.isExpression(property.key) &&
          isEncoderExpression(property.key, name)
        : t.isIdentifier(property.key) ||
          t.isStringLiteral(property.key) ||
          t.isNumericLiteral(property.key);
      return (
        key &&
        t.isExpression(property.value) &&
        isEncoderExpression(property.value, name)
      );
    });
  }
  if (t.isMemberExpression(node)) {
    if (!isEncoderExpression(node.object, name)) return false;
    if (t.isPrivateName(node.property)) return false;
    if (node.computed) {
      return (
        t.isExpression(node.property) &&
        isEncoderExpression(node.property, name)
      );
    }
    return t.isIdentifier(node.property);
  }
  if (t.isUnaryExpression(node)) {
    return (
      (node.operator === '~' ||
        node.operator === '!' ||
        node.operator === '+' ||
        node.operator === '-') &&
      isEncoderExpression(node.argument, name)
    );
  }
  if (t.isUpdateExpression(node)) {
    return (
      node.operator === '++' &&
      node.prefix &&
      t.isIdentifier(node.argument, { name })
    );
  }
  if (t.isBinaryExpression(node)) {
    return (
      node.operator === '+' &&
      t.isExpression(node.left) &&
      t.isExpression(node.right) &&
      isEncoderExpression(node.left, name) &&
      isEncoderExpression(node.right, name)
    );
  }
  if (t.isAssignmentExpression(node)) {
    return (
      node.operator === '=' &&
      isEncoderTarget(node.left, name) &&
      t.isExpression(node.right) &&
      isEncoderExpression(node.right, name)
    );
  }
  return false;
}

async function decodeBlock(
  block: EncodedBlock,
  sandbox: Sandbox,
): Promise<string | undefined> {
  const setup = block.paths
    .slice(0, -1)
    .map((path) => generate(path.node))
    .join('\n');
  let decoded: unknown;
  try {
    decoded = await sandbox(`${setup}\n(${generate(block.payload)});`);
  } catch {
    // Payloads that throw (or time out) in the sandbox are left untouched.
    return undefined;
  }
  return typeof decoded === 'string' ? decoded : undefined;
}
