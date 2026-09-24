import { parse } from '@babel/parser';
import { z } from 'zod';
import { createNodeSandbox } from 'webcrack/analysis';
import { WcError } from '../format/errors';
import { textResult } from '../format/response';
import { resolveTarget } from '../format/target';
import { evaluateInModule } from '../workspace/sandbox';
import type { ModuleEntry, Workspace } from '../workspace/types';
import { defineTool, workspaceArg } from './define';

const PASS_NAMES = [
  'deobfuscate',
  'unminify',
  'jsx',
  'mangle',
  'renameHeuristics',
] as const;

/** Used when `passes` is omitted. */
const DEFAULT_PASSES: readonly string[] = ['deobfuscate', 'unminify'];

/** Like the `withTimeout` in `store.ts`: webcrack is not cancellable, so the
 * timeout only stops waiting for it. */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new WcError(
          `Deobfuscation timed out after ${ms} ms. Retry with a smaller range, fewer passes, or raise WEBCRACK_MCP_TIMEOUT_MS.`,
        ),
      );
    }, ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface Slice {
  entry: ModuleEntry;
  /** 1-based inclusive start line in the module's clean code. */
  start: number;
  /** 1-based inclusive end line in the module's clean code. */
  end: number;
}

/**
 * Widen a line range to the enclosing complete top-level statements, so the
 * slice parses on its own.
 */
function widenToStatements(
  entry: ModuleEntry,
  target: string,
  start: number,
  end: number,
): Slice {
  const ast = parse(entry.code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ['jsx'],
  });
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const statement of ast.program.body) {
    const loc = statement.loc;
    if (loc === null || loc === undefined) continue;
    if (loc.start.line <= end && loc.end.line >= start) {
      from = Math.min(from, loc.start.line);
      to = Math.max(to, loc.end.line);
    }
  }
  if (from === Number.POSITIVE_INFINITY) {
    throw new WcError(
      `Target "${target}" covers no complete statement: range must cover whole statements; use module:symbol (e.g. "${entry.path}:1-3" must include every statement it touches).`,
    );
  }
  return { entry, start: from, end: to };
}

function extractSlice(ws: Workspace, target: string): Slice {
  const resolved = resolveTarget(ws, target);
  const entry = ws.modules.get(resolved.module);
  if (!entry) {
    throw new WcError(
      `Unknown module "${resolved.module}". Call wc_map to list modules.`,
    );
  }
  if (resolved.start === undefined || resolved.end === undefined) {
    const count = entry.code.split('\n').length;
    return { entry, start: 1, end: count };
  }
  if (resolved.symbol) {
    return { entry, start: resolved.start, end: resolved.end };
  }
  return widenToStatements(entry, target, resolved.start, resolved.end);
}

/** The slice must parse on its own, or webcrack would read half a statement. */
function assertSliceParses(
  slice: string,
  target: string,
  sliceRef: string,
): void {
  try {
    parse(slice, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      plugins: ['jsx'],
    });
  } catch {
    throw new WcError(
      `Target "${target}" (${sliceRef}) does not parse on its own: range must cover whole statements; use module:symbol.`,
    );
  }
}

type DiffOp = { type: 'equal' | 'del' | 'ins'; line: string };

/**
 * Line diff via LCS. Quadratic, so huge inputs fall back to a single
 * whole-slice replacement hunk instead of a giant DP table.
 */
function diffLines(before: string[], after: string[]): DiffOp[] {
  if (before.length * after.length > 1_000_000) {
    return [
      ...before.map((line): DiffOp => ({ type: 'del', line })),
      ...after.map((line): DiffOp => ({ type: 'ins', line })),
    ];
  }
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        before[i] === after[j]
          ? (dp[i + 1][j + 1] ?? 0) + 1
          : Math.max(dp[i + 1][j] ?? 0, dp[i][j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', line: before[i] ?? '' });
      i++;
      j++;
    } else if ((dp[i + 1][j] ?? 0) >= (dp[i][j + 1] ?? 0)) {
      ops.push({ type: 'del', line: before[i] ?? '' });
      i++;
    } else {
      ops.push({ type: 'ins', line: after[j] ?? '' });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: before[i] ?? '' });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'ins', line: after[j] ?? '' });
    j++;
  }
  return ops;
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Compact unified diff: only changed hunks, 2 lines of context each. */
function unifiedDiff(before: string[], after: string[]): string[] {
  const ops = diffLines(before, after);
  if (ops.every((op) => op.type === 'equal')) return [];
  const changed = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    if ((ops[i]?.type ?? 'equal') !== 'equal') {
      for (
        let k = Math.max(0, i - 2);
        k <= Math.min(ops.length - 1, i + 2);
        k++
      ) {
        changed.add(k);
      }
    }
  }
  const indices = [...changed].sort((a, b) => a - b);
  const out: string[] = [];
  let group: number[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    let beforeLine = 1;
    let afterLine = 1;
    const first = group[0] ?? 0;
    for (let i = 0; i < first; i++) {
      const op = ops[i];
      if (op?.type !== 'ins') beforeLine++;
      if (op?.type !== 'del') afterLine++;
    }
    let beforeCount = 0;
    let afterCount = 0;
    for (const index of group) {
      const op = ops[index];
      if (op?.type !== 'ins') beforeCount++;
      if (op?.type !== 'del') afterCount++;
    }
    out.push(
      `@@ -${hunkRange(beforeLine, beforeCount)} +${hunkRange(afterLine, afterCount)} @@`,
    );
    for (const index of group) {
      const op = ops[index];
      if (op === undefined) continue;
      out.push(
        op.type === 'equal'
          ? ` ${op.line}`
          : op.type === 'del'
            ? `-${op.line}`
            : `+${op.line}`,
      );
    }
    group = [];
  };
  for (const index of indices) {
    const last = group[group.length - 1];
    if (group.length > 0 && last !== undefined && index > last + 1) flush();
    group.push(index);
  }
  flush();
  return out;
}

export const deobfuscate = defineTool({
  name: 'wc_deobfuscate',
  title: 'Deobfuscate region',
  description:
    'Run webcrack deobfuscation passes on a module, line range or symbol and show a before/after diff (apply=true saves it into the workspace). Only the slice is in context: string-array decoders defined outside it are not applied — pass `expression` to evaluate a decoder call (e.g. `_0x1a2b(0x1a3)`) against a module in the sandbox instead.',
  inputSchema: {
    workspace: workspaceArg,
    target: z
      .string()
      .optional()
      .describe('module, module:start-end or module:symbol.'),
    passes: z
      .array(z.enum(PASS_NAMES))
      .optional()
      .describe(
        'Passes to run; defaults to deobfuscate+unminify. Each listed pass runs, the rest are off.',
      ),
    expression: z
      .string()
      .optional()
      .describe(
        'JS expression to evaluate in the sandbox (target module in scope).',
      ),
    apply: z.boolean().default(false),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    if (args.expression !== undefined) {
      const ws = ctx.store.get(args.workspace);
      // The whole module is preloaded (not a slice): decoders are often
      // defined far from the call site. Without a target, empty code.
      let code = '';
      let moduleLabel = '(no module)';
      if (args.target !== undefined) {
        const resolved = resolveTarget(ws, args.target);
        const entry = ws.modules.get(resolved.module);
        if (!entry) {
          throw new WcError(
            `Unknown module "${resolved.module}". Call wc_map to list modules.`,
          );
        }
        code = entry.code;
        moduleLabel = entry.path;
      }
      // Sandbox errors (rejected injection, timeout, missing isolated-vm)
      // already come back as WcError: pass them through.
      const result = await evaluateInModule(code, args.expression, {
        timeoutMs: Math.min(ctx.config.timeoutMs, 5000),
        memoryLimitMb: 128,
      });
      const body =
        `expression in ${moduleLabel} (sandbox)\n` +
        `\`\`\`\n${result}\n\`\`\``;
      // Without a target there is no module to point at, so omit the Next
      // hints rather than emitting an invalid `wc_read (no module)`.
      const next =
        args.target !== undefined
          ? [`wc_read ${moduleLabel}`, `wc_annotate ${moduleLabel}:<name>`]
          : undefined;
      return textResult(body, { budget: ctx.config.outputBudget, next });
    }
    if (args.target === undefined) {
      throw new WcError(
        'Pass a target: a module ("src/api.js"), a range ("src/api.js:100-160") or a symbol ("src/api.js:login").',
      );
    }
    const target = args.target;
    const ws = ctx.store.get(args.workspace);
    const { entry, start, end } = extractSlice(ws, target);
    const moduleLines = entry.code.split('\n');
    const slice = moduleLines.slice(start - 1, end).join('\n');
    if (start !== 1 || end !== moduleLines.length) {
      assertSliceParses(slice, target, `${entry.path}:${start}-${end}`);
    }

    const effective: readonly string[] = args.passes ?? DEFAULT_PASSES;
    const selected = new Set(effective);
    const startedAt = Date.now();
    const result = await withTimeout(
      ctx.store.deps.webcrack(slice, {
        unpack: false,
        deobfuscate: selected.has('deobfuscate'),
        unminify: selected.has('unminify'),
        jsx: selected.has('jsx'),
        mangle: selected.has('mangle'),
        renameHeuristics: selected.has('renameHeuristics'),
        sandbox: createNodeSandbox({
          timeout: Math.min(ctx.config.timeoutMs, 10_000),
          memoryLimit: 128,
        }),
      }),
      ctx.config.timeoutMs,
    );
    const ms = Date.now() - startedAt;
    const cleanLines = result.code.split('\n');
    if (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === '') {
      cleanLines.pop();
    }
    const beforeLines = slice.split('\n');

    const header = `wc_deobfuscate ${target} · passes: ${effective.join(', ')} · ${ms} ms`;
    const hunks = unifiedDiff(beforeLines, cleanLines);
    let body =
      hunks.length > 0
        ? `${header}\n\`\`\`diff\n${hunks.join('\n')}\n\`\`\``
        : `${header}\nNo changes: the passes left the code unchanged.`;

    if (args.apply === true) {
      entry.code = [
        ...moduleLines.slice(0, start - 1),
        ...cleanLines,
        ...moduleLines.slice(end),
      ].join('\n');
      await ctx.store.commit(ws, [entry.path]);
      body += '\napplied; reindexed; cache updated';
    }

    const next =
      args.apply === true
        ? [`wc_read ${entry.path}`]
        : [`wc_deobfuscate ${target} apply=true`];
    return textResult(body, { budget: ctx.config.outputBudget, next });
  },
});
