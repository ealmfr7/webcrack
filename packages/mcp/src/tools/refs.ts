import { z } from 'zod';
import { WcError } from '../format/errors';
import { paginate, textResult } from '../format/response';
import { resolveSymbol, symbolsByName } from '../format/target';
import { approximateSymbolMatches } from '../workspace/approximate';
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
    let def;
    try {
      def = resolveSymbol(ws, args.symbol, args.from as Location | undefined);
    } catch (error) {
      if (
        !(error instanceof WcError) ||
        !error.message.startsWith('Unknown symbol')
      )
        throw error;
      const matches = approximateSymbolMatches(ws, args.symbol);
      if (matches.length === 0) throw error;
      const body = [
        `Approximate matches for ${JSON.stringify(args.symbol)} (references are not resolved):`,
        ...matches.map((m) => `${m.module}:${m.line}  ${m.kind}  ${m.code}`),
      ].join('\n');
      return Promise.resolve(
        textResult(body, {
          budget: ctx.config.outputBudget,
          next: [`wc_read ${matches[0].module}:${matches[0].line}`],
        }),
      );
    }
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
 * Refs whose `defModule`/`defLine` point at the definition, so callers
 * through an export alias (`export { renamedFn as sign }`: importers
 * still call it `sign`, or `ns.sign`) keep resolving after a rename.
 *
 * A name check remains only to separate symbols declared on the same line
 * (`const a = 1, b = 2` share one `defLine`): a ref is accepted when its
 * last segment matches the def name, or when it is a cross-module ref
 * whose last segment is an export alias of the def (a self-reexport
 * `{ module: def.module, from: def.module, importedName: def.name }`).
 */
function findCallers(
  ws: Workspace,
  def: { module: string; line: number; name: string },
): CallerRow[] {
  const rows: CallerRow[] = [];
  for (const ref of ws.index.refs) {
    if (ref.defModule !== def.module || ref.defLine !== def.line) continue;
    if (
      ref.name !== def.name &&
      lastSegment(ref.name) !== def.name &&
      !isAliasRef(ws, ref, def)
    )
      continue;
    if (
      ref.kind === 'write' &&
      ref.module === def.module &&
      ref.line === def.line
    )
      continue;
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

/**
 * A cross-module ref reaching the def through an export alias: the def's
 * own module re-exports its local name under the ref's name
 * (`export { renamedFn as sign }`).
 */
function isAliasRef(
  ws: Workspace,
  ref: { module: string; name: string },
  def: { module: string; name: string },
): boolean {
  if (ref.module === def.module) return false;
  const segment = lastSegment(ref.name);
  return ws.index.reexports.some(
    (re) =>
      re.module === def.module &&
      re.from === def.module &&
      re.importedName === def.name &&
      re.name === segment,
  );
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
    // the callee (or its last segment) names a known symbol. A WcError
    // (globals like `fetch`, `*.x`) means unresolved; anything else is a
    // real bug and must propagate instead of masking as unresolved.
    if (byName.has(call.callee) || byName.has(lastSegment(call.callee))) {
      try {
        const target = resolveSymbol(
          ws,
          call.callee,
          `${call.module}:${call.line}`,
        );
        resolved = `${target.module}:${target.line}`;
      } catch (error) {
        if (!(error instanceof WcError)) throw error;
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
