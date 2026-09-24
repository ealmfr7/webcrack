import vm from 'node:vm';
import { z } from 'zod';
import { WcError } from '../format/errors';
import { paginate, textResult } from '../format/response';
import { matchModules } from '../format/target';
import { defineTool, pagination, readOnly, workspaceArg } from './define';
import { searchAst } from '../workspace/search-ast';
import type { ModuleEntry, SearchHit, Workspace } from '../workspace/types';

/** Lines are cut to this many chars before regex matching. */
const REGEX_LINE_CUT = 2000;
/** Regex scan stops after this many hits. */
const REGEX_HIT_CAP = 1000;
/** Graceful regex time budget (checked between lines, inside the sandbox). */
const REGEX_TIME_BUDGET_MS = 2000;
/** Hard backstop: also interrupts a single hanging RegExp.exec. */
const REGEX_VM_TIMEOUT_MS = 2500;
/** Context snippets are cut to this many chars around the match. */
const SNIPPET_LEN = 200;

interface Hit {
  module: string;
  line: number;
  snippet: string;
  extra?: string;
}

export const search = defineTool({
  name: 'wc_search',
  title: 'Search code',
  description:
    'Search the clean code. kind: text (substring), regex, string (string literals only), identifier (bindings by name), call (call sites, e.g. "fetch", "axios.post", "*.postMessage"), ast (structural pattern with $X / $$ARGS wildcards, e.g. `fetch($URL, { method: "POST", $$REST })`). Returns module:line hits with one line of context.',
  inputSchema: {
    workspace: workspaceArg,
    query: z.string(),
    kind: z
      .enum(['text', 'regex', 'string', 'identifier', 'call', 'ast'])
      .default('text'),
    module: z.string().optional().describe('Limit to one module or folder.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    if (args.query.trim() === '') {
      throw new WcError(
        'Empty query. Pass text, a /regex/, a string value, an identifier or a call pattern like "fetch".',
      );
    }
    const budget = ctx.config.outputBudget;
    if (args.kind === 'ast') {
      // M2.5 owns the implementation; the stub throws notImplemented('M2.5').
      const found = searchAst(ws, args.query, args.module);
      return Promise.resolve(
        renderHits(args.query, args.kind, toHits(found), args, budget),
      );
    }
    const modules = matchModules(ws, args.module);
    const linesByModule = new Map<string, string[]>(
      modules.map((m) => [m.path, m.code.split('\n')]),
    );
    const outcome = collectHits(ws, modules, linesByModule, args);
    return Promise.resolve(
      renderHits(
        args.query,
        args.kind,
        outcome.hits,
        args,
        budget,
        modules.length,
        outcome.note,
      ),
    );
  },
});

interface SearchArgs {
  query: string;
  kind: 'text' | 'regex' | 'string' | 'identifier' | 'call' | 'ast';
  module?: string;
  limit: number;
  offset: number;
}

function collectHits(
  ws: Workspace,
  modules: ModuleEntry[],
  linesByModule: Map<string, string[]>,
  args: SearchArgs,
): { hits: Hit[]; note?: string } {
  switch (args.kind) {
    case 'text':
      return { hits: textHits(modules, args.query) };
    case 'regex':
      return regexHits(modules, args.query);
    case 'string':
      return { hits: stringHits(ws, modules, linesByModule, args.query) };
    case 'identifier':
      return { hits: identifierHits(ws, modules, linesByModule, args.query) };
    case 'call':
      return { hits: callHits(ws, linesByModule, args.query) };
    case 'ast':
      return { hits: [] };
  }
}

function codeLine(
  linesByModule: Map<string, string[]>,
  module: string,
  line: number,
): string {
  return linesByModule.get(module)?.[line - 1] ?? '';
}

/**
 * searchAst hits already carry the matched node's first source line
 * (trimmed, cut to 200 chars), so it is used as the snippet directly. That
 * also surfaces searchAst's in-band `Search truncated: …` notice verbatim
 * instead of replacing it with an unrelated code line.
 */
function toHits(found: SearchHit[]): Hit[] {
  return found.map((hit) => ({
    module: hit.module,
    line: hit.line,
    snippet: hit.text,
  }));
}

// -- text --------------------------------------------------------------------

function textHits(modules: ModuleEntry[], query: string): Hit[] {
  const needle = query.toLowerCase();
  const hits: Hit[] = [];
  for (const mod of modules) {
    const lines = mod.code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const index = lines[i].toLowerCase().indexOf(needle);
      if (index >= 0) {
        hits.push({
          module: mod.path,
          line: i + 1,
          snippet: snippet(lines[i], index),
        });
      }
    }
  }
  return hits;
}

// -- regex -------------------------------------------------------------------

const SLASH_FORM = /^\/([\s\S]*)\/([a-z]*)$/;

/**
 * Compile the query: `/pattern/flags` when it has the slash form, otherwise
 * the raw pattern. Strips `g`/`y` so repeated exec/test calls stay stateless.
 */
function compileRegex(query: string): RegExp {
  const slash = SLASH_FORM.exec(query);
  const source = slash ? slash[1] : query;
  const flags = (slash ? slash[2] : '').replace(/[gy]/g, '');
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WcError(
      `Invalid regex ${JSON.stringify(query)}: ${message}. Fix the pattern or use kind="text" for a literal search.`,
    );
  }
}

interface VmLine {
  m: number;
  line: number;
  text: string;
  /** Match offset within the line; set by the sandbox on hits. */
  index?: number;
}

/**
 * Match line by line inside a `vm` sandbox with a dual guard: a `Date.now()`
 * deadline checked between lines (graceful stop) plus a `vm` timeout that
 * also interrupts a single hanging `RegExp.exec` (V8 cannot interrupt
 * catastrophic backtracking synchronously; the timeout throws and the hits
 * collected so far are kept). Lines are pre-cut and the scan stops at a hit
 * cap; every early stop is reported in the returned note.
 */
function regexHits(
  modules: ModuleEntry[],
  query: string,
): { hits: Hit[]; note?: string } {
  const re = compileRegex(query);
  const paths = modules.map((m) => m.path);
  const lines: VmLine[] = [];
  for (let m = 0; m < modules.length; m++) {
    const codeLines = modules[m].code.split('\n');
    for (let i = 0; i < codeLines.length; i++) {
      lines.push({
        m,
        line: i + 1,
        text: codeLines[i].slice(0, REGEX_LINE_CUT),
      });
    }
  }
  const collected: VmLine[] = [];
  const sandbox = {
    lines,
    source: re.source,
    flags: re.flags,
    push(hit: VmLine): void {
      if (collected.length < REGEX_HIT_CAP) collected.push(hit);
    },
    stop(): boolean {
      return collected.length >= REGEX_HIT_CAP;
    },
  };
  const script = `
const re = new RegExp(source, flags);
const deadline = Date.now() + ${REGEX_TIME_BUDGET_MS};
let status = 'ok';
for (let i = 0; i < lines.length; i++) {
  if (stop()) { status = 'cap'; break; }
  if ((i & 63) === 0 && Date.now() > deadline) { status = 'time'; break; }
  const found = re.exec(lines[i].text);
  if (found !== null) push({ m: lines[i].m, line: lines[i].line, text: '', index: found.index });
}
status;
`;
  let status: string;
  try {
    status = vm.runInNewContext(script, sandbox, {
      timeout: REGEX_VM_TIMEOUT_MS,
    }) as string;
  } catch {
    status = 'time';
  }
  const hits: Hit[] = collected.map((hit) => {
    const path = paths[hit.m];
    const line = modules[hit.m].code.split('\n')[hit.line - 1] ?? '';
    return {
      module: path,
      line: hit.line,
      snippet: snippet(line, hit.index ?? 0),
    };
  });
  return {
    hits,
    note:
      status === 'cap'
        ? `stopped after the ${REGEX_HIT_CAP}-hit cap`
        : status === 'time'
          ? 'stopped after the 2 s time budget (partial results)'
          : undefined,
  };
}

// -- string ------------------------------------------------------------------

function stringHits(
  ws: Workspace,
  modules: ModuleEntry[],
  linesByModule: Map<string, string[]>,
  query: string,
): Hit[] {
  const scope = new Set(modules.map((m) => m.path));
  const slash = SLASH_FORM.exec(query);
  const re = slash ? compileRegex(query) : undefined;
  const needle = slash ? undefined : query.toLowerCase();
  const hits: Hit[] = [];
  for (const entry of ws.index.strings) {
    if (!scope.has(entry.module)) continue;
    const matches = re
      ? re.test(entry.value)
      : entry.value.toLowerCase().includes(needle ?? '');
    if (!matches) continue;
    const line = codeLine(linesByModule, entry.module, entry.line);
    const shown =
      entry.value.length > 120
        ? `${entry.value.slice(0, 117)}...`
        : entry.value;
    hits.push({
      module: entry.module,
      line: entry.line,
      snippet: snippet(
        line,
        line.toLowerCase().indexOf(entry.value.toLowerCase()),
      ),
      extra: `string ${JSON.stringify(shown)}`,
    });
  }
  return hits;
}

// -- identifier ---------------------------------------------------------------

function identifierHits(
  ws: Workspace,
  modules: ModuleEntry[],
  linesByModule: Map<string, string[]>,
  query: string,
): Hit[] {
  const scope = new Set(modules.map((m) => m.path));
  const quoted = /^(['"])([\s\S]*)\1$/.exec(query);
  // Exact match when quoted, substring otherwise.
  const matches = (name: string): boolean =>
    quoted ? name === quoted[2] : name.includes(query);
  const order = new Map(modules.map((m, i) => [m.path, i]));
  const hits: Hit[] = [];
  for (const sym of ws.index.symbols) {
    if (!scope.has(sym.module) || !matches(sym.name)) continue;
    hits.push({
      module: sym.module,
      line: sym.line,
      snippet: snippet(codeLine(linesByModule, sym.module, sym.line), 0),
      extra: `symbol ${sym.kind} ${sym.name}`,
    });
  }
  for (const ref of ws.index.refs) {
    if (!scope.has(ref.module) || !matches(ref.name)) continue;
    hits.push({
      module: ref.module,
      line: ref.line,
      snippet: snippet(codeLine(linesByModule, ref.module, ref.line), 0),
      extra:
        ref.defModule !== undefined
          ? `ref ${ref.kind} → ${ref.defModule}:${ref.defLine}`
          : `ref ${ref.kind}`,
    });
  }
  hits.sort(
    (a, b) => order.get(a.module)! - order.get(b.module)! || a.line - b.line,
  );
  return hits;
}

// -- call ---------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function callHits(
  ws: Workspace,
  linesByModule: Map<string, string[]>,
  query: string,
): Hit[] {
  const scope = new Set([...linesByModule.keys()]);
  const glob = new RegExp(`^${query.split('*').map(escapeRegExp).join('.*')}$`);
  const hits: Hit[] = [];
  for (const call of ws.index.calls) {
    if (!scope.has(call.module) || !glob.test(call.callee)) continue;
    hits.push({
      module: call.module,
      line: call.line,
      snippet: snippet(codeLine(linesByModule, call.module, call.line), 0),
      extra:
        call.caller !== undefined
          ? `call ${call.callee}, caller ${call.caller}`
          : `call ${call.callee}`,
    });
  }
  return hits;
}

// -- rendering -----------------------------------------------------------------

function snippet(line: string, index: number): string {
  const text = line.trim();
  if (text.length <= SNIPPET_LEN) return text;
  const indent = line.length - line.trimStart().length;
  const at = Math.min(Math.max(index - indent, 0), text.length);
  let start = at - 80;
  if (start < 0) start = 0;
  if (start + SNIPPET_LEN > text.length) start = text.length - SNIPPET_LEN;
  const cut = text.slice(start, start + SNIPPET_LEN);
  return `${start > 0 ? '…' : ''}${cut}${start + SNIPPET_LEN < text.length ? '…' : ''}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function renderHitLine(loc: string, hit: Hit): string {
  const head = hit.extra ? `- ${loc} (${hit.extra})` : `- ${loc}`;
  return `${head}\n\`\`\`js\n${hit.snippet}\n\`\`\``;
}

function renderHits(
  query: string,
  kind: string,
  hits: Hit[],
  args: SearchArgs,
  budget: number,
  searchedModules?: number,
  note?: string,
): ReturnType<typeof textResult> {
  const page = paginate(hits, args.limit, args.offset);
  const shown = JSON.stringify(query);
  let body: string;
  let next: string[];
  if (hits.length === 0) {
    body =
      `No matches for ${shown} (kind ${kind})` +
      (searchedModules !== undefined
        ? ` in ${plural(searchedModules, 'module', 'modules')}`
        : '') +
      (note ? ` — ${note}.` : '.');
    next = ['wc_map'];
  } else {
    const modules = new Set(hits.map((hit) => hit.module)).size;
    const head =
      `Search ${shown} (kind ${kind}): ` +
      `${plural(hits.length, 'hit', 'hits')} in ${plural(modules, 'module', 'modules')}` +
      (note ? ` — ${note}.` : '.');
    const flat = page.items
      .map((hit) => renderHitLine(`${hit.module}:${hit.line}`, hit))
      .join('\n');
    const byModule = new Map<string, Hit[]>();
    for (const hit of page.items) {
      const list = byModule.get(hit.module);
      if (list) list.push(hit);
      else byModule.set(hit.module, [hit]);
    }
    const grouped = [...byModule]
      .map(
        ([module, list]) =>
          `### ${module}\n` +
          list.map((hit) => renderHitLine(`:${hit.line}`, hit)).join('\n'),
      )
      .join('\n');
    // Group under a per-module header when that is shorter.
    body = `${head}\n\n${grouped.length < flat.length ? grouped : flat}`;
    if (page.footer) body += `\n${page.footer}`;
    const first = page.items[0];
    next = first ? [`wc_read ${first.module}:${first.line}`] : ['wc_map'];
  }
  return textResult(body, { budget, next });
}
