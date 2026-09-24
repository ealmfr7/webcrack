import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { webcrack } from 'webcrack';
import type { Options as WebcrackOptions } from 'webcrack';
import { detectInterpreters, extractReport } from 'webcrack/analysis';
import type { InterpreterInfo, Report } from 'webcrack/analysis';
import type { Config } from '../config';
import { WcError } from '../format/errors';
import {
  listCachedWorkspaces,
  readWorkspaceFromCache,
  writeWorkspaceChangesToCache,
  writeWorkspaceToCache,
} from './cache';
import { collectModuleAstFindings, precomputeModuleFindings } from './findings';
import { buildIndex, INDEX_VERSION, indexModule, linkIndex } from './indexer';
import { loadSource } from './loader';
import { tagModule } from './tags';
import { detectTechniques } from './techniques';
import type {
  CachedSummary,
  InterpreterSummary,
  ModuleEntry,
  ModuleIndex,
  OpenOptions,
  Workspace,
  WorkspaceIndex,
} from './types';
import { parseClean } from './parse';

/**
 * Per-module index slices keyed by workspace, backing incremental `commit`.
 * Never serialized: it only mirrors `ws.index` for workspaces built with
 * the real indexer in this process. Workspaces from the disk cache (or
 * built with an injected `deps.buildIndex`, as in tests) have no entry and
 * fall back to a full rebuild on the next commit.
 */
const indexParts = new WeakMap<Workspace, Map<string, ModuleIndex>>();

/** True when the store uses the real indexer, so parts can be kept. */
function usesRealIndex(deps: StoreDeps): boolean {
  return deps.buildIndex === buildIndex;
}

/** Index every module from scratch and return the parts plus the link. */
function fullReindex(modules: Map<string, ModuleEntry>): {
  parts: Map<string, ModuleIndex>;
  index: WorkspaceIndex;
} {
  const paths = [...modules.keys()];
  const parts = new Map<string, ModuleIndex>();
  for (const [path, entry] of modules) {
    parts.set(path, indexModule(entry, paths));
  }
  return { parts, index: linkIndex(parts) };
}

/**
 * Injectable processors, so tests can spy without `vi.mock` and keep
 * passing while `loader`/`indexer`/`tags` are still stubs on other branches.
 */
export interface StoreDeps {
  webcrack: typeof webcrack;
  loadSource: typeof loadSource;
  buildIndex: typeof buildIndex;
  tagModule: typeof tagModule;
  /**
   * Optional so fakes built before this task (which only stub
   * webcrack/loadSource/buildIndex/tagModule) keep working: they fall back
   * to the real detector at the call site.
   */
  detectTechniques?: typeof detectTechniques;
}

export type ProgressFn = (fraction: number, message?: string) => Promise<void>;

/** webcrack release baked into the workspace id, read off its package.json. */
function resolveWebcrackVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('webcrack'));
    for (let depth = 0; depth < 6; depth++) {
      try {
        const data: unknown = JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf8'),
        );
        if (
          typeof data === 'object' &&
          data !== null &&
          (data as { name?: unknown }).name === 'webcrack' &&
          typeof (data as { version?: unknown }).version === 'string'
        ) {
          return (data as { version: string }).version;
        }
      } catch {
        // Not a readable package.json here; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable (e.g. dist not built); fall through to 'unknown'.
  }
  return 'unknown';
}

const WEBCRACK_VERSION = resolveWebcrackVersion();

/**
 * When the unpacked modules hold less than this share of webcrack's output
 * code, the bundle was a small part of the input and the host code is kept
 * as an extra module (`bundle-host.js`) instead of being dropped.
 */
const HOST_CODE_MIN_COVERAGE = 0.5;

function computeId(
  code: string,
  options: Omit<OpenOptions, 'refresh'>,
  version: string,
): string {
  return createHash('sha256')
    .update(code, 'utf8')
    .update(JSON.stringify(options), 'utf8')
    .update(version, 'utf8')
    .update(`index:${INDEX_VERSION}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

/** Drop `undefined` values so webcrack's own defaults still apply. */
function toWebcrackOptions(
  options: Omit<OpenOptions, 'refresh'>,
): WebcrackOptions {
  const out: WebcrackOptions = {};
  if (options.unpack !== undefined) out.unpack = options.unpack;
  if (options.deobfuscate !== undefined) out.deobfuscate = options.deobfuscate;
  if (options.unminify !== undefined) out.unminify = options.unminify;
  if (options.jsx !== undefined) out.jsx = options.jsx;
  if (options.mangle !== undefined) out.mangle = options.mangle;
  if (options.renameHeuristics !== undefined) {
    out.renameHeuristics = options.renameHeuristics;
  }
  return out;
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new WcError(
          `Opening timed out after ${ms} ms. Retry with a smaller input, pass deobfuscate: false, or raise WEBCRACK_MCP_TIMEOUT_MS.`,
        ),
      );
    }, ms);
  });
  // Note: webcrack itself is not cancellable; the timeout only stops waiting
  // for it. The underlying run keeps going in the background.
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function bindingName(binding: InterpreterInfo['pc']): string | undefined {
  const identifier = binding?.identifier;
  return identifier?.type === 'Identifier' ? identifier.name : undefined;
}

function toInterpreterSummary(
  module: string,
  info: InterpreterInfo,
): InterpreterSummary {
  const startLine = info.loop.node.loc?.start.line ?? 1;
  const summary: InterpreterSummary = {
    module,
    line: startLine,
    endLine: info.loop.node.loc?.end.line ?? startLine,
    dispatchKind: info.dispatchKind,
    handlerCount: info.handlers.length,
  };
  const pc = bindingName(info.pc);
  const bytecode = bindingName(info.bytecode);
  const stack = bindingName(info.stack);
  if (pc !== undefined) summary.pc = pc;
  if (bytecode !== undefined) summary.bytecode = bytecode;
  if (stack !== undefined) summary.stack = stack;
  return summary;
}

/**
 * Project the workspace index back down to one module's slice, for
 * `tagModule`. Refs stay as the linker left them; tags only read
 * calls/strings, so the slice is sufficient.
 */
function sliceIndex(index: WorkspaceIndex, modulePath: string): ModuleIndex {
  return {
    symbols: index.symbols.filter((entry) => entry.module === modulePath),
    calls: index.calls.filter((entry) => entry.module === modulePath),
    strings: index.strings.filter((entry) => entry.module === modulePath),
    refs: index.refs.filter((entry) => entry.module === modulePath),
    imports: index.imports[modulePath] ?? [],
    reexports: index.reexports
      .filter((entry) => entry.module === modulePath)
      .map((entry) => ({
        name: entry.name,
        importedName: entry.importedName,
        from: entry.from,
      })),
  };
}

/**
 * Parse one module's clean code into its report and interpreter summaries
 * (shared by `open` and `commit`).
 */
function analyzeModule(
  modulePath: string,
  code: string,
): { report: Report; interpreters: InterpreterSummary[] } {
  const ast = parseClean(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ['jsx'],
  });
  return {
    report: extractReport(ast),
    interpreters: detectInterpreters(ast).map((info) =>
      toInterpreterSummary(modulePath, info),
    ),
  };
}

/**
 * Tag one module from the workspace index slice (shared by `open` and
 * `commit`). `tags.ts` does not detect VM interpreters, so 'vm' is added
 * here when the module has one.
 */
function retagModule(
  module: ModuleEntry,
  index: WorkspaceIndex,
  interpreters: InterpreterSummary[],
  tagModule: StoreDeps['tagModule'],
): void {
  const tags = tagModule(module, sliceIndex(index, module.path));
  const hasVm = interpreters.some((info) => info.module === module.path);
  module.tags = hasVm && !tags.includes('vm') ? [...tags, 'vm'] : tags;
}

/**
 * A webcrack failure that looks like a syntax error is almost always a wrong
 * input, not a webcrack bug: surface it as an actionable `WcError` (with the
 * parser's location) instead of an "Internal error". Anything else —
 * including the timeout `WcError` — passes through untouched.
 */
export function toActionableOpenError(error: unknown): unknown {
  if (error instanceof WcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const looksLikeParseError =
    code === 'BABEL_PARSER_SYNTAX_ERROR' ||
    /unexpected token|unterminated|missing (semicolon|parenthesis)|unknown: /i.test(
      message,
    );
  if (!looksLikeParseError) return error;
  return new WcError(
    `Could not parse the input as JavaScript: ${message}. ` +
      `Check that the source is JavaScript; if it was meant as a file path or URL, ` +
      `check that it exists and is readable; or retry with options { "deobfuscate": false }.`,
  );
}

/**
 * Open workspaces, kept in memory. The disk cache (ROADMAP_MCP §3.3, M1.2)
 * plugs in here: `open` reuses it, `listCached` enumerates it.
 */
export class WorkspaceStore {
  #workspaces = new Map<string, Workspace>();
  #current: string | undefined;

  constructor(
    readonly config: Config,
    readonly deps: StoreDeps = {
      webcrack,
      loadSource,
      buildIndex,
      tagModule,
      detectTechniques,
    },
  ) {}

  add(workspace: Workspace): void {
    this.#workspaces.set(workspace.id, workspace);
    this.#current = workspace.id;
  }

  /** The workspace with `id`, or the most recently opened one. */
  get(id?: string): Workspace {
    const key = id ?? this.#current;
    if (key === undefined) {
      throw new WcError(
        'No workspace is open. Call wc_open with a file path, URL or code first.',
      );
    }
    const workspace = this.#workspaces.get(key);
    if (!workspace) {
      throw new WcError(
        `Unknown workspace "${key}". Call wc_workspaces to list them.`,
        [...this.#workspaces.keys()],
      );
    }
    return workspace;
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()];
  }

  /**
   * Full `wc_open` pipeline (M1.2): load the source, run it through the
   * injectable `webcrack` processor, index the clean modules, persist to
   * the disk cache, and register the workspace. `cached` is true when the
   * workspace came from the cache without reprocessing.
   */
  async open(
    source: string,
    options: OpenOptions,
    progress: ProgressFn,
  ): Promise<{ workspace: Workspace; cached: boolean }> {
    const startedAt = Date.now();
    await progress(0.05, 'loading source');
    const loaded = await this.deps.loadSource(source, this.config);

    const { refresh, ...webcrackFlags } = options;
    const id = computeId(loaded.code, webcrackFlags, WEBCRACK_VERSION);
    await progress(0.1, 'checking cache');

    if (!refresh) {
      const hit = await readWorkspaceFromCache(this.config, id);
      if (hit !== undefined) {
        this.add(hit);
        await progress(1, `workspace ${id} loaded from cache`);
        return { workspace: hit, cached: true };
      }
    }

    let result: Awaited<ReturnType<StoreDeps['webcrack']>>;
    try {
      result = await withTimeout(
        this.deps.webcrack(loaded.code, toWebcrackOptions(webcrackFlags)),
        this.config.timeoutMs,
      );
    } catch (error) {
      throw toActionableOpenError(error);
    }
    await progress(0.5, 'deobfuscated');

    const modules = new Map<string, ModuleEntry>();
    let bundle: Workspace['bundle'];
    if (result.bundle !== undefined) {
      for (const module of result.bundle.modules.values()) {
        const path = module.path.startsWith('./')
          ? module.path.slice(2)
          : module.path;
        modules.set(path, {
          path,
          bundleId: module.id,
          isEntry: module.isEntry,
          code: module.code,
          tags: [],
        });
      }
      bundle = { type: result.bundle.type, entryId: result.bundle.entryId };
      // Never lose code: a small bundle embedded in a large script (a worker
      // runtime inside a 9 MB app chunk, or a runtime with no modules) is
      // detected as "the" bundle, and its modules cover only a sliver of
      // the input. Keep the rest as a module of its own.
      let moduleChars = 0;
      for (const module of modules.values()) moduleChars += module.code.length;
      if (moduleChars < result.code.length * HOST_CODE_MIN_COVERAGE) {
        let hostPath = 'bundle-host.js';
        for (let n = 2; modules.has(hostPath); n++) {
          hostPath = `bundle-host-${n}.js`;
        }
        modules.set(hostPath, {
          path: hostPath,
          bundleId: hostPath,
          isEntry: modules.size === 0,
          code: result.code,
          tags: [],
        });
      }
    } else {
      modules.set('main.js', {
        path: 'main.js',
        bundleId: '0',
        isEntry: true,
        code: result.code,
        tags: [],
      });
    }
    await progress(0.6, 'modules extracted');

    const report: Workspace['report'] = {};
    const interpreters: InterpreterSummary[] = [];
    for (const module of modules.values()) {
      const analyzed = analyzeModule(module.path, module.code);
      report[module.path] = analyzed.report;
      interpreters.push(...analyzed.interpreters);
    }
    await progress(0.7, 'reports extracted');

    // With the real indexer, build via indexModule + linkIndex (exactly
    // what buildIndex does) and keep the per-module parts for commit.
    // With an injected buildIndex (tests), just call it and keep no parts.
    let index: WorkspaceIndex;
    let parts: Map<string, ModuleIndex> | undefined;
    if (usesRealIndex(this.deps)) {
      const rebuilt = fullReindex(modules);
      parts = rebuilt.parts;
      index = rebuilt.index;
    } else {
      index = this.deps.buildIndex(modules);
    }
    await progress(0.8, 'index built');

    for (const module of modules.values()) {
      retagModule(module, index, interpreters, this.deps.tagModule);
    }
    await progress(0.85, 'modules tagged');

    const detect = this.deps.detectTechniques ?? detectTechniques;
    const techniques = detect(
      loaded.code,
      [...modules.values()].map((module) => module.code),
      interpreters,
      { deobfuscated: options.deobfuscate !== false },
    );

    const workspace: Workspace = {
      id,
      source: { kind: loaded.kind, label: loaded.label, bytes: loaded.bytes },
      original: loaded.code,
      ...(bundle === undefined ? {} : { bundle }),
      modules,
      index,
      report,
      interpreters,
      annotations: [],
      stats: { openMs: Date.now() - startedAt, techniques },
      findings: precomputeModuleFindings(modules.values(), { cache: false }),
    };
    await progress(0.92, 'writing cache');
    await writeWorkspaceToCache(this.config, workspace, WEBCRACK_VERSION);
    if (parts !== undefined) indexParts.set(workspace, parts);
    this.add(workspace);
    await progress(1, `workspace ${id} ready`);
    return { workspace, cached: false };
  }

  /**
   * Persist a mutation (M2.3, shared by every mutating tool): refresh the
   * derived data for `changedPaths`, reindex, and write the changes back to
   * the disk cache. Call it after editing `ws.modules` code or
   * `ws.annotations` in place; with `[]` (e.g. a note-only annotation) it
   * just persists the annotations without touching any module file.
   *
   * Reindexing is incremental when the workspace was built with the real
   * indexer in this process: only `changedPaths` are re-parsed, then the
   * kept per-module parts are relinked. Without kept parts (a workspace
   * from the disk cache, or an injected `deps.buildIndex` as in tests) it
   * falls back to a full rebuild, seeding the parts for the next commit.
   *
   * On a cache load nothing is reapplied: `readWorkspaceFromCache` already
   * reads the renamed `modules/<path>` code and `annotations.json`, so the
   * workspace comes back exactly as committed.
   */
  async commit(ws: Workspace, changedPaths: string[]): Promise<void> {
    const changed = [...new Set(changedPaths)];
    for (const path of changed) {
      const module = ws.modules.get(path);
      if (!module) {
        // A removed module leaves no findings behind either.
        if (ws.findings !== undefined) delete ws.findings[path];
        continue;
      }
      const analyzed = analyzeModule(path, module.code);
      ws.report[path] = analyzed.report;
      ws.interpreters = [
        ...ws.interpreters.filter((info) => info.module !== path),
        ...analyzed.interpreters,
      ];
      // Refresh only the changed modules' precomputed findings; the rest of
      // `ws.findings` is still valid. Workspaces without it (old caches)
      // keep falling back to on-demand parsing.
      if (ws.findings !== undefined) {
        ws.findings[path] = collectModuleAstFindings(module, { cache: false });
      }
    }
    if (usesRealIndex(this.deps)) {
      let parts = indexParts.get(ws);
      if (parts === undefined) {
        const rebuilt = fullReindex(ws.modules);
        parts = rebuilt.parts;
        ws.index = rebuilt.index;
        indexParts.set(ws, parts);
      } else {
        // Drop parts for removed modules, then re-parse only the modules
        // that changed (plus any module missing a part, e.g. added without
        // being listed in `changedPaths`), and relink over all parts.
        for (const path of [...parts.keys()]) {
          if (!ws.modules.has(path)) parts.delete(path);
        }
        const paths = [...ws.modules.keys()];
        const toReindex = new Set<string>();
        for (const path of changed) {
          if (ws.modules.has(path)) toReindex.add(path);
        }
        for (const path of paths) {
          if (!parts.has(path)) toReindex.add(path);
        }
        for (const path of toReindex) {
          const module = ws.modules.get(path);
          if (module !== undefined) parts.set(path, indexModule(module, paths));
        }
        ws.index = linkIndex(parts);
      }
    } else {
      ws.index = this.deps.buildIndex(ws.modules);
    }
    for (const path of changed) {
      const module = ws.modules.get(path);
      if (!module) continue;
      retagModule(module, ws.index, ws.interpreters, this.deps.tagModule);
    }
    await writeWorkspaceChangesToCache(
      this.config,
      ws,
      changed,
      WEBCRACK_VERSION,
    );
  }

  /** One-line summaries of every disk-cached workspace (M1.2). */
  listCached(): Promise<CachedSummary[]> {
    return listCachedWorkspaces(this.config);
  }
}
