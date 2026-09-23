import type { ParseResult } from '@babel/parser';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type * as t from '@babel/types';
import type Matchers from '@codemod/matchers';
import * as m from '@codemod/matchers';
import debug from 'debug';
import { join, normalize } from 'node:path';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
  generate,
  generateWithMap,
} from './ast-utils';
import type { GeneratedWithMap } from './ast-utils';
import { removeNodeFields } from './ast-utils/remove-node-fields.js';
import { callGraph, moduleGraph, toDot, toJSON } from './analysis/graph.js';
import type { Graph } from './analysis/graph.js';
import { extractReport } from './analysis/report.js';
import type { Report } from './analysis/report.js';
import type { Sandbox } from './deobfuscate';
import deobfuscate, {
  createBrowserSandbox,
  createNodeSandbox,
} from './deobfuscate';
import debugProtection from './deobfuscate/debug-protection';
import evaluateGlobals from './deobfuscate/evaluate-globals';
import mergeObjectAssignments from './deobfuscate/merge-object-assignments';
import selfDefending from './deobfuscate/self-defending';
import {
  runPlugins,
  type Plugin,
  type PluginState,
  type Stage,
} from './plugin';
import jsx from './transforms/jsx';
import jsxNew from './transforms/jsx-new';
import mangle from './transforms/mangle';
import renameHeuristics from './transforms/rename-heuristics';
import transpile from './transpile';
import unminify from './unminify';
import {
  blockStatements,
  sequence,
  splitVariableDeclarations,
} from './unminify/transforms';
import type { Bundle } from './unpack';
import { unpackAST } from './unpack';
import { withTrace, type TraceEntry } from './trace.js';
import { isBrowser } from './utils/platform';

export { type Sandbox } from './deobfuscate';
export type { Plugin } from './plugin';
export type { Graph } from './analysis/graph.js';
export type { Report } from './analysis/report.js';
export {
  callGraph,
  moduleGraph,
  toDot,
  type GraphEdge,
  type GraphNode,
} from './analysis/graph.js';
export { fingerprint, matchModules } from './analysis/lib-fingerprint.js';
export type {
  LibraryMatch,
  LibrarySignature,
} from './analysis/lib-fingerprint.js';
export {
  extractReport,
  type EndpointEntry,
  type InterestingEntry,
  type RegexEntry,
  type ReportPosition,
  type SecretEntry,
  type UrlEntry,
} from './analysis/report.js';
export {
  renameWithLLM,
  type LLMBindingInfo,
  type RenameLLMOptions,
  type RenameLogEntry,
  type SuggestNames,
} from './transforms/rename-llm.js';
export { unpackChunks, type UnpackChunksResult } from './unpack/multi-chunk.js';
export {
  detectInterpreters,
  type InterpreterDispatchKind,
  type InterpreterHandler,
  type InterpreterInfo,
} from './vm-analysis/detect.js';
export {
  labelHandlers,
  type HandlerKind,
  type HandlerLabel,
  type HandlerLabelKind,
} from './vm-analysis/handlers.js';

type Matchers = typeof m;

export interface WebcrackResult {
  code: string;
  bundle: Bundle | undefined;
  /**
   * Collected URLs, network endpoints, secrets, regexes and other
   * interesting strings with original source positions.
   * Only present when the `report` option is enabled.
   */
  report?: Report;
  /**
   * Dependency graph of the unpacked bundle.
   * Only present when the `graph` option is enabled and a bundle was found.
   */
  moduleGraph?: Graph;
  /**
   * Static call graph of the deobfuscated code.
   * Only present when the `graph` option is enabled.
   */
  callGraph?: Graph;
  /**
   * Source map mapping the deobfuscated code back to the input positions.
   * Only present when the `sourceMap` option is enabled.
   */
  map?: GeneratedWithMap['map'];
  /**
   * Per-stage transform trace (name, change count and unified line diff).
   * Only present when the `trace` option is enabled.
   */
  trace?: TraceEntry[];
  /**
   * Save the deobfuscated code and the extracted bundle to the given directory.
   * Also writes `report.json` when the `report` option is enabled and
   * `graph.modules.json`/`.dot` (only when a bundle exists) plus
   * `graph.calls.json`/`.dot` when the `graph` option is enabled.
   * Appends a `sourceMappingURL` comment to `deobfuscated.js` and writes
   * `deobfuscated.js.map` when the `sourceMap` option is enabled, and writes
   * `trace.diff` when the `trace` option is enabled.
   * @param path Output directory
   */
  save(path: string): Promise<void>;
}

export interface Options {
  /**
   * Decompile react components to JSX.
   * @default true
   */
  jsx?: boolean;
  /**
   * Extract modules from the bundle.
   * @default true
   */
  unpack?: boolean;
  /**
   * Deobfuscate the code.
   * @default true
   */
  deobfuscate?: boolean;
  /**
   * Unminify the code. Required for some of the deobfuscate/unpack/jsx transforms.
   * @default true
   */
  unminify?: boolean;
  /**
   * Mangle variable names.
   * @default false
   */
  mangle?: boolean | ((id: string) => boolean);
  /**
   * Rename short or mangled variable names using heuristics
   * (module names, event parameters, loop indices, props, ...).
   * @default false
   */
  renameHeuristics?: boolean;
  /**
   * Collect URLs, network endpoints, secrets, regexes and other
   * interesting strings with original source positions.
   * @default false
   */
  report?: boolean;
  /**
   * Build the module dependency graph (when a bundle exists) and the
   * static call graph of the deobfuscated code.
   * @default false
   */
  graph?: boolean;
  /**
   * Emit a version 3 source map (`result.map`) mapping the deobfuscated
   * code back to the input positions. `save()` writes it as
   * `deobfuscated.js.map` and appends a `sourceMappingURL` comment to
   * `deobfuscated.js`.
   * @default false
   */
  sourceMap?: boolean;
  /**
   * Record one trace entry per pipeline stage (transform name, change count
   * and unified line diff) in `result.trace`. `save()` writes them as
   * `trace.diff`.
   *
   * Tracing uses a module-global tracer: concurrent `webcrack()` calls with
   * `trace` enabled are not supported, await each call before starting the
   * next one.
   * @default false
   */
  trace?: boolean;
  /**
   * Automatically name modules matching known open-source library
   * signatures (see `matchModules`) as `node_modules/<path>` and rewrite
   * `require()` calls to use the new paths. The detected mappings are
   * merged under `mappings`: explicit mappings win for modules they match.
   * @default false
   */
  libraryMappings?: boolean;
  /**
   * Run AST transformations after specific stages
   */
  plugins?: Partial<Record<Stage, Plugin[]>>;
  /**
   * Assigns paths to modules based on the given matchers.
   * This will also rewrite `require()` calls to use the new paths.
   *
   * @example
   * ```js
   * m => ({
   *   './utils/color.js': m.regExpLiteral('^#([0-9a-f]{3}){1,2}$')
   * })
   * ```
   */
  mappings?: (m: Matchers) => Record<string, m.Matcher<unknown>>;
  /**
   * Function that executes a code expression and returns the result (typically from the obfuscator).
   */
  sandbox?: Sandbox;
  /**
   * @param progress Progress in percent (0-100)
   */
  onProgress?: (progress: number) => void;
}

function mergeOptions(options: Options): asserts options is Required<Options> {
  const mergedOptions: Required<Options> = {
    jsx: true,
    unminify: true,
    unpack: true,
    deobfuscate: true,
    mangle: false,
    renameHeuristics: false,
    report: false,
    graph: false,
    sourceMap: false,
    trace: false,
    libraryMappings: false,
    plugins: options.plugins ?? {},
    mappings: () => ({}),
    onProgress: () => {},
    sandbox: isBrowser() ? createBrowserSandbox() : createNodeSandbox(),
    ...options,
  };
  Object.assign(options, mergedOptions);
}

export async function webcrack(
  code: string,
  options: Options = {},
): Promise<WebcrackResult> {
  mergeOptions(options);
  options.onProgress(0);

  if (isBrowser()) {
    debug.enable('webcrack:*');
  }

  const isBookmarklet = /^javascript:./.test(code);
  if (isBookmarklet) {
    code = code
      .replace(/^javascript:/, '')
      .split(/%(?![a-f\d]{2})/i)
      .map(decodeURIComponent)
      .join('%');
  }

  let ast: ParseResult<t.File> = null!;
  let outputCode = '';
  let bundle: Bundle | undefined;
  let report: Report | undefined;
  let moduleGraphResult: Graph | undefined;
  let callGraphResult: Graph | undefined;
  let sourceMap: GeneratedWithMap['map'] | undefined;
  let traceEntries: TraceEntry[] | undefined;

  const { plugins } = options;
  const state: PluginState = { opts: {} };

  const stages = [
    () => {
      ast = parse(code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx'],
      });
      if (ast.errors?.length) {
        debug('webcrack:parse')('Recovered from parse errors', ast.errors);
      }
    },
    // The report needs original source positions, so it runs on the fresh
    // parse before removeNodeFields strips `loc`.
    options.report && (() => (report = extractReport(ast))),
    plugins.afterParse && (() => runPlugins(ast, plugins.afterParse!, state)),

    () => {
      // Separate traverseFast is ~4x faster than running it within the merged prepare visitor.
      // This introduces some initial performance overhead, but reduces the memory usage of each AST node by half,
      // `loc` is kept when a source map is requested so the output can be
      // mapped back to the input positions.
      removeNodeFields(ast, { keepLoc: options.sourceMap });
      applyTransforms(
        ast,
        [blockStatements, sequence, splitVariableDeclarations],
        { name: 'prepare' },
      );
    },
    plugins.afterPrepare &&
      (() => runPlugins(ast, plugins.afterPrepare!, state)),

    options.deobfuscate &&
      (() => applyTransformAsync(ast, deobfuscate, options.sandbox)),
    plugins.afterDeobfuscate &&
      (() => runPlugins(ast, plugins.afterDeobfuscate!, state)),

    options.unminify &&
      (() => {
        applyTransforms(ast, [transpile, unminify]);
      }),
    plugins.afterUnminify &&
      (() => runPlugins(ast, plugins.afterUnminify!, state)),

    options.renameHeuristics && (() => applyTransform(ast, renameHeuristics)),
    options.mangle &&
      (() =>
        applyTransform(
          ast,
          mangle,
          typeof options.mangle === 'boolean' ? () => true : options.mangle,
        )),
    // TODO: Also merge unminify visitor (breaks selfDefending/debugProtection atm)
    (options.deobfuscate || options.jsx) &&
      (() => {
        applyTransforms(
          ast,
          [
            // Have to run this after unminify to properly detect it
            options.deobfuscate ? [selfDefending, debugProtection] : [],
            options.jsx ? [jsx, jsxNew] : [],
          ].flat(),
        );
      }),
    options.deobfuscate &&
      (() => applyTransforms(ast, [mergeObjectAssignments, evaluateGlobals])),
    () => {
      if (options.sourceMap) {
        const generated = generateWithMap(ast, {
          sourceFileName: 'input.js',
          sourceContent: code,
        });
        outputCode = generated.code;
        sourceMap = generated.map;
      } else {
        outputCode = generate(ast);
      }
    },
    // Unpacking modifies the same AST and may result in imports not at top level
    // so the code has to be generated before
    options.unpack &&
      (async () => {
        const userMappings = options.mappings(m);
        bundle = unpackAST(
          ast,
          userMappings,
          options.libraryMappings
            ? { libraryMappings: await createLibraryMappings(userMappings) }
            : undefined,
        );
      }),
    plugins.afterUnpack && (() => runPlugins(ast, plugins.afterUnpack!, state)),
    // Graphs don't use `loc`, so they run on the final AST after unpacking.
    options.graph &&
      (() => {
        if (bundle !== undefined) moduleGraphResult = moduleGraph(bundle);
        callGraphResult = callGraph(ast);
      }),
  ].filter(Boolean) as (() => unknown)[];

  const runStages = async () => {
    for (let i = 0; i < stages.length; i++) {
      await stages[i]();
      options.onProgress((100 / stages.length) * (i + 1));
    }
  };
  if (options.trace) {
    traceEntries = (await withTrace(runStages)).entries;
  } else {
    await runStages();
  }

  return {
    code: outputCode,
    bundle,
    report,
    moduleGraph: moduleGraphResult,
    callGraph: callGraphResult,
    map: sourceMap,
    trace: traceEntries,
    async save(path) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      path = normalize(path);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, 'deobfuscated.js'),
        sourceMap !== undefined
          ? `${outputCode}\n//# sourceMappingURL=deobfuscated.js.map\n`
          : outputCode,
        'utf8',
      );
      if (sourceMap !== undefined) {
        await writeFile(
          join(path, 'deobfuscated.js.map'),
          JSON.stringify(sourceMap),
          'utf8',
        );
      }
      if (traceEntries !== undefined) {
        await writeFile(
          join(path, 'trace.diff'),
          formatTrace(traceEntries),
          'utf8',
        );
      }
      await bundle?.save(path);
      if (report !== undefined) {
        await writeFile(
          join(path, 'report.json'),
          `${JSON.stringify(report, null, 2)}\n`,
          'utf8',
        );
      }
      if (moduleGraphResult !== undefined) {
        await writeFile(
          join(path, 'graph.modules.json'),
          toJSON(moduleGraphResult),
          'utf8',
        );
        await writeFile(
          join(path, 'graph.modules.dot'),
          toDot(moduleGraphResult, 'modules'),
          'utf8',
        );
      }
      if (callGraphResult !== undefined) {
        await writeFile(
          join(path, 'graph.calls.json'),
          toJSON(callGraphResult),
          'utf8',
        );
        await writeFile(
          join(path, 'graph.calls.dot'),
          toDot(callGraphResult, 'calls'),
          'utf8',
        );
      }
    },
  };
}

/**
 * Builds the `unpackAST` library-mappings hook from the known-library
 * signatures: modules whose structure matches a seeded library
 * (`matchModules`) are mapped to `node_modules/<path>` via `toMappings`.
 *
 * The detected mappings sit under the explicit user mappings: matches for
 * modules an explicit mapping already claims are dropped (so the user path
 * wins even when the user matcher only matches below the module root), and
 * at most one module is kept per path (a mapping matching several modules,
 * e.g. duplicated library copies, would make `applyMappings` throw
 * `Mapping <path> is already used`).
 */
async function createLibraryMappings(
  userMappings: Record<string, m.Matcher<unknown>>,
): Promise<(bundle: Bundle) => Record<string, m.Matcher<unknown>>> {
  // Imported lazily so the `node:crypto` dependency of lib-fingerprint stays
  // out of the browser bundle unless this option is used.
  const { matchModules, toMappings } =
    await import('./analysis/lib-fingerprint.js');
  const userPaths = Object.keys(userMappings);
  return (bundle) => {
    const userMatched = new Set<string>();
    if (userPaths.length > 0) {
      for (const module of bundle.modules.values()) {
        let claimed = false;
        traverse(module.ast, {
          enter(path) {
            for (const mappingPath of userPaths) {
              if (userMappings[mappingPath].match(path.node)) {
                claimed = true;
                path.stop();
                break;
              }
            }
          },
          noScope: true,
        });
        if (claimed) {
          userMatched.add(module.id);
        }
      }
    }
    const matches = matchModules(bundle).filter(
      (match) => !userMatched.has(match.moduleId),
    );
    const byPath = new Map<string, typeof matches>();
    for (const match of matches) {
      const list = byPath.get(match.path);
      if (list === undefined) {
        byPath.set(match.path, [match]);
      } else {
        list.push(match);
      }
    }
    const unique = [...byPath.values()]
      .filter((list) => list.length === 1)
      .map((list) => list[0]);
    return toMappings(unique);
  };
}

function formatTrace(entries: TraceEntry[]): string {
  const text = entries
    .map(
      (entry) => `### ${entry.name} (${entry.changes} changes)\n${entry.diff}`,
    )
    .join('\n');
  return text === '' ? text : `${text}\n`;
}
