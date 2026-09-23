import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
import { getPropName } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { TurbopackBundle } from './bundle';
import { TurbopackModule } from './module';

type Factory = t.FunctionExpression | t.ArrowFunctionExpression;

const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window', 'global']);

/**
 * Matches `<global>.TURBOPACK` (e.g. `globalThis.TURBOPACK`, `self.TURBOPACK`).
 * The property name must be exactly `TURBOPACK` so webpack chunk globals
 * (`webpackChunk_*`, `webpackJsonp`) never match.
 */
function isTurbopackMember(node: t.Node | null | undefined): boolean {
  if (!t.isMemberExpression(node)) return false;
  if (node.computed) {
    if (!t.isStringLiteral(node.property, { value: 'TURBOPACK' })) return false;
  } else if (!t.isIdentifier(node.property, { name: 'TURBOPACK' })) {
    return false;
  }
  const { object } = node;
  return (
    t.isThisExpression(object) ||
    (t.isIdentifier(object) && GLOBAL_OBJECTS.has(object.name))
  );
}

/**
 * Matches the array `.push` is called on: either the
 * `(globalThis.TURBOPACK = globalThis.TURBOPACK || [])` initializer or a
 * plain `globalThis.TURBOPACK` reference from a later chunk.
 */
function isTurbopackArray(node: t.Node | null | undefined): boolean {
  if (isTurbopackMember(node)) return true;
  return (
    t.isAssignmentExpression(node, { operator: '=' }) &&
    isTurbopackMember(node.left)
  );
}

/**
 * Matches `(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([...])`
 * and returns the pushed array. Anything else (including the
 * `TURBOPACK_CHUNK_LISTS` manifest pushes) returns undefined.
 */
function matchPushArray(node: t.Node): t.ArrayExpression | undefined {
  if (!t.isCallExpression(node)) return undefined;
  const { callee } = node;
  if (!t.isMemberExpression(callee)) return undefined;
  if (callee.computed) {
    if (!t.isStringLiteral(callee.property, { value: 'push' })) return undefined;
  } else if (!t.isIdentifier(callee.property, { name: 'push' })) {
    return undefined;
  }
  if (!isTurbopackArray(callee.object)) return undefined;
  return node.arguments.find((arg) => t.isArrayExpression(arg));
}

function asFactory(value: t.Node | null | undefined): Factory | undefined {
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
    return value;
  }
  // Module values may already be invoked, e.g.
  // `(({ r: __turbopack_require__, ... }) => (() => {...}))()`
  if (
    t.isCallExpression(value) &&
    (t.isFunctionExpression(value.callee) ||
      t.isArrowFunctionExpression(value.callee))
  ) {
    return value.callee;
  }
  return undefined;
}

interface ModuleEntry {
  id: string;
  factory: Factory;
}

/**
 * Collects one entry per module from an object container
 * (`{ "[project]/src/x.js [app-client] (ecmascript)": factory, 5: factory }`)
 * or an array container (`[factory, null, factory]`, index is the id).
 * Entries without an inline function value (holes, spreads, aliases) are
 * skipped; a container with no entries never claims a bundle.
 */
function collectEntries(
  container: t.ObjectExpression | t.ArrayExpression,
): ModuleEntry[] {
  const entries: ModuleEntry[] = [];
  if (t.isObjectExpression(container)) {
    for (const property of container.properties) {
      if (!t.isObjectProperty(property)) continue;
      const key = getPropName(property.key);
      if (key === undefined) continue;
      const factory = asFactory(property.value);
      if (factory) entries.push({ id: key, factory });
    }
  } else {
    container.elements.forEach((element, index) => {
      const factory = asFactory(element);
      if (factory) entries.push({ id: String(index), factory });
    });
  }
  return entries;
}

interface ContextNames {
  /** Local names called as `require(id)` */
  require: Set<string>;
  /** Local names called as `import(id)` */
  import: Set<string>;
  /** Single-identifier context param used as `ctx.r(id)` / `ctx.i(id)` */
  context: string | undefined;
}

function addDestructured(
  pattern: t.ObjectPattern,
  names: Pick<ContextNames, 'require' | 'import'>,
): void {
  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property) || !t.isIdentifier(property.value)) {
      continue;
    }
    const key = getPropName(property.key);
    if (key === 'r' || key === 't') names.require.add(property.value.name);
    else if (key === 'i') names.import.add(property.value.name);
  }
}

/**
 * Finds the local names of the require/import helpers for one factory:
 * - a destructured first parameter (`({ r: __turbopack_require__, ... })`),
 * - a single context parameter (`__turbopack_context__`, minified `e`) used
 *   directly (`ctx.r(id)`) or destructured at the top of the body
 *   (`var { r: __turbopack_require__, ... } = __turbopack_context__`).
 */
function analyzeParams(factory: Factory): ContextNames {
  const names: ContextNames = {
    require: new Set(),
    import: new Set(),
    context: undefined,
  };
  const [first] = factory.params;
  if (t.isObjectPattern(first)) {
    addDestructured(first, names);
  } else if (t.isIdentifier(first)) {
    names.context = first.name;
    if (t.isBlockStatement(factory.body)) {
      for (const statement of factory.body.body) {
        if (!t.isVariableDeclaration(statement)) continue;
        for (const declarator of statement.declarations) {
          if (
            t.isObjectPattern(declarator.id) &&
            t.isIdentifier(declarator.init, { name: first.name })
          ) {
            addDestructured(declarator.id, names);
          }
        }
      }
    }
  }
  return names;
}

/**
 * Drops `var { ... } = <context>` declarators from the module body: the
 * context parameter no longer exists after extraction, and the remaining
 * `module`/`exports` bindings are conventional CJS free variables.
 */
function stripContextDestructures(
  statements: t.Statement[],
  context: string | undefined,
): t.Statement[] {
  if (context === undefined) return statements;
  const result: t.Statement[] = [];
  for (const statement of statements) {
    if (!t.isVariableDeclaration(statement)) {
      result.push(statement);
      continue;
    }
    const kept = statement.declarations.filter(
      (declarator) =>
        !(
          t.isObjectPattern(declarator.id) &&
          t.isIdentifier(declarator.init, { name: context })
        ),
    );
    if (kept.length > 0) result.push({ ...statement, declarations: kept });
  }
  return result;
}

/**
 * Extracts the module code from a factory. Factories whose body is a single
 * no-arg IIFE (`() => (() => {...})()`) are unwrapped so the module keeps
 * only its own statements.
 */
function factoryStatements(factory: Factory, context: string | undefined): t.Statement[] {
  const { body } = factory;
  let statements: t.Statement[];
  if (!t.isBlockStatement(body)) {
    if (
      (t.isFunctionExpression(body) || t.isArrowFunctionExpression(body)) &&
      body.params.length === 0
    ) {
      return factoryStatements(body, undefined);
    }
    if (
      t.isCallExpression(body) &&
      (t.isFunctionExpression(body.callee) ||
        t.isArrowFunctionExpression(body.callee)) &&
      body.callee.params.length === 0 &&
      body.arguments.length === 0
    ) {
      return factoryStatements(body.callee, undefined);
    }
    statements = [t.returnStatement(body)];
  } else {
    statements = stripContextDestructures(body.body, context);
    if (statements.length === 1) {
      const [only] = statements;
      if (t.isExpressionStatement(only) && t.isCallExpression(only.expression)) {
        const { callee, arguments: args } = only.expression;
        if (
          (t.isFunctionExpression(callee) ||
            t.isArrowFunctionExpression(callee)) &&
          callee.params.length === 0 &&
          args.length === 0
        ) {
          return factoryStatements(callee, undefined);
        }
      }
    }
  }
  return statements;
}

function literalId(node: t.Node | null | undefined): string | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value.toString();
  return undefined;
}

const LAYER_SUFFIX = /\s*\[[^\]]*\]\s*\([^()]*\)\s*$/;

function uniquePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = candidate.lastIndexOf('.');
  const base = dot === -1 ? candidate : candidate.slice(0, dot);
  const ext = dot === -1 ? '' : candidate.slice(dot);
  let index = 1;
  while (used.has(`${base}-${index}${ext}`)) index++;
  const unique = `${base}-${index}${ext}`;
  used.add(unique);
  return unique;
}

/**
 * Derives a file path from a module key: `[project]/src/x.js [app-client]
 * (ecmascript)` becomes `./src/x.js` (the `[layer] (ecmascript)` suffix is
 * stripped). The same file in two layers maps to unique paths (`./x.js`,
 * `./x-1.js`). Keys without a `[project]/` prefix (numeric ids) become
 * `./<id>.js`.
 */
export function deriveModulePath(rawId: string, used: Set<string>): string {
  const match = /^\[([^\]/]*)\]\/(.*)$/s.exec(rawId);
  if (match) {
    const rest = match[2].replace(LAYER_SUFFIX, '').replace(/^\.\//, '');
    const segments = rest
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .map((segment) => (segment === '..' ? '__parent__' : segment));
    if (segments.length === 0) return uniquePath('./module.js', used);
    const last = segments[segments.length - 1];
    if (!/\.[^/.]+$/.test(last)) segments[segments.length - 1] = `${last}.js`;
    return uniquePath(`./${segments.join('/')}`, used);
  }
  const safe = rawId === '' ? 'module' : rawId.replace(/\.\./g, '__parent__');
  const file = /\.[^/.]+$/.test(safe) ? safe : `${safe}.js`;
  return uniquePath(`./${file}`, used);
}

/**
 * Rewrites `__turbopack_require__(id)` to `require("path")`,
 * `__turbopack_import__(id)` to `import("path")`, and the single-context
 * forms `ctx.r(id)` / `ctx.i(id)` the same way. Only calls whose argument
 * resolves to a module in this chunk are rewritten; externals and
 * cross-chunk ids are left untouched.
 */
function rewriteRequires(
  file: t.File,
  names: ContextNames,
  resolveId: (rawId: string) => string | undefined,
): void {
  const rewriteCall = (
    call: t.CallExpression,
    isRequire: boolean,
    replaceCallee: () => void,
  ): void => {
    const [first] = call.arguments;
    if (call.arguments.length !== 1) return;
    const rawId = literalId(first);
    if (rawId === undefined) return;
    const target = resolveId(rawId);
    if (target === undefined) return;
    call.arguments = [t.stringLiteral(target)];
    replaceCallee();
  };

  traverse(file, {
    CallExpression(path) {
      const { callee } = path.node;
      if (t.isIdentifier(callee)) {
        const isRequire = names.require.has(callee.name);
        const isImport = !isRequire && names.import.has(callee.name);
        if (!isRequire && !isImport) return;
        rewriteCall(path.node, isRequire, () => {
          path.node.callee = isImport
            ? t.import()
            : t.identifier('require');
        });
        return;
      }
      if (
        t.isMemberExpression(callee) &&
        names.context !== undefined &&
        t.isIdentifier(callee.object, { name: names.context })
      ) {
        const prop = callee.computed
          ? t.isStringLiteral(callee.property)
            ? callee.property.value
            : undefined
          : getPropName(callee.property);
        const isRequire = prop === 'r' || prop === 't';
        const isImport = prop === 'i';
        if (!isRequire && !isImport) return;
        rewriteCall(path.node, isRequire, () => {
          const calleePath = path.get('callee') as NodePath;
          calleePath.replaceWith(
            isImport ? t.import() : t.identifier('require'),
          );
        });
        return;
      }
      // Resolve the specifier of dynamic imports that are already imports
      if (callee.type === 'Import') {
        rewriteCall(path.node, false, () => {});
      }
    },
    noScope: true,
  });
}

/**
 * Format:
 * ```js
 * (globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([document.currentScript, {
 *   "[project]/src/x.js [app-client] (ecmascript)":
 *     (({ r: __turbopack_require__, i: __turbopack_import__, ... }) => (() => {...}))(),
 * }])
 * ```
 * Newer/minified chunks use numeric ids (`{ 5: (e) => {...} }`, with
 * `e.r(id)` / `e.i(id)` helper calls) or arrays (`[(e) => {...}, ...]`,
 * index is the id). One module is created per entry with its path derived
 * from the `[project]/...` key.
 */
export const unpackTurbopack = {
  name: 'unpack-turbopack',
  tags: ['unsafe'],
  scope: true,
  visitor(options: { bundle: Bundle | undefined } = { bundle: undefined }) {
    return {
      Program(path) {
        const entries: ModuleEntry[] = [];
        for (const statement of path.get('body')) {
          if (!statement.isExpressionStatement()) continue;
          const chunk = matchPushArray(statement.node.expression);
          if (!chunk) continue;
          for (const element of chunk.elements) {
            if (
              element !== null &&
              (t.isObjectExpression(element) || t.isArrayExpression(element))
            ) {
              entries.push(...collectEntries(element));
            }
          }
        }
        if (entries.length === 0) return;

        const usedPaths = new Set<string>();
        const modules = new Map<string, TurbopackModule>();
        const idToPath = new Map<string, string>();
        for (const { id, factory } of entries) {
          if (modules.has(id)) continue;
          const modulePath = deriveModulePath(id, usedPaths);
          const names = analyzeParams(factory);
          const file = t.file(
            t.program(factoryStatements(factory, names.context)),
          );
          const module = new TurbopackModule(id, file, false);
          module.path = modulePath;
          modules.set(id, module);
          idToPath.set(id, modulePath);
        }

        for (const { id, factory } of entries) {
          const module = modules.get(id);
          if (!module) continue;
          rewriteRequires(module.ast, analyzeParams(factory), (rawId) =>
            idToPath.get(rawId),
          );
        }

        const [entryId] = modules.keys();
        modules.get(entryId)!.isEntry = true;
        options.bundle = new TurbopackBundle(entryId, modules);
        path.stop();
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
