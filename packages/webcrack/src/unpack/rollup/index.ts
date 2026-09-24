import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { RollupBundle } from './bundle';
import { RollupModule } from './module';

export { RollupBundle } from './bundle';
export { RollupModule } from './module';

/**
 * Matches Rollup's default chunk file names (`chunk-abc123.js`,
 * `assets/chunk-abc123.js`). Plain ESM sources import arbitrary relative
 * paths, so only this narrow shape counts as a chunk signal.
 */
const CHUNK_SPECIFIER = /(^|\/)chunk[.-][A-Za-z0-9_.-]*\.js$/;

/**
 * Matches a module region comment: a bare path with a code extension, e.g.
 * `// node_modules/is-odd/index.js` or `// src/main.ts`. Excludes URLs,
 * `/// <reference ... />` directives and anything with interior whitespace.
 */
const REGION_PATH =
  /^(?!.*\s)(?!.*:\/\/)(?=.*\/).+\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|json)$/;

/**
 * esbuild runtime helper names. esbuild's ESM output carries the same
 * `// src/...` comments as Rollup regions, so a file defining these helpers
 * belongs to esbuild and must not be claimed here.
 */
const ESBUILD_HELPERS = new Set([
  '__commonJS',
  '__export',
  '__esm',
  '__toESM',
  '__toCommonJS',
  '__copyProps',
  '__defProp',
]);

/**
 * Unpacks Vite/Rollup ESM chunks.
 *
 * Non-minified Rollup output separates modules with region comments:
 * ```js
 * import { shared } from './chunk-shared.abc123.js';
 *
 * // node_modules/is-odd/index.js
 * function isOdd(n) { return n % 2 === 1; }
 *
 * // src/main.js
 * console.log(isOdd(3));
 * export { ... };
 * ```
 * Each region becomes a module keeping its path; chunk-header statements
 * (shared-chunk imports) move into the entry module. Minified chunks have no
 * comments and are reported as a single module.
 *
 * Detection is deliberately conservative: a bundle is only reported when the
 * file has at least two region comments, a `chunk-*` static import, or a
 * `__vitePreload` reference — and never when esbuild helpers are defined.
 * Plain ESM files must not become bundles.
 */
export const unpackRollup = {
  name: 'unpack-rollup',
  tags: ['unsafe'],
  scope: true,
  visitor(options) {
    return {
      Program(path) {
        // Another unpacker (esbuild/webpack/...) already claimed this file
        if (options?.bundle) return;
        if (hasEsbuildHelpers(path)) return;

        const regions = collectRegions(path);
        if (regions.length >= 2) {
          options!.bundle = buildSplitBundle(regions);
          return;
        }

        if (hasChunkSignal(path)) {
          options!.bundle = buildSingleBundle(path);
        }
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;

interface Region {
  path: string;
  statements: t.Statement[];
}

function normalizeRegionPath(raw: string): string {
  const value = raw.trim();
  return value.startsWith('.') ? value : `./${value}`;
}

function regionMarker(
  comments: readonly t.Comment[] | null | undefined,
): string | undefined {
  if (!comments) return undefined;
  let marker: string | undefined;
  for (const comment of comments) {
    if (
      comment.type === 'CommentLine' &&
      REGION_PATH.test(comment.value.trim())
    ) {
      marker = comment.value;
    }
  }
  return marker;
}

/**
 * Splits the top-level statements at own-line `// <path>` region comments.
 * Uses comment attachment (leading comments of each statement) rather than
 * source positions, which earlier pipeline stages may have removed.
 */
function collectRegions(programPath: NodePath<t.Program>): Region[] {
  const regions: Region[] = [];
  const header: t.Statement[] = [];
  let current: Region | undefined;

  for (const statement of programPath.get('body')) {
    const marker = regionMarker(statement.node.leadingComments);
    if (marker !== undefined) {
      current = {
        path: normalizeRegionPath(marker),
        statements: [statement.node],
      };
      regions.push(current);
    } else if (current) {
      current.statements.push(statement.node);
    } else {
      header.push(statement.node);
    }
  }

  if (regions.length > 0 && header.length > 0) {
    // Chunk-header imports belong to the entry module
    const entry = pickEntry(regions);
    entry.statements.unshift(...header);
  }

  return regions;
}

/**
 * The entry is the last region with an export declaration, falling back to
 * the last region (Rollup emits entry exports at the end of the chunk).
 */
function pickEntry(regions: Region[]): Region {
  for (let i = regions.length - 1; i >= 0; i--) {
    if (
      regions[i].statements.some(
        (statement) =>
          t.isExportNamedDeclaration(statement) ||
          t.isExportDefaultDeclaration(statement) ||
          t.isExportAllDeclaration(statement),
      )
    ) {
      return regions[i];
    }
  }
  return regions[regions.length - 1];
}

/**
 * Static `import ... from './chunk-*.js'` or any `__vitePreload` reference.
 * A bare dynamic `import('./x.js')` alone is not enough: hand-written ESM
 * uses it too.
 */
function hasChunkSignal(programPath: NodePath<t.Program>): boolean {
  let found = false;
  programPath.traverse({
    ImportDeclaration(path) {
      if (CHUNK_SPECIFIER.test(path.node.source.value)) {
        found = true;
        path.stop();
      }
    },
    Identifier(path) {
      if (path.node.name === '__vitePreload') {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

function hasEsbuildHelpers(programPath: NodePath<t.Program>): boolean {
  let found = false;
  programPath.traverse({
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (
        t.isIdentifier(id) &&
        ESBUILD_HELPERS.has(id.name) &&
        (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))
      ) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

/**
 * Static import / re-export sources plus string-literal dynamic `import()`
 * targets (including `__vitePreload(() => import(...))`), deduplicated.
 */
function collectDependencies(statements: t.Statement[]): string[] {
  const dependencies: string[] = [];
  const seen = new Set<string>();
  // Read-only traversal over the same nodes (no scope needed)
  traverse(t.file(t.program(statements)), {
    ImportDeclaration(path) {
      addDep(path.node.source.value);
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) addDep(path.node.source.value);
    },
    ExportAllDeclaration(path) {
      addDep(path.node.source.value);
    },
    CallExpression(path) {
      if (
        path.node.callee.type === 'Import' &&
        path.node.arguments.length > 0
      ) {
        const [first] = path.node.arguments;
        if (t.isStringLiteral(first)) addDep(first.value);
      }
    },
  });
  return dependencies;

  function addDep(specifier: string): void {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      dependencies.push(specifier);
    }
  }
}

function toModule(id: string, statements: t.Statement[], isEntry: boolean) {
  const module = new RollupModule(
    id,
    t.file(t.program(statements)),
    isEntry,
    collectDependencies(statements),
  );
  // Split modules keep their region paths; the single-module id ('index',
  // like esbuild's scope-hoisted case) keeps the constructor default path
  if (id !== 'index') module.path = id;
  return module;
}

function buildSplitBundle(regions: Region[]): RollupBundle {
  const entry = pickEntry(regions);
  const taken = new Set<string>();
  const modules = new Map<string, RollupModule>();
  let entryId = '';
  for (const region of regions) {
    let id = region.path;
    let index = 0;
    while (taken.has(id)) id = `${region.path}#${++index}`;
    taken.add(id);
    modules.set(id, toModule(id, region.statements, region === entry));
    if (region === entry) entryId = id;
  }
  return new RollupBundle(entryId, modules);
}

function buildSingleBundle(programPath: NodePath<t.Program>): RollupBundle {
  const statements = programPath.get('body').map((statement) => statement.node);
  const entry = toModule('index', statements, true);
  return new RollupBundle(entry.id, new Map([[entry.id, entry]]));
}
