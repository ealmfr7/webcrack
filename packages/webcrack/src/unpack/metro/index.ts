import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Bundle } from '../bundle';
import type { Transform } from '../../ast-utils';
import { renameFast } from '../../ast-utils';
import { MetroBundle } from './bundle';
import { MetroModule } from './module';

export { MetroBundle } from './bundle';
export { MetroModule } from './module';

function literalId(node: t.Node | null | undefined): string | undefined {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) {
    return node.value.toString();
  }
  return undefined;
}

function dependencyIndex(node: t.Node | null | undefined): number | undefined {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) {
    const n = Number(node.value);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

function indexOfParam(fn: t.Function, name: string): number | undefined {
  const index = fn.params.findIndex(
    (param) => t.isIdentifier(param) && param.name === name,
  );
  return index === -1 ? undefined : index;
}

// Metro factory layouts per version. 7-param is current:
// (global, require, importDefault, importAll, module, exports, dependencyMap).
// Older bundles use 5 or 6 params; these positions are best-effort and are
// only a fallback when usage-based detection finds no require/dependencyMap
// pair.
function fallbackIndices(count: number):
  | {
      require: number;
      module: number;
      exports: number;
      dependencyMap?: number;
    }
  | undefined {
  if (count >= 7) return { require: 1, module: 4, exports: 5, dependencyMap: 6 };
  if (count === 6) return { require: 1, module: 4, exports: 5 };
  if (count === 5) return { require: 1, module: 2, exports: 3, dependencyMap: 4 };
  if (count === 4) return { require: 1, module: 2, exports: 3 };
  return undefined;
}

function paramName(fn: t.Function, index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  const param = fn.params[index];
  return param && t.isIdentifier(param) ? param.name : undefined;
}

// Finds the require/dependencyMap pair by usage: requireParam(depMapParam[n]).
// Works regardless of param positions or names.
function findRequirePair(
  fn: t.Function,
): { require: string; dependencyMap: string } | undefined {
  const paramNames = new Set<string>();
  for (const param of fn.params) {
    if (t.isIdentifier(param)) paramNames.add(param.name);
  }

  let found: { require: string; dependencyMap: string } | undefined;
  traverse(
    fn,
    {
      CallExpression(path) {
        if (found) {
          path.stop();
          return;
        }
        const { callee } = path.node;
        const [firstArg] = path.node.arguments;
        if (!t.isIdentifier(callee) || !t.isMemberExpression(firstArg)) return;
        if (!paramNames.has(callee.name)) return;
        const { object, property } = firstArg;
        if (
          !t.isIdentifier(object) ||
          !paramNames.has(object.name) ||
          object.name === callee.name
        ) {
          return;
        }
        if (dependencyIndex(property) !== undefined) {
          found = { require: callee.name, dependencyMap: object.name };
          path.stop();
        }
      },
      noScope: true,
    },
  );
  return found;
}

function rewriteRequires(
  fn: t.Function,
  requireName: string,
  depMapName: string,
  deps: (number | string)[],
): void {
  traverse(
    fn,
    {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: requireName })) return;
        const [firstArg] = path.node.arguments;
        if (!t.isMemberExpression(firstArg)) return;
        if (!t.isIdentifier(firstArg.object, { name: depMapName })) return;
        const index = dependencyIndex(firstArg.property);
        if (index === undefined || index < 0 || index >= deps.length) return;
        const depId = deps[index];
        path.node.arguments[0] =
          typeof depId === 'number'
            ? t.numericLiteral(depId)
            : t.stringLiteral(depId);
      },
      noScope: true,
    },
  );
}

function renameParam(
  fn: NodePath<t.Function>,
  index: number | undefined,
  newName: string,
): void {
  if (index === undefined) return;
  const param = fn.node.params[index];
  if (!param || !t.isIdentifier(param) || param.name === newName) return;
  const binding = fn.scope.getBinding(param.name);
  if (binding) renameFast(binding, newName);
  else param.name = newName;
}

function toCallExpression(
  stmt: NodePath<t.Statement>,
): NodePath<t.CallExpression> | undefined {
  if (!stmt.isExpressionStatement()) return undefined;
  const expr = stmt.get('expression');
  if (!expr.isCallExpression()) return undefined;
  return expr;
}

function isGlobalCall(
  call: NodePath<t.CallExpression>,
  name: string,
): boolean {
  return t.isIdentifier(call.node.callee, { name });
}

function parseModule(
  call: NodePath<t.CallExpression>,
  entryId: string,
): MetroModule | undefined {
  const args = call.get('arguments');
  if (args.length < 2) return undefined;
  const [fnArg, idArg, depsArg, nameArg] = args;
  if (!fnArg.isFunction()) return undefined;
  const fn = fnArg as NodePath<t.Function>;
  if (!t.isBlockStatement(fn.node.body)) return undefined;

  const id = literalId(idArg.node);
  if (id === undefined) return undefined;

  const deps: (number | string)[] = [];
  if (depsArg && depsArg.isArrayExpression()) {
    for (const element of depsArg.get('elements')) {
      if (element === null) continue;
      if (element.isNumericLiteral() || element.isStringLiteral()) {
        deps.push(element.node.value);
      }
    }
  }

  const verboseName =
    nameArg && nameArg.isStringLiteral() ? nameArg.node.value : undefined;

  const pair = findRequirePair(fn.node);
  const fallback = fallbackIndices(fn.node.params.length);

  let requireIdx =
    pair !== undefined ? indexOfParam(fn.node, pair.require) : fallback?.require;
  const depMapIdx =
    pair !== undefined
      ? indexOfParam(fn.node, pair.dependencyMap)
      : fallback?.dependencyMap;

  // module/exports are the two params right before dependencyMap
  let moduleIdx: number | undefined;
  let exportsIdx: number | undefined;
  if (depMapIdx !== undefined && depMapIdx >= 2) {
    const m = depMapIdx - 2;
    const e = depMapIdx - 1;
    if (m !== requireIdx && e !== requireIdx) {
      moduleIdx = m;
      exportsIdx = e;
    }
  }
  moduleIdx ??= fallback?.module;
  exportsIdx ??= fallback?.exports;
  requireIdx ??= fallback?.require;

  const requireName = paramName(fn.node, requireIdx);
  const depMapName = paramName(fn.node, depMapIdx);

  // Rewrite before renaming so the original require/dependencyMap names match
  if (requireName !== undefined && depMapName !== undefined) {
    rewriteRequires(fn.node, requireName, depMapName, deps);
  }
  renameParam(fn, requireIdx, 'require');
  renameParam(fn, moduleIdx, 'module');
  renameParam(fn, exportsIdx, 'exports');

  const file = t.file(t.program(fn.node.body.body));
  const module = new MetroModule(
    id,
    file,
    id === entryId,
    deps,
    verboseName,
  );
  if (verboseName) {
    module.path = `./${verboseName.replace(/^\.\//, '')}`;
  }
  return module;
}

/**
 * Format:
 * ```js
 * __d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
 *   const add = _$$_REQUIRE(_dependencyMap[0]);
 * }, 0, [1], "index.js");
 * __r(0);
 * ```
 */
export const unpackMetro = {
  name: 'unpack-metro',
  tags: ['unsafe'],
  scope: true,
  visitor(options = { bundle: undefined }) {
    return {
      Program(path) {
        let entryId: string | undefined;
        for (const stmt of path.get('body')) {
          const call = toCallExpression(stmt);
          if (!call || !isGlobalCall(call, '__r')) continue;
          if (call.node.arguments.length !== 1) continue;
          const id = literalId(call.node.arguments[0]);
          if (id !== undefined) entryId = id;
        }

        const modules = new Map<string, MetroModule>();
        for (const stmt of path.get('body')) {
          const call = toCallExpression(stmt);
          if (!call || !isGlobalCall(call, '__d')) continue;
          const module = parseModule(call, entryId ?? '');
          if (module && !modules.has(module.id)) {
            modules.set(module.id, module);
          }
        }

        if (modules.size > 0) {
          options.bundle = new MetroBundle(entryId ?? '', modules);
          path.stop();
        }
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
