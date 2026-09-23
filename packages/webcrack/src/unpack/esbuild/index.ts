import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
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
 * Unpacks esbuild bundles.
 *
 * CommonJS form:
 * ```js
 * var require_util = __commonJS({
 *   "src/util.js"(exports, module) {
 *     module.exports = ...;
 *   }
 * });
 * var require_main = __commonJS({
 *   "src/index.js"(exports, module) {
 *     const util = __toESM(require_util());
 *   }
 * });
 * require_main();
 * ```
 * Each `"path"(exports, module) {...}` entry becomes a module that keeps its
 * original path, and `require_util()` calls are rewritten to
 * `require("./src/util.js")`.
 *
 * Scope-hoisted ESM form (`__export`/`__esm` with no module wrappers) is
 * reported as a single module.
 */
export const unpackEsbuild = {
  name: 'unpack-esbuild',
  tags: ['unsafe'],
  scope: true,
  visitor(options) {
    return {
      Program(path) {
        if (unpackCommonJS(path, options)) return;
        unpackScopeHoistedESM(path, options);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;

function isCommonJSCall(node: t.Node): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: '__commonJS' }) &&
    node.arguments.length >= 1 &&
    t.isObjectExpression(node.arguments[0])
  );
}

/**
 * Collects the `var require_x = __commonJS({...})` declarations and builds a
 * module per `"path"(exports, module) {...}` entry.
 */
function collectCommonJSModules(
  path: NodePath<t.Program>,
): Map<string, CommonJSModule> {
  const requireVars = new Map<string, CommonJSModule>();

  for (const statement of path.get('body')) {
    if (!statement.isVariableDeclaration()) continue;
    for (const declarator of statement.get('declarations')) {
      const id = declarator.get('id');
      const init = declarator.get('init');
      if (!id.isIdentifier() || !init.isCallExpression()) continue;
      if (!isCommonJSCall(init.node)) continue;

      const container = init.node.arguments[0] as t.ObjectExpression;
      let first = true;
      for (const property of container.properties) {
        if (!t.isObjectMethod(property) && !t.isObjectProperty(property)) {
          continue;
        }
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
        if (first) {
          requireVars.set(id.node.name, {
            declarator: declarator.node,
            module,
          });
          first = false;
        }
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
 * `__require("path")` to `require("path")`. Returns the last `require_x()`
 * call that happens outside the `__commonJS({...})` definitions, i.e. the
 * entry point invocation.
 */
function rewriteRequires(
  path: NodePath<t.Program>,
  requireVars: Map<string, CommonJSModule>,
): CommonJSModule | undefined {
  let entry: CommonJSModule | undefined;

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
        if (!isInsideCommonJSInit(callPath)) {
          entry = target;
        }
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

  return entry;
}

function isInsideCommonJSInit(path: NodePath): boolean {
  return (
    path.findParent(
      (parent) => parent.isCallExpression() && isCommonJSCall(parent.node),
    ) !== null
  );
}

function unpackCommonJS(
  path: NodePath<t.Program>,
  options: { bundle: Bundle | undefined } | undefined,
): boolean {
  const requireVars = collectCommonJSModules(path);
  if (requireVars.size === 0) return false;

  const entry = rewriteRequires(path, requireVars);

  const modules = new Map<string, EsbuildModule>();
  for (const { module } of requireVars.values()) {
    modules.set(module.id, module);
  }

  // Fall back to the first module when no entry invocation was found
  const entryModule =
    entry?.module ?? requireVars.values().next().value!.module;
  entryModule.isEntry = true;

  options!.bundle = new EsbuildBundle(entryModule.id, modules);
  return true;
}

/**
 * Scope-hoisted ESM bundles have no module wrappers, only `__export`/`__esm`
 * calls spread over the concatenated files. Report them as a single module.
 */
function unpackScopeHoistedESM(
  path: NodePath<t.Program>,
  options: { bundle: Bundle | undefined } | undefined,
): void {
  let found = false;
  path.traverse({
    CallExpression(callPath) {
      const callee = callPath.get('callee');
      if (!callee.isIdentifier()) return;
      if (
        callee.node.name !== '__export' &&
        callee.node.name !== '__esm' &&
        callee.node.name !== '__reExport'
      ) {
        return;
      }
      const binding = callPath.scope.getBinding(callee.node.name);
      // Don't match a user-defined shadowing declaration
      if (binding && binding.scope !== path.scope) return;
      found = true;
      callPath.stop();
    },
  });
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
