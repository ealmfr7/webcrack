/**
 * Opt-in per-pass trace recorder.
 *
 * The tracer observes every transform applied through `applyTransform`,
 * `applyTransforms` and `applyTransformAsync` (see
 * `src/ast-utils/transform.ts`) and records one {@link TraceEntry} per call
 * with the transform name, the reported change count and a unified line diff
 * of the generated code before/after the transform ran.
 *
 * Tracing is disabled by default (`getTracer()` returns `null`) and the
 * transform pipeline only calls `generate()` when a tracer is active, so the
 * overhead when tracing is off is a single null check per applied transform.
 *
 * `applyTransforms` merges all visitors into a single traversal, so it
 * records a single entry per merged batch using the batch name
 * (`options.name`, or the comma-joined transform names by default) instead
 * of one entry per transform.
 *
 * The line diff ({@link diffLines}) is a small self-contained LCS diff with
 * a bounded fast path for very large inputs. No extra dependencies.
 *
 * Tracing is reentrant on Node.js: each `withTrace` scope runs in its own
 * `AsyncLocalStorage` context, so overlapping or nested async scopes each
 * collect only their own entries. Where `AsyncLocalStorage` is unavailable
 * (e.g. browsers) tracing falls back to a single module-global tracer: async
 * scopes may then observe each other's entries, and nested scopes behave as
 * before (the inner scope shadows the outer one until it finishes).
 */

import type { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks';

export interface TraceEntry {
  /** Transform name, or the merged-batch name for `applyTransforms`. */
  name: string;
  /** Value of `state.changes` after the transform ran. */
  changes: number;
  /**
   * Unified line diff (`@@ -a,b +c,d @@` hunks with ` `/`-`/`+` lines).
   * Empty string when the code did not change.
   */
  diff: string;
}

export type Tracer = (entry: TraceEntry) => void;

let activeTracer: Tracer | null = null;

type AsyncLocalStorageType = NodeAsyncLocalStorage<Tracer>;

let traceStorage: AsyncLocalStorageType | null | undefined;

/**
 * Return the `AsyncLocalStorage` instance used to scope tracers, or `null`
 * when it is unavailable (e.g. browsers).
 *
 * The builtin module is loaded through `process.getBuiltinModule` instead of
 * a static `node:async_hooks` import so browser bundles (which compile this
 * file from source) never see a Node-only import and build without warnings.
 */
function getTraceStorage(): AsyncLocalStorageType | null {
  if (traceStorage !== undefined) return traceStorage;
  traceStorage = null;
  try {
    const proc = (
      globalThis as {
        process?: {
          versions?: { node?: string };
          getBuiltinModule?: (id: string) => unknown;
        };
      }
    ).process;
    if (typeof proc?.getBuiltinModule !== 'function') return traceStorage;
    const mod = proc.getBuiltinModule('node:async_hooks') as {
      AsyncLocalStorage?: new () => AsyncLocalStorageType;
    };
    if (typeof mod?.AsyncLocalStorage === 'function') {
      traceStorage = new mod.AsyncLocalStorage();
    }
  } catch {
    traceStorage = null;
  }
  return traceStorage;
}

/**
 * Install a process-global tracer, or pass `null` to disable tracing.
 *
 * Inside a `withTrace` scope the scope's collector takes precedence over the
 * global tracer; `setTracer` only affects code running outside any scope.
 */
export function setTracer(tracer: Tracer | null): void {
  activeTracer = tracer;
}

/**
 * Return the currently active tracer, or `null` when tracing is off.
 *
 * Inside a `withTrace` scope (on platforms with `AsyncLocalStorage`) this is
 * the scope's collector; otherwise it is the global tracer from `setTracer`.
 */
export function getTracer(): Tracer | null {
  const store = getTraceStorage()?.getStore();
  if (store !== undefined) return store;
  return activeTracer;
}

export function withTrace<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; entries: TraceEntry[] }>;
export function withTrace<T>(fn: () => T): {
  result: T;
  entries: TraceEntry[];
};
export function withTrace<T>(
  fn: () => T | Promise<T>,
):
  | { result: T; entries: TraceEntry[] }
  | Promise<{ result: Awaited<T>; entries: TraceEntry[] }> {
  const entries: TraceEntry[] = [];
  const collector: Tracer = (entry) => {
    entries.push(entry);
  };
  // Reentrant path: the collector lives in an AsyncLocalStorage context, so
  // overlapping async scopes each see only their own tracer and no manual
  // save/restore (which the first scope to finish would clobber) is needed.
  const storage = getTraceStorage();
  if (storage !== null) {
    const result = storage.run(collector, fn);
    if (result instanceof Promise) {
      return (result as Promise<unknown>).then((value) => ({
        result: value as Awaited<T>,
        entries,
      }));
    }
    return { result, entries };
  }
  // Fallback for environments without AsyncLocalStorage (e.g. browsers):
  // a single module-global tracer, restored when the scope finishes.
  const previous = activeTracer;
  activeTracer = collector;
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    activeTracer = previous;
    throw error;
  }
  if (result instanceof Promise) {
    return (result as Promise<unknown>).then(
      (value) => {
        activeTracer = previous;
        return { result: value as Awaited<T>, entries };
      },
      (error: unknown) => {
        activeTracer = previous;
        throw error;
      },
    );
  }
  activeTracer = previous;
  return { result, entries };
}

const DIFF_CONTEXT = 3;
// Bounds the O(n*m) LCS table; larger inputs fall back to a plain
// delete-all/insert-all block for the differing middle.
const MAX_LCS_CELLS = 4_000_000;

interface DiffOp {
  kind: ' ' | '-' | '+';
  aIndex: number;
  bIndex: number;
  line: string;
}

/**
 * Compute a unified line diff between `before` and `after`.
 *
 * Returns `@@ -a,b +c,d @@` hunks with 3 lines of context, lines prefixed
 * with ` ` (context), `-` (removed) or `+` (added). Returns an empty string
 * when both inputs have identical lines.
 */
export function diffLines(before: string, after: string): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  let loA = 0;
  let loB = 0;
  while (loA < a.length && loB < b.length && a[loA] === b[loB]) {
    loA++;
    loB++;
  }
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > loA && hiB > loB && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  const ops: DiffOp[] = [];
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < loA; i++) {
    ops.push({ kind: ' ', aIndex: ai, bIndex: bi, line: a[i] });
    ai++;
    bi++;
  }
  for (const op of diffMiddle(a.slice(loA, hiA), b.slice(loB, hiB))) {
    ops.push({
      kind: op.kind,
      aIndex: ai + op.aIndex,
      bIndex: bi + op.bIndex,
      line: op.line,
    });
  }
  ai += hiA - loA;
  bi += hiB - loB;
  for (let i = hiA; i < a.length; i++) {
    ops.push({ kind: ' ', aIndex: ai, bIndex: bi, line: a[i] });
    ai++;
    bi++;
  }

  if (!ops.some((op) => op.kind !== ' ')) return '';

  const changeIndexes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== ' ') changeIndexes.push(index);
  });
  const windows: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT);
    const end = Math.min(ops.length, index + DIFF_CONTEXT + 1);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }

  let out = '';
  for (const [start, end] of windows) {
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((op) => op.kind !== '+').length;
    const bCount = hunk.filter((op) => op.kind !== '-').length;
    const aStart = aCount === 0 ? hunk[0].aIndex : hunk[0].aIndex + 1;
    const bStart = bCount === 0 ? hunk[0].bIndex : hunk[0].bIndex + 1;
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (const op of hunk) out += `${op.kind}${op.line}\n`;
  }
  return out;
}

function diffMiddle(
  a: string[],
  b: string[],
): Array<{
  kind: '-' | '+' | ' ';
  aIndex: number;
  bIndex: number;
  line: string;
}> {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return b.map((line, j) => ({
      kind: '+' as const,
      aIndex: 0,
      bIndex: j,
      line,
    }));
  }
  if (m === 0) {
    return a.map((line, i) => ({
      kind: '-' as const,
      aIndex: i,
      bIndex: 0,
      line,
    }));
  }
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...a.map((line, i) => ({
        kind: '-' as const,
        aIndex: i,
        bIndex: 0,
        line,
      })),
      ...b.map((line, j) => ({
        kind: '+' as const,
        aIndex: n,
        bIndex: j,
        line,
      })),
    ];
  }

  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * stride + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * stride + (j - 1)] + 1
          : Math.max(dp[(i - 1) * stride + j], dp[i * stride + (j - 1)]);
    }
  }

  const ops: Array<{
    kind: '-' | '+' | ' ';
    aIndex: number;
    bIndex: number;
    line: string;
  }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--;
      j--;
      ops.push({ kind: ' ', aIndex: i, bIndex: j, line: a[i] });
    } else if (
      i > 0 &&
      (j === 0 || dp[(i - 1) * stride + j] > dp[i * stride + (j - 1)])
    ) {
      i--;
      ops.push({ kind: '-', aIndex: i, bIndex: j, line: a[i] });
    } else {
      j--;
      ops.push({ kind: '+', aIndex: i, bIndex: j, line: b[j] });
    }
  }
  return ops.reverse();
}
