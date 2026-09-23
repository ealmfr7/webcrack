import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';

// Reverse of `@babel/plugin-transform-classes` (spec and loose output).
// Helper functions are identified by body shape instead of by name because
// bundlers and minifiers usually rename them. Supported patterns:
//
// - `_classCallCheck(this, Foo)` at the top of the constructor
// - `_createClass(Foo, protoProps, staticProps)` with `{ key, value/get/set }`
//   descriptors, plus loose `Foo.prototype.m = ...` / `Foo.m = ...` assignments
// - `_inherits(Sub, Super)` (also `_inheritsLoose`) with `extends`
// - constructor super calls: `_super.call(this, ...)` / `_super.apply(this, ...)`
//   (via `_createSuper`), `_callSuper(this, Cls, args)` and loose
//   `Super.call(this, ...) || this`, including the `_this` alias and
//   `_possibleConstructorReturn` / `_assertThisInitialized` wrappers
// - super member access: `_get(_getPrototypeOf(Cls.prototype), k, this)`,
//   `_superPropGet(Cls, k, this, flags)` and loose `Super.prototype.m.call`
// - helpers provided as `require('@babel/runtime/helpers/...')` or imports
//
// Helper definitions are removed only when no references to them remain.

type HelperKind =
  | 'classCallCheck'
  | 'createClass'
  | 'defineProperties'
  | 'inherits'
  | 'setPrototypeOf'
  | 'createSuper'
  | 'callSuper'
  | 'possibleConstructorReturn'
  | 'getPrototypeOf'
  | 'assertThisInitialized'
  | 'superPropGet'
  | 'toPrimitive'
  | 'toPropertyKey'
  | 'superPropBase'
  | 'lazy';

type HelperSets = Record<HelperKind, Set<string>>;

const RUNTIME_HELPERS: Record<string, HelperKind> = {
  classCallCheck: 'classCallCheck',
  createClass: 'createClass',
  inherits: 'inherits',
  inheritsLoose: 'inherits',
  createSuper: 'createSuper',
  callSuper: 'callSuper',
  possibleConstructorReturn: 'possibleConstructorReturn',
  getPrototypeOf: 'getPrototypeOf',
  assertThisInitialized: 'assertThisInitialized',
  superPropGet: 'superPropGet',
  setPrototypeOf: 'setPrototypeOf',
  get: 'lazy',
  isNativeReflectConstruct: 'lazy',
};

function emptyHelpers(): HelperSets {
  return {
    classCallCheck: new Set(),
    createClass: new Set(),
    defineProperties: new Set(),
    inherits: new Set(),
    setPrototypeOf: new Set(),
    createSuper: new Set(),
    callSuper: new Set(),
    possibleConstructorReturn: new Set(),
    getPrototypeOf: new Set(),
    assertThisInitialized: new Set(),
    superPropGet: new Set(),
    toPrimitive: new Set(),
    toPropertyKey: new Set(),
    superPropBase: new Set(),
    lazy: new Set(),
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
    typeof (value).type === 'string'
  );
}

function walkNodes(
  node: t.Node,
  cb: (node: t.Node, depth: number) => void,
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
    cb(current, depth);
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

type PlainFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

function asPlainFunction(node: t.Node | null | undefined): PlainFunction | null {
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
  if (!t.isBlockStatement(fn.body)) return null;
  const names: string[] = [];
  for (const param of fn.params) {
    if (!t.isIdentifier(param)) return null;
    names.push(param.name);
  }
  return names;
}

// Unwraps `(0, X.default)(...)` / `X.default(...)` / `X(...)` to `X`.
function getCalleeName(
  callee: t.Node | null | undefined,
): string | null {
  if (!callee) return null;
  if (t.isIdentifier(callee)) return callee.name;
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    ((t.isIdentifier(callee.property) &&
      callee.property.name === 'default' &&
      !callee.computed) ||
      (t.isStringLiteral(callee.property) &&
        callee.property.value === 'default' &&
        callee.computed))
  ) {
    return callee.object.name;
  }
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions[callee.expressions.length - 1];
    return last ? getCalleeName(last) : null;
  }
  return null;
}

function isHelperCall(
  node: t.Node | null | undefined,
  names: Set<string>,
): node is t.CallExpression {
  if (!t.isCallExpression(node)) return false;
  if (!t.isExpression(node.callee)) return false;
  const name = getCalleeName(node.callee);
  return name !== null && names.has(name);
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

function returnsName(
  arg: t.Node | null | undefined,
  name: string,
): boolean {
  if (!arg) return false;
  if (t.isIdentifier(arg, { name })) return true;
  if (t.isSequenceExpression(arg)) {
    const last = arg.expressions[arg.expressions.length - 1];
    return !!last && returnsName(last, name);
  }
  return false;
}

function throwsNewError(fn: PlainFunction, names: string[]): boolean {
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        !found &&
        t.isThrowStatement(node) &&
        t.isNewExpression(node.argument) &&
        t.isIdentifier(node.argument.callee) &&
        names.includes(node.argument.callee.name)
      ) {
        found = true;
      }
    },
    true,
  );
  return found;
}

// Babel's constructor helpers guard with `throw new TypeError(...)`
// (`_possibleConstructorReturn`) or `throw new ReferenceError(...)`
// (`_assertThisInitialized`).
function throwsHelperError(fn: PlainFunction): boolean {
  return throwsNewError(fn, ['TypeError', 'ReferenceError']);
}

function callsNamed(
  fn: PlainFunction,
  names: Set<string>,
): boolean {
  if (names.size === 0) return false;
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (found || !t.isCallExpression(node)) return;
      if (!t.isExpression(node.callee)) return;
      const name = getCalleeName(node.callee);
      if (name !== null && names.has(name)) found = true;
    },
    true,
  );
  return found;
}

function hasMemberNamed(
  fn: PlainFunction,
  property: string,
  skipNested = true,
): boolean {
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (found || !t.isMemberExpression(node)) return;
      const prop = node.property;
      if (
        (!node.computed && t.isIdentifier(prop, { name: property })) ||
        (node.computed && t.isStringLiteral(prop, { value: property }))
      ) {
        found = true;
      }
    },
    skipNested,
  );
  return found;
}

function hasNestedFunction(fn: PlainFunction): boolean {
  let found = false;
  walkNodes(
    fn.body,
    (node, depth) => {
      if (
        depth > 0 &&
        (t.isFunctionDeclaration(node) ||
          t.isFunctionExpression(node) ||
          t.isArrowFunctionExpression(node))
      ) {
        found = true;
      }
    },
    false,
  );
  return found;
}

function selfAssigns(
  fn: PlainFunction,
  name: string,
  skipNested = true,
): boolean {
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        !found &&
        t.isAssignmentExpression(node) &&
        t.isIdentifier(node.left, { name })
      ) {
        found = true;
      }
    },
    skipNested,
  );
  return found;
}

// `function (a, b) { if (!(a instanceof b)) throw new TypeError(...) }`
function isClassCallCheckFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  const [a, b] = params as [string, string];
  let found = false;
  walkNodes(
    fn.body,
    (node) => {
      if (found || !t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isUnaryExpression(test, { operator: '!' })) return;
      const inner = test.argument;
      if (!t.isBinaryExpression(inner, { operator: 'instanceof' })) return;
      if (!t.isIdentifier(inner.left) || !t.isIdentifier(inner.right)) return;
      const names = [inner.left.name, inner.right.name];
      if (!names.includes(a) || !names.includes(b)) return;
      let throws = false;
      walkNodes(node.consequent, (child) => {
        if (
          t.isThrowStatement(child) &&
          t.isNewExpression(child.argument) &&
          t.isIdentifier(child.argument.callee, { name: 'TypeError' })
        ) {
          throws = true;
        }
      }, false);
      if (throws) found = true;
    },
    true,
  );
  return found;
}

// `function (C, proto, statics) { ...; return C; }` touching `C.prototype`
function isCreateClassFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 3) return false;
  const [self] = params as [string, string, string];
  let sawProto = false;
  let sawCall = false;
  let returned = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        t.isMemberExpression(node) &&
        t.isIdentifier(node.object, { name: self }) &&
        !node.computed &&
        t.isIdentifier(node.property, { name: 'prototype' })
      ) {
        sawProto = true;
      } else if (t.isCallExpression(node)) {
        sawCall = true;
      } else if (
        t.isReturnStatement(node) &&
        returnsName(node.argument, self)
      ) {
        returned = true;
      }
    },
    true,
  );
  return sawProto && sawCall && returned;
}

// `function (target, props) { for (...) { ... Object.defineProperty(...) } }`
function isDefinePropertiesFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  let sawFor = false;
  walkNodes(
    fn.body,
    (node) => {
      if (t.isForStatement(node)) sawFor = true;
    },
    true,
  );
  return sawFor && hasMemberNamed(fn, 'defineProperty');
}

// `function (sub, sup) { sub.prototype = Object.create(...); ... }`
function isInheritsFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  const [sub] = params as [string, string];
  let sawProtoAssign = false;
  let sawCreate = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        t.isAssignmentExpression(node, { operator: '=' }) &&
        t.isMemberExpression(node.left) &&
        t.isIdentifier(node.left.object, { name: sub }) &&
        ((!node.left.computed &&
          t.isIdentifier(node.left.property, { name: 'prototype' })) ||
          (node.left.computed &&
            t.isStringLiteral(node.left.property, { value: 'prototype' })))
      ) {
        sawProtoAssign = true;
      } else if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        ((!node.callee.computed &&
          t.isIdentifier(node.callee.property, { name: 'create' })) ||
          (node.callee.computed &&
            t.isStringLiteral(node.callee.property, { value: 'create' })))
      ) {
        sawCreate = true;
      }
    },
    true,
  );
  return sawProtoAssign && sawCreate;
}

// `function (self, call) { ... throw ...; return self / _assertThisInitialized(self) }`
function isPossibleConstructorReturnFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  const [self] = params as [string, string];
  let returned = false;
  walkNodes(
    fn.body,
    (node) => {
      if (!t.isReturnStatement(node)) return;
      const arg = node.argument;
      if (!arg) return;
      if (t.isIdentifier(arg, { name: self })) {
        returned = true;
      } else if (t.isCallExpression(arg)) {
        let usesSelf = false;
        walkNodes(arg, (child) => {
          if (t.isIdentifier(child, { name: self })) usesSelf = true;
        }, false);
        if (usesSelf) returned = true;
      }
    },
    true,
  );
  return returned && throwsHelperError(fn);
}

// `function (o) { ... Object.getPrototypeOf ...; self-rewrite or __proto__ }`
function isGetPrototypeOfFn(fn: PlainFunction, name: string): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 1) return false;
  return (
    hasMemberNamed(fn, 'getPrototypeOf') &&
    (selfAssigns(fn, name) ||
      hasMemberNamed(fn, '__proto__') ||
      hasMemberNamed(fn, 'setPrototypeOf'))
  );
}

// `function (self) { if (self === void 0) throw ...; return self; }`
function isAssertThisInitializedFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 1) return false;
  const [self] = params as [string];
  let returned = false;
  walkNodes(
    fn.body,
    (node) => {
      if (t.isReturnStatement(node) && t.isIdentifier(node.argument, { name: self })) {
        returned = true;
      }
    },
    true,
  );
  return returned && throwsHelperError(fn);
}

// `function (o, p) { ... Object.setPrototypeOf ...; self-rewrite or __proto__ }`
function isSetPrototypeOfFn(fn: PlainFunction, name: string): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  return (
    hasMemberNamed(fn, 'setPrototypeOf') &&
    (selfAssigns(fn, name) || hasMemberNamed(fn, '__proto__'))
  );
}

// `function (D) { ... return function () { ... _possibleConstructorReturn / _getPrototypeOf / Reflect ... } }`
function isCreateSuperFn(fn: PlainFunction, known: Set<string>): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 1) return false;
  if (!hasNestedFunction(fn)) return false;
  return (
    callsNamed(fn, known) ||
    hasMemberNamed(fn, 'construct', false) ||
    hasMemberNamed(fn, 'apply', false)
  );
}

// `function (t, o, e) { ... _possibleConstructorReturn / _getPrototypeOf / Reflect ... }`
function isCallSuperFn(fn: PlainFunction, known: Set<string>): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 3) return false;
  return (
    callsNamed(fn, known) ||
    hasMemberNamed(fn, 'construct') ||
    hasMemberNamed(fn, 'apply')
  );
}

// `function (t, o, e, r) { ... _getPrototypeOf ... }`
function isSuperPropGetFn(fn: PlainFunction, known: Set<string>): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 4) return false;
  return callsNamed(fn, known) || hasMemberNamed(fn, 'apply');
}

// `function () { _get = ... Reflect ...; return _get(...) }` (`_get`,
// `_isNativeReflectConstruct`, ...): zero params plus a self-rewrite.
function isLazyHelperFn(fn: PlainFunction, name: string): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 0) return false;
  return selfAssigns(fn, name);
}

// `function (t, r) { ... t[Symbol.toPrimitive] ...; throw ... }`.
// Cleanup-only: never matched at usage sites.
function isToPrimitiveFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  let sawSymbol = false;
  walkNodes(
    fn.body,
    (node) => {
      if (
        !sawSymbol &&
        t.isMemberExpression(node) &&
        t.isIdentifier(node.object, { name: 'Symbol' })
      ) {
        sawSymbol = true;
      }
    },
    true,
  );
  return sawSymbol && throwsHelperError(fn);
}

// `function (t, o) { for (; !{}.hasOwnProperty.call(t, o) && ...); return t; }`.
// Cleanup-only: never matched at usage sites.
function isSuperPropBaseFn(fn: PlainFunction): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 2) return false;
  const [first] = params as [string, string];
  let sawLoop = false;
  let returnsFirst = false;
  walkNodes(
    fn.body,
    (node) => {
      if (t.isForStatement(node) || t.isWhileStatement(node)) sawLoop = true;
      else if (
        t.isReturnStatement(node) &&
        t.isIdentifier(node.argument, { name: first })
      ) {
        returnsFirst = true;
      }
    },
    true,
  );
  return sawLoop && returnsFirst && hasMemberNamed(fn, 'hasOwnProperty');
}

// `function (t) { var i = _toPrimitive(t, "string"); ... typeof ... }`.
// Cleanup-only: never matched at usage sites.
function isToPropertyKeyFn(fn: PlainFunction, known: Set<string>): boolean {
  const params = fnParams(fn);
  if (!params || params.length !== 1) return false;
  if (!callsNamed(fn, known)) return false;
  let sawTypeof = false;
  walkNodes(
    fn.body,
    (node) => {
      if (t.isUnaryExpression(node, { operator: 'typeof' })) sawTypeof = true;
    },
    true,
  );
  return sawTypeof;
}

function classifyHelper(
  fn: PlainFunction,
  name: string,
  helpers: HelperSets,
): boolean {
  if (isClassCallCheckFn(fn)) {
    helpers.classCallCheck.add(name);
    return true;
  }
  if (isCreateClassFn(fn)) {
    helpers.createClass.add(name);
    return true;
  }
  if (isDefinePropertiesFn(fn)) {
    helpers.defineProperties.add(name);
    return true;
  }
  if (isInheritsFn(fn)) {
    helpers.inherits.add(name);
    return true;
  }
  // Before the possible-constructor-return check: `_toPrimitive` also takes
  // two params and returns its first one, but only this shape reads Symbol.
  if (isToPrimitiveFn(fn)) {
    helpers.toPrimitive.add(name);
    return true;
  }
  if (isSuperPropBaseFn(fn)) {
    helpers.superPropBase.add(name);
    return true;
  }
  if (isPossibleConstructorReturnFn(fn)) {
    helpers.possibleConstructorReturn.add(name);
    return true;
  }
  if (isGetPrototypeOfFn(fn, name)) {
    helpers.getPrototypeOf.add(name);
    return true;
  }
  if (isAssertThisInitializedFn(fn)) {
    helpers.assertThisInitialized.add(name);
    return true;
  }
  if (isSetPrototypeOfFn(fn, name)) {
    helpers.setPrototypeOf.add(name);
    return true;
  }
  if (isLazyHelperFn(fn, name)) {
    helpers.lazy.add(name);
    return true;
  }
  return false;
}

function classifyLateHelper(
  fn: PlainFunction,
  name: string,
  helpers: HelperSets,
): boolean {
  const known = new Set([
    ...helpers.possibleConstructorReturn,
    ...helpers.getPrototypeOf,
  ]);
  if (isCreateSuperFn(fn, known)) {
    helpers.createSuper.add(name);
    return true;
  }
  if (isCallSuperFn(fn, known)) {
    helpers.callSuper.add(name);
    return true;
  }
  if (isSuperPropGetFn(fn, known)) {
    helpers.superPropGet.add(name);
    return true;
  }
  if (isToPropertyKeyFn(fn, helpers.toPrimitive)) {
    helpers.toPropertyKey.add(name);
    return true;
  }
  return false;
}

function collectHelpers(programPath: NodePath<t.Program>): HelperSets {
  const helpers = emptyHelpers();
  const pending: { fn: PlainFunction; name: string }[] = [];

  const consider = (fn: PlainFunction | null, name: string): void => {
    if (!fn) return;
    if (!classifyHelper(fn, name, helpers)) pending.push({ fn, name });
  };

  for (const stmtPath of programPath.get('body')) {
    const node = stmtPath.node;
    if (t.isFunctionDeclaration(node) && node.id) {
      const fn = asPlainFunction(node);
      consider(fn, node.id.name);
    } else if (t.isVariableDeclaration(node)) {
      for (const declarator of stmtPath.get('declarations')) {
        const id = declarator.node.id;
        const init = declarator.node.init;
        if (!t.isIdentifier(id) || !init) continue;
        const fn = asPlainFunction(init);
        if (fn) {
          consider(fn, id.name);
        } else {
          const source = findRequireSource(init);
          if (source) {
            const kind = runtimeHelperKind(source);
            if (kind) helpers[kind].add(id.name);
          }
        }
      }
    } else if (t.isImportDeclaration(node)) {
      const kind = runtimeHelperKind(node.source.value);
      if (!kind) continue;
      for (const specifier of node.specifiers) {
        if (
          t.isImportDefaultSpecifier(specifier) ||
          t.isImportNamespaceSpecifier(specifier)
        ) {
          helpers[kind].add(specifier.local.name);
        }
      }
    }
  }

  for (const { fn, name } of pending) classifyLateHelper(fn, name, helpers);
  return helpers;
}

interface ParsedDescriptor {
  key: t.Expression;
  hasValue: boolean;
  value: t.Expression | null;
  get: t.FunctionExpression | null;
  set: t.FunctionExpression | null;
}

function parseDescriptor(
  obj: t.ObjectExpression,
  keyOverride?: t.Expression,
): ParsedDescriptor | null {
  let key: t.Expression | null = null;
  let value: t.Expression | null = null;
  let hasValue = false;
  let get: t.FunctionExpression | null = null;
  let set: t.FunctionExpression | null = null;
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) return null;
    const name = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (name === null) return null;
    if (name === 'key') {
      if (key !== null || !t.isExpression(prop.value)) return null;
      key = prop.value;
    } else if (name === 'value') {
      if (hasValue || !t.isExpression(prop.value)) return null;
      hasValue = true;
      value = prop.value;
    } else if (name === 'get' || name === 'set') {
      if (!t.isFunctionExpression(prop.value)) return null;
      if (name === 'get') {
        if (get) return null;
        get = prop.value;
      } else {
        if (set) return null;
        set = prop.value;
      }
    } else if (
      name === 'enumerable' ||
      name === 'configurable' ||
      name === 'writable'
    ) {
      continue;
    } else {
      return null;
    }
  }
  // `Object.defineProperty` descriptors carry the key separately.
  if (!key) key = keyOverride ?? null;
  if (!key || (!hasValue && !get && !set)) return null;
  return { key, hasValue, value, get, set };
}

function memberKeyName(key: t.Expression): string | null {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return key.value.toString();
  return null;
}

const IDENT_RE = /^[$A-Z_a-z][$\w]*$/;

function toClassKey(key: t.Expression): {
  key: t.Expression;
  computed: boolean;
} {
  if (t.isIdentifier(key) || t.isNumericLiteral(key)) {
    return { key, computed: false };
  }
  // `"bar"() {}` and `bar() {}` are equivalent; prefer the latter.
  if (t.isStringLiteral(key) && IDENT_RE.test(key.value)) {
    return { key: t.identifier(key.value), computed: false };
  }
  return { key, computed: true };
}

interface MemberDesc {
  key: t.Expression;
  computed: boolean;
  isStatic: boolean;
  kind: 'method' | 'get' | 'set' | 'field';
  fn: t.FunctionExpression | null;
  fieldValue: t.Expression | null;
}

// Builds a class member from a `{ key, value/get/set }` descriptor shape.
// Returns null when the descriptor cannot be represented in a class body.
function descriptorToMember(
  desc: ParsedDescriptor,
  isStatic: boolean,
): MemberDesc | null {
  const keyName = memberKeyName(desc.key);
  if (keyName === 'prototype') return null;
  const { key, computed } = toClassKey(desc.key);
  if (desc.get) {
    if (!isStatic && keyName === 'constructor') return null;
    return { key, computed, isStatic, kind: 'get', fn: desc.get, fieldValue: null };
  }
  if (desc.set) {
    if (!isStatic && keyName === 'constructor') return null;
    return { key, computed, isStatic, kind: 'set', fn: desc.set, fieldValue: null };
  }
  if (desc.hasValue) {
    if (t.isFunctionExpression(desc.value)) {
      if (!isStatic && keyName === 'constructor' && desc.value) return null;
      return { key, computed, isStatic, kind: 'method', fn: desc.value, fieldValue: null };
    }
    // Data values only convert safely as static fields; a prototype data
    // assignment evaluates once while an instance field evaluates per instance.
    if (!isStatic) return null;
    return { key, computed, isStatic, kind: 'field', fn: null, fieldValue: desc.value };
  }
  return null;
}

function parsePropsArray(
  arg: t.Node | null | undefined,
): ParsedDescriptor[] | null {
  if (!arg) return [];
  if (
    t.isNullLiteral(arg) ||
    t.isIdentifier(arg, { name: 'undefined' }) ||
    (t.isUnaryExpression(arg, { operator: 'void' }) &&
      t.isNumericLiteral(arg.argument, { value: 0 }))
  ) {
    return [];
  }
  if (!t.isArrayExpression(arg)) return null;
  const descs: ParsedDescriptor[] = [];
  for (const element of arg.elements) {
    if (!element || !t.isObjectExpression(element)) return null;
    const desc = parseDescriptor(element);
    if (!desc) return null;
    descs.push(desc);
  }
  return descs;
}

function isSideEffectFree(node: t.Node): boolean {
  return (
    t.isIdentifier(node) ||
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

interface SuperCtorCall {
  call: NodePath<t.CallExpression>;
  top: NodePath<t.CallExpression | t.LogicalExpression>;
  kind: 'classic' | 'callSuper' | 'loose';
}

interface SuperPropAccess {
  top: NodePath<t.CallExpression | t.MemberExpression>;
  key: t.Expression;
  computed: boolean;
  args: (t.Expression | t.SpreadElement)[] | null;
  spreadArg: t.Expression | null;
}

interface CtorScan {
  ccc: NodePath<t.ExpressionStatement> | null;
  superCalls: SuperCtorCall[];
  pcrCalls: { call: NodePath<t.CallExpression>; helper: 'pcr' | 'ati' }[];
  returnsThis: NodePath<t.ReturnStatement>[];
  propAccesses: SuperPropAccess[];
  thisAlias: string | null;
  thisDecl: NodePath<t.VariableDeclaration> | null;
  producingAssign: NodePath<t.ExpressionStatement> | null;
}

// `Cls.prototype` or `Cls` (as the target of a super lookup).
function protoTargetInfo(
  expr: t.Node | null | undefined,
  className: string,
  helpers: HelperSets,
): { isStatic: boolean } | null {
  if (!t.isCallExpression(expr) || expr.arguments.length !== 1) return null;
  const callee = expr.callee;
  const arg = expr.arguments[0];
  if (t.isExpression(callee)) {
    const base = getCalleeName(callee);
    if (base !== null && helpers.getPrototypeOf.has(base)) {
      // recognized `_getPrototypeOf(...)`
    } else if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: 'Object' }) &&
      ((!callee.computed && t.isIdentifier(callee.property, { name: 'getPrototypeOf' })) ||
        (callee.computed && t.isStringLiteral(callee.property, { value: 'getPrototypeOf' })))
    ) {
      // `Object.getPrototypeOf(...)`
    } else {
      return null;
    }
  } else {
    return null;
  }
  if (
    t.isMemberExpression(arg) &&
    t.isIdentifier(arg.object, { name: className }) &&
    ((!arg.computed && t.isIdentifier(arg.property, { name: 'prototype' })) ||
      (arg.computed && t.isStringLiteral(arg.property, { value: 'prototype' })))
  ) {
    return { isStatic: false };
  }
  if (t.isIdentifier(arg, { name: className })) return { isStatic: true };
  return null;
}

function propNameOf(member: t.MemberExpression): string | null {
  if (!member.computed && t.isIdentifier(member.property)) {
    return member.property.name;
  }
  if (member.computed && t.isStringLiteral(member.property)) {
    return member.property.value;
  }
  return null;
}

// No function boundary (other than `container` itself) may sit between a
// recorded node and `container`, except arrow functions for member reads
// (lexical `this`/`super` still apply there).
function crossesFunctionBoundary(
  from: NodePath,
  container: NodePath,
  allowArrow: boolean,
): boolean {
  let current: NodePath | null = from.parentPath;
  while (current && current !== container) {
    if (current.isFunction()) {
      if (!allowArrow || !current.isArrowFunctionExpression()) return true;
    }
    if (current.isClass()) return true;
    current = current.parentPath;
  }
  return current !== container;
}

interface ScanContext {
  className: string;
  helpers: HelperSets;
  iifeParam: string | null;
  superId: string | null;
  superAlias: string | null;
  superAliasDecl: t.Node | null;
  isStatic: boolean;
  inConstructor: boolean;
  container: NodePath<t.Function>;
}

// `X(...) || this` unwraps to the call; anything else wrapping a super call
// is left alone.
function unwrapSuperTop(
  call: NodePath<t.CallExpression>,
): NodePath<t.CallExpression | t.LogicalExpression> | null {
  const parent = call.parentPath;
  if (parent.isLogicalExpression({ operator: '||' })) {
    if (
      parent.node.left === call.node &&
      t.isThisExpression(parent.node.right)
    ) {
      return parent;
    }
    return null;
  }
  return call;
}

function superNames(ctx: ScanContext): (string | null)[] {
  return [ctx.iifeParam, ctx.superId];
}

function scanCallExpression(
  path: NodePath<t.CallExpression>,
  ctx: ScanContext,
  scan: CtorScan,
): void {
  const node = path.node;
  const { className, helpers } = ctx;

  if (ctx.inConstructor) {
    if (
      isHelperCall(node, helpers.possibleConstructorReturn) ||
      isHelperCall(node, helpers.assertThisInitialized)
    ) {
      const first = node.arguments[0];
      // Accepted provisionally; analyze keeps only calls whose first
      // argument is `this` or the validated `this` alias.
      if (t.isThisExpression(first) || t.isIdentifier(first)) {
        scan.pcrCalls.push({
          call: path,
          helper: isHelperCall(node, helpers.possibleConstructorReturn)
            ? 'pcr'
            : 'ati',
        });
      }
      return;
    }
  }

  // `_get(protoTarget, key, this)` with optional `.call(this, ...)` /
  // `.apply(this, ...)` wrapper.
  if (
    t.isIdentifier(node.callee) &&
    node.arguments.length === 3 &&
    t.isThisExpression(node.arguments[2])
  ) {
    const target = protoTargetInfo(node.arguments[0], className, helpers);
    if (target) {
      const key = node.arguments[1];
      if (!t.isExpression(key)) return;
      if (crossesFunctionBoundary(path, ctx.container, true)) return;
      // The inner call's parent is the `.call`/`.apply` member expression;
      // the invocation itself is one level further up.
      const calleeParent = path.parentPath;
      const outer =
        calleeParent.isMemberExpression() &&
        calleeParent.node.object === node
          ? calleeParent.parentPath
          : null;
      if (
        outer &&
        outer.isCallExpression() &&
        t.isMemberExpression(outer.node.callee) &&
        outer.node.callee.object === node
      ) {
        const prop = propNameOf(outer.node.callee);
        const receiver = outer.node.arguments[0];
        if (
          (prop === 'call' || prop === 'apply') &&
          t.isThisExpression(receiver) &&
          !crossesFunctionBoundary(outer, ctx.container, true)
        ) {
          if (prop === 'call') {
            const callArgs = takeCallArgs(outer.node.arguments.slice(1));
            if (!callArgs) return;
            const { key: k, computed } = toClassKey(key);
            scan.propAccesses.push({
              top: outer,
              key: k,
              computed,
              args: callArgs,
              spreadArg: null,
            });
          } else {
            const spread = outer.node.arguments[1];
            if (!spread || !t.isExpression(spread)) return;
            const { key: k, computed } = toClassKey(key);
            scan.propAccesses.push({
              top: outer,
              key: k,
              computed,
              args: null,
              spreadArg: spread,
            });
          }
          return;
        }
      }
      const { key: k, computed } = toClassKey(key);
      scan.propAccesses.push({
        top: path,
        key: k,
        computed,
        args: null,
        spreadArg: null,
      });
      return;
    }
  }

  // `_superPropGet(Cls, key, this, flags)` optionally applied `(args)`.
  if (
    isHelperCall(node, helpers.superPropGet) &&
    node.arguments.length >= 3 &&
    t.isIdentifier(node.arguments[0], { name: className }) &&
    t.isThisExpression(node.arguments[2])
  ) {
    const key = node.arguments[1];
    if (!t.isExpression(key)) return;
    if (crossesFunctionBoundary(path, ctx.container, true)) return;
    const parent = path.parentPath;
    if (
      parent.isCallExpression() &&
      parent.node.callee === node &&
      parent.node.arguments.length === 1 &&
      t.isExpression(parent.node.arguments[0]) &&
      !crossesFunctionBoundary(parent, ctx.container, true)
    ) {
      const { key: k, computed } = toClassKey(key);
      const applied = parent.node.arguments[0];
      if (!t.isExpression(applied)) return;
      scan.propAccesses.push({
        top: parent,
        key: k,
        computed,
        args: null,
        spreadArg: applied,
      });
      return;
    }
    const { key: k, computed } = toClassKey(key);
    scan.propAccesses.push({
      top: path,
      key: k,
      computed,
      args: null,
      spreadArg: null,
    });
    return;
  }

  // `_callSuper(this, Cls, args)` (constructor only). Checked before the
  // member-callee gate below: `_callSuper` is a plain identifier callee.
  if (
    ctx.inConstructor &&
    isHelperCall(node, helpers.callSuper) &&
    node.arguments.length === 3 &&
    t.isThisExpression(node.arguments[0]) &&
    t.isIdentifier(node.arguments[1], { name: className })
  ) {
    if (crossesFunctionBoundary(path, ctx.container, false)) return;
    const top = unwrapSuperTop(path);
    if (!top) return;
    scan.superCalls.push({ call: path, top, kind: 'callSuper' });
    return;
  }

  if (!t.isMemberExpression(node.callee)) return;
  const prop = propNameOf(node.callee);
  const receiver = node.arguments[0];
  if (!t.isThisExpression(receiver)) return;

  // Classic `S.call(this, ...)` / `S.apply(this, ...)` (constructor only).
  if (
    ctx.inConstructor &&
    ctx.superAlias !== null &&
    (prop === 'call' || prop === 'apply') &&
    t.isIdentifier(node.callee.object, { name: ctx.superAlias })
  ) {
    if (crossesFunctionBoundary(path, ctx.container, false)) return;
    const binding = path.scope.getBinding(ctx.superAlias);
    if (!binding || binding.path.node !== ctx.superAliasDecl) return;
    const top = unwrapSuperTop(path);
    if (!top) return;
    scan.superCalls.push({ call: path, top, kind: 'classic' });
    return;
  }

  // Loose `S.m.call(this, ...)` (static) or `S.prototype.m.call(this, ...)`
  // (instance), plus `.apply(this, ...)` variants.
  if (prop !== 'call' && prop !== 'apply') return;
  const base = node.callee.object;
  if (!t.isMemberExpression(base)) {
    // Loose `S.call(this, ...)` super-constructor call (constructor only).
    if (
      ctx.inConstructor &&
      t.isIdentifier(base) &&
      superNames(ctx).includes(base.name)
    ) {
      if (crossesFunctionBoundary(path, ctx.container, false)) return;
      const top = unwrapSuperTop(path);
      if (!top) return;
      scan.superCalls.push({ call: path, top, kind: 'loose' });
    }
    return;
  }
  let fromProto: boolean;
  if (
    t.isIdentifier(base.object) &&
    superNames(ctx).includes(base.object.name)
  ) {
    fromProto = false;
  } else if (
    t.isMemberExpression(base.object) &&
    t.isIdentifier(base.object.object) &&
    superNames(ctx).includes(base.object.object.name) &&
    propNameOf(base.object) === 'prototype'
  ) {
    fromProto = true;
  } else {
    return;
  }
  // Prototype-ness must match the method kind so plain base-class references
  // (e.g. `Super.setup()` in an instance method) keep working.
  if (fromProto === ctx.isStatic) return;
  if (!t.isExpression(base.property)) return;
  if (!base.computed && t.isIdentifier(base.property, { name: 'prototype' })) {
    return;
  }
  if (crossesFunctionBoundary(path, ctx.container, true)) return;
  const { key: k, computed } = toClassKey(base.property);
  if (prop === 'call') {
    const callArgs: (t.Expression | t.SpreadElement)[] = [];
    for (const arg of node.arguments.slice(1)) {
      if (t.isExpression(arg) || t.isSpreadElement(arg)) callArgs.push(arg);
      else return;
    }
    scan.propAccesses.push({
      top: path,
      key: k,
      computed,
      args: callArgs,
      spreadArg: null,
    });
  } else {
    const spread = node.arguments[1];
    if (!spread || !t.isExpression(spread)) return;
    scan.propAccesses.push({
      top: path,
      key: k,
      computed,
      args: null,
      spreadArg: spread,
    });
  }
}

function takeCallArgs(
  args: t.CallExpression['arguments'],
): (t.Expression | t.SpreadElement)[] | null {
  const out: (t.Expression | t.SpreadElement)[] = [];
  for (const arg of args) {
    if (t.isExpression(arg) || t.isSpreadElement(arg)) out.push(arg);
    else return null;
  }
  return out;
}

// Loose member reads: `S.prototype.m` (instance) / `S.m` (static).
function scanMemberExpression(
  path: NodePath<t.MemberExpression>,
  ctx: ScanContext,
  scan: CtorScan,
): void {
  const node = path.node;
  // Skip the callee object of a `.call`/`.apply` handled by the call scanner.
  const parent = path.parentPath;
  if (
    parent.isCallExpression() &&
    t.isMemberExpression(parent.node.callee) &&
    parent.node.callee.object === node &&
    (propNameOf(parent.node.callee) === 'call' ||
      propNameOf(parent.node.callee) === 'apply')
  ) {
    return;
  }
  let fromProto: boolean;
  if (t.isIdentifier(node.object) && superNames(ctx).includes(node.object.name)) {
    fromProto = false;
  } else if (
    t.isMemberExpression(node.object) &&
    t.isIdentifier(node.object.object) &&
    superNames(ctx).includes(node.object.object.name) &&
    propNameOf(node.object) === 'prototype'
  ) {
    fromProto = true;
  } else {
    return;
  }
  // The constructor behaves like an instance context for `super` lookups.
  const staticCtx = ctx.inConstructor ? false : ctx.isStatic;
  if (fromProto === staticCtx) return;
  if (!t.isExpression(node.property)) return;
  if (!node.computed && t.isIdentifier(node.property, { name: 'prototype' })) {
    return;
  }
  if (crossesFunctionBoundary(path, ctx.container, true)) return;
  const { key, computed } = toClassKey(node.property);
  scan.propAccesses.push({ top: path, key, computed, args: null, spreadArg: null });
}

function scanFunction(
  fnPath: NodePath<t.Function>,
  ctx: ScanContext,
): CtorScan {
  const scan: CtorScan = {
    ccc: null,
    superCalls: [],
    pcrCalls: [],
    returnsThis: [],
    propAccesses: [],
    thisAlias: null,
    thisDecl: null,
    producingAssign: null,
  };
  const local: ScanContext = { ...ctx, container: fnPath };
  fnPath.traverse({
    Class(path) {
      path.skip();
    },
    CallExpression(path) {
      scanCallExpression(path, local, scan);
    },
    MemberExpression(path) {
      scanMemberExpression(path, local, scan);
    },
  });
  return scan;
}

// Loose `Foo.prototype.m = ...` / `Foo.m = ...` and
// `Object.defineProperty(Foo[.prototype], key, desc)`.
function parseLooseMember(
  stmt: NodePath<t.ExpressionStatement>,
  className: string,
  protoAlias: string | null,
): MemberDesc | null {
  const expr = stmt.node.expression;
  if (
    t.isAssignmentExpression(expr, { operator: '=' }) &&
    t.isMemberExpression(expr.left)
  ) {
    const left = expr.left;
    let isStatic: boolean;
    if (
      t.isMemberExpression(left.object) &&
      t.isIdentifier(left.object.object, { name: className }) &&
      propNameOf(left.object) === 'prototype'
    ) {
      isStatic = false;
    } else if (t.isIdentifier(left.object, { name: className })) {
      isStatic = true;
    } else if (
      protoAlias !== null &&
      t.isIdentifier(left.object, { name: protoAlias })
    ) {
      isStatic = false;
    } else {
      return null;
    }
    if (!t.isExpression(left.property)) return null;
    if (
      !left.computed &&
      t.isIdentifier(left.property, { name: 'prototype' })
    ) {
      return null;
    }
    const keyName = memberKeyName(left.property);
    const { key, computed } = toClassKey(left.property);
    if (t.isFunctionExpression(expr.right)) {
      if (!isStatic && keyName === 'constructor') return null;
      return {
        key,
        computed,
        isStatic,
        kind: 'method',
        fn: expr.right,
        fieldValue: null,
      };
    }
    if (!t.isExpression(expr.right) || !isStatic) return null;
    return {
      key,
      computed,
      isStatic,
      kind: 'field',
      fn: null,
      fieldValue: expr.right,
    };
  }
  if (
    t.isCallExpression(expr) &&
    t.isMemberExpression(expr.callee) &&
    t.isIdentifier(expr.callee.object, { name: 'Object' }) &&
    propNameOf(expr.callee) === 'defineProperty' &&
    expr.arguments.length === 3
  ) {
    const [target, keyArg, descArg] = expr.arguments;
    if (!t.isExpression(target) || !t.isExpression(keyArg)) return null;
    let isStatic: boolean;
    if (
      t.isMemberExpression(target) &&
      t.isIdentifier(target.object, { name: className }) &&
      propNameOf(target) === 'prototype'
    ) {
      isStatic = false;
    } else if (t.isIdentifier(target, { name: className })) {
      isStatic = true;
    } else if (
      protoAlias !== null &&
      t.isIdentifier(target, { name: protoAlias })
    ) {
      isStatic = false;
    } else {
      return null;
    }
    if (!t.isObjectExpression(descArg)) return null;
    const desc = parseDescriptor(descArg, keyArg);
    if (!desc) return null;
    return descriptorToMember(desc, isStatic);
  }
  return null;
}

type SuperArgs =
  | { kind: 'args'; args: (t.Expression | t.SpreadElement)[] }
  | { kind: 'spread'; expr: t.Expression };

function superCallArgs(sc: SuperCtorCall): SuperArgs | null {
  const node = sc.call.node;
  if (sc.kind === 'callSuper') {
    const arr = node.arguments[2];
    if (t.isArrayExpression(arr)) {
      const args: (t.Expression | t.SpreadElement)[] = [];
      for (const element of arr.elements) {
        if (!element) return null;
        if (t.isExpression(element) || t.isSpreadElement(element)) {
          args.push(element);
        } else {
          return null;
        }
      }
      return { kind: 'args', args };
    }
    if (t.isExpression(arr)) return { kind: 'spread', expr: arr };
    return null;
  }
  if (!t.isMemberExpression(node.callee)) return null;
  const prop = propNameOf(node.callee);
  if (prop === 'call') {
    const args = takeCallArgs(node.arguments.slice(1));
    return args ? { kind: 'args', args } : null;
  }
  if (prop === 'apply') {
    const spread = node.arguments[1];
    if (spread && t.isExpression(spread)) return { kind: 'spread', expr: spread };
    return null;
  }
  return null;
}

function isUnder(refPath: NodePath, topNodes: Set<t.Node>): boolean {
  let current: NodePath | null = refPath;
  while (current) {
    if (topNodes.has(current.node)) return true;
    current = current.parentPath;
  }
  return false;
}

interface AnalyzedClass {
  declPath: NodePath<t.VariableDeclarator>;
  varDeclPath: NodePath<t.VariableDeclaration>;
  className: string;
  ctorPath: NodePath<t.FunctionDeclaration>;
  superclass: t.Expression | null;
  superAlias: {
    name: string;
    declPath: NodePath<t.VariableDeclaration>;
  } | null;
  members: MemberDesc[];
  ctorScan: CtorScan;
  methodPropAccesses: SuperPropAccess[];
  cccs: NodePath<t.ExpressionStatement>[];
  pcrCalls: { call: NodePath<t.CallExpression>; helper: 'pcr' | 'ati' }[];
  returnsThis: NodePath<t.ReturnStatement>[];
  thisAlias: string | null;
  thisDecl: NodePath<t.VariableDeclaration> | null;
  producingAssign: NodePath<t.ExpressionStatement> | null;
}

// Read-only validation: returns a conversion plan, or null when the
// declarator is not a recognized transpiled class. Never mutates.
function analyzeClass(
  declPath: NodePath<t.VariableDeclarator>,
  helpers: HelperSets,
): AnalyzedClass | null {
  const id = declPath.node.id;
  const init = declPath.node.init;
  if (!t.isIdentifier(id) || !t.isCallExpression(init)) return null;
  const className = id.name;

  const initPath = declPath.get('init') as NodePath<t.CallExpression>;
  const calleePath = initPath.get('callee');
  if (!calleePath.isFunctionExpression() && !calleePath.isArrowFunctionExpression()) {
    return null;
  }
  const fnNode = calleePath.node;
  if (fnNode.async || fnNode.generator) return null;
  if (!t.isBlockStatement(fnNode.body)) return null;
  if (
    fnNode.params.length > 1 ||
    fnNode.params.some((p) => !t.isIdentifier(p))
  ) {
    return null;
  }
  if (initPath.node.arguments.length !== fnNode.params.length) return null;
  const iifeParam =
    fnNode.params.length === 1
      ? (fnNode.params[0] as t.Identifier).name
      : null;

  const fnPath = calleePath as NodePath<
    t.FunctionExpression | t.ArrowFunctionExpression
  >;
  const stmts = (fnPath.get('body') as NodePath<t.BlockStatement>).get('body');

  const ctorPaths = stmts.filter(
    (s): s is NodePath<t.FunctionDeclaration> =>
      s.isFunctionDeclaration() && s.node.id?.name === className,
  );
  if (ctorPaths.length !== 1) return null;
  const ctorPath = ctorPaths[0];

  const returnPaths = stmts.filter((s): s is NodePath<t.ReturnStatement> =>
    s.isReturnStatement(),
  );
  if (returnPaths.length !== 1) return null;
  const returnPath = returnPaths[0];
  if (stmts[stmts.length - 1] !== returnPath) return null;

  const varDeclPath = declPath.parentPath;
  if (!varDeclPath.isVariableDeclaration()) return null;

  const members: MemberDesc[] = [];
  const staticByFn = new Map<t.FunctionExpression, boolean>();
  const pushDesc = (
    desc: ParsedDescriptor,
    isStatic: boolean,
  ): boolean => {
    const member = descriptorToMember(desc, isStatic);
    if (!member) return false;
    if (member.fn) {
      const prev = staticByFn.get(member.fn);
      if (prev !== undefined && prev !== isStatic) return false;
      staticByFn.set(member.fn, isStatic);
    }
    members.push(member);
    return true;
  };

  let inheritsPath: NodePath<t.ExpressionStatement> | null = null;
  let inheritsArg: NodePath<t.Expression> | null = null;
  let superclass: t.Expression | null = null;
  let superAlias: {
    name: string;
    declPath: NodePath<t.VariableDeclaration>;
  } | null = null;
  let protoAlias: string | null = null;
  let createClassCount = 0;

  const consumeCreateClass = (
    call: t.CallExpression,
  ): boolean => {
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 3 ||
      !t.isIdentifier(call.arguments[0], { name: className })
    ) {
      return false;
    }
    const proto = parsePropsArray(call.arguments[1]);
    const statics = parsePropsArray(call.arguments[2]);
    if (!proto || !statics) return false;
    createClassCount++;
    if (createClassCount > 1) return false;
    for (const desc of proto) {
      if (!pushDesc(desc, false)) return false;
    }
    for (const desc of statics) {
      if (!pushDesc(desc, true)) return false;
    }
    return true;
  };

  for (const stmt of stmts) {
    if (stmt === ctorPaths[0] || stmt === returnPath) continue;
    if (stmt.isEmptyStatement()) continue;
    if (stmt.isFunctionDeclaration()) return null;
    if (stmt.isVariableDeclaration()) {
      const declarators = stmt.get('declarations');
      if (declarators.length !== 1) return null;
      const declarator = declarators[0];
      const did = declarator.node.id;
      const dinit = declarator.node.init;
      if (!t.isIdentifier(did) || !dinit) return null;
      if (
        isHelperCall(dinit, helpers.createSuper) &&
        dinit.arguments.length === 1 &&
        t.isIdentifier(dinit.arguments[0], { name: className })
      ) {
        if (superAlias) return null;
        superAlias = { name: did.name, declPath: stmt };
        continue;
      }
      if (
        t.isMemberExpression(dinit) &&
        t.isIdentifier(dinit.object, { name: className }) &&
        propNameOf(dinit) === 'prototype'
      ) {
        if (protoAlias) return null;
        protoAlias = did.name;
        continue;
      }
      return null;
    }
    if (stmt.isExpressionStatement()) {
      const expr = stmt.node.expression;
      if (
        isHelperCall(expr, helpers.inherits) &&
        expr.arguments.length === 2 &&
        t.isIdentifier(expr.arguments[0], { name: className }) &&
        t.isExpression(expr.arguments[1])
      ) {
        if (inheritsPath) return null;
        const superArg = expr.arguments[1];
        if (iifeParam !== null && t.isIdentifier(superArg, { name: iifeParam })) {
          const passed = initPath.node.arguments[0];
          if (!passed || !t.isExpression(passed)) return null;
          superclass = passed;
        } else {
          superclass = superArg;
          if (iifeParam !== null) {
            const passed = initPath.node.arguments[0];
            if (!passed || !isSideEffectFree(passed)) return null;
          }
        }
        inheritsPath = stmt;
        const argPath = (stmt.get('expression') as NodePath<t.CallExpression>).get(
          'arguments',
        )[1];
        if (!argPath || !argPath.isExpression()) return null;
        inheritsArg = argPath;
        continue;
      }
      if (
        isHelperCall(expr, helpers.createClass) &&
        consumeCreateClass(expr)
      ) {
        continue;
      }
      if (
        t.isCallExpression(expr) &&
        t.isExpression(expr.callee) &&
        getCalleeName(expr.callee) !== null &&
        expr.arguments.length >= 1 &&
        t.isIdentifier(expr.arguments[0], { name: className })
      ) {
        // Unrecognized `X(Foo, ...)` helper call: a different transform
        // version whose output we cannot reconstruct safely.
        return null;
      }
      const loose = parseLooseMember(stmt, className, protoAlias);
      if (loose) {
        if (loose.fn) {
          const prev = staticByFn.get(loose.fn);
          if (prev !== undefined && prev !== loose.isStatic) return null;
          staticByFn.set(loose.fn, loose.isStatic);
        }
        members.push(loose);
        continue;
      }
      return null;
    }
    return null;
  }

  const returnArg = returnPath.node.argument;
  if (t.isIdentifier(returnArg, { name: className })) {
    // plain `return Foo`
  } else if (t.isCallExpression(returnArg) && consumeCreateClass(returnArg)) {
    // `return _createClass(Foo, ...)`
  } else {
    return null;
  }

  if (!superclass && iifeParam !== null) {
    const passed = initPath.node.arguments[0];
    if (!passed || !isSideEffectFree(passed)) return null;
  }

  const superId =
    superclass && t.isIdentifier(superclass) ? superclass.name : null;
  const baseCtx: ScanContext = {
    className,
    helpers,
    iifeParam,
    superId,
    superAlias: superAlias?.name ?? null,
    superAliasDecl: superAlias
      ? (superAlias.declPath.node.declarations[0])
      : null,
    isStatic: false,
    inConstructor: true,
    container: ctorPath,
  };

  const ctorScan = scanFunction(
    ctorPath,
    baseCtx,
  );

  // `_classCallCheck(this, Foo)`: recognized helpers are dropped, anything
  // else shaped like a class check bails out (negative case).
  const ctorStmts = (
    ctorPath.get('body')
  ).get('body');
  const cccs: NodePath<t.ExpressionStatement>[] = [];
  for (const s of ctorStmts) {
    if (!s.isExpressionStatement()) continue;
    const e = s.node.expression;
    if (
      !t.isCallExpression(e) ||
      !t.isExpression(e.callee) ||
      getCalleeName(e.callee) === null
    ) {
      continue;
    }
    if (
      e.arguments.length === 2 &&
      t.isThisExpression(e.arguments[0]) &&
      t.isIdentifier(e.arguments[1], { name: className })
    ) {
      const base = getCalleeName(e.callee)!;
      if (helpers.classCallCheck.has(base)) {
        cccs.push(s);
      } else {
        return null;
      }
    }
  }

  // Every super-constructor call must sit in a convertible position, which
  // also determines the `this` alias.
  const producingNames = new Map<string, 'init' | 'assign'>();
  let thisDecl: NodePath<t.VariableDeclaration> | null = null;
  let producingAssign: NodePath<t.ExpressionStatement> | null = null;
  for (const sc of ctorScan.superCalls) {
    if (!superCallArgs(sc)) return null;
    const parent = sc.top.parentPath;
    if (parent.isVariableDeclarator()) {
      const decl = parent.parentPath;
      const pid = parent.node.id;
      if (
        !t.isIdentifier(pid) ||
        !decl.isVariableDeclaration() ||
        decl.node.declarations.length !== 1
      ) {
        return null;
      }
      const prev = producingNames.get(pid.name);
      if (prev) return null;
      producingNames.set(pid.name, 'init');
      thisDecl = decl;
    } else if (
      parent.isAssignmentExpression({ operator: '=' }) &&
      t.isIdentifier(parent.node.left) &&
      parent.parentPath.isExpressionStatement()
    ) {
      const prev = producingNames.get(parent.node.left.name);
      if (prev) return null;
      producingNames.set(parent.node.left.name, 'assign');
      producingAssign = parent.parentPath;
    } else if (parent.isExpressionStatement()) {
      // bare `super(...);` (possibly `|| this` wrapped)
    } else if (parent.isReturnStatement()) {
      // `return super(...);`
    } else if (parent.isCallExpression()) {
      if (
        !ctorScan.pcrCalls.some((pc) => pc.call.node === parent.node)
      ) {
        return null;
      }
    } else {
      return null;
    }
  }
  if (producingNames.size > 1) return null;
  const thisAlias =
    producingNames.size === 1
      ? ([...producingNames.keys()][0])
      : null;

  const tBinding = thisAlias
    ? ctorPath.scope.getOwnBinding(thisAlias)
    : null;
  if (thisAlias && !tBinding) return null;
  if (tBinding) {
    if (tBinding.constantViolations.length > 1) return null;
    for (const ref of tBinding.referencePaths) {
      const p = ref.parentPath;
      if (!p) return null;
      const ok =
        (p.isAssignmentExpression({ operator: '=' }) &&
          p.node.left === ref.node) ||
        (p.isMemberExpression() && p.node.object === ref.node) ||
        p.isReturnStatement() ||
        (p.isCallExpression() &&
          ctorScan.pcrCalls.some((pc) => pc.call.node === p.node));
      if (!ok) return null;
    }
  }

  const pcrCalls = ctorScan.pcrCalls.filter((pc) => {
    const first = pc.call.node.arguments[0];
    if (t.isThisExpression(first)) return true;
    if (
      thisAlias &&
      t.isIdentifier(first, { name: thisAlias }) &&
      tBinding &&
      pc.call.scope.getBinding(first.name) === tBinding
    ) {
      return true;
    }
    return false;
  });

  const returnsThis: NodePath<t.ReturnStatement>[] = [];
  if (thisAlias && tBinding) {
    for (const s of ctorStmts) {
      if (
        s.isReturnStatement() &&
        t.isIdentifier(s.node.argument, { name: thisAlias }) &&
        s.scope.getBinding(thisAlias) === tBinding
      ) {
        returnsThis.push(s);
      }
    }
  }

  if (superclass && ctorScan.superCalls.length === 0) return null;
  if (!superclass && ctorScan.superCalls.length > 0) return null;
  if (
    superAlias &&
    !ctorScan.superCalls.some((sc) => sc.kind === 'classic')
  ) {
    return null;
  }

  // The `super` alias must only be used by converted super calls.
  if (superAlias) {
    const binding = fnPath.scope.getOwnBinding(superAlias.name);
    if (!binding || binding.constantViolations.length > 0) return null;
    const tops = new Set<t.Node>(
      ctorScan.superCalls
        .filter((sc) => sc.kind === 'classic')
        .map((sc) => sc.top.node),
    );
    for (const ref of binding.referencePaths) {
      if (!isUnder(ref, tops)) return null;
    }
  }

  // Scan methods for super member accesses.
  const memberFnEntries: {
    path: NodePath<t.FunctionExpression>;
    isStatic: boolean;
  }[] = [];
  {
    const seen = new Set<t.FunctionExpression>();
    fnPath.traverse({
      Class(path) {
        path.skip();
      },
      FunctionExpression(path) {
        const isStatic = staticByFn.get(path.node);
        if (isStatic === undefined || seen.has(path.node)) return;
        seen.add(path.node);
        memberFnEntries.push({ path, isStatic });
      },
    });
  }
  if (memberFnEntries.length !== staticByFn.size) return null;
  const methodPropAccesses: SuperPropAccess[] = [];
  for (const { path: mPath, isStatic } of memberFnEntries) {
    const mscan = scanFunction(mPath, {
      ...baseCtx,
      inConstructor: false,
      isStatic,
      container: mPath,
    });
    if (mscan.superCalls.length > 0 || mscan.pcrCalls.length > 0) return null;
    methodPropAccesses.push(...mscan.propAccesses);
  }

  // The IIFE parameter must only feed recognized positions.
  if (iifeParam !== null) {
    const binding = fnPath.scope.getOwnBinding(iifeParam);
    if (!binding || binding.constantViolations.length > 0) return null;
    const tops = new Set<t.Node>();
    if (inheritsArg) tops.add(inheritsArg.node);
    for (const sc of ctorScan.superCalls) tops.add(sc.top.node);
    for (const pa of ctorScan.propAccesses) tops.add(pa.top.node);
    for (const pa of methodPropAccesses) tops.add(pa.top.node);
    for (const ref of binding.referencePaths) {
      if (!isUnder(ref, tops)) return null;
    }
  }

  return {
    declPath,
    varDeclPath,
    className,
    ctorPath,
    superclass,
    superAlias,
    members,
    ctorScan,
    methodPropAccesses,
    cccs,
    pcrCalls,
    returnsThis,
    thisAlias,
    thisDecl,
    producingAssign,
  };
}

function buildSuperCallExpression(sc: SuperCtorCall): t.CallExpression | null {
  const sa = superCallArgs(sc);
  if (!sa) return null;
  if (sa.kind === 'args') {
    return t.callExpression(t.super(), sa.args);
  }
  return t.callExpression(t.super(), [t.spreadElement(sa.expr)]);
}

function buildSuperMember(acc: SuperPropAccess): t.Expression {
  const computed =
    acc.computed || !(t.isIdentifier(acc.key) || t.isNumericLiteral(acc.key));
  const member = t.memberExpression(t.super(), acc.key, computed);
  if (acc.args !== null) {
    return t.callExpression(member, acc.args);
  }
  if (acc.spreadArg !== null) {
    if (
      t.isArrayExpression(acc.spreadArg) &&
      acc.spreadArg.elements.every(
        (e) => e && (t.isExpression(e) || t.isSpreadElement(e)),
      )
    ) {
      return t.callExpression(
        member,
        acc.spreadArg.elements as (t.Expression | t.SpreadElement)[],
      );
    }
    return t.callExpression(member, [t.spreadElement(acc.spreadArg)]);
  }
  return member;
}

function replacePcrCall(
  callPath: NodePath<t.CallExpression>,
  replacement: t.Expression,
): void {
  const parent = callPath.parentPath;
  if (t.isThisExpression(replacement)) {
    if (parent.isExpressionStatement() || parent.isReturnStatement()) {
      parent.remove();
    } else {
      callPath.replaceWith(replacement);
    }
  } else if (
    parent.isReturnStatement() &&
    t.isCallExpression(replacement) &&
    t.isSuper(replacement.callee)
  ) {
    // `return _possibleConstructorReturn(this, super(...))` runs the super
    // call for its side effects; the derived constructor returns `this`.
    parent.replaceWith(t.expressionStatement(replacement));
  } else {
    callPath.replaceWith(replacement);
  }
}

function buildMember(desc: MemberDesc): t.ClassMethod | t.ClassProperty {
  const computed =
    desc.computed || !(t.isIdentifier(desc.key) || t.isNumericLiteral(desc.key));
  if (desc.kind === 'field') {
    return t.classProperty(
      desc.key,
      desc.fieldValue,
      undefined,
      undefined,
      computed,
      desc.isStatic,
    );
  }
  const fn = desc.fn!;
  return t.classMethod(
    desc.kind,
    desc.key,
    fn.params,
    fn.body,
    computed,
    desc.isStatic,
    fn.generator,
    fn.async,
  );
}

// Applies a validated plan. Every position was checked by `analyzeClass`,
// so unexpected shapes below are skipped defensively instead of bailing.
function buildClass(info: AnalyzedClass): void {
  for (const ccc of info.cccs) {
    if (!ccc.removed) ccc.remove();
  }

  for (const sc of info.ctorScan.superCalls) {
    if (sc.call.removed) continue;
    const superCall = buildSuperCallExpression(sc);
    if (!superCall) continue;
    const top = sc.top;
    const parent = top.parentPath;
    if (top.isLogicalExpression()) {
      if (parent.isVariableDeclarator()) {
        const decl = parent.parentPath;
        if (decl.isVariableDeclaration() && decl.node.declarations.length === 1) {
          decl.replaceWith(t.expressionStatement(superCall));
        }
      } else if (
        parent.isAssignmentExpression({ operator: '=' }) &&
        parent.parentPath.isExpressionStatement()
      ) {
        parent.parentPath.replaceWith(t.expressionStatement(superCall));
      } else if (parent.isExpressionStatement()) {
        parent.replaceWith(t.expressionStatement(superCall));
      } else if (parent.isReturnStatement()) {
        parent.replaceWith(t.returnStatement(superCall));
      } else if (parent.isCallExpression()) {
        sc.call.replaceWith(superCall);
      }
    } else if (top.isCallExpression()) {
      if (parent.isVariableDeclarator()) {
        const decl = parent.parentPath;
        if (decl.isVariableDeclaration() && decl.node.declarations.length === 1) {
          decl.replaceWith(t.expressionStatement(superCall));
        }
      } else if (
        parent.isAssignmentExpression({ operator: '=' }) &&
        parent.parentPath.isExpressionStatement()
      ) {
        parent.parentPath.replaceWith(t.expressionStatement(superCall));
      } else if (parent.isExpressionStatement()) {
        // already `super(...);`
      } else if (parent.isReturnStatement()) {
        parent.replaceWith(t.returnStatement(superCall));
      } else if (parent.isCallExpression()) {
        sc.call.replaceWith(superCall);
      }
    }
  }

  for (const pc of info.pcrCalls) {
    if (pc.call.removed) continue;
    const first = pc.call.node.arguments[0];
    const isThisLike =
      t.isThisExpression(first) ||
      (info.thisAlias !== null && t.isIdentifier(first, { name: info.thisAlias }));
    if (!isThisLike) continue;
    if (pc.helper === 'ati') {
      replacePcrCall(pc.call, t.thisExpression());
      continue;
    }
    const second = pc.call.node.arguments[1];
    if (!second || !t.isExpression(second)) {
      replacePcrCall(pc.call, t.thisExpression());
    } else {
      replacePcrCall(pc.call, second);
    }
  }

  for (const ret of info.returnsThis) {
    if (!ret.removed) ret.remove();
  }

  if (info.thisAlias !== null) {
    const binding = info.ctorPath.scope.getOwnBinding(info.thisAlias);
    if (binding) {
      for (const ref of [...binding.referencePaths]) {
        if (ref.removed) continue;
        const p = ref.parentPath;
        if (!p) continue;
        if (
          p.isAssignmentExpression({ operator: '=' }) &&
          p.node.left === ref.node
        ) {
          continue;
        }
        ref.replaceWith(t.thisExpression());
      }
      // `var _this;` (the separate-declaration producing form) is now unused.
      // The `var _this = ...` form was already replaced with `super(...);`.
      const tDeclPath = binding.path;
      if (tDeclPath.isVariableDeclarator()) {
        const varDecl = tDeclPath.parentPath;
        tDeclPath.remove();
        if (
          varDecl.isVariableDeclaration() &&
          varDecl.node.declarations.length === 0
        ) {
          varDecl.remove();
        }
      }
    }
  }

  for (const pa of [...info.ctorScan.propAccesses, ...info.methodPropAccesses]) {
    if (pa.top.removed) continue;
    pa.top.replaceWith(buildSuperMember(pa));
  }

  if (info.superAlias && !info.superAlias.declPath.removed) {
    info.superAlias.declPath.remove();
  }

  const ctorFn = info.ctorPath.node;
  const classMembers: (t.ClassMethod | t.ClassProperty)[] = [];
  if (ctorFn.body.body.length > 0) {
    classMembers.push(
      t.classMethod(
        'constructor',
        t.identifier('constructor'),
        ctorFn.params,
        t.blockStatement(ctorFn.body.body),
        false,
        false,
      ),
    );
  }
  for (const desc of info.members) {
    classMembers.push(buildMember(desc));
  }
  const classBody = t.classBody(classMembers);

  if (
    info.varDeclPath.node.declarations.length === 1 &&
    (() => {
      const parent = info.varDeclPath.parentPath;
      return (
        parent.isProgram() ||
        parent.isBlockStatement() ||
        parent.isStaticBlock() ||
        parent.isExportNamedDeclaration()
      );
    })()
  ) {
    // `replaceWith` re-crawls scope starting from the new `class` node and
    // the program scope (never reset by that crawl) still holds the old
    // `var` binding, so drop it first to avoid a duplicate-declaration throw.
    info.varDeclPath.scope.removeBinding(info.className);
    info.varDeclPath.replaceWith(
      t.classDeclaration(
        t.identifier(info.className),
        info.superclass,
        classBody,
      ),
    );
  } else {
    info.declPath.get('init').replaceWith(
      t.classExpression(
        t.identifier(info.className),
        info.superclass,
        classBody,
      ),
    );
  }
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
        if (
          imp.isImportDeclaration() &&
          imp.node.specifiers.length === 0
        ) {
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
  name: 'classes',
  tags: ['safe'],
  scope: true,
  visitor() {
    return {
      Program: {
        exit(path) {
          const helpers = collectHelpers(path);
          const candidates: NodePath<t.VariableDeclarator>[] = [];
          path.traverse({
            VariableDeclarator(candidate) {
              candidates.push(candidate);
            },
          });
          // Innermost first so converting an outer class never detaches a
          // class nested inside its methods.
          for (let i = candidates.length - 1; i >= 0; i--) {
            const candidate = candidates[i];
            if (!candidate || candidate.removed) continue;
            let attached: NodePath | null = candidate;
            let alive = true;
            while (attached) {
              if (attached.removed) {
                alive = false;
                break;
              }
              attached = attached.parentPath;
            }
            if (!alive) continue;
            const info = analyzeClass(candidate, helpers);
            if (info) {
              buildClass(info);
              this.changes++;
            }
          }
          this.changes += removeDeadHelpers(path, helpers);
        },
      },
    };
  },
} satisfies Transform;
