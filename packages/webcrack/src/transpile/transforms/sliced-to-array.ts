import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';

// Reverse of `@babel/plugin-transform-destructuring` (and the equivalent
// TypeScript downleveling): array destructuring is compiled to indexed reads
// off a `_slicedToArray(arr, n)` (Babel) or `__read(arr, n)` (TS) temporary,
// e.g. `var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1];` becomes
// `var [a, b] = arr;`.
// Defaults become assignment patterns (`b = _x[1] === void 0 ? d : _x[1]`
// becomes `b = d`), holes stay holes, and nested array patterns via chained
// temporaries (`_y = _slicedToArray(_x[1], 2), ...`) fold into one pattern.
// Single-use parameters and for-of heads are promoted afterwards:
// `function f(_ref) { var [a, b] = _ref; }` becomes `function f([a, b])`.
//
// Helper functions are identified by body shape instead of by name because
// bundlers and minifiers usually rename them. When no definition is in
// scope (helpers bundled elsewhere), the canonical `_slicedToArray` and
// `__read` names are trusted. Helpers provided as
// `require('@babel/runtime/helpers/...')`, imports, or `require('tslib')`
// (`tslib.__read`) are handled as well.
//
// Conversion only happens when the temporary is used exclusively for the
// recognized indexed reads. Anything else (extra references, out-of-range
// indices, member access off an element like `_x[1].lines` from nested
// object patterns) leaves the code alone.
//
// Helper definitions are removed only when no references to them remain.

type PlainFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

type SliceHelperKind =
  | 'slice'
  | 'holes'
  | 'limit'
  | 'unsupported'
  | 'nonIterable'
  | 'tslib';

type SliceHelpers = Record<SliceHelperKind, Set<string>>;

const RUNTIME_HELPERS: Record<string, keyof Omit<SliceHelpers, 'tslib'>> = {
  slicedToArray: 'slice',
  iterableToArrayLimit: 'slice',
  arrayWithHoles: 'holes',
  unsupportedIterableToArray: 'unsupported',
  nonIterableRest: 'nonIterable',
};

function emptyHelpers(): SliceHelpers {
  return {
    slice: new Set(),
    holes: new Set(),
    limit: new Set(),
    unsupported: new Set(),
    nonIterable: new Set(),
    tslib: new Set(),
  };
}

const SKIPPED_KEYS = new Set([
  'loc',
  'start',
  'end',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as t.Node).type === 'string'
  );
}

function walkNodes(
  node: t.Node,
  cb: (node: t.Node) => void,
  skipNestedFunctions: boolean,
): void {
  const visit = (current: t.Node, depth: number): void => {
    if (
      depth > 0 &&
      skipNestedFunctions &&
      (t.isFunctionDeclaration(current) ||
        t.isFunctionExpression(current) ||
        t.isArrowFunctionExpression(current) ||
        t.isClass(current))
    ) {
      return;
    }
    cb(current);
    for (const key of Object.keys(current)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const value: unknown = (current as unknown as Record<string, unknown>)[
        key
      ];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item, depth + 1);
        }
      } else if (isNode(value)) {
        visit(value, depth + 1);
      }
    }
  };
  visit(node, 0);
}

function asFn(node: t.Node | null | undefined): PlainFunction | null {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  ) {
    return node;
  }
  return null;
}

function fnParams(fn: PlainFunction): string[] | null {
  if (fn.async || fn.generator) return null;
  const names: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param)) return null;
    names.push(param.name);
  }
  return names;
}

// The single returned expression: `return <expr>;` or an arrow body.
function returnedExpr(fn: PlainFunction): t.Expression | null {
  if (t.isBlockStatement(fn.body)) {
    if (fn.body.body.length !== 1) return null;
    const stmt = fn.body.body[0];
    if (!t.isReturnStatement(stmt) || !t.isExpression(stmt.argument)) {
      return null;
    }
    return stmt.argument;
  }
  if (t.isArrowFunctionExpression(fn) && t.isExpression(fn.body)) {
    return fn.body;
  }
  return null;
}

function isVoidZero(node: t.Node | null | undefined): boolean {
  return (
    !!node &&
    t.isUnaryExpression(node, { operator: 'void' }) &&
    t.isNumericLiteral(node.argument, { value: 0 })
  );
}

function isNamedProperty(
  member: t.MemberExpression,
  property: string,
): boolean {
  const prop = member.property;
  return (
    (!member.computed && t.isIdentifier(prop, { name: property })) ||
    (member.computed && t.isStringLiteral(prop, { value: property }))
  );
}

function hasMember(
  fn: PlainFunction,
  object: string | null,
  property: string,
): boolean {
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (found || !t.isMemberExpression(node)) return;
      if (object !== null && !t.isIdentifier(node.object, { name: object })) {
        return;
      }
      if (isNamedProperty(node, property)) found = true;
    },
    true,
  );
  return found;
}

// `function (arr, i) { return f(arr) || g(arr, i) || h(arr, i) || k(); }`
// (Babel 7; older chains have three operands instead of four).
function isSlicedToArrayFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  const [first, second] = params as [string, string];
  const returned = returnedExpr(fn);
  if (!returned) return false;
  const operands: t.Node[] = [];
  let current: t.Node = returned;
  while (t.isLogicalExpression(current, { operator: '||' })) {
    operands.unshift(current.right);
    current = current.left;
  }
  operands.unshift(current);
  if (operands.length < 3) return false;
  return operands.every((operand, index) => {
    if (!t.isCallExpression(operand) || !t.isIdentifier(operand.callee)) {
      return false;
    }
    const args = operand.arguments;
    if (index === 0) {
      return args.length === 1 && t.isIdentifier(args[0], { name: first });
    }
    if (index === operands.length - 1) {
      return args.length === 0;
    }
    return (
      args.length === 2 &&
      t.isIdentifier(args[0], { name: first }) &&
      t.isIdentifier(args[1], { name: second })
    );
  });
}

// `function (arr) { if (Array.isArray(arr)) return arr; }`
function isArrayWithHolesFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 1) return false;
  const [first] = params as [string];
  let sawCheck = false;
  let sawReturn = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        t.isIdentifier(node.callee.object, { name: 'Array' }) &&
        isNamedProperty(node.callee, 'isArray') &&
        node.arguments.length === 1 &&
        t.isIdentifier(node.arguments[0], { name: first })
      ) {
        sawCheck = true;
      } else if (
        t.isReturnStatement(node) &&
        t.isIdentifier(node.argument, { name: first })
      ) {
        sawReturn = true;
      }
    },
    true,
  );
  return sawCheck && sawReturn;
}

// Babel's `_iterableToArrayLimit(arr, i)` and TS's `__read(o, n)` share a
// shape: two params plus `Symbol.iterator`, a `try` statement and `.next`.
// Both return up to `n` elements, so both reverse to destructuring.
function isIterableLimitOrReadFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  let sawTry = false;
  walkNodes(
    fn.body,
    (node) => {
      if (t.isTryStatement(node)) sawTry = true;
    },
    true,
  );
  return (
    sawTry && hasMember(fn, 'Symbol', 'iterator') && hasMember(fn, null, 'next')
  );
}

// `function (o, n) { ... Array.from(o) ... "Map"/"Set"/"Arguments" ... }`.
// Cleanup-only: never matched at usage sites.
function isUnsupportedIterableToArrayFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  let sawFrom = false;
  let sawKind = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        t.isIdentifier(node.callee.object, { name: 'Array' }) &&
        isNamedProperty(node.callee, 'from')
      ) {
        sawFrom = true;
      } else if (
        t.isStringLiteral(node) &&
        (node.value === 'Map' ||
          node.value === 'Set' ||
          node.value === 'Arguments')
      ) {
        sawKind = true;
      }
    },
    true,
  );
  return sawFrom && sawKind;
}

// `function () { throw new TypeError(...); }`.
// Cleanup-only: never matched at usage sites.
function isNonIterableRestFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 0) return false;
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        !found &&
        t.isThrowStatement(node) &&
        t.isNewExpression(node.argument) &&
        t.isIdentifier(node.argument.callee, { name: 'TypeError' })
      ) {
        found = true;
      }
    },
    true,
  );
  return found;
}

function findRequireSource(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  let found: string | null = null;
  walkNodes(
    node,
    (child) => {
      if (found !== null) return;
      if (
        t.isCallExpression(child) &&
        t.isIdentifier(child.callee, { name: 'require' }) &&
        child.arguments.length === 1 &&
        t.isStringLiteral(child.arguments[0])
      ) {
        found = child.arguments[0].value;
      }
    },
    false,
  );
  return found;
}

function runtimeHelperKind(
  source: string,
): keyof Omit<SliceHelpers, 'tslib'> | null {
  const base = source.split('/').pop() ?? '';
  return RUNTIME_HELPERS[base.replace(/\.js$/, '')] ?? null;
}

function importedNameOf(specifier: t.ImportSpecifier): string {
  return t.isIdentifier(specifier.imported)
    ? specifier.imported.name
    : specifier.imported.value;
}

function collectHelpers(programPath: NodePath<t.Program>): SliceHelpers {
  const helpers = emptyHelpers();

  const consider = (fn: PlainFunction | null, name: string): void => {
    if (!fn) return;
    if (isSlicedToArrayFn(fn) || isIterableLimitOrReadFn(fn)) {
      helpers.slice.add(name);
    } else if (isArrayWithHolesFn(fn)) {
      helpers.holes.add(name);
    } else if (isUnsupportedIterableToArrayFn(fn)) {
      helpers.unsupported.add(name);
    } else if (isNonIterableRestFn(fn)) {
      helpers.nonIterable.add(name);
    }
  };

  for (const stmtPath of programPath.get('body')) {
    const node = stmtPath.node;
    if (t.isFunctionDeclaration(node) && node.id) {
      consider(asFn(node), node.id.name);
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (!t.isIdentifier(declarator.id) || !declarator.init) continue;
        const fn = asFn(declarator.init);
        if (fn) {
          consider(fn, declarator.id.name);
        } else {
          const source = findRequireSource(declarator.init);
          if (!source) continue;
          if (source === 'tslib') {
            helpers.tslib.add(declarator.id.name);
          } else {
            const kind = runtimeHelperKind(source);
            if (kind) helpers[kind].add(declarator.id.name);
          }
        }
      }
    } else if (t.isImportDeclaration(node)) {
      if (node.source.value === 'tslib') {
        for (const specifier of node.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            importedNameOf(specifier) === '__read'
          ) {
            helpers.slice.add(specifier.local.name);
          } else if (!t.isImportSpecifier(specifier)) {
            helpers.tslib.add(specifier.local.name);
          }
        }
        continue;
      }
      const kind = runtimeHelperKind(node.source.value);
      if (!kind) continue;
      for (const specifier of node.specifiers) {
        if (
          t.isImportDefaultSpecifier(specifier) ||
          t.isImportNamespaceSpecifier(specifier) ||
          t.isImportSpecifier(specifier)
        ) {
          helpers[kind].add(specifier.local.name);
        }
      }
    }
  }

  return helpers;
}

function fnOfBinding(binding: Binding): PlainFunction | null {
  const bpath = binding.path;
  if (
    bpath.isFunctionDeclaration() ||
    bpath.isFunctionExpression() ||
    bpath.isArrowFunctionExpression()
  ) {
    return bpath.node;
  }
  if (bpath.isVariableDeclarator()) {
    return asFn(bpath.node.init);
  }
  return null;
}

// True when `name(...)` may be a `_slicedToArray`/`__read`-like helper.
// Shape-verified definitions (even under minified names) and
// `@babel/runtime`/`tslib` imports always count; otherwise the binding must
// carry a matching definition. Unresolvable `_slicedToArray`/`__read` names
// are trusted as helpers bundled elsewhere, while any other unresolvable
// name is not.
function resolveSliceName(
  name: string,
  scope: Scope,
  helpers: SliceHelpers,
): boolean {
  const binding = scope.getBinding(name);
  if (!binding) {
    return (
      helpers.slice.has(name) || name === '_slicedToArray' || name === '__read'
    );
  }
  const bpath = binding.path;
  if (
    bpath.isImportSpecifier() ||
    bpath.isImportDefaultSpecifier() ||
    bpath.isImportNamespaceSpecifier()
  ) {
    const imp = bpath.parentPath;
    if (!imp.isImportDeclaration()) return false;
    const source = imp.node.source.value;
    if (source === 'tslib') {
      return (
        bpath.isImportSpecifier() && importedNameOf(bpath.node) === '__read'
      );
    }
    if (runtimeHelperKind(source) === 'slice') {
      helpers.slice.add(name);
      return true;
    }
    return false;
  }
  const fn = fnOfBinding(binding);
  if (fn) {
    if (isSlicedToArrayFn(fn) || isIterableLimitOrReadFn(fn)) {
      helpers.slice.add(name);
      return true;
    }
    return false;
  }
  if (bpath.isVariableDeclarator()) {
    const source = findRequireSource(bpath.node.init);
    if (source && runtimeHelperKind(source) === 'slice') {
      helpers.slice.add(name);
      return true;
    }
  }
  return false;
}

// True when `obj.__read(...)` comes from tslib.
function isTslibObject(name: string, scope: Scope): boolean {
  const binding = scope.getBinding(name);
  if (!binding) return name === 'tslib';
  const bpath = binding.path;
  if (
    bpath.isImportDefaultSpecifier() ||
    bpath.isImportNamespaceSpecifier() ||
    bpath.isImportSpecifier()
  ) {
    const imp = bpath.parentPath;
    return imp.isImportDeclaration() && imp.node.source.value === 'tslib';
  }
  if (bpath.isVariableDeclarator()) {
    return findRequireSource(bpath.node.init) === 'tslib';
  }
  return false;
}

interface SliceCall {
  source: t.Expression;
  limit: number;
}

function getSliceCall(
  scope: Scope,
  helpers: SliceHelpers,
  init: t.Node | null | undefined,
): SliceCall | null {
  if (!t.isCallExpression(init) || init.arguments.length !== 2) return null;
  const [source, limit] = init.arguments;
  if (!t.isExpression(source) || !t.isNumericLiteral(limit)) return null;
  let callee: t.Expression | t.Super | t.V8IntrinsicIdentifier = init.callee;
  while (t.isSequenceExpression(callee)) {
    const last = callee.expressions[callee.expressions.length - 1];
    if (!last) return null;
    callee = last;
  }
  if (t.isIdentifier(callee)) {
    if (!resolveSliceName(callee.name, scope, helpers)) return null;
  } else if (
    t.isMemberExpression(callee) &&
    !callee.optional &&
    t.isIdentifier(callee.object) &&
    ((t.isIdentifier(callee.property, { name: '__read' }) &&
      !callee.computed) ||
      (t.isStringLiteral(callee.property, { value: '__read' }) &&
        callee.computed))
  ) {
    if (!isTslibObject(callee.object.name, scope)) return null;
  } else {
    return null;
  }
  return { source, limit: limit.value };
}

// Integer index of `_temp[i]`, or null for anything else.
function tempIndex(
  node: t.Node | null | undefined,
  temp: string,
): number | null {
  if (
    !t.isMemberExpression(node) ||
    node.optional ||
    !node.computed ||
    !t.isIdentifier(node.object, { name: temp }) ||
    !t.isNumericLiteral(node.property) ||
    !Number.isInteger(node.property.value)
  ) {
    return null;
  }
  return node.property.value;
}

interface DefaultRead {
  index: number;
  fallback: t.Expression;
  first: t.MemberExpression;
  second: t.MemberExpression;
}

// `_temp[i] === void 0 ? fallback : _temp[i]` (either operand order).
function matchDefault(init: t.Expression, temp: string): DefaultRead | null {
  if (!t.isConditionalExpression(init)) return null;
  const test = init.test;
  if (!t.isBinaryExpression(test, { operator: '===' })) return null;
  let read: t.MemberExpression;
  if (
    t.isMemberExpression(test.left) &&
    tempIndex(test.left, temp) !== null &&
    isVoidZero(test.right)
  ) {
    read = test.left;
  } else if (
    t.isMemberExpression(test.right) &&
    tempIndex(test.right, temp) !== null &&
    isVoidZero(test.left)
  ) {
    read = test.right;
  } else {
    return null;
  }
  const index = tempIndex(read, temp);
  if (index === null) return null;
  if (!t.isMemberExpression(init.alternate)) return null;
  if (tempIndex(init.alternate, temp) !== index) return null;
  if (!t.isExpression(init.consequent)) return null;
  return {
    index,
    fallback: init.consequent,
    first: read,
    second: init.alternate,
  };
}

type PatternElement = t.Identifier | t.AssignmentPattern | t.ArrayPattern;

interface NestedCall {
  index: number;
  limit: number;
  source: t.MemberExpression;
}

// `_helper(_temp[i], m)` where the declarator itself is the nested temporary.
function matchNestedCall(
  scope: Scope,
  helpers: SliceHelpers,
  init: t.Expression,
  temp: string,
): NestedCall | null {
  const call = getSliceCall(scope, helpers, init);
  if (!call || !t.isMemberExpression(call.source)) return null;
  const index = tempIndex(call.source, temp);
  if (index === null) return null;
  return { index, limit: call.limit, source: call.source };
}

// True when every reference to the temporary is one of the recognized
// indexed reads and it is never reassigned. The temporary's own initializer
// is exempt: Babel records it as a violation when the declaration sits in a
// loop body (it re-runs every iteration), which is still equivalent after
// conversion since reads see the current iteration's value.
function isExclusiveTemp(
  binding: Binding,
  own: t.VariableDeclarator,
  refs: Set<t.Node>,
): boolean {
  for (const violation of binding.constantViolations) {
    if (violation.isVariableDeclarator() && violation.node === own) continue;
    return false;
  }
  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath;
    if (!parent || !parent.isMemberExpression()) return false;
    if (parent.node.object !== ref.node) return false;
    if (!refs.has(parent.node)) return false;
  }
  return true;
}

interface CollectContext {
  scope: Scope;
  helpers: SliceHelpers;
}

// Collects element declarators for `temp` (limit `n`) from `decls` starting
// at `start`, stopping at the first declarator that is not a recognized
// element read. Returns the number of consumed declarators, or null when a
// read is malformed (out of range, duplicated index).
function collectElements(
  ctx: CollectContext,
  decls: t.VariableDeclarator[],
  start: number,
  temp: string,
  limit: number,
  elements: Map<number, PatternElement>,
  refs: Set<t.Node>,
): number | null {
  let count = 0;
  for (let j = start; j < decls.length; j++) {
    const declarator = decls[j];
    if (!t.isIdentifier(declarator.id) || !t.isExpression(declarator.init)) {
      break;
    }
    const init = declarator.init;
    const index = tempIndex(init, temp);
    if (index !== null) {
      if (index >= limit || elements.has(index)) return null;
      elements.set(index, declarator.id);
      refs.add(init);
      count++;
      continue;
    }
    const def = matchDefault(init, temp);
    if (def) {
      if (def.index >= limit || elements.has(def.index)) return null;
      elements.set(def.index, t.assignmentPattern(declarator.id, def.fallback));
      refs.add(def.first);
      refs.add(def.second);
      count++;
      continue;
    }
    const nested = matchNestedCall(ctx.scope, ctx.helpers, init, temp);
    if (nested) {
      if (
        nested.index >= limit ||
        elements.has(nested.index) ||
        !Number.isInteger(nested.limit) ||
        nested.limit < 0
      ) {
        return null;
      }
      const subBinding = ctx.scope.getBinding(declarator.id.name);
      if (!subBinding || subBinding.path.node !== declarator) break;
      const subElements = new Map<number, PatternElement>();
      const subCount = collectElements(
        ctx,
        decls,
        j + 1,
        declarator.id.name,
        nested.limit,
        subElements,
        refs,
      );
      if (subCount === null || subCount === 0) break;
      if (!isExclusiveTemp(subBinding, declarator, refs)) break;
      const subPattern = buildPattern(subElements);
      if (!subPattern) break;
      refs.add(nested.source);
      elements.set(nested.index, subPattern);
      count += 1 + subCount;
      j += subCount;
      continue;
    }
    break;
  }
  return count;
}

function buildPattern(
  elements: Map<number, PatternElement>,
): t.ArrayPattern | null {
  if (elements.size === 0) return null;
  const max = Math.max(...elements.keys());
  const list: (PatternElement | null)[] = [];
  for (let i = 0; i <= max; i++) {
    list.push(elements.get(i) ?? null);
  }
  return t.arrayPattern(list);
}

function isAlive(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (current.removed) return false;
    current = current.parentPath;
  }
  return true;
}

// True when the declaration is exported (`export var _temp ...`); the
// temporary must stay put then.
function isExportedPath(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (
      current.isExportNamedDeclaration() ||
      current.isExportDefaultDeclaration()
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

// Attempts to convert the declarator at `index` (a `_slicedToArray`-style
// call) plus its following element declarators into one array-pattern
// declarator. Returns true when the declaration was rewritten.
function tryConvertAt(
  declPath: NodePath<t.VariableDeclaration>,
  index: number,
  helpers: SliceHelpers,
): boolean {
  const scope = declPath.scope;
  const decls = declPath.node.declarations;
  // Inside a for-of/for-in head only a full-declaration conversion is valid.
  const parent = declPath.parentPath;
  const isHead =
    !!parent &&
    (parent.isForOfStatement() || parent.isForInStatement()) &&
    parent.node.left === declPath.node;
  if (isHead && index !== 0) return false;
  const tempNode = decls[index];
  if (!tempNode || !t.isIdentifier(tempNode.id)) return false;
  const temp = tempNode.id.name;
  const call = getSliceCall(scope, helpers, tempNode.init);
  if (!call || !Number.isInteger(call.limit)) return false;
  const binding = scope.getBinding(temp);
  if (!binding || binding.path.node !== tempNode) return false;
  if (isExportedPath(declPath)) return false;
  const ctx: CollectContext = { scope, helpers };
  const elements = new Map<number, PatternElement>();
  const refs = new Set<t.Node>();
  const count = collectElements(
    ctx,
    decls,
    index + 1,
    temp,
    call.limit,
    elements,
    refs,
  );
  if (count === null || elements.size === 0) return false;
  if (!isExclusiveTemp(binding, tempNode, refs)) return false;
  const consumed = 1 + count;
  if (isHead && consumed !== decls.length) return false;
  const pattern = buildPattern(elements);
  if (!pattern) return false;
  decls.splice(index, consumed, t.variableDeclarator(pattern, call.source));
  return true;
}

interface ConvertState {
  crawlIfDirty: () => void;
  markDirty: () => void;
  bump: () => void;
}

function convertInDeclaration(
  declPath: NodePath<t.VariableDeclaration>,
  helpers: SliceHelpers,
  state: ConvertState,
): void {
  const skipped = new Set<number>();
  for (;;) {
    if (declPath.removed || !isAlive(declPath)) return;
    const declarators = declPath.get('declarations');
    let advanced = false;
    for (let i = 0; i < declarators.length; i++) {
      if (skipped.has(i)) continue;
      if (declarators[i].removed) continue;
      state.crawlIfDirty();
      if (tryConvertAt(declPath, i, helpers)) {
        state.markDirty();
        state.bump();
        advanced = true;
        break;
      }
      skipped.add(i);
    }
    if (!advanced) return;
    // Indices shifted; re-analyze from scratch.
    skipped.clear();
  }
}

function collectPatternNames(
  node: t.Node | null | undefined,
  out: Set<string>,
): void {
  if (!node) return;
  if (t.isIdentifier(node)) {
    out.add(node.name);
    return;
  }
  if (t.isAssignmentPattern(node)) {
    collectPatternNames(node.left, out);
    return;
  }
  if (t.isRestElement(node)) {
    collectPatternNames(node.argument, out);
    return;
  }
  if (t.isArrayPattern(node)) {
    for (const element of node.elements) {
      collectPatternNames(element, out);
    }
    return;
  }
  if (t.isObjectPattern(node)) {
    for (const property of node.properties) {
      if (t.isObjectProperty(property)) {
        collectPatternNames(property.value, out);
      } else {
        collectPatternNames(property.argument, out);
      }
    }
  }
}

interface ParamJob {
  fn: NodePath<t.Function>;
}

// `function f(_ref) { var [a, b] = _ref; ...}` -> `function f([a, b])`.
// Jobs are collected first and applied after re-validation, so earlier
// rewrites cannot invalidate later ones.
function collectParamJob(fnPath: NodePath<t.Function>): ParamJob | null {
  const node = fnPath.node;
  if (!t.isBlockStatement(node.body) || node.body.body.length === 0) {
    return null;
  }
  const first = node.body.body[0];
  if (
    !t.isVariableDeclaration(first) ||
    first.kind === 'const' ||
    first.declarations.length !== 1
  ) {
    return null;
  }
  const declarator = first.declarations[0];
  if (!t.isArrayPattern(declarator.id) || !t.isIdentifier(declarator.init)) {
    return null;
  }
  const source = declarator.init.name;
  const index = node.params.findIndex(
    (param) => t.isIdentifier(param) && param.name === source,
  );
  if (index === -1) return null;
  const binding = fnPath.scope.getBinding(source);
  if (!binding) return null;
  const ref = binding.referencePaths;
  if (
    binding.kind !== 'param' ||
    ref.length !== 1 ||
    binding.constantViolations.length !== 0 ||
    !ref[0] ||
    ref[0].node !== declarator.init
  ) {
    return null;
  }
  const bound = new Set<string>();
  collectPatternNames(declarator.id, bound);
  if (bound.has(source)) return null;
  for (const param of node.params) {
    const names = new Set<string>();
    collectPatternNames(param, names);
    for (const name of names) {
      if (bound.has(name)) return null;
    }
  }
  return { fn: fnPath };
}

function applyParamJobs(jobs: ParamJob[]): number {
  let applied = 0;
  for (const job of jobs) {
    if (job.fn.removed || !isAlive(job.fn)) continue;
    const node = job.fn.node;
    if (!t.isBlockStatement(node.body)) continue;
    // Re-validate against the current tree; the stored pattern must still
    // be the first statement's only declarator.
    if (collectParamJob(job.fn) === null) continue;
    const first = node.body.body[0];
    if (!t.isVariableDeclaration(first) || first.declarations.length !== 1) {
      continue;
    }
    const declarator = first.declarations[0];
    if (!t.isArrayPattern(declarator.id)) continue;
    const init = declarator.init;
    if (!t.isIdentifier(init)) continue;
    const source = init.name;
    const index = node.params.findIndex(
      (param) => t.isIdentifier(param) && param.name === source,
    );
    if (index === -1) continue;
    node.params[index] = declarator.id;
    node.body.body.shift();
    applied++;
  }
  return applied;
}

interface ForJob {
  loop: NodePath<t.ForOfStatement | t.ForInStatement>;
}

// `for (var _ref of arr) { var [a, b] = _ref; ...}` ->
// `for (var [a, b] of arr)`.
function collectForJob(
  loopPath: NodePath<t.ForOfStatement | t.ForInStatement>,
): ForJob | null {
  const node = loopPath.node;
  const left = node.left;
  if (!t.isVariableDeclaration(left) || left.declarations.length !== 1) {
    return null;
  }
  const head = left.declarations[0];
  if (!t.isIdentifier(head.id) || head.init) return null;
  if (!t.isBlockStatement(node.body) || node.body.body.length === 0) {
    return null;
  }
  const first = node.body.body[0];
  if (
    !t.isVariableDeclaration(first) ||
    first.kind !== left.kind ||
    first.declarations.length !== 1
  ) {
    return null;
  }
  const declarator = first.declarations[0];
  if (
    !t.isArrayPattern(declarator.id) ||
    !t.isIdentifier(declarator.init, { name: head.id.name })
  ) {
    return null;
  }
  const binding = loopPath.scope.getBinding(head.id.name);
  if (!binding) return null;
  const ref = binding.referencePaths;
  const reassigned = binding.constantViolations.some(
    (violation) => !violation.isVariableDeclarator() || violation.node !== head,
  );
  if (
    ref.length !== 1 ||
    reassigned ||
    !ref[0] ||
    ref[0].node !== declarator.init
  ) {
    return null;
  }
  const bound = new Set<string>();
  collectPatternNames(declarator.id, bound);
  if (bound.has(head.id.name)) return null;
  return { loop: loopPath };
}

function applyForJobs(jobs: ForJob[]): number {
  let applied = 0;
  for (const job of jobs) {
    if (job.loop.removed || !isAlive(job.loop)) continue;
    if (collectForJob(job.loop) === null) continue;
    const node = job.loop.node;
    const left = node.left;
    if (!t.isVariableDeclaration(left) || left.declarations.length !== 1) {
      continue;
    }
    const head = left.declarations[0];
    if (!t.isBlockStatement(node.body)) continue;
    const first = node.body.body[0];
    if (!t.isVariableDeclaration(first) || first.declarations.length !== 1) {
      continue;
    }
    const declarator = first.declarations[0];
    if (!t.isArrayPattern(declarator.id)) continue;
    head.id = declarator.id;
    node.body.body.shift();
    applied++;
  }
  return applied;
}

// True when every remaining reference lives inside the helper's own
// definition (recursion, self-rewrites like `_gpo = ...`), i.e. nothing
// else in the program uses it anymore.
// Exported bindings stay: removing them would break importers even when
// nothing in this program references them anymore.
function isExported(binding: Binding): boolean {
  let current: NodePath | null = binding.path;
  while (current) {
    if (
      current.isExportNamedDeclaration() ||
      current.isExportDefaultDeclaration()
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

function isHelperDead(binding: Binding): boolean {
  const defNode = binding.path.node;
  return binding.referencePaths.every((ref) => {
    let current: NodePath | null = ref;
    while (current) {
      if (current.node === defNode) return true;
      current = current.parentPath;
    }
    return false;
  });
}

function removeDeadHelpers(
  programPath: NodePath<t.Program>,
  helpers: SliceHelpers,
): number {
  const all = new Set<string>();
  for (const set of Object.values(helpers)) {
    for (const name of set) all.add(name);
  }
  if (all.size === 0) return 0;
  let removedCount = 0;
  for (let round = 0; round < 10; round++) {
    programPath.scope.crawl();
    let removed = false;
    for (const name of all) {
      const binding = programPath.scope.getBinding(name);
      if (!binding || isExported(binding) || !isHelperDead(binding)) continue;
      const bpath = binding.path;
      if (bpath.isFunctionDeclaration()) {
        bpath.remove();
        removed = true;
      } else if (bpath.isVariableDeclarator()) {
        const decl = bpath.parentPath;
        bpath.remove();
        if (
          decl.isVariableDeclaration() &&
          decl.node.declarations.length === 0
        ) {
          decl.remove();
        }
        removed = true;
      } else if (
        bpath.isImportDefaultSpecifier() ||
        bpath.isImportNamespaceSpecifier() ||
        bpath.isImportSpecifier()
      ) {
        const imp = bpath.parentPath;
        bpath.remove();
        if (imp.isImportDeclaration() && imp.node.specifiers.length === 0) {
          imp.remove();
        }
        removed = true;
      }
    }
    if (!removed) break;
    removedCount++;
  }
  return removedCount;
}

export default {
  name: 'sliced-to-array',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      Program: {
        exit(path) {
          const helpers = collectHelpers(path);
          const declarations: NodePath<t.VariableDeclaration>[] = [];
          path.traverse({
            VariableDeclaration(declarator) {
              declarations.push(declarator);
            },
          });
          let dirty = false;
          const state: ConvertState = {
            crawlIfDirty: () => {
              if (dirty) {
                path.scope.crawl();
                dirty = false;
              }
            },
            markDirty: () => {
              dirty = true;
            },
            bump: () => {
              this.changes++;
            },
          };
          for (const declaration of declarations) {
            if (declaration.removed || !isAlive(declaration)) continue;
            convertInDeclaration(declaration, helpers, state);
          }
          path.scope.crawl();

          const paramJobs: ParamJob[] = [];
          const forJobs: ForJob[] = [];
          path.traverse({
            Function(fnPath) {
              const job = collectParamJob(fnPath);
              if (job) paramJobs.push(job);
            },
            ForOfStatement(loopPath) {
              const job = collectForJob(loopPath);
              if (job) forJobs.push(job);
            },
            ForInStatement(loopPath) {
              const job = collectForJob(loopPath);
              if (job) forJobs.push(job);
            },
          });
          this.changes += applyParamJobs(paramJobs);
          this.changes += applyForJobs(forJobs);
          this.changes += removeDeadHelpers(path, helpers);
        },
      },
    };
  },
} satisfies Transform;
