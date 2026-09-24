import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../ast-utils';

// Global aliases whose `.eval` property is the indirect eval. When a local
// binding shadows one of these names the call is left alone.
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'global']);

/**
 * Statically known strings: string literals, untagged template literals
 * without expressions, and `+` concatenations of those. Anything else
 * (identifiers, calls, ...) would have to be evaluated, which this
 * transform never does — nothing is executed.
 */
function getStaticString(node: t.Node | null | undefined): string | undefined {
  if (node == null) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length > 0) return undefined;
    let result = '';
    for (const quasi of node.quasis) {
      // `cooked` is undefined for invalid escape sequences, which throw at
      // runtime, so bail out instead of guessing a value.
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

// Side-effect-free literals allowed before the `eval` in `(0, eval)` style
// indirect calls. Anything else is left alone so no evaluation is dropped.
function isBenignPrefix(node: t.Expression): boolean {
  if (
    t.isNumericLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    (t.isTemplateLiteral(node) && node.expressions.length === 0)
  ) {
    return true;
  }
  return (
    t.isUnaryExpression(node) &&
    (node.operator === 'void' ||
      node.operator === '!' ||
      node.operator === '~' ||
      node.operator === '+' ||
      node.operator === '-') &&
    isBenignPrefix(node.argument)
  );
}

function isGlobalEvalMember(
  node: t.Node | null | undefined,
  scope: NodePath['scope'],
): boolean {
  if (!t.isMemberExpression(node)) return false;
  if (!t.isIdentifier(node.object) || !GLOBAL_OBJECTS.has(node.object.name)) {
    return false;
  }
  if (scope.getBinding(node.object.name)) return false;
  if (!node.computed && t.isIdentifier(node.property)) {
    return node.property.name === 'eval';
  }
  return node.computed && t.isStringLiteral(node.property, { value: 'eval' });
}

// Direct `eval(...)` (shares the caller's scope) and indirect
// `(0, eval)(...)` / `window.eval(...)` / `globalThis.eval(...)` variants
// (run in global scope). Both are only inlined at positions without an
// enclosing function, where the two scopes coincide, so no distinction is
// needed here.
function isEvalCallee(
  callee: t.Expression | t.V8IntrinsicIdentifier,
  scope: NodePath['scope'],
): boolean {
  if (t.isIdentifier(callee, { name: 'eval' })) {
    return !scope.getBinding('eval');
  }
  if (isGlobalEvalMember(callee, scope)) return true;
  if (t.isSequenceExpression(callee)) {
    const expressions = callee.expressions;
    if (expressions.length === 0) return false;
    if (!expressions.slice(0, -1).every(isBenignPrefix)) return false;
    const last = expressions[expressions.length - 1];
    return (
      (t.isIdentifier(last, { name: 'eval' }) && !scope.getBinding('eval')) ||
      isGlobalEvalMember(last, scope)
    );
  }
  return false;
}

// `Function(...)` or `new Function(...)` referencing the unshadowed global.
function asFunctionConstruction(
  node: t.Node | null | undefined,
  scope: NodePath['scope'],
): { args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[] } | null {
  if (!t.isCallExpression(node) && !t.isNewExpression(node)) return null;
  if (!t.isIdentifier(node.callee, { name: 'Function' })) return null;
  if (scope.getBinding('Function')) return null;
  return { args: node.arguments };
}

// Nodes re-parsed from a decoded string carry `loc` relative to that
// string. With Options.sourceMap (keepLoc) those positions would map the
// output to made-up input locations, so strip them and point the spliced
// top-level statements (or the replacement expression) at the node they
// replace instead.
function stripLoc(node: t.Node): void {
  node.loc = undefined;
  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;
  for (const key of keys) {
    const value: unknown = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (t.isNode(child)) stripLoc(child);
      }
    } else if (t.isNode(value)) {
      stripLoc(value);
    }
  }
}

function parseStatements(code: string): t.Statement[] | undefined {
  try {
    const program = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      plugins: ['jsx'],
    }).program;
    // A leading directive (e.g. "use strict") applies to the eval scope
    // only; the parser lifts it out of `body`, so splicing the rest would
    // silently drop it and could change strictness-sensitive behavior.
    if (program.directives.length > 0) return undefined;
    for (const statement of program.body) stripLoc(statement);
    return program.body;
  } catch {
    // Unparseable payloads are left untouched.
    return undefined;
  }
}

// `Function("a", "b", "return a + b")` becomes
// `function (a, b) { return a + b; }`. Parsing params and body together also
// validates the combination (e.g. a "use strict" body with duplicate params
// throws, just like the Function constructor would at runtime).
function parseFunctionExpression(
  paramSources: string[],
  bodySource: string,
): t.FunctionExpression | undefined {
  try {
    const program = parse(
      `function __unwrap(${paramSources.join(',')}) {\n${bodySource}\n}`,
      { sourceType: 'script', plugins: ['jsx'] },
    ).program.body;
    const declaration = program[0];
    if (program.length !== 1 || !t.isFunctionDeclaration(declaration)) {
      return undefined;
    }
    const fn = t.functionExpression(null, declaration.params, declaration.body);
    stripLoc(fn);
    return fn;
  } catch {
    return undefined;
  }
}

// A top-level `return` can only come from direct eval inside a function
// (untouched, see below) or from throwing indirect eval, so splicing it
// outside any function would produce invalid code.
function hasTopLevelReturn(statements: t.Statement[]): boolean {
  return statements.some((statement) => t.isReturnStatement(statement));
}

// Import/export declarations cannot be spliced into an arbitrary position
// (and adding the file's first import would flip it into a module).
function hasImportExport(statements: t.Statement[]): boolean {
  return statements.some(
    (statement) =>
      t.isImportDeclaration(statement) ||
      t.isExportNamedDeclaration(statement) ||
      t.isExportDefaultDeclaration(statement) ||
      t.isExportAllDeclaration(statement),
  );
}

// Spliced `var`/`function` redeclarations are harmless, but a new lexical
// declaration colliding with any visible binding would be a SyntaxError.
function hasLexicalConflict(
  scope: NodePath['scope'],
  statements: t.Statement[],
): boolean {
  for (const statement of statements) {
    if (t.isVariableDeclaration(statement)) {
      const varLike = statement.kind === 'var';
      for (const declarator of statement.declarations) {
        for (const name of Object.keys(
          t.getBindingIdentifiers(declarator.id),
        )) {
          const existing = scope.getBinding(name);
          if (!existing) continue;
          if (
            varLike &&
            (existing.kind === 'var' || existing.kind === 'hoisted')
          ) {
            continue;
          }
          return true;
        }
      }
    } else if (
      (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement)) &&
      statement.id
    ) {
      const existing = scope.getBinding(statement.id.name);
      if (!existing) continue;
      if (
        t.isFunctionDeclaration(statement) &&
        (existing.kind === 'var' || existing.kind === 'hoisted')
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function spliceStatements(
  statement: NodePath<t.ExpressionStatement>,
  statements: t.Statement[],
): boolean {
  if (!Array.isArray(statement.container)) return false;
  if (hasLexicalConflict(statement.scope, statements)) return false;
  const loc = statement.node.loc;
  if (loc != null) {
    for (const spliced of statements) spliced.loc = loc;
  }
  statement.replaceWithMultiple(statements);
  return true;
}

function inlineFunctionBody(
  path: NodePath<t.CallExpression>,
  bodySource: string,
  state: { changes: number },
): void {
  // A Function body always runs in global scope, so calls nested
  // inside another function (whose locals the payload must not see)
  // are left untouched.
  if (path.getFunctionParent() !== null) return;
  const statements = parseStatements(bodySource);
  if (statements === undefined || hasImportExport(statements)) return;
  const parent = path.parentPath;
  if (
    parent.isExpressionStatement() &&
    Array.isArray(parent.container) &&
    !hasTopLevelReturn(statements) &&
    spliceStatements(parent, statements)
  ) {
    state.changes++;
    return;
  }
  // Expression (or single-statement) position: an IIFE preserves the
  // `return` behavior, the local scoping, and the call value
  // (`undefined` unless the body returns).
  const replacement = t.callExpression(
    t.functionExpression(null, [], t.blockStatement(statements)),
    [],
  );
  replacement.loc = path.node.loc;
  path.replaceWith(replacement);
  state.changes++;
}

function convertConstruction(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
  state: { changes: number },
): void {
  // Same global-scope reasoning as above: a converted function
  // expression nested in another function would capture its locals.
  if (path.getFunctionParent() !== null) return;
  const sources = args.map(getStaticString);
  if (sources.some((source) => source === undefined)) return;
  const strings = sources as string[];
  const fn = parseFunctionExpression(
    strings.slice(0, -1),
    strings.length === 0 ? '' : strings[strings.length - 1],
  );
  if (!fn) return;
  fn.loc = path.node.loc;
  path.replaceWith(fn);
  state.changes++;
}

export default {
  name: 'eval-unwrap',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      CallExpression: {
        exit(path) {
          const node = path.node;

          // `Function("code")()` / `new Function("code")()` with a single
          // body argument (or none) and no call arguments.
          const construction = asFunctionConstruction(node.callee, path.scope);
          if (construction !== null && node.arguments.length === 0) {
            const sources = construction.args.map(getStaticString);
            if (
              construction.args.length > 1 ||
              sources.some((source) => source === undefined)
            ) {
              return;
            }
            inlineFunctionBody(path, sources[0] ?? '', this);
            return;
          }

          if (
            node.arguments.length === 1 &&
            isEvalCallee(node.callee, path.scope)
          ) {
            const parent = path.parentPath;
            // Only bare `eval("code");` statements are inlined. Assignment
            // values etc. would need the eval completion value, and anything
            // inside a function may observe or leak locals, so those are
            // left untouched.
            if (!parent.isExpressionStatement()) return;
            if (path.getFunctionParent() !== null) return;
            const code = getStaticString(node.arguments[0]);
            if (code === undefined) return;
            const statements = parseStatements(code);
            if (
              statements === undefined ||
              hasTopLevelReturn(statements) ||
              hasImportExport(statements)
            ) {
              return;
            }
            if (spliceStatements(parent, statements)) this.changes++;
            return;
          }

          // Bare `Function("body")` / `Function("a", "b", "body")`
          // constructions become function expressions. When the
          // single-body construction is immediately invoked with no
          // arguments the outer call above handles it instead, so the
          // payload is spliced rather than trapped in a new function
          // (which would also hide nested layers from this transform).
          const bare = asFunctionConstruction(node, path.scope);
          if (bare !== null) {
            if (
              bare.args.length <= 1 &&
              path.parentPath.isCallExpression() &&
              path.parentPath.node.callee === node &&
              path.parentPath.node.arguments.length === 0
            ) {
              return;
            }
            convertConstruction(path, bare.args, this);
          }
        },
      },
      NewExpression: {
        exit(path) {
          const node = path.node;
          // `new Function("code")()` exits the inner construction before
          // the outer call; converting here would trap the payload in a
          // new function scope (hiding nested layers), so the outer call
          // handler below takes the body-only shape instead.
          if (
            path.parentPath.isCallExpression() &&
            path.parentPath.node.callee === node &&
            path.parentPath.node.arguments.length === 0 &&
            node.arguments.length <= 1 &&
            node.arguments.every((arg) => getStaticString(arg) !== undefined)
          ) {
            return;
          }
          const bare = asFunctionConstruction(node, path.scope);
          // `new (Function(...))` (a NewExpression using the construction
          // as its callee) converts the same way; the `new` stays.
          if (bare !== null) convertConstruction(path, bare.args, this);
        },
      },
    };
  },
} satisfies Transform;
