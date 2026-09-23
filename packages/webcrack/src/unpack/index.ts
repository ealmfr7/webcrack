import traverse, { visitors } from '@babel/traverse';
import type * as t from '@babel/types';
import type * as m from '@codemod/matchers';
import debug from 'debug';
import { unpackBrowserify } from './browserify';
import type { Bundle } from './bundle';
import { unpackEsbuild } from './esbuild';
import { unpackMetro } from './metro';
import { unpackParcel } from './parcel';
import { unpackRollup } from './rollup';
import { unpackTurbopack } from './turbopack';
import unpackWebpack4 from './webpack/unpack-webpack-4.js';
import unpackWebpack5 from './webpack/unpack-webpack-5.js';
import unpackWebpackChunk from './webpack/unpack-webpack-chunk.js';

export { Bundle } from './bundle';

export interface UnpackASTOptions {
  /**
   * Computes additional module-path mappings from the freshly created
   * bundle. Runs after bundle creation but before `applyMappings` (and
   * therefore before `applyTransforms`, so structural hashes still match
   * the raw extracted modules). The returned mappings are merged UNDER the
   * explicit `mappings` argument: explicit keys win, and a returned entry
   * for a path an explicit mapping already uses is dropped, so
   * `applyMappings` never sees the same path twice.
   */
  libraryMappings?: (bundle: Bundle) => Record<string, m.Matcher<unknown>>;
}

export function unpackAST(
  ast: t.Node,
  mappings: Record<string, m.Matcher<unknown>> = {},
  options: UnpackASTOptions = {},
): Bundle | undefined {
  const state: { bundle: Bundle | undefined } = { bundle: undefined };
  const visitor = visitors.merge([
    unpackWebpack4.visitor(state),
    unpackWebpack5.visitor(state),
    unpackWebpackChunk.visitor(state),
    unpackBrowserify.visitor(state),
    unpackEsbuild.visitor(state),
    unpackMetro.visitor(state),
    unpackRollup.visitor(state),
    unpackParcel.visitor(state),
    unpackTurbopack.visitor(state),
  ]);
  traverse(ast, visitor, undefined, { changes: 0 });
  // TODO: applyTransforms(ast, [unpackWebpack, unpackBrowserify]) instead
  if (state.bundle) {
    const libraryMappings = options.libraryMappings?.(state.bundle) ?? {};
    // Library mappings sit under the explicit ones: explicit keys win.
    const mergedMappings: Record<string, m.Matcher<unknown>> = {
      ...libraryMappings,
    };
    for (const [path, matcher] of Object.entries(mappings)) {
      mergedMappings[path] = matcher;
    }
    state.bundle.applyMappings(mergedMappings);
    state.bundle.applyTransforms();
    debug('webcrack:unpack')(
      `Bundle: ${state.bundle.type}, modules: ${state.bundle.modules.size}, entry id: ${state.bundle.entryId}`,
    );
  }
  return state.bundle;
}
