import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../ast-utils';

// Cap folded strings to avoid huge outputs (e.g. repeated concatenation).
const MAX_STRING_LENGTH = 10_000;

const BINARY_OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '<<',
  '>>',
  '>>>',
  '|',
  '&',
  '^',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
]);

const UNARY_OPERATORS = new Set(['!', '+', '-', '~', 'typeof']);

// Only these node types may appear inside a folded expression. Anything else
// (identifiers, calls, member access with possible getters, objects with
// possible getters/setters, functions, etc.) makes the expression impure and
// it is left alone.
function isPure(node: t.Node | null | undefined): boolean {
  if (node == null) return true;
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  ) {
    return true;
  }
  if (t.isTemplateLiteral(node)) {
    return node.expressions.length === 0;
  }
  if (t.isArrayExpression(node)) {
    return node.elements.every(
      (element) =>
        element !== null && !t.isSpreadElement(element) && isPure(element),
    );
  }
  if (t.isUnaryExpression(node)) {
    return UNARY_OPERATORS.has(node.operator) && isPure(node.argument);
  }
  if (t.isBinaryExpression(node)) {
    return (
      BINARY_OPERATORS.has(node.operator) &&
      isPure(node.left) &&
      isPure(node.right)
    );
  }
  if (t.isLogicalExpression(node)) {
    return isPure(node.left) && isPure(node.right);
  }
  return false;
}

// Already in canonical folded form ("-5" parses as UnaryExpression). Folding
// it again would replace the node with an identical one forever.
function isCanonical(node: t.Node): boolean {
  return (
    t.isUnaryExpression(node) &&
    (node.operator === '-' || node.operator === '+') &&
    t.isNumericLiteral(node.argument)
  );
}

function toLiteral(value: unknown): t.Node | null {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) return null;
    return t.stringLiteral(value);
  }
  if (typeof value === 'number') {
    // NaN and ±Infinity have no literal form; folding to the `NaN`/`Infinity`
    // globals could resolve to shadowed bindings, so leave them alone.
    if (!Number.isFinite(value)) return null;
    if (Object.is(value, -0)) {
      return t.unaryExpression('-', t.numericLiteral(0));
    }
    if (value < 0) {
      return t.unaryExpression('-', t.numericLiteral(-value));
    }
    return t.numericLiteral(value);
  }
  if (typeof value === 'boolean') {
    return t.booleanLiteral(value);
  }
  if (value === null) {
    return t.nullLiteral();
  }
  // undefined, objects, functions, symbols, bigints: no safe literal form.
  return null;
}

export default {
  name: 'constant-folding',
  tags: ['safe'],
  visitor() {
    return {
      'BinaryExpression|LogicalExpression|UnaryExpression': {
        exit(_path) {
          const path = _path as NodePath<
            t.BinaryExpression | t.LogicalExpression | t.UnaryExpression
          >;
          if (isCanonical(path.node)) return;
          if (!isPure(path.node)) return;

          let evaluated: { confident: boolean; value: unknown };
          try {
            evaluated = path.evaluate();
          } catch {
            return;
          }
          if (!evaluated.confident) return;

          const replacement = toLiteral(evaluated.value);
          if (replacement === null) return;

          // A bare string literal at the start of a function/program body is
          // a directive prologue, so folding `"use" + " strict"` there into
          // `"use strict"` would silently enable strict mode. Only string
          // results can become directives, so only those are skipped.
          if (
            t.isStringLiteral(replacement) &&
            path.parentPath.isExpressionStatement()
          ) {
            return;
          }

          path.replaceWith(replacement);
          path.skip();
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
