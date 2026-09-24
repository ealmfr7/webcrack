import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type {
  ClassBody,
  ClassDeclaration,
  ExportSpecifier,
  Expression,
  File,
  FunctionDeclaration,
  Identifier,
  Node,
  VariableDeclaration,
  VariableDeclarator,
} from '@babel/types';
import type {
  CallSite,
  ModuleEntry,
  ModuleIndex,
  RefEntry,
  StringLiteralEntry,
  SymbolEntry,
  WorkspaceIndex,
} from './types';

/**
 * Index one module's clean code (M1.2): re-parse it and extract the
 * per-module slice (symbols, calls, strings, refs, imports).
 *
 * Refs to imported bindings stay unresolved here (no `defModule`/`defLine`
 * for the other module); `linkIndex` resolves them afterwards. Refs to
 * same-module bindings are resolved immediately.
 */
export function indexModule(
  module: ModuleEntry,
  modulePaths: string[],
): ModuleIndex {
  const empty = emptyModuleIndex();
  let ast: File;
  try {
    ast = parse(module.code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['jsx'],
    });
  } catch {
    return empty;
  }
  if (!ast?.program) return empty;
  try {
    return walkModule(module.path, ast, new Set(modulePaths.map(stripDot)));
  } catch {
    return empty;
  }
}

/**
 * Link per-module slices into a workspace-wide index (M1.2): resolve refs
 * to imported bindings to their exporting module (`defModule`/`defLine`)
 * and recompute `refCount` including cross-module refs.
 */
export function linkIndex(parts: Map<string, ModuleIndex>): WorkspaceIndex {
  const symbols: SymbolEntry[] = [];
  const calls: CallSite[] = [];
  const strings: StringLiteralEntry[] = [];
  const refs: RefEntry[] = [];
  const imports: Record<string, string[]> = {};
  const reexports: WorkspaceIndex['reexports'] = [];
  for (const [mod, part] of parts) {
    for (const s of part.symbols) symbols.push({ ...s, refCount: 0 });
    for (const c of part.calls) calls.push({ ...c });
    for (const st of part.strings) strings.push({ ...st });
    for (const r of part.refs) refs.push({ ...r });
    imports[mod] = [...part.imports];
    for (const re of part.reexports) reexports.push({ ...re, module: mod });
  }

  const lookups = buildLinkLookups(symbols, reexports);

  const counts = new Map<string, number>();
  const addCount = (module: string, line: number, name: string): void => {
    const key = `${module}\0${line}\0${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const ref of refs) {
    if (ref.defModule !== undefined) {
      // Resolved inside its own module: keep the local name.
      if (ref.defLine !== undefined) {
        addCount(ref.defModule, ref.defLine, baseName(ref.name));
      }
      continue;
    }
    const target = resolveRef(lookups, imports, ref.module, ref.name);
    if (target) {
      ref.defModule = target.module;
      ref.defLine = target.line;
      // Count toward the RESOLVED target symbol (module + name + line):
      // the ref's local name may differ (import alias, export alias, or
      // namespace member). The name stays in the key: `const a = 1, b = 2`
      // share a line, so line alone would merge them.
      addCount(target.module, target.line, target.name);
    }
  }
  for (const sym of symbols) {
    sym.refCount = counts.get(`${sym.module}\0${sym.line}\0${sym.name}`) ?? 0;
  }

  return { symbols, calls, strings, refs, imports, reexports };
}

/**
 * Index every module, then link. Reindexing one module (M2.3, after a
 * rename) = `indexModule(changed)` + `linkIndex(all parts, with the
 * refreshed part swapped in)`.
 */
export function buildIndex(modules: Map<string, ModuleEntry>): WorkspaceIndex {
  const paths = [...modules.keys()];
  const parts = new Map<string, ModuleIndex>();
  for (const [path, entry] of modules) {
    parts.set(path, indexModule(entry, paths));
  }
  return linkIndex(parts);
}

function emptyModuleIndex(): ModuleIndex {
  return {
    symbols: [],
    calls: [],
    strings: [],
    refs: [],
    imports: [],
    reexports: [],
  };
}

function stripDot(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

/** `ns.sign` refers to the exported symbol `sign`. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Resolve a relative import source against the workspace module paths.
 * Handles `./` and `../`, with or without the `.js` extension, and
 * `index.js` for folders. Anything else (npm packages, bare names)
 * returns `undefined`.
 */
function resolveImport(
  fromModule: string,
  source: string,
  modulePaths: Set<string>,
): string | undefined {
  if (!source.startsWith('.')) return undefined;
  const from = stripDot(fromModule);
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of source.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/');
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
    if (modulePaths.has(candidate)) return candidate;
  }
  return undefined;
}

interface ImportCandidate {
  line: number;
  path: string;
}

interface WalkState {
  module: string;
  paths: Set<string>;
  symbols: SymbolEntry[];
  /** First symbol wins; mirrors the linker's lookup. */
  byName: Map<string, SymbolEntry>;
  calls: CallSite[];
  strings: StringLiteralEntry[];
  refs: RefEntry[];
  importCandidates: ImportCandidate[];
  importSeen: Set<string>;
  reexports: ModuleIndex['reexports'];
  /** Local names bound by imports (ESM + CJS require). */
  importNames: Set<string>;
}

function walkModule(
  modulePath: string,
  ast: File,
  paths: Set<string>,
): ModuleIndex {
  const state: WalkState = {
    module: modulePath,
    paths,
    symbols: [],
    byName: new Map(),
    calls: [],
    strings: [],
    refs: [],
    importCandidates: [],
    importSeen: new Set(),
    reexports: [],
    importNames: new Set(),
  };
  collectTopLevel(state, ast.program.body);
  try {
    collectUsages(state, ast);
  } catch {
    // Hostile AST shape: keep symbols/imports, drop calls/strings/refs.
    state.calls.length = 0;
    state.strings.length = 0;
    state.refs.length = 0;
  }
  const imports: string[] = [];
  for (const candidate of [...state.importCandidates].sort(
    (a, b) => a.line - b.line,
  )) {
    if (!state.importSeen.has(candidate.path)) {
      state.importSeen.add(candidate.path);
      imports.push(candidate.path);
    }
  }
  return {
    symbols: state.symbols,
    calls: state.calls,
    strings: state.strings,
    refs: state.refs,
    imports,
    reexports: state.reexports,
  };
}

function lineOf(node: Node | null | undefined): number | undefined {
  return node?.loc?.start.line;
}

function endLineOf(node: Node | null | undefined): number | undefined {
  return node?.loc?.end.line;
}

function addImport(
  state: WalkState,
  line: number | undefined,
  path: string,
): void {
  if (line === undefined) return;
  state.importCandidates.push({ line, path });
}

function addSymbol(state: WalkState, sym: SymbolEntry): void {
  state.symbols.push(sym);
  if (!state.byName.has(sym.name)) state.byName.set(sym.name, sym);
}

/** Mark the first top-level symbol with `name` exported (a no-op if absent). */
function markExported(state: WalkState, name: string): void {
  const sym = state.byName.get(name);
  if (sym) sym.exported = true;
}

function staticKey(
  key: Node | null | undefined,
  computed: boolean,
): string | undefined {
  if (!key || computed) return undefined;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  if (key.type === 'PrivateName' && key.id.type === 'Identifier') {
    return `#${key.id.name}`;
  }
  return undefined;
}

/**
 * True when this identifier declares a binding rather than using one:
 * declaration ids, params, catch params and the contents of declaring
 * patterns (`const { a } = …`), plus import-specifier locals. Assignment
 * and update targets are NOT declarations — they are writes.
 */
function isDeclarationSite(path: NodePath): boolean {
  let childKey: string | number | null = path.key;
  let owner = path.parentPath;
  while (owner) {
    const node = owner.node;
    switch (node.type) {
      case 'ObjectProperty':
        if (childKey !== 'value') return false;
        break;
      case 'ArrayPattern':
      case 'ObjectPattern':
      case 'RestElement':
        break;
      case 'AssignmentPattern':
        if (childKey !== 'left') return false;
        break;
      default: {
        if (node.type === 'VariableDeclarator') return childKey === 'id';
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression' ||
          node.type === 'ObjectMethod' ||
          node.type === 'ClassMethod' ||
          node.type === 'ClassPrivateMethod'
        ) {
          return childKey === 'id' || typeof childKey === 'number';
        }
        if (
          node.type === 'ClassDeclaration' ||
          node.type === 'ClassExpression'
        ) {
          return childKey === 'id';
        }
        if (node.type === 'CatchClause') return childKey === 'param';
        if (
          node.type === 'ImportSpecifier' ||
          node.type === 'ImportDefaultSpecifier' ||
          node.type === 'ImportNamespaceSpecifier'
        ) {
          return childKey === 'local';
        }
        return false;
      }
    }
    childKey = owner.key;
    owner = owner.parentPath;
  }
  return false;
}

/**
 * True when the identifier (or the destructuring pattern containing it) is
 * an assignment/update target: `x = …`, `x++`, `({ a } = …)`, `for (x of …)`.
 */
function isWriteTarget(owner: NodePath | null, top: Node): boolean {
  let child: Node = top;
  let current = owner;
  while (current) {
    const node = current.node as Node & {
      left?: Node;
      argument?: Node;
      value?: Node;
    };
    if (
      (node.type === 'AssignmentExpression' && node.left === child) ||
      (node.type === 'UpdateExpression' && node.argument === child) ||
      ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
        (node as unknown as { left?: Node }).left === child)
    ) {
      return true;
    }
    if (
      (node.type === 'ObjectProperty' && node.value === child) ||
      node.type === 'ArrayPattern' ||
      node.type === 'ObjectPattern' ||
      (node.type === 'RestElement' && node.argument === child) ||
      (node.type === 'AssignmentPattern' &&
        (node as unknown as { left?: Node }).left === child)
    ) {
      child = node;
      current = current.parentPath;
      continue;
    }
    return false;
  }
  return false;
}

/** Best-effort parameter names: identifiers, defaults, rest, destructuring. */
function patternNames(pattern: Node | null | undefined, out: string[]): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'AssignmentPattern':
      patternNames(pattern.left, out);
      break;
    case 'RestElement':
      patternNames(pattern.argument, out);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'ObjectProperty') patternNames(prop.value, out);
        else if (prop.type === 'RestElement') patternNames(prop.argument, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (el) patternNames(el, out);
      }
      break;
  }
}

function paramNames(params: Node[]): string[] {
  const out: string[] = [];
  for (const p of params) patternNames(p, out);
  return out;
}

type BodyNode = File['program']['body'][number];

function collectTopLevel(state: WalkState, body: BodyNode[]): void {
  for (const node of body) {
    try {
      collectStatement(state, node);
    } catch {
      // Hostile node: skip it, keep the rest of the module.
    }
  }
}

function collectStatement(state: WalkState, node: BodyNode): void {
  switch (node.type) {
    case 'ImportDeclaration': {
      const source = node.source.value;
      const from = resolveImport(state.module, source, state.paths);
      if (from) addImport(state, lineOf(node), from);
      for (const spec of node.specifiers) {
        const line = lineOf(spec) ?? lineOf(node);
        const endLine = endLineOf(spec) ?? endLineOf(node);
        if (line === undefined || endLine === undefined) continue;
        let importedName: string;
        if (spec.type === 'ImportDefaultSpecifier') importedName = 'default';
        else if (spec.type === 'ImportNamespaceSpecifier') importedName = '*';
        else {
          const imported = spec.imported;
          importedName =
            imported.type === 'Identifier'
              ? imported.name
              : String(imported.value);
        }
        const sym: SymbolEntry = {
          module: state.module,
          name: spec.local.name,
          kind: 'import',
          line,
          endLine,
          exported: false,
          refCount: 0,
          importedName,
        };
        if (from !== undefined) sym.from = from;
        addSymbol(state, sym);
        state.importNames.add(spec.local.name);
      }
      break;
    }
    case 'ExportAllDeclaration': {
      const from = resolveImport(state.module, node.source.value, state.paths);
      if (from === undefined) break;
      addImport(state, lineOf(node), from);
      state.reexports.push({ name: '*', importedName: '*', from });
      break;
    }
    case 'ExportNamedDeclaration': {
      if (node.declaration) {
        const decl = node.declaration;
        if (
          decl.type === 'FunctionDeclaration' ||
          decl.type === 'ClassDeclaration' ||
          decl.type === 'VariableDeclaration'
        ) {
          collectDeclaration(state, decl, true);
        }
      } else if (node.source) {
        const from = resolveImport(
          state.module,
          node.source.value,
          state.paths,
        );
        if (from === undefined) break;
        addImport(state, lineOf(node), from);
        for (const spec of node.specifiers) {
          if (spec.type === 'ExportNamespaceSpecifier') {
            // `export * as ns from '…'`: a namespace object, not a named export.
            state.reexports.push({
              name: exportNameOf(spec.exported),
              importedName: '*',
              from,
            });
          } else if (spec.type === 'ExportSpecifier') {
            state.reexports.push({
              name: exportNameOf(spec.exported),
              importedName: exportNameOf(spec.local),
              from,
            });
          }
        }
      } else {
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ExportSpecifier' &&
            spec.local.type === 'Identifier'
          ) {
            markExported(state, spec.local.name);
            // `export { local as exported }`: record a self-reexport alias
            // so cross-module refs to the exported name resolve to the
            // local binding (e.g. after a rename keeps the old export
            // name). Same-name specifiers need no alias, and the module
            // must not gain itself in `imports` (wc_graph shows imports).
            const exported = exportNameOf(spec.exported);
            if (exported !== spec.local.name) {
              state.reexports.push({
                name: exported,
                importedName: spec.local.name,
                from: state.module,
              });
            }
          }
        }
      }
      break;
    }
    case 'ExportDefaultDeclaration': {
      const decl = node.declaration;
      if (
        decl.type === 'FunctionDeclaration' ||
        decl.type === 'ClassDeclaration'
      ) {
        if (decl.id) {
          collectDeclaration(state, decl, true);
        } else {
          const line = lineOf(decl) ?? lineOf(node);
          const endLine = endLineOf(decl) ?? endLineOf(node);
          if (line === undefined || endLine === undefined) break;
          const sym: SymbolEntry = {
            module: state.module,
            name: 'default',
            kind: decl.type === 'FunctionDeclaration' ? 'function' : 'class',
            line,
            endLine,
            exported: true,
            refCount: 0,
          };
          if (decl.type === 'FunctionDeclaration') {
            sym.params = paramNames(decl.params);
          }
          addSymbol(state, sym);
          if (decl.type === 'ClassDeclaration') {
            collectMethods(state, 'default', decl.body, true, line);
          }
        }
      } else if (decl.type === 'Identifier') {
        markExported(state, decl.name);
      }
      break;
    }
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'VariableDeclaration':
      collectDeclaration(state, node, false);
      break;
    case 'ExpressionStatement':
      collectCjsExports(state, node.expression, lineOf(node), endLineOf(node));
      break;
  }
}

function exportNameOf(
  spec: ExportSpecifier['exported'] | ExportSpecifier['local'],
): string {
  return spec.type === 'Identifier' ? spec.name : String(spec.value);
}

function collectDeclaration(
  state: WalkState,
  decl: FunctionDeclaration | ClassDeclaration | VariableDeclaration,
  exported: boolean,
): void {
  if (decl.type === 'FunctionDeclaration') {
    const line = lineOf(decl);
    const endLine = endLineOf(decl);
    if (line === undefined || endLine === undefined) return;
    addSymbol(state, {
      module: state.module,
      name: decl.id?.name ?? 'default',
      kind: 'function',
      line,
      endLine,
      params: paramNames(decl.params),
      exported,
      refCount: 0,
    });
  } else if (decl.type === 'ClassDeclaration') {
    const line = lineOf(decl);
    const endLine = endLineOf(decl);
    if (line === undefined || endLine === undefined) return;
    const name = decl.id?.name ?? 'default';
    addSymbol(state, {
      module: state.module,
      name,
      kind: 'class',
      line,
      endLine,
      exported,
      refCount: 0,
    });
    collectMethods(state, name, decl.body, exported, line);
  } else {
    for (const d of decl.declarations) {
      collectDeclarator(state, d, exported);
    }
  }
}

function collectDeclarator(
  state: WalkState,
  d: VariableDeclarator,
  exported: boolean,
): void {
  const id = d.id;
  if (!id) return;
  if (id.type === 'Identifier') {
    const line = lineOf(d) ?? lineOf(id);
    const endLine = endLineOf(d) ?? endLineOf(id);
    if (line === undefined || endLine === undefined) return;
    const init = d.init;
    if (
      init?.type === 'CallExpression' &&
      init.callee.type === 'Identifier' &&
      init.callee.name === 'require' &&
      init.arguments.length === 1 &&
      init.arguments[0]?.type === 'StringLiteral'
    ) {
      const from = resolveImport(
        state.module,
        init.arguments[0].value,
        state.paths,
      );
      const sym: SymbolEntry = {
        module: state.module,
        name: id.name,
        kind: 'import',
        line,
        endLine,
        exported,
        refCount: 0,
        importedName: '*',
      };
      if (from !== undefined) {
        sym.from = from;
        addImport(state, line, from);
      }
      addSymbol(state, sym);
      state.importNames.add(id.name);
      return;
    }
    if (
      init?.type === 'ArrowFunctionExpression' ||
      init?.type === 'FunctionExpression'
    ) {
      addSymbol(state, {
        module: state.module,
        name: id.name,
        kind: 'function',
        line,
        endLine,
        params: paramNames(init.params),
        exported,
        refCount: 0,
      });
      return;
    }
    addSymbol(state, {
      module: state.module,
      name: id.name,
      kind: 'variable',
      line,
      endLine,
      exported,
      refCount: 0,
    });
    if (init?.type === 'ClassExpression') {
      collectMethods(state, id.name, init.body, exported, line);
    }
  } else if (id.type === 'ObjectPattern' || id.type === 'ArrayPattern') {
    for (const { name, line, endLine } of patternBindings(id)) {
      addSymbol(state, {
        module: state.module,
        name,
        kind: 'variable',
        line,
        endLine,
        exported,
        refCount: 0,
      });
    }
  }
}

function patternBindings(
  pattern: Node,
): Array<{ name: string; line: number; endLine: number }> {
  const out: Array<{ name: string; line: number; endLine: number }> = [];
  const visit = (p: Node | null | undefined): void => {
    if (!p) return;
    if (p.type === 'Identifier') {
      const line = lineOf(p);
      const endLine = endLineOf(p);
      if (line !== undefined && endLine !== undefined) {
        out.push({ name: p.name, line, endLine });
      }
    } else if (p.type === 'AssignmentPattern') {
      visit(p.left);
    } else if (p.type === 'RestElement') {
      visit(p.argument);
    } else if (p.type === 'ObjectPattern') {
      for (const prop of p.properties) {
        if (prop.type === 'ObjectProperty') visit(prop.value);
        else if (prop.type === 'RestElement') visit(prop.argument);
      }
    } else if (p.type === 'ArrayPattern') {
      for (const el of p.elements) {
        if (el) visit(el);
      }
    }
  };
  visit(pattern);
  return out;
}

function collectMethods(
  state: WalkState,
  className: string,
  body: ClassBody,
  exported: boolean,
  fallbackLine: number,
): void {
  for (const member of body.body) {
    if (member.type !== 'ClassMethod' && member.type !== 'ClassPrivateMethod') {
      continue;
    }
    const key = staticKey(member.key, member.computed === true);
    if (key === undefined) continue;
    const line = lineOf(member) ?? fallbackLine;
    const endLine = endLineOf(member) ?? fallbackLine;
    addSymbol(state, {
      module: state.module,
      name: `${className}.${key}`,
      kind: 'method',
      line,
      endLine,
      params: paramNames(member.params),
      exported,
      refCount: 0,
    });
  }
}

/** `module.exports.x = …` / `exports.x = …` sets `exported` on `x`. */
function collectCjsExports(
  state: WalkState,
  expr: Expression,
  line: number | undefined,
  endLine: number | undefined,
): void {
  if (expr.type !== 'AssignmentExpression' || expr.operator !== '=') return;
  const left = expr.left;
  if (left.type !== 'MemberExpression') return;
  if (!isExportsObject(left.object)) return;
  let name: string | undefined;
  if (!left.computed && left.property.type === 'Identifier') {
    name = left.property.name;
  } else if (left.property.type === 'StringLiteral') {
    name = left.property.value;
  }
  if (name === undefined || line === undefined || endLine === undefined) return;
  const existing = state.byName.get(name);
  if (existing) {
    existing.exported = true;
    return;
  }
  addSymbol(state, {
    module: state.module,
    name,
    kind: 'variable',
    line,
    endLine,
    exported: true,
    refCount: 0,
  });
}

function isExportsObject(node: Node): boolean {
  if (node.type === 'Identifier') return node.name === 'exports';
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'module' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'exports'
  );
}

interface CalleeSplit {
  root: string | undefined;
  props: string[];
}

/** Split a call callee into its root identifier plus static prop names. */
function splitCallee(callee: Expression): CalleeSplit {
  const props: string[] = [];
  let current: Expression = callee;
  while (
    current.type === 'MemberExpression' ||
    current.type === 'OptionalMemberExpression'
  ) {
    const prop = current.property;
    if (current.computed) {
      props.unshift(prop.type === 'StringLiteral' ? prop.value : '*');
    } else if (prop.type === 'Identifier') {
      props.unshift(prop.name);
    } else if (prop.type === 'PrivateName') {
      props.unshift(`#${prop.id.name}`);
    } else {
      props.unshift('*');
    }
    current = current.object;
  }
  return {
    root: current.type === 'Identifier' ? current.name : undefined,
    props,
  };
}

function dotted(root: string | undefined, props: string[]): string {
  if (root === undefined)
    return props.length > 0 ? `*.${props.join('.')}` : '*';
  return [root, ...props].join('.');
}

/**
 * Second pass: strings, calls and refs in Babel enter order. Top-level
 * symbols are already known, so callee roots and ref targets resolve
 * against real scope bindings.
 */
function collectUsages(state: WalkState, ast: File): void {
  const fnStack: Array<string | undefined> = [];
  const classStack: Array<string | undefined> = [];

  const caller = (): string | undefined => {
    for (let i = fnStack.length - 1; i >= 0; i--) {
      if (fnStack[i] !== undefined) return fnStack[i];
    }
    return undefined;
  };

  /** Name a function-like node contributes to the caller stack, if any. */
  const functionName = (
    node: Node,
    parent: Node | undefined,
  ): string | undefined => {
    const id = (node as { id?: { name: string } | null }).id;
    if (id) return id.name;
    if (!parent) return undefined;
    if (parent.type === 'VariableDeclarator') {
      return parent.id.type === 'Identifier' ? parent.id.name : undefined;
    }
    if (
      (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') &&
      !parent.computed
    ) {
      return staticKey(parent.key, false);
    }
    if (
      parent.type === 'AssignmentExpression' &&
      parent.left.type === 'Identifier'
    ) {
      return parent.left.name;
    }
    if (parent.type === 'ExportDefaultDeclaration') return 'default';
    return undefined;
  };

  const methodName = (
    key: Node | null | undefined,
    computed: boolean,
  ): string => {
    const top =
      classStack.length > 0 ? classStack[classStack.length - 1] : undefined;
    const keyName = staticKey(key, computed) ?? '*';
    return top ? `${top}.${keyName}` : keyName;
  };

  const recordCall = (
    path: NodePath,
    callee: Expression,
    line: number,
  ): void => {
    const { root, props } = splitCallee(callee);
    let name: string;
    if (props.length === 0) {
      // A bare name is statically known; only member roots get starred.
      name = root ?? '*';
    } else if (root !== undefined && state.importNames.has(root)) {
      name = dotted(root, props);
    } else if (root === undefined) {
      name = dotted(undefined, props);
    } else {
      name = !path.scope.getBinding(root)
        ? dotted(root, props)
        : dotted(undefined, props);
    }
    const site: CallSite = { module: state.module, line, callee: name };
    const from = caller();
    if (from !== undefined) site.caller = from;
    state.calls.push(site);

    // `require('./x')` / `import('./x')` add an import edge.
    if (
      (callee.type === 'Identifier' && callee.name === 'require') ||
      callee.type === 'Import'
    ) {
      const call = path.node as unknown as {
        arguments?: Array<{ type: string; value?: unknown }>;
      };
      const arg = call.arguments?.[0];
      if (arg?.type === 'StringLiteral' && typeof arg.value === 'string') {
        const from = resolveImport(state.module, arg.value, state.paths);
        if (from) addImport(state, line, from);
      }
    }
  };

  /**
   * Record one use of a module-level binding. `rootName` is the binding
   * (dotted ref names only arise from import roots); `displayName` is the
   * recorded name (`ns.sign` keeps the dotted form).
   */
  const recordRef = (
    path: NodePath,
    rootName: string,
    displayName: string,
    kind: RefEntry['kind'],
  ): void => {
    const line = lineOf(path.node);
    if (line === undefined) return;
    const local = state.byName.get(rootName);
    if (local && local.kind !== 'import') {
      state.refs.push({
        module: state.module,
        line,
        name: displayName,
        defModule: state.module,
        defLine: local.line,
        kind,
      });
      return;
    }
    const binding = path.scope.getBinding(rootName);
    if (
      !binding ||
      (binding.kind !== 'module' && !binding.scope.path.isProgram())
    ) {
      return;
    }
    state.refs.push({ module: state.module, line, name: displayName, kind });
  };

  traverse(ast, {
    FunctionDeclaration: {
      enter(path) {
        const id = path.node.id;
        fnStack.push(id?.name ?? defaultName(path));
      },
      exit() {
        fnStack.pop();
      },
    },
    FunctionExpression: {
      enter(path) {
        fnStack.push(functionName(path.node, path.parent));
      },
      exit() {
        fnStack.pop();
      },
    },
    ArrowFunctionExpression: {
      enter(path) {
        fnStack.push(functionName(path.node, path.parent));
      },
      exit() {
        fnStack.pop();
      },
    },
    ObjectMethod: {
      enter(path) {
        fnStack.push(staticKey(path.node.key, path.node.computed === true));
      },
      exit() {
        fnStack.pop();
      },
    },
    ClassMethod: {
      enter(path) {
        fnStack.push(methodName(path.node.key, path.node.computed === true));
      },
      exit() {
        fnStack.pop();
      },
    },
    ClassPrivateMethod: {
      enter(path) {
        fnStack.push(methodName(path.node.key, path.node.computed === true));
      },
      exit() {
        fnStack.pop();
      },
    },
    ClassDeclaration: {
      enter(path) {
        classStack.push(path.node.id?.name);
      },
      exit() {
        classStack.pop();
      },
    },
    ClassExpression: {
      enter(path) {
        classStack.push(path.node.id?.name);
      },
      exit() {
        classStack.pop();
      },
    },

    StringLiteral(path) {
      const parent = path.parent;
      // Object/class property keys are not value strings.
      if (
        (parent.type === 'ObjectProperty' ||
          parent.type === 'ObjectMethod' ||
          parent.type === 'ClassMethod' ||
          parent.type === 'ClassPrivateMethod' ||
          parent.type === 'ClassProperty') &&
        path.key === 'key' &&
        !parent.computed
      ) {
        return;
      }
      const line = lineOf(path.node);
      if (line === undefined) return;
      const entry: StringLiteralEntry = {
        module: state.module,
        line,
        value: path.node.value,
      };
      state.strings.push(entry);
    },

    CallExpression(path) {
      const node = path.node;
      const line = lineOf(node);
      // V8 intrinsics (`%Foo()`) are never emitted by the parser.
      if (node.callee.type === 'V8IntrinsicIdentifier' || line === undefined)
        return;
      recordCall(path, node.callee, line);
    },
    OptionalCallExpression(path) {
      const node = path.node;
      const line = lineOf(node);
      if (line !== undefined) {
        recordCall(path, node.callee, line);
      }
    },

    Identifier(path: NodePath) {
      const node = path.node as Identifier;
      // Declaration sites (and import-specifier sites) are NOT refs. Note
      // `isBindingIdentifier` is too broad here: Babel also flags plain
      // assignment/update targets, which are genuine writes.
      if (isDeclarationSite(path)) return;
      const parent = path.parent;
      const key = path.key;

      if (
        (parent.type === 'MemberExpression' ||
          parent.type === 'OptionalMemberExpression') &&
        key === 'property' &&
        !parent.computed
      ) {
        return;
      }
      if (
        (parent.type === 'ObjectProperty' ||
          parent.type === 'ObjectMethod' ||
          parent.type === 'ClassMethod' ||
          parent.type === 'ClassPrivateMethod' ||
          parent.type === 'ClassProperty') &&
        key === 'key' &&
        !parent.computed
      ) {
        return;
      }
      if (
        parent.type === 'LabeledStatement' ||
        parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement'
      ) {
        return;
      }
      if (
        parent.type === 'ImportSpecifier' ||
        parent.type === 'ImportDefaultSpecifier' ||
        parent.type === 'ImportNamespaceSpecifier'
      ) {
        return;
      }
      if (parent.type === 'ExportSpecifier') {
        // `export { x }` reads the local binding; names re-exported from
        // another module (`export { x } from`) belong to that module.
        const decl = path.parentPath?.parentPath?.node;
        if (decl?.type === 'ExportNamedDeclaration' && decl.source) return;
        if (key !== 'local') return;
      }

      // Ascend a member chain whose object is this identifier: a chain on
      // an import root keeps the dotted name (`ns.sign`).
      let displayName = node.name;
      let top: Node = node;
      let owner = path.parentPath;
      while (
        owner &&
        (owner.node.type === 'MemberExpression' ||
          owner.node.type === 'OptionalMemberExpression') &&
        (owner.node.object as unknown as Node) === top
      ) {
        top = owner.node;
        owner = owner.parentPath;
      }
      if (top !== node && state.importNames.has(node.name)) {
        const { root, props } = splitCallee(top);
        displayName = dotted(root, props);
      }

      // Only the binding itself (not a property of it) can be a write;
      // chains are reads unless they are the callee.
      let kind: RefEntry['kind'] = 'read';
      if (top === (node as Node)) {
        const topParent = owner?.node as
          | {
              type: string;
              callee?: Node;
              tag?: Node;
              left?: Node;
              argument?: Node;
            }
          | undefined;
        if (
          topParent &&
          (topParent.type === 'CallExpression' ||
            topParent.type === 'OptionalCallExpression' ||
            topParent.type === 'NewExpression') &&
          topParent.callee === top
        ) {
          kind = 'call';
        } else if (
          topParent?.type === 'TaggedTemplateExpression' &&
          topParent.tag === top
        ) {
          kind = 'call';
        } else if (isWriteTarget(owner ?? null, top)) {
          kind = 'write';
        }
      } else {
        const topParent = owner?.node as
          | { type: string; callee?: Node; tag?: Node }
          | undefined;
        if (
          topParent &&
          (topParent.type === 'CallExpression' ||
            topParent.type === 'OptionalCallExpression' ||
            topParent.type === 'NewExpression') &&
          topParent.callee === top
        ) {
          kind = 'call';
        } else if (
          topParent?.type === 'TaggedTemplateExpression' &&
          topParent.tag === top
        ) {
          kind = 'call';
        }
      }

      recordRef(path, node.name, displayName, kind);
    },
  });
}

function defaultName(path: NodePath): string | undefined {
  return path.parent.type === 'ExportDefaultDeclaration'
    ? 'default'
    : undefined;
}

/**
 * Per-link lookup tables so resolution is O(refs + symbols) instead of
 * O(refs × symbols).
 */
interface LinkLookups {
  /** `module\0name` → every symbol with that name, in link order. */
  byModuleName: Map<string, SymbolEntry[]>;
  /** module → reexports recorded from that module, in order. */
  reexportsByModule: Map<string, WorkspaceIndex['reexports']>;
}

function buildLinkLookups(
  symbols: SymbolEntry[],
  reexports: WorkspaceIndex['reexports'],
): LinkLookups {
  const byModuleName = new Map<string, SymbolEntry[]>();
  for (const sym of symbols) {
    const key = `${sym.module}\0${sym.name}`;
    const list = byModuleName.get(key);
    if (list) list.push(sym);
    else byModuleName.set(key, [sym]);
  }
  const reexportsByModule = new Map<string, WorkspaceIndex['reexports']>();
  for (const re of reexports) {
    const list = reexportsByModule.get(re.module);
    if (list) list.push(re);
    else reexportsByModule.set(re.module, [re]);
  }
  return { byModuleName, reexportsByModule };
}

/** Every symbol with `name` in `modulePath`, in link order (maybe none). */
function lookupName(
  lookups: LinkLookups,
  modulePath: string,
  name: string,
): SymbolEntry[] {
  return lookups.byModuleName.get(`${modulePath}\0${name}`) ?? [];
}

/** Follow one module's import of `name` to the exported symbol. */
function resolveRef(
  lookups: LinkLookups,
  imports: Record<string, string[]>,
  fromModule: string,
  name: string,
): SymbolEntry | undefined {
  const dot = name.indexOf('.');
  if (dot !== -1) {
    // Namespace member (`ns.sign`): only a `*` import root resolves.
    const root = name.slice(0, dot);
    const member = name.slice(dot + 1).split('.')[0];
    const rootBinding = lookupName(lookups, fromModule, root).find(
      (s) => s.kind === 'import',
    );
    if (
      !rootBinding ||
      !rootBinding.from ||
      rootBinding.importedName !== '*' ||
      !member
    ) {
      return undefined;
    }
    return resolveExportName(lookups, rootBinding.from, member, new Set());
  }
  return resolveImportRef(lookups, imports, fromModule, name, new Set());
}

/**
 * Same semantics as `resolveThroughImport` in `format/target.ts`: import
 * bindings follow `from` + `importedName` (namespace `*` roots follow
 * nowhere); barrels are followed transitively; cycles give `undefined`.
 * Two sharp edges, per the contract: `export *` never re-exports `default`,
 * and a namespace re-export (`export * as ns`) is not a named export.
 */
function resolveImportRef(
  lookups: LinkLookups,
  imports: Record<string, string[]>,
  fromModule: string,
  name: string,
  seen: Set<string>,
): SymbolEntry | undefined {
  const key = `${fromModule}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const binding = lookupName(lookups, fromModule, name).find(
    (s) => s.kind === 'import',
  );
  if (!binding) return undefined;
  if (binding.from !== undefined) {
    if (binding.importedName === '*') return undefined;
    return resolveExportName(
      lookups,
      binding.from,
      binding.importedName ?? name,
      seen,
    );
  }
  for (const target of imports[fromModule] ?? []) {
    const exported = lookupName(lookups, target, name).find((s) => s.exported);
    if (exported) return exported;
  }
  return undefined;
}

function resolveExportName(
  lookups: LinkLookups,
  modulePath: string,
  name: string,
  seen: Set<string>,
): SymbolEntry | undefined {
  const key = `export:${modulePath}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const local = lookupName(lookups, modulePath, name);
  const real = local.find((s) => s.kind !== 'import');
  if (real) return real;
  // Self-reexport aliases (`export { local as exported }`, where
  // `from` is this same module) are followed by this same branch; the
  // `seen` key above guards alias cycles.
  for (const re of lookups.reexportsByModule.get(modulePath) ?? []) {
    if (re.name === name && re.importedName !== '*') {
      const found = resolveExportName(lookups, re.from, re.importedName, seen);
      if (found) return found;
    } else if (re.name === '*' && name !== 'default') {
      const found = resolveExportName(lookups, re.from, name, seen);
      if (found) return found;
    }
  }
  const binding = local.find(
    (s) => s.kind === 'import' && s.from !== undefined,
  );
  if (binding) {
    if (binding.importedName === '*') return undefined;
    return resolveExportName(
      lookups,
      binding.from as string,
      binding.importedName ?? name,
      seen,
    );
  }
  return undefined;
}
