import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Transform } from '../../ast-utils';
import { getPropName } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { EsbuildBundle } from './bundle';
import { EsbuildModule } from './module';

interface CommonJSModule {
  declarator: t.VariableDeclarator;
  module: EsbuildModule;
}

/**
 * Local names of the esbuild runtime helpers, found by the shape of their
 * definitions (minified bundles rename them to single letters).
 */
interface EsbuildHelpers {
  commonJS: string | undefined;
  export: string | undefined;
  esm: string | undefined;
  reExport: string | undefined;
}

/**
 * Unpacks esbuild bundles.
 *
 * CommonJS form (current esbuild puts the entry code at the top level and
 * wraps only the dependencies):
 * ```js
 * var require_dep = __commonJS({
 *   "src/dep.js"(exports, module) {
 *     module.exports = ...;
 *   }
 * });
 * var entry_exports = {};
 * __export(entry_exports, { x: () => x });
 * var import_dep = __toESM(require_dep());
 * ```
 * Each `"path"(exports, module) {...}` entry becomes a module that keeps its
 * original path, the remaining top-level code becomes a synthetic `./index.js`
 * entry module, and `require_dep()` calls are rewritten to
 * `require("./src/dep.js")`. Minified bundles rename the helpers and pass the
 * callback directly (`var s = g((e, m) => {...})`); those modules get
 * synthesized ids (`./module-0.js`).
 *
 * Scope-hoisted ESM form (`__export` with no module wrappers) is reported as
 * a single module.
 */
export const unpackEsbuild = {
  name: 'unpack-esbuild',
  tags: ['unsafe'],
  scope: true,
  visitor(options) {
    return {
      Program(path) {
        const { helpers, helperDecls } = discoverHelpers(path);
        if (unpackCommonJS(path, options, helpers, helperDecls)) return;
        unpackScopeHoistedESM(path, options, helpers);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;

type AnyFunction = t.ArrowFunctionExpression | t.FunctionExpression;

/**
 * Recursively checks whether any node in the subtree matches.
 */
function someNode(root: t.Node, predicate: (node: t.Node) => boolean): boolean {
  if (predicate(root)) return true;
  for (const key of VISITOR_KEYS[root.type] ?? []) {
    const value = (root as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (
        child !== null &&
        typeof child === 'object' &&
        'type' in child &&
        someNode(child as t.Node, predicate)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Unwraps `(0, fn)(...)` indirect calls to `fn`.
 */
function unwrapCallee(
  callee: t.CallExpression['callee'],
): t.CallExpression['callee'] {
  let current: t.CallExpression['callee'] = callee;
  while (t.isSequenceExpression(current)) {
    current = current.expressions[current.expressions.length - 1];
  }
  return current;
}

function isExportsObject(node: t.Node | null | undefined): boolean {
  return (
    t.isObjectExpression(node) &&
    node.properties.length === 1 &&
    t.isObjectProperty(node.properties[0]) &&
    getPropName(node.properties[0].key) === 'exports' &&
    t.isObjectExpression(node.properties[0].value) &&
    node.properties[0].value.properties.length === 0
  );
}

/**
 * ```js
 * // before minification, with or without the try/catch
 * var __commonJS = (cb, mod) => function __require() {
 *   try {
 *     return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
 *   } catch (e) {
 *     throw mod = 0, e;
 *   }
 * };
 * // minified
 * var g = (r, o) => () => { try { return o || r((o = { exports: {} }).exports, o), o.exports; } catch (t) { throw o = 0, t; } };
 * ```
 */
function isCommonJSHelper(fn: AnyFunction): boolean {
  if (fn.params.length !== 2) return false;
  const [first, second] = fn.params;
  if (!t.isIdentifier(first) || !t.isIdentifier(second)) return false;
  return someNode(
    fn.body,
    (node) =>
      (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
      node !== fn &&
      node.params.length === 0 &&
      someNode(node.body, (inner) => {
        if (!t.isCallExpression(inner)) return false;
        // Either `first(...)` (minified) or `(0, first[...])(...)`
        const callee = unwrapCallee(inner.callee);
        const callsFirst =
          t.isIdentifier(callee, { name: first.name }) ||
          (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object, { name: first.name }));
        return (
          callsFirst &&
          inner.arguments.some((arg) =>
            t.isIdentifier(arg, { name: second.name }),
          ) &&
          inner.arguments.some(
            (arg) =>
              t.isMemberExpression(arg) &&
              t.isAssignmentExpression(arg.object, { operator: '=' }) &&
              t.isIdentifier(arg.object.left, { name: second.name }) &&
              isExportsObject(arg.object.right),
          )
        );
      }),
  );
}

/**
 * ```js
 * var __export = (target, all) => {
 *   for (var name in all)
 *     __defProp(target, name, { get: all[name], enumerable: true });
 * };
 * ```
 */
function isExportHelper(fn: AnyFunction): boolean {
  if (fn.params.length !== 2) return false;
  return someNode(
    fn.body,
    (node) =>
      t.isForInStatement(node) &&
      someNode(
        node.body,
        (inner) =>
          t.isCallExpression(inner) &&
          inner.arguments.some(
            (arg) =>
              t.isObjectExpression(arg) &&
              arg.properties.some(
                (property) =>
                  (t.isObjectProperty(property) ||
                    t.isObjectMethod(property)) &&
                  getPropName(property.key) === 'get',
              ),
          ),
      ),
  );
}

/**
 * ```js
 * var __esm = (fn, res) => function __init() {
 *   return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
 * };
 * ```
 */
function isEsmHelper(fn: AnyFunction): boolean {
  if (fn.params.length !== 2) return false;
  const [first] = fn.params;
  if (!t.isIdentifier(first)) return false;
  return someNode(
    fn.body,
    (node) =>
      (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
      node !== fn &&
      node.params.length === 0 &&
      someNode(node.body, (inner) => {
        if (!t.isCallExpression(inner)) return false;
        // `(0, first[...])(...)`
        const callee = unwrapCallee(inner.callee);
        return (
          t.isMemberExpression(callee) &&
          callee.computed &&
          t.isIdentifier(callee.object, { name: first.name })
        );
      }) &&
      someNode(
        node.body,
        (inner) =>
          t.isAssignmentExpression(inner, { operator: '=' }) &&
          t.isIdentifier(inner.left, { name: first.name }) &&
          t.isNumericLiteral(inner.right, { value: 0 }),
      ),
  );
}

/**
 * `__toESM` always references both `.__esModule` and `"default"`.
 */
function isToESMHelper(fn: AnyFunction): boolean {
  return (
    someNode(
      fn.body,
      (node) =>
        t.isMemberExpression(node) &&
        getPropName(node.property) === '__esModule',
    ) &&
    someNode(fn.body, (node) => t.isStringLiteral(node, { value: 'default' }))
  );
}

/**
 * ```js
 * var __copyProps = (to, from, except, desc) => {
 *   if (...) { for (let key of ...(from)) ... }
 *   return to;
 * };
 * ```
 */
function isCopyPropsHelper(fn: AnyFunction): boolean {
  if (fn.params.length !== 4) return false;
  const [first] = fn.params;
  if (!t.isIdentifier(first)) return false;
  return (
    someNode(fn.body, (node) => t.isForOfStatement(node)) &&
    someNode(
      fn.body,
      (node) =>
        t.isReturnStatement(node) &&
        t.isIdentifier(node.argument, { name: first.name }),
    )
  );
}

/**
 * ```js
 * var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
 * ```
 */
function isToCommonJSHelper(fn: AnyFunction): boolean {
  return (
    fn.params.length === 1 &&
    someNode(fn.body, (node) =>
      t.isStringLiteral(node, { value: '__esModule' }),
    )
  );
}

/**
 * Historical `__reExport(target, mod, ...)` shape. Only used together with a
 * call to the discovered name, so this stays deliberately narrow.
 */
function isReExportHelper(fn: AnyFunction): boolean {
  return (
    fn.params.length >= 2 &&
    someNode(fn.body, (node) =>
      t.isStringLiteral(node, { value: 'default' }),
    ) &&
    !someNode(
      fn.body,
      (node) =>
        t.isMemberExpression(node) &&
        getPropName(node.property) === '__esModule',
    )
  );
}

/**
 * Matches `Object.*` member chains such as `Object.defineProperty` and
 * `Object.prototype.hasOwnProperty`.
 */
function isObjectAlias(init: t.Expression): boolean {
  let current: t.Expression | t.Super | t.PrivateName = init;
  while (t.isMemberExpression(current)) {
    current = current.object;
  }
  return t.isIdentifier(current, { name: 'Object' });
}

/**
 * Finds the esbuild runtime helpers by definition shape and collects the
 * declarators that are runtime noise (helper definitions, `Object.*`
 * aliases, other `__`-prefixed vars) rather than bundle content.
 */
function discoverHelpers(path: NodePath<t.Program>): {
  helpers: EsbuildHelpers;
  helperDecls: Set<t.VariableDeclarator>;
} {
  const helpers: EsbuildHelpers = {
    commonJS: undefined,
    export: undefined,
    esm: undefined,
    reExport: undefined,
  };
  const helperDecls = new Set<t.VariableDeclarator>();

  for (const statement of path.node.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (!t.isIdentifier(declarator.id) || !declarator.init) continue;
      const { init } = declarator;
      if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
        if (!helpers.commonJS && isCommonJSHelper(init)) {
          helpers.commonJS = declarator.id.name;
          helperDecls.add(declarator);
        } else if (!helpers.export && isExportHelper(init)) {
          helpers.export = declarator.id.name;
          helperDecls.add(declarator);
        } else if (!helpers.esm && isEsmHelper(init)) {
          helpers.esm = declarator.id.name;
          helperDecls.add(declarator);
        } else if (
          isToESMHelper(init) ||
          isCopyPropsHelper(init) ||
          isToCommonJSHelper(init)
        ) {
          helperDecls.add(declarator);
        } else if (!helpers.reExport && isReExportHelper(init)) {
          helpers.reExport = declarator.id.name;
          helperDecls.add(declarator);
        }
      } else if (isObjectAlias(init)) {
        // var __defProp = Object.defineProperty;
        // (minified) var u = Object.prototype.hasOwnProperty;
        helperDecls.add(declarator);
      }
    }
  }

  const commonJSName = helpers.commonJS ?? '__commonJS';
  for (const statement of path.node.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (
        !t.isIdentifier(declarator.id) ||
        !declarator.id.name.startsWith('__')
      )
        continue;
      if (helperDecls.has(declarator)) continue;
      // A `var require_x = __commonJS(...)` handle never starts with `__`,
      // but guard against it anyway.
      if (
        declarator.init &&
        t.isCallExpression(declarator.init) &&
        t.isIdentifier(declarator.init.callee, { name: commonJSName })
      ) {
        continue;
      }
      helperDecls.add(declarator);
    }
  }

  return { helpers, helperDecls };
}

/**
 * Collects the top-level `var require_x = <commonJSHelper>(...)` declarations
 * and builds a module per entry. An object argument contributes only its
 * first key (`"path"(exports, module) {...}`); a bare function argument
 * (minified output) gets a synthesized id.
 */
function collectCommonJSModules(
  path: NodePath<t.Program>,
  commonJSName: string,
): Map<string, CommonJSModule> {
  const requireVars = new Map<string, CommonJSModule>();
  let synthesized = 0;

  for (const statement of path.node.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      if (!t.isIdentifier(declarator.id)) continue;
      const { init } = declarator;
      if (
        !t.isCallExpression(init) ||
        !t.isIdentifier(init.callee, { name: commonJSName })
      ) {
        continue;
      }

      const [first] = init.arguments;
      if (
        t.isObjectExpression(first) &&
        first.properties.length > 0 &&
        (t.isObjectMethod(first.properties[0]) ||
          t.isObjectProperty(first.properties[0]))
      ) {
        const property = first.properties[0];
        const key = getPropName(property.key);
        const body = getFunctionBody(property);
        if (key === undefined || body === undefined) continue;
        const modulePath = key.startsWith('.') ? key : `./${key}`;
        const module = new EsbuildModule(
          modulePath,
          t.file(t.program(body)),
          false,
        );
        module.path = modulePath;
        requireVars.set(declarator.id.name, { declarator, module });
      } else if (
        t.isFunctionExpression(first) ||
        t.isArrowFunctionExpression(first)
      ) {
        const rawBody = first.body;
        const body = t.isBlockStatement(rawBody)
          ? rawBody.body
          : [t.returnStatement(rawBody)];
        const modulePath = `./module-${synthesized++}.js`;
        const module = new EsbuildModule(
          modulePath,
          t.file(t.program(body)),
          false,
        );
        module.path = modulePath;
        requireVars.set(declarator.id.name, { declarator, module });
      }
    }
  }

  return requireVars;
}

function getFunctionBody(
  property: t.ObjectMethod | t.ObjectProperty,
): t.Statement[] | undefined {
  if (t.isObjectMethod(property)) {
    return property.body.body;
  }
  if (
    t.isFunctionExpression(property.value) ||
    t.isArrowFunctionExpression(property.value)
  ) {
    const body = property.value.body;
    return t.isBlockStatement(body) ? body.body : [t.returnStatement(body)];
  }
}

/**
 * Rewrites `require_x()` to `require("path")` and normalizes
 * `__require("path")` to `require("path")`.
 */
function rewriteRequires(
  path: NodePath<t.Program>,
  requireVars: Map<string, CommonJSModule>,
): void {
  path.traverse({
    CallExpression(callPath) {
      const callee = callPath.get('callee');
      if (!callee.isIdentifier()) return;

      const target = requireVars.get(callee.node.name);
      if (target) {
        const binding = callPath.scope.getBinding(callee.node.name);
        if (!binding || binding.path.node !== target.declarator) return;
        callPath.replaceWith(
          t.callExpression(t.identifier('require'), [
            t.stringLiteral(target.module.path),
          ]),
        );
        return;
      }

      if (callee.node.name === '__require') {
        const binding = callPath.scope.getBinding('__require');
        // Don't touch a user-defined shadowing declaration
        if (binding && binding.scope !== path.scope) return;
        const [first] = callPath.node.arguments;
        if (callPath.node.arguments.length === 1 && t.isStringLiteral(first)) {
          callee.replaceWith(t.identifier('require'));
        }
      }
    },
  });
}

/**
 * Matches a bare `require_x();` or `module.exports = ...(require_x())...`
 * statement, i.e. a pure wrapper invocation with no other content.
 */
function matchWrapperInvocation(
  statement: NodePath<t.Statement>,
  requireVars: Map<string, CommonJSModule>,
): CommonJSModule | undefined {
  if (!statement.isExpressionStatement()) return undefined;
  const expression = statement.get('expression');

  if (expression.isCallExpression()) {
    return matchRequireHandle(expression, requireVars);
  }

  if (expression.isAssignmentExpression({ operator: '=' })) {
    const left = expression.get('left');
    if (
      !left.isMemberExpression() ||
      !left.get('object').isIdentifier({ name: 'module' }) ||
      getPropName(left.node.property) !== 'exports' ||
      left.node.computed
    ) {
      return undefined;
    }
    // Note: path.traverse() only visits children, never the path itself
    const right = expression.get('right');
    if (right.isCallExpression()) {
      return matchRequireHandle(right, requireVars);
    }
    let found: CommonJSModule | undefined;
    right.traverse({
      CallExpression(callPath) {
        found = matchRequireHandle(callPath, requireVars) ?? found;
        if (found) callPath.stop();
      },
    });
    return found;
  }
}

function matchRequireHandle(
  callPath: NodePath<t.CallExpression>,
  requireVars: Map<string, CommonJSModule>,
): CommonJSModule | undefined {
  const callee = callPath.get('callee');
  if (!callee.isIdentifier()) return undefined;
  const target = requireVars.get(callee.node.name);
  if (!target) return undefined;
  const binding = callPath.scope.getBinding(callee.node.name);
  if (!binding || binding.path.node !== target.declarator) return undefined;
  return target;
}

function pickEntryPath(taken: Set<string>): string {
  if (!taken.has('./index.js')) return './index.js';
  if (!taken.has('./entry.js')) return './entry.js';
  let index = 0;
  while (taken.has(`./entry-${index}.js`)) index++;
  return `./entry-${index}.js`;
}

function unpackCommonJS(
  path: NodePath<t.Program>,
  options: { bundle: Bundle | undefined } | undefined,
  helpers: EsbuildHelpers,
  helperDecls: Set<t.VariableDeclarator>,
): boolean {
  const requireVars = collectCommonJSModules(
    path,
    helpers.commonJS ?? '__commonJS',
  );
  if (requireVars.size === 0) return false;

  const requireDecls = new Set(
    [...requireVars.values()].map(({ declarator }) => declarator),
  );

  // Split off the runtime noise and pure wrapper invocations. Whatever is
  // left is real entry code and becomes a synthetic entry module.
  const content: t.Statement[] = [];
  let invoked: CommonJSModule | undefined;
  for (const statement of path.get('body')) {
    if (statement.isVariableDeclaration()) {
      const declarations = statement.get('declarations').map((d) => d.node);
      if (
        declarations.every((d) => helperDecls.has(d) || requireDecls.has(d))
      ) {
        continue;
      }
      content.push(statement.node);
      continue;
    }
    const target = matchWrapperInvocation(statement, requireVars);
    if (target) {
      invoked = target;
      continue;
    }
    // Skip directives such as "use strict"
    if (
      statement.isExpressionStatement() &&
      t.isStringLiteral(statement.node.expression)
    ) {
      continue;
    }
    content.push(statement.node);
  }

  rewriteRequires(path, requireVars);

  const modules = new Map<string, EsbuildModule>();
  for (const { module } of requireVars.values()) {
    modules.set(module.id, module);
  }

  let entryModule: EsbuildModule;
  if (content.length > 0) {
    const entryPath = pickEntryPath(new Set(modules.keys()));
    entryModule = new EsbuildModule(
      entryPath,
      t.file(t.program(content)),
      true,
    );
    entryModule.path = entryPath;
    modules.set(entryModule.id, entryModule);
  } else {
    // The top level is just `require_x();` / `module.exports = require_x();`
    entryModule = invoked?.module ?? requireVars.values().next().value!.module;
    entryModule.isEntry = true;
  }

  options!.bundle = new EsbuildBundle(entryModule.id, modules);
  return true;
}

/**
 * Scope-hoisted ESM bundles have no module wrappers, only `__export`/`__esm`
 * calls spread over the concatenated files. Report them as a single module.
 * Both the helper definition (matched by shape) and the call shape are
 * required so that foreign `__export` helpers (e.g. tsc output) don't match.
 */
function unpackScopeHoistedESM(
  path: NodePath<t.Program>,
  options: { bundle: Bundle | undefined } | undefined,
  helpers: EsbuildHelpers,
): void {
  let found = false;

  if (helpers.export) {
    const name = helpers.export;
    path.traverse({
      CallExpression(callPath) {
        const callee = callPath.get('callee');
        if (!callee.isIdentifier({ name })) return;
        const [, all] = callPath.node.arguments;
        if (
          callPath.node.arguments.length === 2 &&
          t.isObjectExpression(all) &&
          all.properties.length > 0 &&
          all.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              t.isArrowFunctionExpression(property.value),
          )
        ) {
          found = true;
          callPath.stop();
        }
      },
    });
  }

  if (!found && helpers.esm) {
    const name = helpers.esm;
    path.traverse({
      CallExpression(callPath) {
        if (!callPath.get('callee').isIdentifier({ name })) return;
        found = true;
        callPath.stop();
      },
    });
  }

  if (!found && helpers.reExport) {
    const name = helpers.reExport;
    path.traverse({
      CallExpression(callPath) {
        if (!callPath.get('callee').isIdentifier({ name })) return;
        if (callPath.node.arguments.length < 2) return;
        found = true;
        callPath.stop();
      },
    });
  }

  if (!found) return;

  const module = new EsbuildModule(
    'index',
    t.file(t.program([...path.node.body])),
    true,
  );
  options!.bundle = new EsbuildBundle(
    module.id,
    new Map([[module.id, module]]),
  );
}
