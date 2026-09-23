// Reverse of the TypeScript/esbuild enum emit: an enum factory IIFE such as
// `var E; (function (E) { E[E["A"] = 0] = "A"; E["B"] = "b"; })(E || (E = {}));`
// becomes `enum E { A = 0, B = "b" }`.
//
// Supported factory shapes (parameter is the enum alias, any name):
// - `(function (P) { ... })(E || (E = {}))` (tsc)
// - `!function (p) { ... }(E || (E = {}))` (minified tsc; any unary wrapper)
// - `(function (P) { ... })(E ||= {})` (logical-assignment init)
// - `var E = ((P) => { ...; return P; })(E || {})` (esbuild, pure annotation kept)
// Member statements must all be enum assignments (minifiers may rewrite
// `P["A"]` to `P.A`):
// - reverse-mapped numeric `P[P["A"] = V] = "A"` (V is any expression, e.g.
//   `0`, `E.A + 1`, `foo()`), emitted as `A = V`
// - plain string `P["B"] = "b"`, emitted as `B = "b"`
// A plain numeric assignment (`P.A = 0`) is NOT accepted: tsc always
// reverse-maps numeric members, so that shape is likely a hand-built object.
// Anything else in the factory body (calls, other statements, a mismatched
// reverse-mapping name) leaves the IIFE untouched.
//
// Output form: a real `TSEnumDeclaration` (`enum E { ... }`). This is valid
// here because the pipeline generates code with @babel/generator, which
// prints `TSEnumDeclaration` natively; the `plugins: ['jsx']` parse option in
// src/index.ts only affects parsing, and these nodes are constructed, never
// parsed. Every member keeps its explicit initializer (tsc already folded
// auto-increment values), so no value computation is needed.
//
// Declaration merging: consecutive factory IIFEs for the same enum name are
// folded into one declaration. A duplicate member name aborts the whole
// conversion (a real enum cannot redeclare a member, so it is not one).
// Non-consecutive augmentations are left untouched.
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';

interface EnumMember {
  name: string;
  id: t.Identifier | t.StringLiteral;
  init: t.Expression;
}

interface ParsedEnum {
  name: string;
  members: EnumMember[];
}

// `P["A"]` / `P.A` on the alias object. Returns the member name.
function aliasKey(
  node: t.Node | null | undefined,
  alias: string,
): string | null {
  if (!t.isMemberExpression(node)) return null;
  if (!t.isIdentifier(node.object, { name: alias })) return null;
  if (!node.computed && t.isIdentifier(node.property)) {
    return node.property.name;
  }
  if (node.computed && t.isStringLiteral(node.property)) {
    return node.property.value;
  }
  return null;
}

function isEmptyObject(node: t.Node | null | undefined): boolean {
  return t.isObjectExpression(node) && node.properties.length === 0;
}

// Matches `E || (E = {})`, `E || {}` and `E ||= {}`. Returns the enum name.
function matchEnumInit(arg: t.Node | null | undefined): string | null {
  // `E ||= {}` parses as an assignment, not a logical expression.
  if (t.isAssignmentExpression(arg)) {
    if (arg.operator !== '||=' && arg.operator !== '??=') return null;
    if (!t.isIdentifier(arg.left)) return null;
    return isEmptyObject(arg.right) ? arg.left.name : null;
  }
  if (!t.isLogicalExpression(arg, { operator: '||' })) return null;
  if (!t.isIdentifier(arg.left)) return null;
  const { name } = arg.left;
  if (isEmptyObject(arg.right)) return name;
  // `E || (E = {})`
  if (
    t.isAssignmentExpression(arg.right, { operator: '=' }) &&
    t.isIdentifier(arg.right.left, { name }) &&
    isEmptyObject(arg.right.right)
  ) {
    return name;
  }
  return null;
}

// A factory body statement that assigns one enum member, or null.
function matchMemberStatement(
  stmt: t.Statement,
  alias: string,
): EnumMember | null {
  if (!t.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr, { operator: '=' })) return null;

  // Reverse-mapped numeric: `P[P["A"] = V] = "A"`
  if (
    t.isMemberExpression(expr.left) &&
    t.isIdentifier(expr.left.object, { name: alias }) &&
    t.isAssignmentExpression(expr.left.property, { operator: '=' }) &&
    t.isStringLiteral(expr.right)
  ) {
    const inner = expr.left.property;
    const name = aliasKey(inner.left, alias);
    if (name === null || expr.right.value !== name) return null;
    if (!t.isExpression(inner.right)) return null;
    return { name, id: toMemberId(name), init: inner.right };
  }

  // Plain string member: `P["B"] = "b"`
  const name = aliasKey(expr.left, alias);
  if (name === null) return null;
  if (!t.isStringLiteral(expr.right)) return null;
  return { name, id: toMemberId(name), init: expr.right };
}

function toMemberId(name: string): t.Identifier | t.StringLiteral {
  // `t.isValidIdentifier` rejects reserved words; the generator quotes a
  // StringLiteral id (`enum E { "foo-bar" = 1 }`), so only use Identifier
  // when it prints unquoted.
  return t.isValidIdentifier(name) ? t.identifier(name) : t.stringLiteral(name);
}

// Unwraps `!call(...)` / `void call(...)` (minified tsc) to the call.
function unwrapFactoryCall(expr: t.Expression): t.CallExpression | null {
  if (t.isCallExpression(expr)) return expr;
  if (t.isUnaryExpression(expr) && t.isCallExpression(expr.argument)) {
    return expr.argument;
  }
  return null;
}

// Parses one factory IIFE statement (`var E = ...` declarator init included
// by passing the init expression). Returns null when it is not an enum.
function parseEnumFactory(expr: t.Expression): ParsedEnum | null {
  const call = unwrapFactoryCall(expr);
  if (!call || call.arguments.length !== 1) return null;
  const name = matchEnumInit(call.arguments[0]);
  if (name === null) return null;

  const callee = call.callee;
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) {
    return null;
  }
  if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0])) {
    return null;
  }
  if (callee.async || callee.generator) return null;
  const alias = callee.params[0].name;
  if (!t.isBlockStatement(callee.body)) return null;

  const body = callee.body.body;
  // esbuild arrow factories end with `return P;`
  const last: t.Statement | undefined = body[body.length - 1];
  const stmts =
    last !== undefined &&
    t.isReturnStatement(last) &&
    t.isIdentifier(last.argument, { name: alias })
      ? body.slice(0, -1)
      : body;
  if (stmts.length === 0) return null;

  const members: EnumMember[] = [];
  for (const stmt of stmts) {
    const member = matchMemberStatement(stmt, alias);
    if (member === null) return null;
    members.push(member);
  }
  return { name, members };
}

// The immediately preceding `var E;`-style declarator for a `var E;` +
// factory pair, or null. Only `var` without init qualifies.
function precedingVarDeclarator(
  siblings: NodePath<t.Statement>[],
  index: number,
  name: string,
): NodePath<t.VariableDeclarator> | null {
  if (index === 0) return null;
  const prev = siblings[index - 1];
  if (!prev.isVariableDeclaration({ kind: 'var' })) return null;
  const found = prev
    .get('declarations')
    .find(
      (d): d is NodePath<t.VariableDeclarator> =>
        d.isVariableDeclarator() &&
        t.isIdentifier(d.node.id, { name }) &&
        d.node.init == null,
    );
  return found ?? null;
}

// The enum name when the statement is a factory IIFE (esbuild `var E =`
// form included), null when it is a call but not an enum factory, undefined
// when it is not a factory statement at all.
function factoryNameOf(stmt: t.Statement): string | null | undefined {
  if (t.isExpressionStatement(stmt)) {
    if (unwrapFactoryCall(stmt.expression) === null) return undefined;
    return parseEnumFactory(stmt.expression)?.name ?? null;
  }
  if (
    t.isVariableDeclaration(stmt, { kind: 'var' }) &&
    stmt.declarations.length === 1
  ) {
    const decl = stmt.declarations[0];
    if (
      !t.isIdentifier(decl.id) ||
      !decl.init ||
      unwrapFactoryCall(decl.init) === null
    ) {
      return undefined;
    }
    return parseEnumFactory(decl.init)?.name ?? null;
  }
  return undefined;
}

function tryConvertAt(
  siblings: NodePath<t.Statement>[],
  index: number,
  state: { changes: number },
): boolean {
  const stmtPath = siblings[index];
  let factoryExpr: t.Expression;
  let selfDeclared = false;

  if (stmtPath.isExpressionStatement()) {
    const expr = stmtPath.node.expression;
    if (unwrapFactoryCall(expr) === null) return false;
    factoryExpr = expr;
  } else if (
    stmtPath.isVariableDeclaration({ kind: 'var' }) &&
    stmtPath.node.declarations.length === 1
  ) {
    // esbuild: `var E = ((P) => { ...; return P; })(E || {})`
    const decl = stmtPath.node.declarations[0];
    if (!t.isIdentifier(decl.id) || decl.init == null) return false;
    if (unwrapFactoryCall(decl.init) === null) return false;
    factoryExpr = decl.init;
    selfDeclared = true;
  } else {
    return false;
  }

  const first = parseEnumFactory(factoryExpr);
  if (first === null) return false;

  const varDeclarator = selfDeclared
    ? null
    : precedingVarDeclarator(siblings, index, first.name);
  if (!selfDeclared) {
    // Without a `var E;` pair the enum must be a bare global init; any
    // other binding (parameter, initialized var, ...) means lookalike.
    const binding = stmtPath.scope.getBinding(first.name);
    if (binding !== undefined) {
      if (varDeclarator === null) return false;
      if (binding.path !== varDeclarator) return false;
    } else if (varDeclarator !== null) {
      return false;
    }
  } else if (
    !t.isIdentifier(
      (stmtPath.node as t.VariableDeclaration).declarations[0].id,
      { name: first.name },
    )
  ) {
    return false;
  }

  // Fold consecutive augmentations of the same enum.
  const members = [...first.members];
  const seen = new Set(members.map((m) => m.name));
  let end = index;
  for (let i = index + 1; i < siblings.length; i++) {
    const next = siblings[i];
    if (!next.isExpressionStatement()) break;
    if (unwrapFactoryCall(next.node.expression) === null) break;
    const parsed = parseEnumFactory(next.node.expression);
    if (parsed === null || parsed.name !== first.name) break;
    if (parsed.members.some((m) => seen.has(m.name))) return false;
    for (const m of parsed.members) {
      seen.add(m.name);
      members.push(m);
    }
    end = i;
  }

  const enumDecl = t.tsEnumDeclaration(
    t.identifier(first.name),
    members.map((m) => t.tsEnumMember(m.id, m.init)),
  );
  if (selfDeclared) {
    stmtPath.replaceWith(enumDecl);
  } else {
    if (varDeclarator !== null) {
      if (varDeclarator.parentPath.isVariableDeclaration()) {
        if (varDeclarator.parentPath.node.declarations.length === 1) {
          varDeclarator.parentPath.remove();
        } else {
          varDeclarator.remove();
        }
      }
    }
    // Refresh the sibling list: removing `var E;` shifts indices.
    const listPath = stmtPath.parentPath.get('body') as NodePath<t.Statement>[];
    const fresh = listPath.find((p) => p.node === stmtPath.node);
    (fresh ?? stmtPath).replaceWith(enumDecl);
  }
  for (let i = end; i > index; i--) siblings[i].remove();
  state.changes++;
  return true;
}

export default {
  name: 'ts-enum',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      Statement(path) {
        const parent = path.parentPath;
        if (!parent.isProgram() && !parent.isBlockStatement()) return;
        const siblings = parent.get('body') as NodePath<t.Statement>[];
        const index = siblings.indexOf(path);
        if (index === -1) return;
        // Only attempt conversion at the head of a run of same-name
        // factories: a later factory is either consumed by the head's
        // merge or deliberately left alone with it (e.g. on duplicates).
        if (index > 0) {
          const prevName = factoryNameOf(siblings[index - 1].node);
          const curName = factoryNameOf(path.node);
          if (
            typeof prevName === 'string' &&
            typeof curName === 'string' &&
            prevName === curName
          ) {
            return;
          }
        }
        tryConvertAt(siblings, index, this);
      },
    };
  },
} satisfies Transform;
