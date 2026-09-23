import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';

// Reverse of Babel's spread output (`plugin-transform-spread`) and the
// TypeScript downlevel spread emit (`__assign` / `__read` / `__spreadArray`).
//
// Supported conversions:
//
// - `_toConsumableArray(a)` -> `[...a]`
// - `[].concat(_toConsumableArray(a), [b])` -> `[...a, b]`
// - `fn.apply(void 0, _toConsumableArray(args))` -> `fn(...args)`
// - `_objectSpread({}, a, { b: 1 })` / `_objectSpread2(...)` /
//   `_extends({}, a)` / `__assign({}, a)` / `Object.assign({}, a, ...)`
//   (only when the first argument is a fresh `{}` literal) -> `{ ...a, b: 1 }`
// - `__spreadArray([], __read(a), false)` -> `[...a]`
//
// Helpers are identified by body shape instead of by name alone because
// bundlers and minifiers usually rename them. Canonical helper names are
// still trusted when their definition is missing (globals, unresolved
// imports), but a same-named local function with the wrong shape is left
// alone. Helpers provided as `require('@babel/runtime/helpers/...')` or
// imports (including `tslib` member calls) are handled too.
//
// Helper definitions are removed only when no references to them remain.

type HelperKind =
  | 'toConsumableArray'
  | 'objectSpread'
  | 'spreadArray'
  | 'read'
  | 'sub';

type HelperSets = Record<HelperKind, Set<string>>;

const RUNTIME_HELPERS: Record<string, HelperKind> = {
  toConsumableArray: 'toConsumableArray',
  objectSpread: 'objectSpread',
  objectSpread2: 'objectSpread',
  extends: 'objectSpread',
  arrayWithoutHoles: 'sub',
  arrayLikeToArray: 'sub',
  iterableToArray: 'sub',
  unsupportedIterableToArray: 'sub',
  nonIterableSpread: 'sub',
  nonIterableRest: 'sub',
  defineProperty: 'sub',
};

const TSLIB_HELPERS: Record<string, HelperKind> = {
  __assign: 'objectSpread',
  __read: 'read',
  __spreadArray: 'spreadArray',
};

function emptyHelpers(): HelperSets {
  return {
    toConsumableArray: new Set(),
    objectSpread: new Set(),
    spreadArray: new Set(),
    read: new Set(),
    sub: new Set(),
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
    typeof value.type === 'string'
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
      (t.isFunction(current) || t.isClass(current))
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

function containsNode(
  node: t.Node,
  test: (node: t.Node) => boolean,
  skipNestedFunctions = true,
): boolean {
  let found = false;
  walkNodes(
    node,
    (child) => {
      if (!found && test(child)) found = true;
    },
    skipNestedFunctions,
  );
  return found;
}

type PlainFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

function asPlainFunction(
  node: t.Node | null | undefined,
): PlainFunction | null {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  ) {
    return node;
  }
  return null;
}

function simpleParams(fn: PlainFunction): string[] | null {
  if (fn.async || fn.generator) return null;
  if (!t.isBlockStatement(fn.body)) return null;
  const names: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param)) return null;
    names.push(param.name);
  }
  return names;
}

function usesArguments(fn: PlainFunction): boolean {
  return containsNode(fn.body, (node) =>
    t.isIdentifier(node, { name: 'arguments' }),
  );
}

function containsCall(fn: PlainFunction): boolean {
  return containsNode(fn.body, (node) => t.isCallExpression(node));
}

function hasMemberProp(fn: PlainFunction, name: string): boolean {
  return containsNode(
    fn.body,
    (node) =>
      t.isMemberExpression(node) &&
      ((t.isIdentifier(node.property, { name }) && !node.computed) ||
        (t.isStringLiteral(node.property, { value: name }) && node.computed)),
  );
}

function mentionsSymbol(fn: PlainFunction): boolean {
  return containsNode(fn.body, (node) =>
    t.isIdentifier(node, { name: 'Symbol' }),
  );
}

function selfAssigns(fn: PlainFunction, name: string): boolean {
  return containsNode(
    fn.body,
    (node) =>
      t.isAssignmentExpression(node) && t.isIdentifier(node.left, { name }),
  );
}

// `function (arr) { return _arrayWithoutHoles(arr) || ... }`.
// Babel 7 always emits the `||` delegation chain; a lone `return g(arr)`
// (or the sibling `_arrayWithHoles` shape returning the bare parameter)
// must not match.
function isToConsumableArrayShape(fn: PlainFunction): boolean {
  const params = simpleParams(fn);
  if (params === null || params.length !== 1) return false;
  return containsNode(
    fn.body,
    (node) =>
      t.isReturnStatement(node) &&
      !!node.argument &&
      containsNode(
        node.argument,
        (child) =>
          t.isLogicalExpression(child) &&
          (child.operator === '||' || child.operator === '&&') &&
          containsNode(child, (inner) => t.isCallExpression(inner)),
      ),
  );
}

// `function (target) { for (...; i < arguments.length; ...) { ... } }`.
// Property names survive minification, so the `Object.keys`/`forEach`/
// `defineProperty`-family accesses anchor the shape.
function isObjectSpreadShape(fn: PlainFunction): boolean {
  const params = simpleParams(fn);
  return (
    params !== null &&
    params.length === 1 &&
    usesArguments(fn) &&
    containsCall(fn) &&
    (hasMemberProp(fn, 'keys') ||
      hasMemberProp(fn, 'forEach') ||
      hasMemberProp(fn, 'defineProperty') ||
      hasMemberProp(fn, 'defineProperties') ||
      hasMemberProp(fn, 'getOwnPropertySymbols') ||
      hasMemberProp(fn, 'getOwnPropertyDescriptors'))
  );
}

// `function () { ... Object.assign ...; return _extends.apply(...) }`
// (Babel `_extends`) or the TS `__assign` self-rewrite shape.
function isExtendsShape(fn: PlainFunction, name: string): boolean {
  const params = simpleParams(fn);
  return (
    params !== null &&
    params.length === 0 &&
    (usesArguments(fn) || selfAssigns(fn, name) || hasMemberProp(fn, 'assign'))
  );
}

// `function (to, from, pack) { ... to.concat(ar || slice.call(from)) }`.
// Property names survive minification, so `concat`/`slice` anchor the shape.
function isSpreadArrayShape(fn: PlainFunction): boolean {
  const params = simpleParams(fn);
  return (
    params !== null &&
    params.length === 3 &&
    containsCall(fn) &&
    hasMemberProp(fn, 'concat') &&
    hasMemberProp(fn, 'slice')
  );
}

// `function (o, n) { ... try { while (...) ... } ... }`
function isReadShape(fn: PlainFunction): boolean {
  const params = simpleParams(fn);
  return (
    params !== null &&
    params.length === 2 &&
    containsNode(fn.body, (node) => t.isTryStatement(node)) &&
    mentionsSymbol(fn)
  );
}

function classifyHelper(
  fn: PlainFunction,
  name: string,
  helpers: HelperSets,
): boolean {
  if (/(^|_)toConsumableArray$/.test(name)) {
    if (isToConsumableArrayShape(fn)) helpers.toConsumableArray.add(name);
    return true;
  }
  if (/(^|_)objectSpread2?$/.test(name)) {
    if (isObjectSpreadShape(fn)) helpers.objectSpread.add(name);
    return true;
  }
  if (/(^|_)extends$/.test(name)) {
    if (isExtendsShape(fn, name)) helpers.objectSpread.add(name);
    return true;
  }
  if (/(^|_)__assign$/.test(name)) {
    if (isExtendsShape(fn, name)) helpers.objectSpread.add(name);
    return true;
  }
  if (/(^|_)__spreadArray$/.test(name)) {
    if (isSpreadArrayShape(fn)) helpers.spreadArray.add(name);
    return true;
  }
  if (/(^|_)__read$/.test(name)) {
    if (isReadShape(fn)) helpers.read.add(name);
    return true;
  }
  if (
    /(^|_)(arrayWithoutHoles|arrayLikeToArray|iterableToArray|unsupportedIterableToArray|nonIterableSpread|nonIterableRest|defineProperty)$/.test(
      name,
    )
  ) {
    helpers.sub.add(name);
    return true;
  }
  // Minified name: trust the body shape alone.
  if (isObjectSpreadShape(fn)) {
    helpers.objectSpread.add(name);
    return true;
  }
  if (isToConsumableArrayShape(fn)) {
    helpers.toConsumableArray.add(name);
    return true;
  }
  if (isExtendsShape(fn, name)) {
    helpers.objectSpread.add(name);
    return true;
  }
  if (isSpreadArrayShape(fn)) {
    helpers.spreadArray.add(name);
    return true;
  }
  if (isReadShape(fn)) {
    helpers.read.add(name);
    return true;
  }
  return false;
}

// Unwraps `var h = (this && this.h) || function ...` / assignments /
// sequences down to the underlying function, if any.
function unwrapHelperInit(node: t.Node | null | undefined): t.Node | null {
  let current = node ?? null;
  for (let i = 0; i < 10 && current; i++) {
    if (t.isLogicalExpression(current)) {
      current = current.right;
    } else if (
      t.isAssignmentExpression(current) &&
      t.isExpression(current.right)
    ) {
      current = current.right;
    } else if (t.isSequenceExpression(current)) {
      const last = current.expressions[current.expressions.length - 1];
      current = t.isExpression(last) ? last : null;
    } else if (
      t.isCallExpression(current) &&
      t.isIdentifier(current.callee, { name: 'require' })
    ) {
      return null;
    } else {
      return current;
    }
  }
  return current;
}

function findRequireSource(node: t.Node): string | null {
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

function runtimeHelperKind(source: string): HelperKind | null {
  const base = source.split('/').pop() ?? '';
  return RUNTIME_HELPERS[base.replace(/\.js$/, '')] ?? null;
}

function collectHelpers(programPath: NodePath<t.Program>): HelperSets {
  const helpers = emptyHelpers();

  const consider = (fn: PlainFunction | null, name: string): void => {
    if (fn) classifyHelper(fn, name, helpers);
  };

  for (const stmtPath of programPath.get('body')) {
    const node = stmtPath.node;
    if (t.isFunctionDeclaration(node) && node.id) {
      consider(asPlainFunction(node), node.id.name);
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of stmtPath.get('declarations')) {
        const id = declarator.node.id;
        const init = declarator.node.init;
        if (!t.isIdentifier(id) || !init) continue;
        const unwrapped = unwrapHelperInit(init);
        const fn = asPlainFunction(unwrapped);
        if (fn) {
          consider(fn, id.name);
        } else {
          const source = findRequireSource(init);
          if (!source) continue;
          const kind = runtimeHelperKind(source);
          if (kind) helpers[kind].add(id.name);
        }
      }
    } else if (t.isImportDeclaration(node)) {
      const source = node.source.value;
      if (source === 'tslib' || source.endsWith('/tslib')) {
        for (const specifier of node.specifiers) {
          if (!t.isImportSpecifier(specifier)) continue;
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          const kind = TSLIB_HELPERS[imported];
          if (kind) helpers[kind].add(specifier.local.name);
        }
        continue;
      }
      const kind = runtimeHelperKind(source);
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

type Callee =
  | { type: 'id'; name: string }
  | { type: 'member'; object: string | null; prop: string };

// Matches `(0, helper)(...)` interop call shapes and member calls.
function resolveCallee(
  node: t.Expression | t.Super | t.V8IntrinsicIdentifier | null | undefined,
): Callee | null {
  if (!node) return null;
  if (t.isIdentifier(node)) return { type: 'id', name: node.name };
  if (
    t.isSequenceExpression(node) &&
    node.expressions.length === 2 &&
    t.isNumericLiteral(node.expressions[0], { value: 0 })
  ) {
    const last = node.expressions[1];
    return t.isExpression(last) ? resolveCallee(last) : null;
  }
  if (t.isMemberExpression(node)) {
    const prop = !node.computed
      ? t.isIdentifier(node.property)
        ? node.property.name
        : null
      : t.isStringLiteral(node.property)
        ? node.property.value
        : null;
    if (prop === null) return null;
    const object = t.isIdentifier(node.object) ? node.object.name : null;
    if (prop === 'default' && object !== null) {
      return { type: 'id', name: object };
    }
    return { type: 'member', object, prop };
  }
  return null;
}

function isExpression(node: t.Node | null | undefined): node is t.Expression {
  return t.isExpression(node);
}

interface Context {
  helpers: HelperSets;
}

function isHelperId(
  callee: Callee | null,
  names: Set<string>,
): callee is { type: 'id'; name: string } {
  return callee !== null && callee.type === 'id' && names.has(callee.name);
}

function isToConsumableArrayCall(
  node: t.CallExpression,
  ctx: Context,
): boolean {
  if (node.arguments.length !== 1) return false;
  if (!isExpression(node.arguments[0])) return false;
  return (
    t.isExpression(node.callee) &&
    isHelperId(resolveCallee(node.callee), ctx.helpers.toConsumableArray)
  );
}

function isReadCall(node: t.CallExpression, ctx: Context): boolean {
  if (node.arguments.length < 1 || !isExpression(node.arguments[0])) {
    return false;
  }
  if (!t.isExpression(node.callee)) return false;
  const callee = resolveCallee(node.callee);
  if (isHelperId(callee, ctx.helpers.read)) return true;
  // Dunder names are TypeScript-namespaced, so `x.__read` needs no
  // further check of what `x` is.
  return (
    callee !== null && callee.type === 'member' && callee.prop === '__read'
  );
}

function isSpreadArrayCall(node: t.CallExpression, ctx: Context): boolean {
  if (node.arguments.length !== 3) return false;
  if (!t.isExpression(node.callee)) return false;
  const callee = resolveCallee(node.callee);
  if (isHelperId(callee, ctx.helpers.spreadArray)) return true;
  return (
    callee !== null &&
    callee.type === 'member' &&
    callee.prop === '__spreadArray'
  );
}

function isObjectSpreadCall(node: t.CallExpression, ctx: Context): boolean {
  if (node.arguments.length < 1) return false;
  if (!t.isExpression(node.callee)) return false;
  const callee = resolveCallee(node.callee);
  if (isHelperId(callee, ctx.helpers.objectSpread)) return true;
  if (callee === null || callee.type !== 'member') return false;
  if (callee.object === 'Object' && callee.prop === 'assign') return true;
  return callee.prop === '__assign';
}

function isFreshObject(
  node: t.Node | null | undefined,
): node is t.ObjectExpression {
  return t.isObjectExpression(node) && node.properties.length === 0;
}

// `[...elements]` for the value position of a `__spreadArray` result:
// the `to` array keeps its elements as-is, every other argument spreads.
function expandSpreadArrayArgs(
  args: t.CallExpression['arguments'],
  ctx: Context,
): (t.Expression | t.SpreadElement | null)[] | null {
  const [to, ...middle] = args;
  // The last argument is the `pack` flag, not a value to spread.
  const rest = middle.slice(0, -1);
  let elements: (t.Expression | t.SpreadElement | null)[];
  if (t.isArrayExpression(to)) {
    elements = [...to.elements];
  } else if (t.isCallExpression(to) && isSpreadArrayCall(to, ctx)) {
    const nested = expandSpreadArrayArgs(to.arguments, ctx);
    if (!nested) return null;
    elements = nested;
  } else {
    return null;
  }
  for (const arg of rest) {
    if (t.isSpreadElement(arg)) return null;
    if (t.isCallExpression(arg) && isReadCall(arg, ctx)) {
      const [first] = arg.arguments;
      if (!isExpression(first)) return null;
      elements.push(t.spreadElement(first));
    } else if (t.isArrayExpression(arg)) {
      // `.concat` appends an array argument's items as values, so its
      // elements carry over unchanged (no extra spreading).
      elements.push(...arg.elements);
    } else if (isExpression(arg)) {
      elements.push(t.spreadElement(arg));
    } else {
      return null;
    }
  }
  return elements;
}

function tryBareToConsumableArray(
  path: NodePath<t.CallExpression>,
  ctx: Context,
): boolean {
  if (!isToConsumableArrayCall(path.node, ctx)) return false;
  const [arg] = path.node.arguments;
  if (!isExpression(arg)) return false;
  path.replaceWith(t.arrayExpression([t.spreadElement(arg)]));
  return true;
}

// `[].concat(_toConsumableArray(a), [b])` -> `[ ...a, ...b ]`.
// Plain (non-helper, non-array) arguments keep concat's single-append
// semantics as plain elements. Bails when nothing needs expanding so
// ordinary `.concat` calls are untouched.
function tryConcatSpread(
  path: NodePath<t.CallExpression>,
  ctx: Context,
): boolean {
  const { node } = path;
  if (!t.isExpression(node.callee) || !t.isMemberExpression(node.callee)) {
    return false;
  }
  const { object, property, computed } = node.callee;
  const isConcat =
    !computed &&
    t.isIdentifier(property, { name: 'concat' }) &&
    t.isArrayExpression(object);
  if (!isConcat || node.arguments.length === 0) return false;
  // Only helper output converts: a plain `[].concat(a, b)` cannot spread
  // `a`/`b` without knowing they are arrays.
  const expandable = node.arguments.some(
    (arg) =>
      t.isCallExpression(arg) &&
      (isToConsumableArrayCall(arg, ctx) || isSpreadArrayCall(arg, ctx)),
  );
  if (!expandable) return false;

  const elements: (t.Expression | t.SpreadElement | null)[] = [
    ...object.elements,
  ];
  for (const arg of node.arguments) {
    if (!t.isCallExpression(arg)) {
      // Babel wraps every non-spread item in an array literal, so a bare
      // value here may itself be an array that `.concat` would flatten:
      // only array literals carry over unchanged, anything else bails.
      if (!t.isArrayExpression(arg)) return false;
      elements.push(...arg.elements);
    } else if (isToConsumableArrayCall(arg, ctx)) {
      const [inner] = arg.arguments;
      if (!isExpression(inner)) return false;
      elements.push(t.spreadElement(inner));
    } else if (isSpreadArrayCall(arg, ctx)) {
      const expanded = expandSpreadArrayArgs(arg.arguments, ctx);
      if (!expanded) return false;
      elements.push(...expanded);
    } else {
      return false;
    }
  }
  path.replaceWith(t.arrayExpression(elements));
  return true;
}

// `void <literal>` evaluates to `undefined` without side effects, so it is
// a safe `thisArg` to drop. Any other `void` operand (`void foo()`,
// `void foo`) may carry side effects or read a shadowed binding.
function isVoidLiteral(node: t.Node | null | undefined): boolean {
  return (
    t.isUnaryExpression(node, { operator: 'void' }) &&
    (t.isNumericLiteral(node.argument) ||
      t.isStringLiteral(node.argument) ||
      t.isBooleanLiteral(node.argument) ||
      t.isNullLiteral(node.argument) ||
      t.isBigIntLiteral(node.argument) ||
      t.isRegExpLiteral(node.argument) ||
      (t.isTemplateLiteral(node.argument) &&
        node.argument.expressions.length === 0))
  );
}

// A bare `undefined` is only the global `undefined` value when no local
// binding shadows it.
function isUnshadowedUndefined(
  path: NodePath<t.CallExpression>,
  node: t.Node | null | undefined,
): node is t.Identifier {
  return (
    t.isIdentifier(node, { name: 'undefined' }) &&
    !path.scope.getBinding('undefined')
  );
}

// Side-effect-free receiver: an identifier, `this`, or a pure member chain
// (`a.b`, `a["b"]`, `this.x.y`). Anything else (calls, computed lookups
// with side effects, optionals) reads as impure.
function isPureReceiver(node: t.Node | null | undefined): boolean {
  if (t.isIdentifier(node) || t.isThisExpression(node)) return true;
  if (t.isMemberExpression(node) && !node.optional) {
    const propOk = node.computed
      ? t.isStringLiteral(node.property) || t.isNumericLiteral(node.property)
      : t.isIdentifier(node.property);
    return propOk && isPureReceiver(node.object);
  }
  return false;
}

// Structural identity ignoring locations. Both sides are pure receivers
// (checked first), so only identifiers / `this` / member chains can occur.
function isSameReceiver(a: t.Node, b: t.Node): boolean {
  if (t.isIdentifier(a) && t.isIdentifier(b)) return a.name === b.name;
  if (t.isThisExpression(a) && t.isThisExpression(b)) return true;
  if (t.isMemberExpression(a) && t.isMemberExpression(b)) {
    if (a.computed !== b.computed) return false;
    const propSame = a.computed
      ? (t.isStringLiteral(a.property) &&
          t.isStringLiteral(b.property) &&
          a.property.value === b.property.value) ||
        (t.isNumericLiteral(a.property) &&
          t.isNumericLiteral(b.property) &&
          a.property.value === b.property.value)
      : t.isIdentifier(a.property) &&
        t.isIdentifier(b.property) &&
        a.property.name === b.property.name;
    return !!propSame && isSameReceiver(a.object, b.object);
  }
  return false;
}

// `fn.apply(thisArg, _toConsumableArray(args))` -> `fn(...args)` for bare
// callees, `obj.m.apply(obj, ...)` -> `obj.m(...args)` for member callees.
// A bare call binds `this` to `undefined`, so only `undefined`-valued,
// side-effect-free thisArgs convert (`void <literal>`, unshadowed
// `undefined`, `null`). A member call binds `this` to the receiver, so the
// thisArg must be that same side-effect-free receiver. Anything else
// (`fn.apply(foo, ...)`, `fn.apply(void foo(), ...)`, `o.m.apply(other, ...)`)
// keeps `.apply`; only the inner helper call still converts.
function tryApplySpread(
  path: NodePath<t.CallExpression>,
  ctx: Context,
): boolean {
  const { node } = path;
  if (!t.isExpression(node.callee) || !t.isMemberExpression(node.callee)) {
    return false;
  }
  const { object, property, computed } = node.callee;
  if (computed || !t.isIdentifier(property, { name: 'apply' })) return false;
  if (!isExpression(object) || node.arguments.length !== 2) return false;
  const [thisArg, args] = node.arguments;
  if (!t.isCallExpression(args) || !isToConsumableArrayCall(args, ctx)) {
    return false;
  }
  const [inner] = args.arguments;
  if (!isExpression(thisArg) || !isExpression(inner)) return false;
  if (t.isIdentifier(object)) {
    const droppable =
      isVoidLiteral(thisArg) ||
      isUnshadowedUndefined(path, thisArg) ||
      t.isNullLiteral(thisArg);
    if (!droppable) return false;
  } else if (t.isMemberExpression(object) && !object.optional) {
    const receiver = object.object;
    if (
      !isExpression(receiver) ||
      !isPureReceiver(receiver) ||
      !isSameReceiver(receiver, thisArg)
    ) {
      return false;
    }
  } else {
    return false;
  }
  path.replaceWith(t.callExpression(object, [t.spreadElement(inner)]));
  return true;
}

// `_objectSpread({}, a, { b: 1 })` and friends -> `{ ...a, b: 1 }`.
// Object-literal arguments inline their properties; anything else spreads.
// Only a fresh `{}` first argument converts: any other target would be
// mutated by `Object.assign`-style helpers, which spread cannot express.
function tryObjectSpread(
  path: NodePath<t.CallExpression>,
  ctx: Context,
): boolean {
  const { node } = path;
  if (!isObjectSpreadCall(node, ctx)) return false;
  const [target, ...rest] = node.arguments;
  if (!isFreshObject(target)) return false;
  const properties: (t.ObjectMethod | t.ObjectProperty | t.SpreadElement)[] =
    [];
  for (const arg of rest) {
    if (t.isSpreadElement(arg)) {
      properties.push(arg);
    } else if (t.isObjectExpression(arg)) {
      properties.push(...arg.properties);
    } else if (isExpression(arg)) {
      properties.push(t.spreadElement(arg));
    } else {
      return false;
    }
  }
  path.replaceWith(t.objectExpression(properties));
  return true;
}

function trySpreadArray(
  path: NodePath<t.CallExpression>,
  ctx: Context,
): boolean {
  const { node } = path;
  if (!isSpreadArrayCall(node, ctx)) return false;
  const elements = expandSpreadArrayArgs(node.arguments, ctx);
  if (!elements) return false;
  path.replaceWith(t.arrayExpression(elements));
  return true;
}

// True when every remaining reference lives inside the helper's own
// definition (recursion, self-rewrites like `_extends = ...`), i.e. nothing
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
  helpers: HelperSets,
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
  name: 'spread-helpers',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      Program: {
        exit(path, state) {
          const ctx: Context = { helpers: collectHelpers(path) };
          // Outer calls first (enter order): a `[].concat(...)` / `.apply` /
          // `__spreadArray` match consumes its inner helper calls, so the
          // bare `_toConsumableArray` case only fires for genuinely bare uses.
          path.traverse({
            CallExpression(callPath) {
              if (
                tryConcatSpread(callPath, ctx) ||
                tryApplySpread(callPath, ctx) ||
                trySpreadArray(callPath, ctx) ||
                tryObjectSpread(callPath, ctx) ||
                tryBareToConsumableArray(callPath, ctx)
              ) {
                state.changes++;
              }
            },
          });
          state.changes += removeDeadHelpers(path, ctx.helpers);
        },
      },
    };
  },
} satisfies Transform;
