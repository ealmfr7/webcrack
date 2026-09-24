import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type * as m from '@codemod/matchers';
import { posix } from 'node:path';
import { Bundle } from './bundle';
import { unpackAST } from './index';
import type { Module } from './module';
import { relativePath } from './path';

export interface UnpackChunksResult {
  /** The merged bundle, or undefined when no input produced a bundle. */
  bundle: Bundle | undefined;
  /**
   * Referenced specifiers (module ids or relative paths) that could not be
   * resolved to a module in the merged bundle. Sorted for determinism.
   */
  unresolved: string[];
  /** Non-fatal problems: ignored inputs, type mismatches, duplicate ids. */
  warnings: string[];
}

/**
 * Unpacks several files of the same app (a webpack runtime/entry file plus
 * jsonp chunks, Turbopack chunks, or Rollup/Vite chunks) and merges them
 * into a single bundle.
 *
 * Each input is unpacked with the existing per-format unpackers
 * ({@link unpackAST}); the resulting bundles' modules are merged by module
 * id (the first input wins on conflicts) and cross-chunk `require`/`import`
 * references are re-resolved against the merged module set.
 *
 * Pass the runtime/entry file first: the merged bundle takes its entry from
 * the first input (in order) that produced a bundle with a non-empty
 * entry id. Inputs that match no known chunk format are ignored with a
 * warning.
 *
 * Mappings are applied once to the merged bundle (not per chunk), so a
 * mapping is never reported as already used by another chunk.
 */
export function unpackChunks(
  inputs: (string | t.File)[],
  mappings: Record<string, m.Matcher<unknown>> = {},
): UnpackChunksResult {
  const warnings: string[] = [];
  const bundles: Bundle[] = [];

  inputs.forEach((input, index) => {
    const ast =
      typeof input === 'string'
        ? parse(input, {
            sourceType: 'unambiguous',
            allowReturnOutsideFunction: true,
            errorRecovery: true,
            plugins: ['jsx'],
          })
        : input;
    const bundle = unpackAST(ast);
    if (!bundle) {
      warnings.push(`input #${index}: no known chunk format detected, ignored`);
      return;
    }
    if (bundles.length > 0 && bundle.type !== bundles[0].type) {
      warnings.push(
        `input #${index}: bundle type '${bundle.type}' does not match '${bundles[0].type}', merged anyway`,
      );
    }
    bundles.push(bundle);
  });

  if (bundles.length === 0) {
    return { bundle: undefined, unresolved: [], warnings };
  }

  const entryBundle =
    bundles.find((bundle) => bundle.entryId !== '') ?? bundles[0];

  const modules = new Map<string, Module>();
  bundles.forEach((bundle, index) => {
    for (const [id, module] of bundle.modules) {
      if (modules.has(id)) {
        warnings.push(
          `duplicate module id '${id}' from input #${index} ignored`,
        );
        continue;
      }
      modules.set(id, module);
    }
  });

  let entryId = entryBundle.entryId;
  if (entryId !== '' && !modules.has(entryId)) {
    entryId = '';
    warnings.push(
      `entry module '${entryBundle.entryId}' was dropped as a duplicate, fell back to '${[...modules.keys()][0] ?? ''}'`,
    );
  }
  if (entryId === '') {
    entryId = [...modules.keys()][0] ?? '';
  }

  const merged = new Bundle(entryBundle.type, entryId, modules);
  for (const module of merged.modules.values()) {
    module.isEntry = module.id === entryId;
  }
  merged.applyMappings(mappings);
  const unresolved = relink(merged);

  return { bundle: merged, unresolved, warnings };
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '');
}

function takeMissingComment(node: t.Node): boolean {
  const comments = node.leadingComments;
  if (!comments) return false;
  const index = comments.findIndex((comment) =>
    comment.value.includes('webcrack:missing'),
  );
  if (index === -1) return false;
  comments.splice(index, 1);
  return true;
}

/**
 * Re-resolves cross-chunk references against the merged module set and
 * collects the specifiers that still point nowhere:
 * - `require("<relative path>")` calls (webpack ids were already rewritten
 *   to paths by the per-chunk transforms; stale `webcrack:missing` markers
 *   are cleared when the target is now present),
 * - leftover `__turbopack_require__(id)` / `__turbopack_import__(id)` calls
 *   whose id was unknown to their own chunk,
 * - static/dynamic `import` and re-export sources.
 */
function relink(bundle: Bundle): string[] {
  const byId = bundle.modules;
  const byPath = new Map<string, string>();
  for (const [id, module] of byId) {
    const key = normalizePath(module.path);
    if (!byPath.has(key)) byPath.set(key, id);
  }
  const unresolved = new Set<string>();

  const lookup = (key: string): string | undefined => {
    const withJs = key.endsWith('.js') ? key : `${key}.js`;
    return byPath.get(key) ?? byPath.get(withJs);
  };

  const resolveRelative = (
    specifier: string,
    fromPath: string,
  ): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    // Module-relative (webpack/turbopack style: resolved from the module dir)
    const relative = normalizePath(
      posix.normalize(posix.join(posix.dirname(fromPath), specifier)),
    );
    // Chunk-root-relative (rollup style: specifiers in a chunk are written
    // relative to the chunk file, while merged modules keep region paths)
    const rooted = normalizePath(specifier);
    return lookup(relative) ?? lookup(rooted);
  };

  const relinkSpecifier = (
    specifier: string,
    fromPath: string,
  ): string | undefined => {
    const target = resolveRelative(specifier, fromPath);
    if (target === undefined) return undefined;
    return relativePath(fromPath, byId.get(target)!.path);
  };

  for (const module of byId.values()) {
    const fromPath = module.path;
    traverse(module.ast, {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        if (
          t.isIdentifier(callee) &&
          (callee.name === '__turbopack_require__' ||
            callee.name === '__turbopack_import__') &&
          args.length === 1
        ) {
          const [first] = args;
          const rawId =
            t.isStringLiteral(first) || t.isNumericLiteral(first)
              ? first.value.toString()
              : undefined;
          if (rawId === undefined) return;
          const target = byId.get(rawId);
          if (!target) {
            unresolved.add(rawId);
            return;
          }
          path.node.arguments = [
            t.stringLiteral(relativePath(fromPath, target.path)),
          ];
          path.node.callee =
            callee.name === '__turbopack_import__'
              ? t.import()
              : t.identifier('require');
          return;
        }
        const isRequire =
          t.isIdentifier(callee, { name: 'require' }) && args.length === 1;
        const isDynamicImport = callee.type === 'Import' && args.length === 1;
        if (!isRequire && !isDynamicImport) return;
        const [first] = args;
        if (!t.isStringLiteral(first)) return;
        const fixed = relinkSpecifier(first.value, fromPath);
        if (fixed !== undefined) {
          first.value = fixed;
          takeMissingComment(first);
        } else if (takeMissingComment(first)) {
          unresolved.add(first.value);
        } else if (
          (isRequire || isDynamicImport) &&
          first.value.startsWith('.')
        ) {
          unresolved.add(first.value);
        }
      },
      ImportDeclaration(path) {
        const { value } = path.node.source;
        const fixed = relinkSpecifier(value, fromPath);
        if (fixed !== undefined) path.node.source.value = fixed;
        else if (value.startsWith('.')) unresolved.add(value);
      },
      ExportNamedDeclaration(path) {
        const { source } = path.node;
        if (!source) return;
        const fixed = relinkSpecifier(source.value, fromPath);
        if (fixed !== undefined) source.value = fixed;
        else if (source.value.startsWith('.')) unresolved.add(source.value);
      },
      ExportAllDeclaration(path) {
        const { value } = path.node.source;
        const fixed = relinkSpecifier(value, fromPath);
        if (fixed !== undefined) path.node.source.value = fixed;
        else if (value.startsWith('.')) unresolved.add(value);
      },
      noScope: true,
    });
  }

  return [...unresolved].sort();
}
