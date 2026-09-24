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
  if (count >= 7)
    return { require: 1, module: 4, exports: 5, dependencyMap: 6 };
  if (count === 6) return { require: 1, module: 4, exports: 5 };
  if (count === 5)
    return { require: 1, module: 2, exports: 3, dependencyMap: 4 };
  if (count === 4) return { require: 1, module: 2, exports: 3 };
  return undefined;
}

interface DepMapUsage {
  dependencyMap: string;
  // Every factory-param callee observed in `callee(dependencyMap[n])` form
  // (require and/or the importDefault/importAll helpers)
  callees: string[];
}

// Collects `factoryParam(depMapParam[n])` calls. Works regardless of param
// positions or names; only used for older (< 7 param) layouts.
function findDepMapUsage(
  fn: t.Function,
  preferredCallee: string | undefined,
): DepMapUsage | undefined {
  const paramNames = new Set<string>();
  for (const param of fn.params) {
    if (t.isIdentifier(param)) paramNames.add(param.name);
  }

  const byObject = new Map<string, Map<string, number>>();
  traverse(fn, {
    CallExpression(path) {
      const { callee } = path.node;
      const [firstArg] = path.node.arguments;
      if (!t.isIdentifier(callee) || !t.isMemberExpression(firstArg)) return;
      if (!paramNames.has(callee.name)) return;
      const { object } = firstArg;
      if (
        !t.isIdentifier(object) ||
        !paramNames.has(object.name) ||
        object.name === callee.name
      ) {
        return;
      }
      if (dependencyIndex(firstArg.property) === undefined) return;
      let callees = byObject.get(object.name);
      if (!callees) {
        callees = new Map();
        byObject.set(object.name, callees);
      }
      callees.set(callee.name, (callees.get(callee.name) ?? 0) + 1);
    },
    noScope: true,
  });
  if (byObject.size === 0) return undefined;

  // Prefer the object indexed through the require param; otherwise the most
  // frequently indexed object. Either way every observed callee is rewritten,
  // so an importDefault/importAll call can never be mistaken for require —
  // callees keep their own names and only the dep-map index is substituted.
  const pick = (
    score: (callees: Map<string, number>) => number,
  ): [string, Map<string, number>] | undefined => {
    let best: [string, Map<string, number>] | undefined;
    let bestScore = 0;
    for (const entry of byObject) {
      const s = score(entry[1]);
      if (s > bestScore) {
        best = entry;
        bestScore = s;
      }
    }
    return best;
  };

  const preferred =
    preferredCallee !== undefined
      ? pick((callees) => callees.get(preferredCallee) ?? 0)
      : undefined;
  const overall = pick((callees) => {
    let total = 0;
    for (const count of callees.values()) total += count;
    return total;
  });
  const winner = preferred ?? overall;
  if (winner === undefined) return undefined;
  return { dependencyMap: winner[0], callees: [...winner[1].keys()] };
}

// Rewrites `callee(depMap[n], ...)` to `callee(<depId>)` for the given callee
// names, keeping each callee's name. Extra args (dev bundles pass the verbose
// name as 2nd arg) are dropped.
function rewriteRequires(
  fn: t.Function,
  calleeNames: ReadonlySet<string>,
  depMapName: string,
  deps: (number | string)[],
): void {
  if (calleeNames.size === 0) return;
  traverse(fn, {
    CallExpression(path) {
      const { callee } = path.node;
      if (!t.isIdentifier(callee) || !calleeNames.has(callee.name)) return;
      const [firstArg] = path.node.arguments;
      if (!t.isMemberExpression(firstArg)) return;
      if (!t.isIdentifier(firstArg.object, { name: depMapName })) return;
      const index = dependencyIndex(firstArg.property);
      if (index === undefined || index < 0 || index >= deps.length) return;
      const depId = deps[index];
      path.node.arguments = [
        typeof depId === 'number'
          ? t.numericLiteral(depId)
          : t.stringLiteral(depId),
      ];
    },
    noScope: true,
  });
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

function isGlobalCall(call: NodePath<t.CallExpression>, name: string): boolean {
  return t.isIdentifier(call.node.callee, { name });
}

function parseModule(
  call: NodePath<t.CallExpression>,
  entryId: string,
): MetroModule | undefined {
  const args = call.get('arguments');
  // Real __d calls always pass factory, id and the dependency-map array
  if (args.length < 3) return undefined;
  const [fnArg, idArg, depsArg, nameArg] = args;
  if (!fnArg.isFunction()) return undefined;
  const fn = fnArg as NodePath<t.Function>;
  if (!t.isBlockStatement(fn.node.body)) return undefined;
  // Metro factories always declare the full parameter list (>= 4 across all
  // shipped versions: global, require, module, exports at minimum). Fewer
  // params means a user-land lookalike, not a Metro module.
  if (fn.node.params.length < 4) return undefined;
  if (!depsArg.isArrayExpression()) return undefined;

  const id = literalId(idArg.node);
  if (id === undefined) return undefined;

  const deps: (number | string)[] = [];
  for (const element of depsArg.get('elements')) {
    if (element === null) continue;
    if (element.isNumericLiteral() || element.isStringLiteral()) {
      deps.push(element.node.value);
    }
  }

  const verboseName =
    nameArg && nameArg.isStringLiteral() ? nameArg.node.value : undefined;

  const params = fn.node.params;
  const nameAt = (index: number | undefined): string | undefined => {
    if (index === undefined) return undefined;
    const param = params[index];
    return param !== undefined && t.isIdentifier(param)
      ? param.name
      : undefined;
  };

  let requireIdx: number | undefined;
  let moduleIdx: number | undefined;
  let exportsIdx: number | undefined;
  let depMapIdx: number | undefined;
  const rewriteCallees = new Set<string>();
  // importDefault/importAll positions are only known for the 7-param layout
  let importDefaultIdx: number | undefined;
  let importAllIdx: number | undefined;

  if (params.length >= 7) {
    // Fixed Metro layout:
    // (global, require, importDefault, importAll, module, exports,
    //  dependencyMap). Positions win over usage detection so
    // importDefault/importAll are never mistaken for require.
    requireIdx = 1;
    importDefaultIdx = 2;
    importAllIdx = 3;
    moduleIdx = 4;
    exportsIdx = 5;
    depMapIdx = 6;
    for (const index of [requireIdx, importDefaultIdx, importAllIdx]) {
      const name = nameAt(index);
      if (name !== undefined) rewriteCallees.add(name);
    }
  } else {
    const fallback = fallbackIndices(params.length);
    requireIdx = fallback?.require;
    const usage = findDepMapUsage(fn.node, nameAt(requireIdx));
    depMapIdx =
      usage !== undefined
        ? indexOfParam(fn.node, usage.dependencyMap)
        : fallback?.dependencyMap;
    // module/exports are the two params right before dependencyMap
    if (depMapIdx !== undefined && depMapIdx >= 2) {
      const m = depMapIdx - 2;
      const e = depMapIdx - 1;
      if (
        m !== requireIdx &&
        e !== requireIdx &&
        t.isIdentifier(params[m]) &&
        t.isIdentifier(params[e])
      ) {
        moduleIdx = m;
        exportsIdx = e;
      }
    }
    moduleIdx ??= fallback?.module;
    exportsIdx ??= fallback?.exports;
    if (usage !== undefined) {
      for (const name of usage.callees) rewriteCallees.add(name);
    } else {
      const requireName = nameAt(requireIdx);
      if (requireName !== undefined) rewriteCallees.add(requireName);
    }
  }

  // Rewrite before renaming so the original param names still match
  const depMapName = nameAt(depMapIdx);
  if (depMapName !== undefined) {
    rewriteRequires(fn.node, rewriteCallees, depMapName, deps);
  }
  renameParam(fn, requireIdx, 'require');
  renameParam(fn, importDefaultIdx, 'importDefault');
  renameParam(fn, importAllIdx, 'importAll');
  renameParam(fn, moduleIdx, 'module');
  renameParam(fn, exportsIdx, 'exports');

  const file = t.file(t.program(fn.node.body.body));
  const module = new MetroModule(id, file, id === entryId, deps, verboseName);
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
        // Metro's __d/__r are runtime-provided globals, never declared
        // in-bundle. A program-scope binding means user-land lookalikes:
        // don't unpack.
        if (path.scope.hasBinding('__d') || path.scope.hasBinding('__r')) {
          return;
        }

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
