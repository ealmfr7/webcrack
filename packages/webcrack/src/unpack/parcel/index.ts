import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
import { getPropName, renameFast } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { resolveDependencyTree } from '../path';
import { ParcelBundle } from './bundle';
import { ParcelModule } from './module';

export { ParcelBundle } from './bundle';
export { ParcelModule } from './module';

/**
 * Unpacks Parcel bundles.
 *
 * Parcel 2 registers one module per factory call and executes the entry:
 * ```js
 * parcelRegister("a1b2", function (module, exports) {
 *   var dep = parcelRequire("c3d4");
 * });
 * parcelRequire("a1b2");
 * ```
 * The `$parcel$global` / `$parcel$interopDefault` / `$parcel$export` runtime
 * helpers (kept under these names even when minified) are runtime noise and
 * never become modules. `parcelRequire("<id>")` calls that reference a
 * registered module are rewritten to `require("<path>")` by
 * {@link ParcelBundle.applyTransforms}.
 *
 * Parcel 1 reuses a browserify-style prelude with an extra `globalName`
 * parameter:
 * ```js
 * (function (modules, cache, entry, globalName) {...})({
 *   "id": [function (require, module, exports) {...}, { "./dep": "depId" }]
 * }, {}, ["id"]);
 * ```
 * Each specifier in the per-module dep map is resolved to a path and
 * `require("<specifier>")` calls are rewritten to `require("<path>")` when
 * the dep map provides them.
 */
export const unpackParcel = {
  name: 'unpack-parcel',
  tags: ['unsafe'],
  scope: true,
  visitor(options = { bundle: undefined }) {
    return {
      Program(path) {
        unpackParcel2(path, options);
      },
      CallExpression(path) {
        unpackParcel1(path, options);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;

function isDirective(statement: NodePath<t.Statement>): boolean {
  return (
    statement.isExpressionStatement() &&
    t.isStringLiteral(statement.node.expression)
  );
}

/**
 * Bundle-scope statements: the program body itself, or the body of a lone
 * IIFE wrapper (`(function (global) {...})(...)`, `!function () {...}()`),
 * skipping a leading directive prologue.
 */
function bundleStatements(
  programPath: NodePath<t.Program>,
): NodePath<t.Statement>[] {
  const body = programPath.get('body');
  let index = 0;
  while (index < body.length && isDirective(body[index])) index++;
  const rest = body.slice(index);
  if (rest.length === 1 && rest[0].isExpressionStatement()) {
    let expression: NodePath = rest[0].get('expression');
    // `!function () {...}()` wraps the call in a unary expression
    while (expression.isUnaryExpression()) {
      const argument = expression.get('argument');
      if (Array.isArray(argument)) break;
      expression = argument;
    }
    if (expression.isCallExpression()) {
      const callee = expression.get('callee');
      if (Array.isArray(callee)) return body;
      if (
        (callee.isFunctionExpression() || callee.isArrowFunctionExpression()) &&
        t.isBlockStatement(callee.node.body)
      ) {
        return (callee.get('body') as NodePath<t.BlockStatement>).get('body');
      }
    }
  }
  return body;
}

/**
 * Top-level calls of a statement: a bare call, or each element of a comma
 * sequence (minified bundles join registers with `,`).
 */
function statementCalls(
  statement: NodePath<t.Statement>,
): NodePath<t.CallExpression>[] {
  if (!statement.isExpressionStatement()) return [];
  const expression = statement.get('expression');
  if (expression.isCallExpression()) return [expression];
  if (expression.isSequenceExpression()) {
    return expression
      .get('expressions')
      .filter((element) => element.isCallExpression());
  }
  return [];
}

function renameFactoryParams(factory: NodePath<t.Function>): void {
  const names =
    factory.node.params.length === 2
      ? ['module', 'exports']
      : ['require', 'module', 'exports'];
  const params = factory.node.params;
  for (let i = 0; i < Math.min(params.length, names.length); i++) {
    const param = params[i];
    if (!t.isIdentifier(param) || param.name === names[i]) continue;
    const binding = factory.scope.getBinding(param.name);
    if (binding) renameFast(binding, names[i]);
    else param.name = names[i];
  }
}

function literalId(node: t.Node | null | undefined): string | undefined {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) {
    return node.value.toString();
  }
  return undefined;
}

function unpackParcel2(
  programPath: NodePath<t.Program>,
  options: { bundle: Bundle | undefined },
): void {
  // parcelRegister is runtime-provided, never declared in-bundle. A
  // program-scope binding means user-land lookalikes: don't unpack.
  if (programPath.scope.hasBinding('parcelRegister')) return;

  const statements = bundleStatements(programPath);

  const registers: { id: string; factory: NodePath<t.Function> }[] = [];
  let entryId: string | undefined;

  for (const statement of statements) {
    for (const expression of statementCalls(statement)) {
      const { callee } = expression.node;
      if (!t.isIdentifier(callee)) continue;
      if (callee.name === 'parcelRegister') {
        const args = expression.get('arguments');
        if (args.length !== 2) continue;
        const [idArg, factoryArg] = args;
        const id = literalId(idArg.node);
        if (id === undefined) continue;
        if (!factoryArg.isFunction()) continue;
        const factory = factoryArg as NodePath<t.Function>;
        // Factories always take (module, exports); fewer params means a
        // user-land lookalike, not a Parcel module.
        if (
          !t.isBlockStatement(factory.node.body) ||
          factory.node.params.length < 2
        ) {
          continue;
        }
        registers.push({ id, factory });
      } else if (callee.name === 'parcelRequire') {
        const args = expression.get('arguments');
        if (args.length !== 1) continue;
        const id = literalId(args[0].node);
        if (id !== undefined) entryId = id;
      }
    }
  }

  if (registers.length === 0) return;
  entryId ??= registers[0].id;

  const modules = new Map<string, ParcelModule>();
  for (const { id, factory } of registers) {
    if (modules.has(id)) continue;
    renameFactoryParams(factory);
    const body = factory.node.body;
    if (!t.isBlockStatement(body)) continue;
    const file = t.file(t.program(body.body));
    modules.set(id, new ParcelModule(id, file, id === entryId));
  }

  if (modules.size > 0) {
    options.bundle = new ParcelBundle(entryId, modules);
    programPath.stop();
  }
}

function unpackParcel1(
  path: NodePath<t.CallExpression>,
  options: { bundle: Bundle | undefined },
): void {
  const { node } = path;
  // Parcel 1 preludes take (modules, cache, entry, globalName); browserify
  // preludes take 3 params, so the shapes never overlap.
  const prelude = node.callee;
  if (
    !t.isFunctionExpression(prelude) ||
    prelude.params.length !== 4 ||
    !prelude.params.every((param) => t.isIdentifier(param))
  ) {
    return;
  }
  if (node.arguments.length < 3) return;
  const [modulesArg, cacheArg, entryArg] = node.arguments;
  if (
    !t.isObjectExpression(modulesArg) ||
    !t.isObjectExpression(cacheArg) ||
    !t.isArrayExpression(entryArg)
  ) {
    return;
  }
  const [entryElement] = entryArg.elements;
  const entryId = literalId(entryElement);
  if (entryId === undefined) return;

  const args = path.get('arguments');
  const modulesPath = args[0] as NodePath<t.ObjectExpression>;
  const moduleProps = modulesPath.get('properties');
  if (moduleProps.length === 0) return;

  const collected: {
    id: string;
    factory: NodePath<t.Function>;
    dependencies: Record<string, string>;
  }[] = [];
  for (const prop of moduleProps) {
    if (!prop.isObjectProperty()) return;
    const id = getPropName(prop.node.key);
    if (id === undefined) return;
    const value = prop.get('value');
    if (!value.isArrayExpression()) return;
    const elements = value.get('elements');
    if (elements.length !== 2) return;
    const [factoryPath, depMapPath] = elements;
    if (
      factoryPath === null ||
      Array.isArray(factoryPath) ||
      !factoryPath.isFunction()
    ) {
      return;
    }
    const factory = factoryPath as NodePath<t.Function>;
    if (!t.isBlockStatement(factory.node.body)) return;
    if (
      depMapPath === null ||
      Array.isArray(depMapPath) ||
      !depMapPath.isObjectExpression()
    ) {
      return;
    }
    // Skip external dependencies like { vscode: undefined }
    const dependencies: Record<string, string> = {};
    for (const dep of depMapPath.get('properties')) {
      if (!dep.isObjectProperty()) return;
      const specifier = getPropName(dep.node.key);
      if (specifier === undefined) return;
      const depId = literalId(dep.node.value);
      if (depId !== undefined) dependencies[specifier] = depId;
    }
    collected.push({ id, factory, dependencies });
  }

  if (collected.length === 0) return;
  path.stop();

  const dependencyTree: Record<string, Record<string, string>> = {};
  const modules = new Map<string, ParcelModule>();
  for (const { id, factory, dependencies } of collected) {
    const reverse: Record<string, string> = (dependencyTree[id] = {});
    for (const [specifier, depId] of Object.entries(dependencies)) {
      reverse[depId] = specifier;
    }
    renameFactoryParams(factory);
    const body = factory.node.body;
    if (!t.isBlockStatement(body)) continue;
    const file = t.file(t.program(body.body));
    modules.set(id, new ParcelModule(id, file, id === entryId, dependencies));
  }

  const resolvedPaths = resolveDependencyTree(dependencyTree, entryId);
  for (const module of modules.values()) {
    if (Object.hasOwn(resolvedPaths, module.id)) {
      module.path = resolvedPaths[module.id];
    }
  }

  if (modules.size > 0) {
    options.bundle = new ParcelBundle(entryId, modules);
  }
}
