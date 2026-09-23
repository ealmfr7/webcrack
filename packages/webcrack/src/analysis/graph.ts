import traverse from '@babel/traverse';
import type * as t from '@babel/types';
import { posix } from 'node:path';
import type { Bundle } from '../unpack/bundle';

export interface GraphNode {
  /** Unique stable id, e.g. a module id or `external:<name>`. */
  id: string;
  /** Human-readable label, defaults to `id` when omitted. */
  label?: string;
  /** Module path for module-graph nodes. */
  path?: string;
  /** True for the bundle entry module. */
  isEntry?: boolean;
  /** True for unresolved/external dependency or callee nodes. */
  external?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Raw specifier or call name that produced the edge. */
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const REQUIRE_NAMES = new Set([
  'require',
  '__webpack_require__',
  '__require__',
]);

function sortedNodes(nodes: Iterable<GraphNode>): GraphNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortedEdges(edges: Iterable<GraphEdge>): GraphEdge[] {
  return [...edges].sort((a, b) =>
    a.from < b.from
      ? -1
      : a.from > b.from
        ? 1
        : a.to < b.to
          ? -1
          : a.to > b.to
            ? 1
            : 0,
  );
}

function stripDotSlash(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

/**
 * Dependency specifiers (`require('./x')`, `import ... from './x'`) found
 * in a module, in traversal order.
 */
function collectDepSpecifiers(ast: t.File): string[] {
  const specs: string[] = [];
  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;
      const isRequire =
        callee.type === 'Identifier' && REQUIRE_NAMES.has(callee.name);
      // Depending on the parser version, dynamic `import(x)` is either an
      // ImportExpression or a CallExpression with an `Import` callee.
      const isDynamicImport = callee.type === 'Import';
      if (isRequire || isDynamicImport) {
        const [arg] = path.node.arguments;
        if (path.node.arguments.length === 1 && arg?.type === 'StringLiteral') {
          specs.push(arg.value);
        }
      }
    },
    ImportDeclaration(path) {
      specs.push(path.node.source.value);
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) specs.push(path.node.source.value);
    },
    ExportAllDeclaration(path) {
      specs.push(path.node.source.value);
    },
    ImportExpression(path) {
      if (path.node.source.type === 'StringLiteral') {
        specs.push(path.node.source.value);
      }
    },
  });
  return specs;
}

/**
 * Resolve a dependency specifier to a module id in the bundle.
 * Returns `undefined` for unresolved (external) dependencies.
 */
function resolveSpecifier(
  spec: string,
  fromPath: string,
  bundle: Bundle,
): string | undefined {
  // Exact module id (webpack numeric ids, esbuild path-like ids)
  if (bundle.modules.has(spec)) return spec;

  const byPath = new Map<string, string>();
  const byNormalized = new Map<string, string>();
  for (const mod of bundle.modules.values()) {
    if (!byPath.has(mod.path)) byPath.set(mod.path, mod.id);
    const normalized = stripDotSlash(mod.path);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, mod.id);
  }

  if (byPath.has(spec)) return byPath.get(spec);
  if (byNormalized.has(stripDotSlash(spec))) {
    return byNormalized.get(stripDotSlash(spec));
  }

  if (spec.startsWith('.')) {
    const base = posix.join(posix.dirname(fromPath), spec);
    const candidates = [
      base,
      `${base}.js`,
      `${base}/index.js`,
      stripDotSlash(base),
      `${stripDotSlash(base)}.js`,
      `${stripDotSlash(base)}/index.js`,
    ];
    for (const candidate of candidates) {
      if (bundle.modules.has(candidate)) return candidate;
      if (byPath.has(candidate)) return byPath.get(candidate);
      if (byNormalized.has(stripDotSlash(candidate))) {
        return byNormalized.get(stripDotSlash(candidate));
      }
    }
    return undefined;
  }

  // Bare specifier (e.g. `require('lodash')`): match node_modules paths
  // produced by the unpackers (`node_modules/<name>/index.js`).
  for (const candidate of [
    `node_modules/${spec}/index.js`,
    `node_modules/${spec}.js`,
    `node_modules/${spec}`,
  ]) {
    if (byPath.has(candidate)) return byPath.get(candidate);
  }
  return undefined;
}

/**
 * Build the module dependency graph of an unpacked bundle. Nodes are the
 * bundle modules (plus one `external:<spec>` node per unresolved
 * dependency); edges point from importer to imported module.
 */
export function moduleGraph(bundle: Bundle): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const mod of bundle.modules.values()) {
    nodes.set(mod.id, {
      id: mod.id,
      label: mod.path,
      path: mod.path,
      isEntry: mod.id === bundle.entryId,
      external: false,
    });
  }

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  // Sort modules by id so edge label choice (first specifier wins) is stable.
  const modules = [...bundle.modules.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const mod of modules) {
    for (const spec of collectDepSpecifiers(mod.ast)) {
      const target = resolveSpecifier(spec, mod.path, bundle);
      const to = target ?? `external:${spec}`;
      if (target === undefined && !nodes.has(to)) {
        nodes.set(to, { id: to, label: spec, external: true });
      }
      const key = `${mod.id}\0${to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from: mod.id, to, label: spec });
    }
  }

  return { nodes: sortedNodes(nodes.values()), edges: sortedEdges(edges) };
}

const TOPLEVEL = '<toplevel>';

function funcBaseName(node: t.Node, parent: t.Node): string | undefined {
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (
    parent.type === 'AssignmentExpression' &&
    parent.left.type === 'Identifier'
  ) {
    return parent.left.name;
  }
  if (
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression') &&
    node.id?.type === 'Identifier'
  ) {
    return node.id.name;
  }
  return undefined;
}

function methodKeyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return undefined;
}

/**
 * Short owner name (`o` in `const o = {...}`, `A` in `class A ...`) for the
 * object/class enclosing a method, by walking up the AST.
 */
function ownerShortName(path: {
  findParent: (cb: (p: { node: t.Node }) => boolean) => { node: t.Node } | null;
}): string | undefined {
  const found = path.findParent(
    (p) =>
      p.node.type === 'VariableDeclarator' ||
      p.node.type === 'AssignmentExpression' ||
      p.node.type === 'ClassDeclaration',
  );
  if (!found) return undefined;
  const n = found.node;
  if (n.type === 'ClassDeclaration' && n.id?.type === 'Identifier') {
    return n.id.name;
  }
  if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
    return n.id.name;
  }
  if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') {
    return n.left.name;
  }
  return undefined;
}

/**
 * Build the static call graph of a single file. Nodes are named functions,
 * methods (`Owner.method`, including object properties holding functions),
 * and arrow functions bound to identifiers (nested definitions are
 * qualified, e.g. `outer.inner`); calls that cannot be resolved to a
 * definition become shared `external:<name>` nodes. Calls from the top
 * level use a `<toplevel>` caller node.
 */
export function callGraph(ast: t.File): Graph {
  const nodes = new Map<string, GraphNode>();
  const usedNames = new Set<string>();
  // Scope binding -> function node id (scope-correct, so shadowing works).
  const bindingToNode = new Map<object, string>();
  // Scope binding of an object/class owner variable -> short owner name.
  const bindingToOwner = new Map<object, string>();
  // Short owner name -> method names defined on it.
  const ownerMethods = new Map<string, Set<string>>();

  function claimName(base: string): string {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let i = 2;
    while (usedNames.has(`${base}#${i}`)) i++;
    const name = `${base}#${i}`;
    usedNames.add(name);
    return name;
  }

  function addNode(id: string): void {
    if (!nodes.has(id)) nodes.set(id, { id, label: id });
  }

  function addMethod(owner: string, key: string): string {
    let set = ownerMethods.get(owner);
    if (!set) {
      set = new Set();
      ownerMethods.set(owner, set);
    }
    set.add(key);
    const id = claimName(`${owner}.${key}`);
    addNode(id);
    return id;
  }

  function findMethodNode(owner: string, key: string): string | undefined {
    for (const id of nodes.keys()) {
      if (id === `${owner}.${key}` || id.endsWith(`.${owner}.${key}`)) {
        return id;
      }
    }
    return undefined;
  }

  // Pass 1: collect definitions. nsStack holds qualified ids of enclosing
  // named functions/methods for qualifying nested definitions.
  const nsStack: string[] = [];
  traverse(ast, {
    Function: {
      enter(path) {
        const { node } = path;
        // Object/class methods are handled by the dedicated visitors below.
        if (
          node.type === 'ObjectMethod' ||
          node.type === 'ClassMethod' ||
          node.type === 'ClassPrivateMethod'
        ) {
          // Paired with the early return in `exit` below.
          return;
        }
        const parent = path.parent;
        // A function directly serving as an object property value
        // (`{ m() {} }` aside, i.e. `{ m: function/arrow }`) is a method.
        if (
          parent.type === 'ObjectProperty' &&
          parent.value === node &&
          !parent.computed
        ) {
          const owner = ownerShortName(path);
          const key = methodKeyName(parent.key);
          if (owner !== undefined && key !== undefined) {
            const id = addMethod(owner, key);
            nsStack.push(id);
          } else {
            nsStack.push('');
          }
          return;
        }
        const base = funcBaseName(node, parent);
        if (base !== undefined) {
          const qualified =
            nsStack.length > 0 && nsStack[nsStack.length - 1] !== ''
              ? `${nsStack[nsStack.length - 1]}.${base}`
              : base;
          const id = claimName(qualified);
          addNode(id);
          const binding = path.scope.getBinding(base);
          if (binding) {
            if (!bindingToNode.has(binding)) bindingToNode.set(binding, id);
            if (!bindingToOwner.has(binding)) bindingToOwner.set(binding, base);
          }
          nsStack.push(id);
        } else {
          nsStack.push('');
        }
      },
      exit(path) {
        if (
          path.node.type === 'ObjectMethod' ||
          path.node.type === 'ClassMethod' ||
          path.node.type === 'ClassPrivateMethod'
        ) {
          return;
        }
        nsStack.pop();
      },
    },
    ObjectMethod: {
      enter(path) {
        const owner = ownerShortName(path);
        const key = methodKeyName(path.node.key);
        nsStack.push(
          owner !== undefined && key !== undefined ? addMethod(owner, key) : '',
        );
      },
      exit() {
        nsStack.pop();
      },
    },
    ClassMethod: {
      enter(path) {
        if (path.node.kind === 'constructor') {
          nsStack.push('');
          return;
        }
        const owner = ownerShortName(path);
        const key = methodKeyName(path.node.key);
        nsStack.push(
          owner !== undefined && key !== undefined ? addMethod(owner, key) : '',
        );
      },
      exit() {
        nsStack.pop();
      },
    },
    // `const o = {...}` / `class A ...` introduce method owner namespaces.
    VariableDeclarator(path) {
      const { node } = path;
      if (
        node.id.type === 'Identifier' &&
        (node.init?.type === 'ObjectExpression' ||
          node.init?.type === 'ClassExpression')
      ) {
        const binding = path.scope.getBinding(node.id.name);
        if (binding && !bindingToOwner.has(binding)) {
          bindingToOwner.set(binding, node.id.name);
        }
      }
    },
    ClassDeclaration(path) {
      const { node } = path;
      if (node.id?.type === 'Identifier') {
        const binding = path.scope.getBinding(node.id.name);
        if (binding && !bindingToOwner.has(binding)) {
          bindingToOwner.set(binding, node.id.name);
        }
      }
    },
  });

  // Pass 2: collect call edges with scope-correct callee resolution.
  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  const callerStack: string[] = [];
  const ownerStack: (string | undefined)[] = [];

  function currentCaller(): string {
    return callerStack.length > 0
      ? callerStack[callerStack.length - 1]
      : TOPLEVEL;
  }

  function currentOwner(): string | undefined {
    return ownerStack.length > 0
      ? ownerStack[ownerStack.length - 1]
      : undefined;
  }

  function pushEdge(from: string, to: string, label: string): void {
    if (from === TOPLEVEL && !nodes.has(TOPLEVEL)) {
      nodes.set(TOPLEVEL, { id: TOPLEVEL, label: TOPLEVEL });
    }
    if (!nodes.has(to)) {
      nodes.set(to, { id: to, label: to, external: true });
    }
    const key = `${from}\0${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, label });
  }

  function resolveFunctionId(
    path: { scope: { getBinding(name: string): unknown } },
    base: string,
  ): string | undefined {
    const binding = path.scope.getBinding(base) as object | undefined;
    return (binding && bindingToNode.get(binding)) ?? undefined;
  }

  function resolveOwner(
    path: { scope: { getBinding(name: string): unknown } },
    name: string,
  ): string | undefined {
    const binding = path.scope.getBinding(name) as object | undefined;
    if (!binding) return undefined;
    return bindingToOwner.get(binding) ?? name;
  }

  function recordCall(path: {
    node: t.CallExpression | t.OptionalCallExpression;
    scope: { getBinding(name: string): unknown };
  }): void {
    const from = currentCaller();
    const callee = path.node.callee;
    if (callee.type === 'Identifier') {
      const target = resolveFunctionId(path, callee.name);
      if (target) pushEdge(from, target, callee.name);
      else pushEdge(from, `external:${callee.name}`, callee.name);
      return;
    }
    if (
      (callee.type === 'MemberExpression' ||
        callee.type === 'OptionalMemberExpression') &&
      !callee.computed &&
      callee.property.type === 'Identifier'
    ) {
      recordStaticMethodCall(path, from, callee.object, callee.property.name);
      return;
    }
    if (
      (callee.type === 'MemberExpression' ||
        callee.type === 'OptionalMemberExpression') &&
      callee.computed &&
      callee.property.type === 'StringLiteral'
    ) {
      const obj = callee.object;
      const objName =
        obj.type === 'Identifier'
          ? obj.name
          : obj.type === 'ThisExpression'
            ? 'this'
            : undefined;
      if (objName !== undefined) {
        const prop = callee.property.value;
        pushEdge(from, `external:${objName}.${prop}`, `${objName}.${prop}`);
      }
    }
  }

  function recordStaticMethodCall(
    path: { scope: { getBinding(name: string): unknown } },
    from: string,
    obj: t.Node,
    prop: string,
  ): void {
    if (obj.type === 'Identifier') {
      const owner = resolveOwner(path, obj.name);
      if (owner !== undefined) {
        const target = findMethodNode(owner, prop);
        if (target) {
          pushEdge(from, target, `${obj.name}.${prop}`);
          return;
        }
      }
      pushEdge(from, `external:${obj.name}.${prop}`, `${obj.name}.${prop}`);
      return;
    }
    if (obj.type === 'ThisExpression') {
      const owner = currentOwner();
      if (owner !== undefined) {
        const target = findMethodNode(owner, prop);
        if (target) {
          pushEdge(from, target, `this.${prop}`);
          return;
        }
        pushEdge(from, `external:${owner}.${prop}`, `this.${prop}`);
        return;
      }
      pushEdge(from, `external:this.${prop}`, `this.${prop}`);
      return;
    }
    if (obj.type === 'Super') {
      pushEdge(from, `external:super.${prop}`, `super.${prop}`);
    }
  }

  traverse(ast, {
    Function: {
      enter(path) {
        const { node } = path;
        // Object/class methods are handled by the dedicated visitors below.
        if (
          node.type === 'ObjectMethod' ||
          node.type === 'ClassMethod' ||
          node.type === 'ClassPrivateMethod'
        ) {
          return;
        }
        const parent = path.parent;
        let id: string | undefined;
        let owner: string | undefined = currentOwner();
        if (
          parent.type === 'ObjectProperty' &&
          parent.value === node &&
          !parent.computed
        ) {
          const shortOwner = ownerShortName(path);
          const key = methodKeyName(parent.key);
          if (shortOwner !== undefined && key !== undefined) {
            id = findMethodNode(shortOwner, key);
            owner = shortOwner;
          }
        } else {
          const base = funcBaseName(node, parent);
          if (base !== undefined) id = resolveFunctionId(path, base);
        }
        callerStack.push(id ?? currentCaller());
        ownerStack.push(owner);
      },
      exit(path) {
        if (
          path.node.type === 'ObjectMethod' ||
          path.node.type === 'ClassMethod' ||
          path.node.type === 'ClassPrivateMethod'
        ) {
          return;
        }
        callerStack.pop();
        ownerStack.pop();
      },
    },
    ObjectMethod: {
      enter(path) {
        const owner = ownerShortName(path);
        const key = methodKeyName(path.node.key);
        const id =
          owner !== undefined && key !== undefined
            ? (findMethodNode(owner, key) ?? currentCaller())
            : currentCaller();
        callerStack.push(id);
        ownerStack.push(owner ?? currentOwner());
      },
      exit() {
        callerStack.pop();
        ownerStack.pop();
      },
    },
    ClassMethod: {
      enter(path) {
        const owner = ownerShortName(path);
        const key = methodKeyName(path.node.key);
        const id =
          owner !== undefined && key !== undefined
            ? (findMethodNode(owner, key) ?? currentCaller())
            : currentCaller();
        callerStack.push(id);
        ownerStack.push(owner ?? currentOwner());
      },
      exit() {
        callerStack.pop();
        ownerStack.pop();
      },
    },
    CallExpression(path) {
      recordCall(path);
    },
    OptionalCallExpression(path) {
      recordCall(path);
    },
  });

  return { nodes: sortedNodes(nodes.values()), edges: sortedEdges(edges) };
}

function escapeDotLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Serialize a graph to deterministic Graphviz DOT. Node ids and labels are
 * always quoted and escaped, so arbitrary module paths and function names
 * produce valid DOT.
 */
export function toDot(graph: Graph, name = 'graph'): string {
  const lines = [`digraph ${name} {`];
  for (const node of sortedNodes(graph.nodes)) {
    const label = escapeDotLabel(node.label ?? node.id);
    const attrs = [`label="${label}"`];
    if (node.external) attrs.push('style=dashed');
    lines.push(`  "${escapeDotLabel(node.id)}" [${attrs.join(', ')}];`);
  }
  for (const edge of sortedEdges(graph.edges)) {
    const label =
      edge.label !== undefined
        ? ` [label="${escapeDotLabel(edge.label)}"]`
        : '';
    lines.push(
      `  "${escapeDotLabel(edge.from)}" -> "${escapeDotLabel(edge.to)}"${label};`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * Serialize a graph to deterministic JSON (nodes/edges sorted by id).
 */
export function toJSON(graph: Graph): string {
  return (
    JSON.stringify(
      { nodes: sortedNodes(graph.nodes), edges: sortedEdges(graph.edges) },
      null,
      2,
    ) + '\n'
  );
}
