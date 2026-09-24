import { z } from 'zod';
import { WcError } from '../format/errors';
import { textResult } from '../format/response';
import { resolveModule, resolveSymbol, symbolsByName } from '../format/target';
import type { SymbolEntry, Workspace } from '../workspace/types';
import { defineTool, readOnly, workspaceArg } from './define';

/** Maximum unique nodes in one graph; beyond this the graph is cut. */
const MAX_NODES = 200;

interface GraphNode {
  id: string;
  label: string;
  module?: string;
  line?: number;
  importedBy?: string[];
}

interface GraphEdge {
  from: string;
  to: string;
}

interface BuiltGraph {
  rootId: string;
  nodes: Map<string, GraphNode>;
  /** Adjacency in first-seen order, deduped. */
  children: Map<string, string[]>;
  edges: GraphEdge[];
  capped: boolean;
}

function newGraph(rootId: string): BuiltGraph {
  return {
    rootId,
    nodes: new Map(),
    children: new Map(),
    edges: [],
    capped: false,
  };
}

function addNode(graph: BuiltGraph, node: GraphNode): boolean {
  if (graph.nodes.has(node.id)) return true;
  if (graph.nodes.size >= MAX_NODES) {
    graph.capped = true;
    return false;
  }
  graph.nodes.set(node.id, node);
  return true;
}

function addEdge(graph: BuiltGraph, from: string, to: string): void {
  const kids = graph.children.get(from) ?? [];
  if (!kids.includes(to)) {
    kids.push(to);
    graph.children.set(from, kids);
    graph.edges.push({ from, to });
  }
}

/** Default modules root: bundle entryId, else the entry module, else first. */
function defaultModuleRoot(ws: Workspace): string {
  if (ws.bundle !== undefined) {
    try {
      return resolveModule(ws, ws.bundle.entryId).path;
    } catch {
      // Fall through to the entry/first fallbacks below.
    }
  }
  const modules = [...ws.modules.values()];
  const entry = modules.find((m) => m.isEntry);
  if (entry) return entry.path;
  const first = modules[0];
  if (!first) throw new WcError('No modules in this workspace.');
  return first.path;
}

function buildModulesGraph(
  ws: Workspace,
  root: string | undefined,
  depth: number,
): BuiltGraph {
  const rootPath =
    root === undefined ? defaultModuleRoot(ws) : resolveModule(ws, root).path;
  const graph = newGraph(rootPath);
  addNode(graph, { id: rootPath, label: rootPath, module: rootPath });
  const queue: { id: string; depth: number }[] = [{ id: rootPath, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    for (const dep of ws.index.imports[current.id] ?? []) {
      addEdge(graph, current.id, dep);
      if (addNode(graph, { id: dep, label: dep, module: dep })) {
        queue.push({ id: dep, depth: current.depth + 1 });
      }
    }
  }
  // Reverse edges from the traversed imports.
  const importedBy = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = importedBy.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    importedBy.set(edge.to, list);
  }
  for (const [id, froms] of importedBy) {
    graph.nodes.get(id)!.importedBy = froms;
  }
  return graph;
}

function nodeId(symbol: SymbolEntry): string {
  return `${symbol.module}:${symbol.name}`;
}

/** Calls whose caller is `symbol`, within its line range, in index order. */
function callsOf(ws: Workspace, symbol: SymbolEntry) {
  return ws.index.calls.filter(
    (call) =>
      call.caller === symbol.name &&
      call.module === symbol.module &&
      call.line >= symbol.line &&
      call.line <= symbol.endLine,
  );
}

function buildCallsGraph(
  ws: Workspace,
  root: string | undefined,
  depth: number,
): BuiltGraph {
  if (root === undefined || root.trim() === '') {
    throw new WcError(
      'kind="calls" needs a root symbol: pass a name or module:name such as "login" or "src/api.js:login". Call wc_outline to list symbols.',
    );
  }
  const rootSymbol = resolveSymbol(ws, root);
  const rootId = nodeId(rootSymbol);
  const graph = newGraph(rootId);
  const byName = symbolsByName(ws);
  addNode(graph, {
    id: rootId,
    label: rootId,
    module: rootSymbol.module,
    line: rootSymbol.line,
  });
  const queue: { symbol: SymbolEntry; depth: number }[] = [
    { symbol: rootSymbol, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    for (const call of callsOf(ws, current.symbol)) {
      // Fast path: a callee whose root name is nowhere in the index can
      // never resolve (globals like `fetch`, `*.json` member calls).
      const calleeRoot = call.callee.split('.')[0];
      let target: SymbolEntry | undefined;
      if (byName.has(call.callee) || byName.has(calleeRoot)) {
        try {
          target = resolveSymbol(
            ws,
            call.callee,
            `${call.module}:${call.line}`,
          );
        } catch (error) {
          if (!(error instanceof WcError)) throw error;
          target = undefined;
        }
      }
      const id = target ? nodeId(target) : call.callee;
      addEdge(graph, nodeId(current.symbol), id);
      if (target) {
        if (
          addNode(graph, {
            id,
            label: id,
            module: target.module,
            line: target.line,
          })
        ) {
          queue.push({ symbol: target, depth: current.depth + 1 });
        }
      } else {
        // Unresolved leaf (a global or `*.x` member call), deduped.
        addNode(graph, { id, label: id });
      }
    }
  }
  return graph;
}

/** Indented ASCII tree; back-edges render as `↺` instead of recursing. */
function renderTree(graph: BuiltGraph): string {
  const label = (id: string) => graph.nodes.get(id)?.label ?? id;
  const lines = [label(graph.rootId)];
  const path = new Set([graph.rootId]);
  const render = (id: string, prefix: string): void => {
    const kids = graph.children.get(id) ?? [];
    kids.forEach((kid, index) => {
      const last = index === kids.length - 1;
      const branch = last ? '└── ' : '├── ';
      if (path.has(kid)) {
        lines.push(`${prefix}${branch}${label(kid)} ↺`);
        return;
      }
      lines.push(`${prefix}${branch}${label(kid)}`);
      path.add(kid);
      render(kid, `${prefix}${last ? '    ' : '│   '}`);
      path.delete(kid);
    });
  };
  render(graph.rootId, '');
  return lines.join('\n');
}

function renderJson(graph: BuiltGraph): string {
  const nodes = [...graph.nodes.values()].map((node) =>
    Object.fromEntries(
      Object.entries(node).filter(([, value]) => value !== undefined),
    ),
  );
  const body: Record<string, unknown> = { nodes, edges: graph.edges };
  if (graph.capped) {
    body.truncated = true;
    body.note = `Graph capped at ${MAX_NODES} nodes.`;
  }
  return JSON.stringify(body, null, 2);
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderDot(kind: string, graph: BuiltGraph): string {
  const name = escapeDot(kind + ' from ' + graph.rootId);
  const lines = [`digraph "${name}" {`];
  for (const node of graph.nodes.values()) {
    lines.push(`  "${escapeDot(node.id)}";`);
  }
  for (const edge of graph.edges) {
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}";`);
  }
  if (graph.capped) {
    lines.push(`  // capped at ${MAX_NODES} nodes`);
  }
  lines.push('}');
  return lines.join('\n');
}

export const graph = defineTool({
  name: 'wc_graph',
  title: 'Dependency graph',
  description:
    'Module dependency graph or call graph around a root, limited by depth. format: tree (compact text, default), json, dot (Graphviz).',
  inputSchema: {
    workspace: workspaceArg,
    kind: z.enum(['modules', 'calls']).default('modules'),
    root: z
      .string()
      .optional()
      .describe('Module path or module:function. Defaults to the entry.'),
    depth: z.number().int().min(1).max(6).default(2),
    format: z.enum(['tree', 'json', 'dot']).default('tree'),
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const built =
      args.kind === 'modules'
        ? buildModulesGraph(ws, args.root, args.depth)
        : buildCallsGraph(ws, args.root, args.depth);
    const body =
      args.format === 'json'
        ? renderJson(built)
        : args.format === 'dot'
          ? renderDot(args.kind, built)
          : renderTree(built);
    const header =
      `${args.kind} graph from ${built.rootId} ` +
      `(depth ${args.depth}, ${built.nodes.size} nodes):`;
    const cappedNote = built.capped
      ? `\nShowing the first ${MAX_NODES} nodes (capped). Narrow with root/depth.`
      : '';
    return Promise.resolve(
      textResult(`${header}\n${body}${cappedNote}`, {
        budget: ctx.config.outputBudget,
        next: [`wc_read ${built.rootId}`, `wc_refs ${built.rootId}`],
      }),
    );
  },
});
