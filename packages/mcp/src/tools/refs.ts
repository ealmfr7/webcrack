import { z } from 'zod';
import { paginate, textResult } from '../format/response';
import { resolveSymbol, symbolsByName } from '../format/target';
import type { Location, Workspace } from '../workspace/types';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const refs = defineTool({
  name: 'wc_refs',
  title: 'Find references',
  description:
    'Find where a symbol is used across modules. direction: callers (who calls/uses it), callees (what it calls), all. Returns module:line with one line of context.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('Name or module:name.'),
    direction: z.enum(['callers', 'callees', 'all']).default('callers'),
    from: z
      .string()
      .optional()
      .describe('module:line where the name is used, to resolve it exactly.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const def = resolveSymbol(
      ws,
      args.symbol,
      args.from as Location | undefined,
    );
    const qualified = `${def.module}:${def.name}`;
    const lines: string[] = [];
    const next: string[] = [];

    const showCallers =
      args.direction === 'callers' || args.direction === 'all';
    const showCallees =
      args.direction === 'callees' || args.direction === 'all';

    const callers = showCallers ? findCallers(ws, def) : [];
    const callees = showCallees ? findCallees(ws, def) : [];

    const callerCount = `${callers.length} caller${callers.length === 1 ? '' : 's'}`;
    const calleeCount = `${callees.length} callee${callees.length === 1 ? '' : 's'}`;
    const counts =
      args.direction === 'all'
        ? `${callerCount}, ${calleeCount}`
        : args.direction === 'callers'
          ? callerCount
          : calleeCount;
    lines.push(
      `\`${def.name}\` defined at ${def.module}:${def.line} (${def.kind}${def.exported ? ', exported' : ''}) — ${counts}`,
    );

    if (showCallers) {
      lines.push('');
      lines.push(...renderCallers(def, callers, args.limit, args.offset));
    }
    if (showCallees) {
      lines.push('');
      lines.push(...renderCallees(def, callees, args.limit, args.offset));
    }

    const first =
      callers.length > 0
        ? `${callers[0].module}:${callers[0].line}`
        : callees.length > 0
          ? `${callees[0].module}:${callees[0].line}`
          : undefined;
    if (first !== undefined) next.push(`wc_read ${first}`);
    next.push(`wc_graph kind=calls root=${qualified}`);

    return Promise.resolve(
      textResult(lines.join('\n'), {
        budget: ctx.config.outputBudget,
        next,
      }),
    );
  },
});

interface CallerRow {
  module: string;
  line: number;
  kind: string;
  caller?: string;
  context?: string;
}

interface CalleeRow {
  module: string;
  line: number;
  callee: string;
  resolved?: string;
}

/** Last dotted segment (`ns.sign` → `sign`, `*.json` → `json`). */
function lastSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Refs whose `defModule`/`defLine` point at the definition and whose name
 * matches it — either exactly or as a namespace member (`ns.sign` refers to
 * the exported `sign`, keeping the dotted name after linking).
 */
function findCallers(
  ws: Workspace,
  def: { module: string; line: number; name: string },
): CallerRow[] {
  const rows: CallerRow[] = [];
  for (const ref of ws.index.refs) {
    if (ref.defModule !== def.module || ref.defLine !== def.line) continue;
    if (lastSegment(ref.name) !== def.name) continue;
    const call = ws.index.calls.find(
      (c) => c.module === ref.module && c.line === ref.line,
    );
    rows.push({
      module: ref.module,
      line: ref.line,
      kind: ref.kind,
      caller: call?.caller,
      context: lineAt(ws, ref.module, ref.line),
    });
  }
  return rows;
}

/** Calls inside the definition's own body (`module`, `caller`, line range). */
function findCallees(
  ws: Workspace,
  def: { module: string; line: number; endLine: number; name: string },
): CalleeRow[] {
  const byName = symbolsByName(ws);
  const rows: CalleeRow[] = [];
  for (const call of ws.index.calls) {
    if (call.module !== def.module) continue;
    if (call.caller !== def.name) continue;
    if (call.line < def.line || call.line > def.endLine) continue;
    let resolved: string | undefined;
    // Pre-filter so big bundles are not O(calls×symbols): only resolve when
    // the callee (or its last segment) names a known symbol. Any WcError
    // (globals like `fetch`, `*.x`) means unresolved.
    if (byName.has(call.callee) || byName.has(lastSegment(call.callee))) {
      try {
        const target = resolveSymbol(
          ws,
          call.callee,
          `${call.module}:${call.line}`,
        );
        resolved = `${target.module}:${target.line}`;
      } catch {
        resolved = undefined;
      }
    }
    rows.push({
      module: call.module,
      line: call.line,
      callee: call.callee,
      resolved,
    });
  }
  return rows;
}

/** Trimmed 1-based line of a module's clean code, if present. */
function lineAt(
  ws: Workspace,
  module: string,
  line: number,
): string | undefined {
  const code = ws.modules.get(module)?.code.split('\n')[line - 1]?.trim();
  return code === undefined || code === '' ? undefined : code;
}

function renderCallers(
  def: { name: string },
  callers: CallerRow[],
  limit: number,
  offset: number,
): string[] {
  const out = [`Callers of \`${def.name}\` (${callers.length}):`];
  if (callers.length === 0) {
    out.push(
      `No recorded uses. It may be an entry point or reached dynamically — try direction=all or wc_search.`,
    );
    return out;
  }
  const page = paginate(callers, limit, offset);
  for (const row of page.items) {
    out.push(
      `${row.module}:${row.line}  ${row.kind}${row.caller !== undefined ? `  in ${row.caller}` : ''}`,
    );
    if (row.context !== undefined) out.push(fence(row.context));
  }
  if (page.footer !== undefined) out.push(page.footer);
  return out;
}

function renderCallees(
  def: { name: string },
  callees: CalleeRow[],
  limit: number,
  offset: number,
): string[] {
  const out = [`Callees of \`${def.name}\` (${callees.length}):`];
  if (callees.length === 0) {
    out.push(`No recorded calls in its body.`);
    return out;
  }
  const page = paginate(callees, limit, offset);
  for (const row of page.items) {
    out.push(
      `${row.module}:${row.line}  ${row.callee}${row.resolved !== undefined ? ` → ${row.resolved}` : ' (unresolved)'}`,
    );
  }
  if (page.footer !== undefined) out.push(page.footer);
  return out;
}

/** Bundle code is untrusted data: always quote it inside a fenced block. */
function fence(code: string): string {
  return `\`\`\`js\n${code}\n\`\`\``;
}
