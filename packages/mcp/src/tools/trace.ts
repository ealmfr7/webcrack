import { parse } from '@babel/parser';
import traverse, { type Binding, type NodePath } from '@babel/traverse';
import type { File, Node } from '@babel/types';
import { z } from 'zod';
import { suggest, WcError } from '../format/errors';
import { textResult } from '../format/response';
import { parseTarget, resolveModule, resolveSymbol } from '../format/target';
import type { ModuleEntry, SymbolEntry, Workspace } from '../workspace/types';
import { defineTool, readOnly, workspaceArg } from './define';

export const trace = defineTool({
  name: 'wc_trace',
  title: 'Trace a value data flow',
  description:
    'Follow a value data flow: where a URL, token or header string is built (backward) and which call sends it (forward). value: a string literal from the code, an identifier or module:name, or a module:line. direction: backward (how it is built), forward (where it flows) or both. Ends with the sink(s) found (fetch, axios, XHR, storage, postMessage).',
  inputSchema: {
    workspace: workspaceArg,
    value: z
      .string()
      .describe(
        'A string literal from the code, an identifier or module:name, or a module:line.',
      ),
    direction: z.enum(['backward', 'forward', 'both']).default('both'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(4)
      .describe('Max function-boundary crossings to follow.'),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(40)
      .describe('Max trace steps to report.'),
  },
  annotations: readOnly,
  handler: (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const tracer = new Tracer(ws, args.depth, args.maxSteps);
    const body = tracer.run(args.value, args.direction);
    const keyStep = tracer.keyStep();
    const next = keyStep === undefined ? ['wc_map'] : [`wc_read ${keyStep}`];
    return Promise.resolve(
      textResult(body, { budget: ctx.config.outputBudget, next }),
    );
  },
});

type Direction = 'backward' | 'forward' | 'both';

type Role =
  | 'seed'
  | 'init'
  | 'assign'
  | 'param'
  | 'arg'
  | 'call'
  | 'read'
  | 'return'
  | 'literal'
  | 'sink';

interface Step {
  module: string;
  line: number;
  role: Role;
  code: string;
}

interface Sink {
  label: string;
  module: string;
  line: number;
}

/** A resolved starting point: an identifier use/def or a string literal. */
interface Seed {
  module: string;
  line: number;
  /** Identifier name when the seed is a binding; undefined for literals. */
  name?: string;
  literal?: string;
}

/** Re-parsed module ASTs, keyed by module entry. Re-parse on code change. */
const astCache = new WeakMap<ModuleEntry, { code: string; ast: File }>();

function getAst(entry: ModuleEntry): File | undefined {
  const cached = astCache.get(entry);
  if (cached !== undefined && cached.code === entry.code) return cached.ast;
  let ast: File;
  try {
    // Same parse options as store.ts so line numbers match the index.
    ast = parse(entry.code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['jsx'],
    });
  } catch {
    return undefined;
  }
  astCache.set(entry, { code: entry.code, ast });
  return ast;
}

/** Trimmed 1-based source line of a module, if present. */
function lineAt(ws: Workspace, module: string, line: number): string {
  return ws.modules.get(module)?.code.split('\n')[line - 1]?.trim() ?? '';
}

function lastSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function nodeLine(node: Node | null | undefined, fallback: number): number {
  return node?.loc?.start.line ?? fallback;
}

/**
 * Dotted callee name from an AST call callee, following the index
 * convention: a plain-identifier root gives the dotted name (`fetch`,
 * `localStorage.setItem`); any other root gives `*.<prop>` (`*.json`).
 */
function calleeText(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  ) {
    const prop =
      node.property.type === 'Identifier' && !node.computed
        ? node.property.name
        : node.property.type === 'StringLiteral'
          ? node.property.value
          : node.property.type === 'PrivateName'
            ? node.property.id.name
            : '*';
    const obj = node.object;
    const root = obj.type === 'Identifier' ? obj.name : '*';
    return `${root}.${prop}`;
  }
  return '*';
}

/** Collect identifier names bound by a pattern (params, declarators). */
function patternNames(node: Node, out: string[]): void {
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      return;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'ObjectProperty') patternNames(prop.value, out);
        else if (prop.type === 'RestElement') patternNames(prop.argument, out);
      }
      return;
    case 'ArrayPattern':
      for (const el of node.elements) {
        if (el !== null) patternNames(el, out);
      }
      return;
    case 'RestElement':
      patternNames(node.argument, out);
      return;
    case 'AssignmentPattern':
      patternNames(node.left, out);
  }
}

/**
 * Deepest function (or program) path whose range contains `line`.
 * Its scope resolves bindings exactly as the code sees them.
 */
function scopeAtLine(ast: File, line: number): NodePath | undefined {
  let best: NodePath | undefined;
  let bestDepth = -1;
  traverse(ast, {
    enter(path) {
      if (!path.isFunction() && !path.isProgram()) return;
      const loc = path.node.loc;
      if (loc === null || loc === undefined) return;
      if (loc.start.line <= line && line <= loc.end.line) {
        let depth = 0;
        let parent = path.parentPath;
        while (parent !== null) {
          if (parent.isFunction()) depth++;
          parent = parent.parentPath;
        }
        if (depth >= bestDepth) {
          bestDepth = depth;
          best = path;
        }
      }
    },
  });
  return best;
}

/** Nearest enclosing named function of a path, if any. */
function enclosingFunctionName(path: NodePath): string | undefined {
  const fn = path.getFunctionParent();
  if (fn === null || !fn.isFunction()) return undefined;
  const node = fn.node;
  if (
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression') &&
    node.id !== null &&
    node.id !== undefined
  ) {
    return node.id.name;
  }
  if (node.type === 'ObjectMethod' || node.type === 'ClassMethod') {
    const key = node.key;
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'StringLiteral') return key.value;
    return undefined;
  }
  const parent = fn.parentPath;
  if (parent !== null && parent.isVariableDeclarator()) {
    const id = parent.node.id;
    if (id.type === 'Identifier') return id.name;
  }
  return undefined;
}

type ReadTarget =
  | { kind: 'call'; line: number; callee: string; argIndex: number }
  | { kind: 'callee'; line: number; callee: string }
  | { kind: 'var'; line: number; name: string; assign: boolean }
  | { kind: 'return'; line: number; caller?: string }
  | { kind: 'other'; line: number };

/**
 * Classify how the value at `start` (an identifier or literal path) is
 * used: as a call argument, as the callee itself, flowing into a variable,
 * returned from a function, or anything else.
 */
function classifyUse(start: NodePath): ReadTarget {
  let current: NodePath = start;
  for (;;) {
    const parent = current.parentPath;
    if (parent === null)
      return { kind: 'other', line: nodeLine(start.node, 1) };
    const node = parent.node;
    switch (node.type) {
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        // A property key names nothing; an object flows into the member.
        if (node.property === current.node && !node.computed) {
          return { kind: 'other', line: nodeLine(node, 1) };
        }
        current = parent;
        continue;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        if (node.callee === current.node) {
          return {
            kind: 'callee',
            line: nodeLine(node, 1),
            callee: calleeText(node.callee),
          };
        }
        const argIndex = node.arguments.findIndex((a) => a === current.node);
        if (argIndex !== -1) {
          return {
            kind: 'call',
            line: nodeLine(node, 1),
            callee: calleeText(node.callee),
            argIndex,
          };
        }
        return { kind: 'other', line: nodeLine(node, 1) };
      }
      case 'VariableDeclarator': {
        const id = node.id;
        if (node.init === current.node && id.type === 'Identifier') {
          return {
            kind: 'var',
            line: nodeLine(node, 1),
            name: id.name,
            assign: false,
          };
        }
        return { kind: 'other', line: nodeLine(node, 1) };
      }
      case 'AssignmentExpression': {
        if (node.right === current.node && node.left.type === 'Identifier') {
          return {
            kind: 'var',
            line: nodeLine(node, 1),
            name: node.left.name,
            assign: true,
          };
        }
        return { kind: 'other', line: nodeLine(node, 1) };
      }
      case 'ReturnStatement':
        return {
          kind: 'return',
          line: nodeLine(node, 1),
          caller: enclosingFunctionName(parent) ?? undefined,
        };
      case 'ObjectProperty':
        if (node.value === current.node) {
          current = parent;
          continue;
        }
        return { kind: 'other', line: nodeLine(node, 1) };
      case 'ArrayExpression':
      case 'SpreadElement':
      case 'TemplateLiteral':
      case 'TaggedTemplateExpression':
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'ConditionalExpression':
      case 'SequenceExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'ParenthesizedExpression':
        current = parent;
        continue;
      default:
        return { kind: 'other', line: nodeLine(node, 1) };
    }
  }
}

/** Find the identifier or literal path starting a seed, if re-parseable. */
function seedPath(
  ws: Workspace,
  seed: Seed,
): { ast: File; path: NodePath } | undefined {
  const entry = ws.modules.get(seed.module);
  if (entry === undefined) return undefined;
  const ast = getAst(entry);
  if (ast === undefined) return undefined;
  let found: NodePath | undefined;
  traverse(ast, {
    enter(path) {
      if (found !== undefined) {
        path.skip();
        return;
      }
      const loc = path.node.loc;
      if (loc === null || loc === undefined || loc.start.line !== seed.line) {
        return;
      }
      if (seed.name !== undefined) {
        if (path.isIdentifier({ name: seed.name })) found = path;
      } else if (path.isStringLiteral({ value: seed.literal ?? '' })) {
        found = path;
      }
    },
  });
  return found === undefined ? undefined : { ast, path: found };
}

class Tracer {
  private readonly ws: Workspace;
  private readonly maxDepth: number;
  private readonly maxSteps: number;
  private readonly steps: Step[] = [];
  private readonly seenSteps = new Set<string>();
  private readonly sinks: Sink[] = [];
  private readonly visited = new Set<string>();
  private capped = false;

  constructor(ws: Workspace, depth: number, maxSteps: number) {
    this.ws = ws;
    this.maxDepth = depth;
    this.maxSteps = maxSteps;
  }

  run(value: string, direction: Direction): string {
    const seeds = this.resolveSeeds(value);
    const lines = [
      `Trace ${JSON.stringify(value)} (${direction}, depth ${this.maxDepth}, maxSteps ${this.maxSteps}): ${seeds.length} seed${seeds.length === 1 ? '' : 's'}.`,
    ];
    if (direction === 'backward' || direction === 'both') {
      const start = this.steps.length;
      for (const seed of seeds) this.backwardFromSeed(seed);
      lines.push(
        '',
        ...this.renderSection('Backward (how it is built)', start),
      );
    }
    if (direction === 'forward' || direction === 'both') {
      const start = this.steps.length;
      for (const seed of seeds) this.forwardFromSeed(seed, 0);
      lines.push('', ...this.renderSection('Forward (where it flows)', start));
    }
    lines.push('', ...this.renderSinks());
    if (this.capped) {
      lines.push(
        `… stopped early: step cap (maxSteps ${this.maxSteps}) or depth cap (depth ${this.maxDepth}) reached. Re-run with larger caps to see more.`,
      );
    }
    return lines.join('\n');
  }

  /** First sink location, else the first step: the `wc_read` target. */
  keyStep(): string | undefined {
    const sink = this.sinks[0];
    if (sink !== undefined) return `${sink.module}:${sink.line}`;
    const step = this.steps[0];
    return step === undefined ? undefined : `${step.module}:${step.line}`;
  }

  // -- Seeds ---------------------------------------------------------------

  /**
   * Resolve `value` to seeds: an exact `index.strings` match first (so
   * values with surrounding whitespace like `"Bearer "` hit their literal),
   * then the trimmed value against `index.strings`, then an identifier /
   * `module:name` via `resolveSymbol`, then `module:line` (identifiers and
   * literals on that line). Unknown values throw a `WcError` with deduped
   * `suggest()` candidates, rendered JSON-quoted so whitespace is visible.
   */
  private resolveSeeds(value: string): Seed[] {
    const toSeed = (s: { module: string; line: number; value: string }) => ({
      module: s.module,
      line: s.line,
      literal: s.value,
    });
    const exactHits = this.ws.index.strings.filter((s) => s.value === value);
    if (exactHits.length > 0) {
      return exactHits.map(toSeed);
    }
    const input = value.trim();
    if (input !== value) {
      const trimmedHits = this.ws.index.strings.filter(
        (s) => s.value === input,
      );
      if (trimmedHits.length > 0) {
        return trimmedHits.map(toSeed);
      }
    }
    try {
      const symbol = resolveSymbol(this.ws, input);
      return [{ module: symbol.module, line: symbol.line, name: symbol.name }];
    } catch (symbolError) {
      let parsed: ReturnType<typeof parseTarget> | undefined;
      try {
        parsed = parseTarget(input);
      } catch {
        parsed = undefined;
      }
      if (parsed?.kind === 'line' || parsed?.kind === 'range') {
        const entry = resolveModule(this.ws, parsed.module);
        const start = parsed.kind === 'line' ? parsed.line : parsed.start;
        const end = parsed.kind === 'line' ? parsed.line : parsed.end;
        const seeds: Seed[] = [];
        for (let line = start; line <= end; line++) {
          seeds.push(...this.seedsOnLine(entry, line));
        }
        if (seeds.length > 0) return seeds;
        throw new WcError(
          `No identifiers or string literals on ${entry.path}:${start}${end === start ? '' : `-${end}`}. Call wc_read ${entry.path}:${start} to see the code.`,
        );
      }
      if (
        symbolError instanceof WcError &&
        symbolError.suggestions.length > 0
      ) {
        throw symbolError;
      }
      // Dedupe the pool: one repeated literal (e.g. "Bearer " used in
      // several places) must not be suggested several times over.
      const candidates = suggest(
        input,
        new Set([
          ...this.ws.index.symbols.map((s) => s.name),
          ...this.ws.index.symbols.map((s) => `${s.module}:${s.name}`),
          ...this.ws.index.strings.map((s) => s.value),
        ]),
      );
      throw new WcError(
        `Unknown value ${JSON.stringify(value)}: no matching string literal, symbol or module:line.${candidates.length > 0 ? ` Did you mean ${candidates.map((c) => `\`${JSON.stringify(c)}\``).join(', ')}?` : ''} Call wc_search to find similar code.`,
        candidates,
      );
    }
  }

  /** Identifier and literal seeds from one source line. */
  private seedsOnLine(entry: ModuleEntry, line: number): Seed[] {
    const seeds: Seed[] = [];
    const seen = new Set<string>();
    const ast = getAst(entry);
    if (ast === undefined) return seeds;
    traverse(ast, {
      Identifier(path) {
        if (path.node.loc?.start.line !== line) return;
        const parent = path.parentPath?.node;
        // Skip property keys (`{ key: … }`, `obj.key`) — they name nothing.
        if (
          parent !== undefined &&
          ((parent.type === 'ObjectProperty' &&
            parent.key === path.node &&
            !parent.computed) ||
            ((parent.type === 'MemberExpression' ||
              parent.type === 'OptionalMemberExpression') &&
              parent.property === path.node &&
              !parent.computed))
        ) {
          return;
        }
        const key = `ident:${path.node.name}`;
        if (seen.has(key)) return;
        seen.add(key);
        seeds.push({ module: entry.path, line, name: path.node.name });
      },
      StringLiteral(path) {
        if (path.node.loc?.start.line !== line) return;
        const key = `literal:${path.node.value}`;
        if (seen.has(key)) return;
        seen.add(key);
        seeds.push({ module: entry.path, line, literal: path.node.value });
      },
    });
    return seeds;
  }

  // -- Step bookkeeping ------------------------------------------------------

  /** Append a step unless a cap stops the trace. */
  private push(step: Step): boolean {
    if (this.steps.length >= this.maxSteps) {
      this.capped = true;
      return false;
    }
    const dedupe = `${step.role}:${step.module}:${step.line}`;
    if (this.seenSteps.has(dedupe)) return true;
    this.seenSteps.add(dedupe);
    const code =
      step.code === '' ? lineAt(this.ws, step.module, step.line) : step.code;
    this.steps.push({ ...step, code });
    return true;
  }

  private pushSink(label: string, module: string, line: number): boolean {
    const key = `sink:${module}:${line}:${label}`;
    if (this.visited.has(key)) return true;
    this.visited.add(key);
    this.sinks.push({ label, module, line });
    return this.push({ module, line, role: 'sink', code: '' });
  }

  /** Guard against unbounded recursion: one visit per key. */
  private claim(key: string): boolean {
    if (this.visited.has(key)) return false;
    this.visited.add(key);
    return true;
  }

  private renderSection(title: string, start: number): string[] {
    const out = [`${title}:`];
    const own = this.steps.slice(start);
    if (own.length === 0) {
      out.push('No steps found.');
      return out;
    }
    for (const step of own) {
      const n = this.steps.indexOf(step) + 1;
      out.push(`${n}. ${step.module}:${step.line}  ${step.role}`);
      out.push('```js');
      out.push(step.code);
      out.push('```');
    }
    return out;
  }

  private renderSinks(): string[] {
    if (this.sinks.length === 0) return ['Sinks: none found.'];
    return [
      `Sinks (${this.sinks.length}):`,
      ...this.sinks.map((s) => `- ${s.label} at ${s.module}:${s.line}`),
    ];
  }

  // -- Backward ---------------------------------------------------------------

  private backwardFromSeed(seed: Seed): void {
    const key = `bseed:${seed.module}:${seed.line}:${seed.name ?? `=${seed.literal ?? ''}`}`;
    if (!this.claim(key)) return;
    if (
      !this.push({
        module: seed.module,
        line: seed.line,
        role: 'seed',
        code: lineAt(this.ws, seed.module, seed.line),
      })
    ) {
      return;
    }
    if (seed.name !== undefined) {
      this.backwardFromIdentifier(seed.module, seed.name, seed.line);
    } else {
      // A literal is atomic: show how its enclosing statement is built by
      // following the sibling identifiers on the same line.
      const located = seedPath(this.ws, seed);
      if (located === undefined) return;
      const statement = located.path.getStatementParent();
      if (statement === null) return;
      const names = new Set<string>();
      statement.traverse({
        Identifier(inner) {
          names.add(inner.node.name);
        },
      });
      for (const name of [...names].sort()) {
        this.backwardFromIdentifier(seed.module, name, seed.line);
      }
    }
  }

  /**
   * Follow an identifier to its reaching definition: a function parameter
   * (then the arguments at its call sites), a declaration with an
   * initializer, or an assignment — then recurse into the right-hand side.
   */
  private backwardFromIdentifier(
    module: string,
    name: string,
    refLine: number,
  ): void {
    const key = `bident:${module}:${name}:${refLine}`;
    if (!this.claim(key)) return;
    const entry = this.ws.modules.get(module);
    if (entry === undefined) return;
    const ast = getAst(entry);
    if (ast === undefined) return;
    const scopePath = scopeAtLine(ast, refLine);
    const binding =
      scopePath === undefined ? undefined : scopePath.scope.getBinding(name);
    if (binding === undefined) {
      this.backwardFromUnresolved(module, name, refLine);
      return;
    }
    if (binding.kind === 'param') {
      const line = nodeLine(binding.identifier, refLine);
      this.push({ module, line, role: 'param', code: '' });
      this.backwardParamToCallSites(module, binding, 0);
      return;
    }
    if (binding.kind === 'module') {
      // An import: show the local binding, then follow it to its definition.
      const line = nodeLine(binding.identifier, refLine);
      this.push({ module, line, role: 'init', code: '' });
      try {
        const symbol = resolveSymbol(this.ws, name, `${module}:${refLine}`);
        if (symbol.module !== module || symbol.line !== line) {
          this.push({
            module: symbol.module,
            line: symbol.line,
            role: 'init',
            code: '',
          });
        }
      } catch {
        // Follows nowhere (e.g. a namespace import): stop here.
      }
      return;
    }
    const declarator = binding.path;
    const init = declarator.isVariableDeclarator()
      ? declarator.node.init
      : undefined;
    if (
      declarator.isVariableDeclarator() &&
      init !== null &&
      init !== undefined
    ) {
      const line = nodeLine(declarator.node, refLine);
      this.push({ module, line, role: 'init', code: '' });
      this.backwardFromNode(module, init, 0);
      // A reassigned binding may carry an earlier value too.
      const prev = previousAssignment(binding, line);
      if (prev !== undefined) {
        this.push({ module, line: prev.line, role: 'assign', code: '' });
        this.backwardFromNode(module, prev.init, 0);
      }
      return;
    }
    if (binding.kind === 'hoisted' || binding.kind === 'local') {
      this.push({
        module,
        line: nodeLine(binding.identifier, refLine),
        role: 'init',
        code: '',
      });
      return;
    }
    // Declaration without an initializer: show it, then look for assignments.
    const line = nodeLine(binding.identifier, refLine);
    this.push({ module, line, role: 'init', code: '' });
    const prev = previousAssignment(binding, refLine);
    if (prev !== undefined) {
      this.push({ module, line: prev.line, role: 'assign', code: '' });
      this.backwardFromNode(module, prev.init, 0);
    }
  }

  /** No local binding (a global or a module-level name): show its definition. */
  private backwardFromUnresolved(
    module: string,
    name: string,
    refLine: number,
  ): void {
    try {
      const symbol = resolveSymbol(this.ws, name, `${module}:${refLine}`);
      if (symbol.module !== module || symbol.line !== refLine) {
        this.push({
          module: symbol.module,
          line: symbol.line,
          role: 'init',
          code: '',
        });
      }
    } catch {
      // A global like `fetch`: nothing more to follow.
    }
  }

  /** A function parameter flows from the arguments at its call sites. */
  private backwardParamToCallSites(
    module: string,
    binding: Binding,
    depth: number,
  ): void {
    // A parameter's binding.path is the parameter itself; the function
    // owns its scope.
    const fnPath = binding.scope.path;
    if (!fnPath.isFunction()) return;
    const names: string[] = [];
    for (const param of fnPath.node.params) patternNames(param, names);
    const paramName = binding.identifier.name;
    const paramIndex = names.indexOf(paramName);
    const fnLine = nodeLine(fnPath.node, 1);
    const caller = findEnclosingSymbol(this.ws, module, fnLine);
    if (caller === undefined || depth + 1 > this.maxDepth) {
      if (caller !== undefined) this.capped = true;
      return;
    }
    for (const site of callSitesOf(this.ws, caller)) {
      const args = callArguments(this.ws, site.module, site.line, caller.name);
      const arg = paramIndex === -1 ? undefined : args[paramIndex];
      this.push({
        module: site.module,
        line: site.line,
        role: 'arg',
        code: '',
      });
      if (arg !== undefined) this.backwardFromNode(site.module, arg, depth + 1);
    }
  }

  /**
   * Follow the expression that builds a value: initializers, string
   * concatenation, template literals, object properties, calls.
   */
  private backwardFromNode(module: string, node: Node, depth: number): void {
    const line = nodeLine(node, 1);
    const key = `bexpr:${module}:${line}:${node.type}`;
    if (!this.claim(key)) return;
    switch (node.type) {
      case 'Identifier':
        this.backwardFromIdentifier(module, node.name, line);
        return;
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'RegExpLiteral':
      case 'BigIntLiteral':
        this.push({ module, line, role: 'literal', code: '' });
        return;
      case 'TemplateLiteral':
        for (const expr of node.expressions) {
          this.backwardFromNode(module, expr, depth);
        }
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
        this.backwardFromNode(module, node.left, depth);
        this.backwardFromNode(module, node.right, depth);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        this.push({ module, line, role: 'call', code: '' });
        if (
          (node.callee.type === 'MemberExpression' ||
            node.callee.type === 'OptionalMemberExpression') &&
          node.callee.object.type !== 'ThisExpression'
        ) {
          this.backwardFromNode(module, node.callee.object, depth);
        }
        for (const arg of node.arguments) {
          if (
            arg.type !== 'SpreadElement' &&
            arg.type !== 'ArgumentPlaceholder'
          ) {
            this.backwardFromNode(module, arg, depth);
          }
        }
        // The result may itself be built in the callee: follow its returns.
        this.backwardIntoCallee(module, node, depth);
        return;
      }
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'UnaryExpression':
      case 'SpreadElement': {
        const argument = node.argument;
        if (argument !== null && argument !== undefined) {
          this.backwardFromNode(module, argument, depth);
        }
        return;
      }
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        this.backwardFromNode(module, node.expression, depth);
        return;
      case 'ParenthesizedExpression':
        this.backwardFromNode(module, node.expression, depth);
        return;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        this.backwardFromNode(module, node.object, depth);
        if (node.computed) this.backwardFromNode(module, node.property, depth);
        return;
      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type === 'ObjectProperty') {
            this.backwardFromNode(module, prop.value, depth);
          } else if (prop.type === 'SpreadElement') {
            this.backwardFromNode(module, prop.argument, depth);
          }
        }
        return;
      case 'ArrayExpression':
        for (const el of node.elements) {
          if (el !== null && el.type !== 'SpreadElement') {
            this.backwardFromNode(module, el, depth);
          }
        }
        return;
      case 'AssignmentExpression':
        this.backwardFromNode(module, node.right, depth);
        return;
      case 'ConditionalExpression':
        this.backwardFromNode(module, node.consequent, depth);
        this.backwardFromNode(module, node.alternate, depth);
        return;
      case 'SequenceExpression': {
        const last = node.expressions[node.expressions.length - 1];
        if (last !== undefined) this.backwardFromNode(module, last, depth);
        return;
      }
      default:
        return;
    }
  }

  /** A call result is built by the callee's returned expressions. */
  private backwardIntoCallee(
    module: string,
    node: Node & {
      type: 'CallExpression' | 'OptionalCallExpression' | 'NewExpression';
    },
    depth: number,
  ): void {
    if (depth + 1 > this.maxDepth) {
      this.capped = true;
      return;
    }
    const line = nodeLine(node, 1);
    const target = resolveCallTarget(
      this.ws,
      calleeText(node.callee),
      module,
      line,
    );
    if (target === undefined) return;
    const entry = this.ws.modules.get(target.module);
    if (entry === undefined) return;
    const ast = getAst(entry);
    if (ast === undefined) return;
    let found = false;
    traverse(ast, {
      ReturnStatement(path) {
        if (
          target.line <= (path.node.loc?.start.line ?? 0) &&
          (path.node.loc?.start.line ?? 0) <= target.endLine &&
          path.node.argument !== null
        ) {
          found = true;
        }
      },
    });
    if (!found) return;
    traverse(ast, {
      ReturnStatement: (path) => {
        const loc = path.node.loc;
        if (loc === null || loc === undefined) return;
        if (
          target.line <= loc.start.line &&
          loc.start.line <= target.endLine &&
          path.node.argument !== null &&
          path.node.argument !== undefined
        ) {
          this.push({
            module: target.module,
            line: loc.start.line,
            role: 'return',
            code: '',
          });
          this.backwardFromNode(target.module, path.node.argument, depth + 1);
        }
      },
    });
  }

  // -- Forward ------------------------------------------------------------------

  private forwardFromSeed(seed: Seed, depth: number): void {
    const key = `fseed:${seed.module}:${seed.line}:${seed.name ?? `=${seed.literal ?? ''}`}`;
    if (!this.claim(key)) return;
    if (
      !this.push({
        module: seed.module,
        line: seed.line,
        role: 'seed',
        code: lineAt(this.ws, seed.module, seed.line),
      })
    ) {
      return;
    }
    if (seed.name !== undefined) {
      this.forwardFromIdentifier(seed.module, seed.name, seed.line, depth);
    } else {
      const located = seedPath(this.ws, seed);
      if (located === undefined) return;
      this.forwardFromUse(seed.module, located.path, depth);
    }
  }

  private forwardFromIdentifier(
    module: string,
    name: string,
    refLine: number,
    depth: number,
  ): void {
    const key = `fident:${module}:${name}:${refLine}`;
    if (!this.claim(key)) return;
    const entry = this.ws.modules.get(module);
    if (entry === undefined) return;
    const ast = getAst(entry);
    if (ast === undefined) return;
    const scopePath = scopeAtLine(ast, refLine);
    const binding =
      scopePath === undefined ? undefined : scopePath.scope.getBinding(name);
    const refs = binding === undefined ? [] : binding.referencePaths;
    const lines = refs
      .map((r) => nodeLine(r.node, refLine))
      .filter((line, i, all) => all.indexOf(line) === i)
      .sort((a, b) => a - b);
    for (const line of lines) {
      const use = refs.find((r) => nodeLine(r.node, refLine) === line);
      if (use === undefined) continue;
      if (!this.push({ module, line, role: 'read', code: '' })) return;
      this.forwardFromUse(module, use, depth);
    }
    // Module-level bindings are also read through imports in other modules:
    // those uses are index refs, not locals of this module.
    if (binding !== undefined && binding.scope.path.isProgram()) {
      const symbol = this.ws.index.symbols.find(
        (s) =>
          s.module === module &&
          s.name === name &&
          s.line === nodeLine(binding.identifier, refLine),
      );
      if (symbol !== undefined) {
        for (const ref of this.ws.index.refs) {
          if (
            ref.defModule === symbol.module &&
            ref.defLine === symbol.line &&
            lastSegment(ref.name) === symbol.name
          ) {
            if (
              !this.push({
                module: ref.module,
                line: ref.line,
                role: 'read',
                code: '',
              })
            ) {
              return;
            }
            this.forwardFromRefLine(ref.module, ref.name, ref.line, depth);
          }
        }
      }
    }
    if (binding === undefined) {
      // No local binding: maybe a module-level symbol (e.g. tracing a
      // function name) — follow its indexed uses.
      this.forwardFromSymbolUses(module, name, refLine, depth);
    }
  }

  /** Follow indexed uses of a module-level symbol with no local binding. */
  private forwardFromSymbolUses(
    module: string,
    name: string,
    refLine: number,
    depth: number,
  ): void {
    let symbol: SymbolEntry | undefined;
    try {
      symbol = resolveSymbol(this.ws, name, `${module}:${refLine}`);
    } catch {
      return;
    }
    for (const ref of this.ws.index.refs) {
      if (
        ref.defModule === symbol.module &&
        ref.defLine === symbol.line &&
        lastSegment(ref.name) === symbol.name
      ) {
        if (
          !this.push({
            module: ref.module,
            line: ref.line,
            role: 'read',
            code: '',
          })
        ) {
          return;
        }
        this.forwardFromRefLine(ref.module, ref.name, ref.line, depth);
      }
    }
  }

  /** A use in another module, known only by line: re-locate the identifier. */
  private forwardFromRefLine(
    module: string,
    name: string,
    line: number,
    depth: number,
  ): void {
    const entry = this.ws.modules.get(module);
    if (entry === undefined) return;
    const ast = getAst(entry);
    if (ast === undefined) return;
    const short = lastSegment(name);
    let use: NodePath | undefined;
    traverse(ast, {
      Identifier(path) {
        if (use !== undefined) return;
        if (path.node.name !== short) return;
        if (path.node.loc?.start.line !== line) return;
        const parent = path.parentPath?.node;
        if (
          parent !== undefined &&
          ((parent.type === 'ObjectProperty' &&
            parent.key === path.node &&
            !parent.computed) ||
            ((parent.type === 'MemberExpression' ||
              parent.type === 'OptionalMemberExpression') &&
              parent.property === path.node &&
              !parent.computed))
        ) {
          return;
        }
        use = path;
      },
    });
    if (use !== undefined) this.forwardFromUse(module, use, depth);
  }

  /** A read of a tracked value: into call args, a new variable, or a return. */
  private forwardFromUse(module: string, use: NodePath, depth: number): void {
    if (
      /document\.cookie/.test(lineAt(this.ws, module, nodeLine(use.node, 1)))
    ) {
      this.pushSink('document.cookie', module, nodeLine(use.node, 1));
      return;
    }
    const target = classifyUse(use);
    switch (target.kind) {
      case 'call': {
        this.push({ module, line: target.line, role: 'call', code: '' });
        this.forwardIntoCall(
          module,
          target.line,
          target.callee,
          target.argIndex,
          depth,
        );
        return;
      }
      case 'callee': {
        // The tracked name itself is called here (a call site of the
        // function): follow what the call result flows into.
        this.push({ module, line: target.line, role: 'call', code: '' });
        const sink = sinkLabel(this.ws, target.callee, module, target.line);
        if (sink !== undefined) {
          this.pushSink(sink, module, target.line);
          return;
        }
        this.forwardFromCallResult(module, target.line, target.callee, depth);
        return;
      }
      case 'var': {
        if (
          target.name === (use.node.type === 'Identifier' ? use.node.name : '')
        ) {
          return;
        }
        this.push({
          module,
          line: target.line,
          role: target.assign ? 'assign' : 'init',
          code: '',
        });
        this.forwardFromIdentifier(module, target.name, target.line, depth);
        return;
      }
      case 'return': {
        this.push({ module, line: target.line, role: 'return', code: '' });
        this.forwardReturnToCallers(module, target.caller, depth);
        return;
      }
      case 'other':
        return;
    }
  }

  /** A call argument flows into the callee's parameter, or into a sink. */
  private forwardIntoCall(
    module: string,
    line: number,
    callee: string,
    argIndex: number,
    depth: number,
  ): void {
    const sink = sinkLabel(this.ws, callee, module, line);
    if (sink !== undefined) {
      this.pushSink(sink, module, line);
      return;
    }
    if (depth + 1 > this.maxDepth) {
      this.capped = true;
      return;
    }
    const target = resolveCallTarget(this.ws, callee, module, line);
    if (target?.params === undefined) return;
    const params =
      argIndex < 0
        ? target.params
        : target.params[argIndex] === undefined
          ? []
          : [target.params[argIndex]];
    for (const param of new Set(params)) {
      this.push({
        module: target.module,
        line: target.line,
        role: 'param',
        code: '',
      });
      this.forwardFromIdentifier(target.module, param, target.line, depth + 1);
    }
  }

  /**
   * A call result flows into its parent: a variable, an argument, a
   * return. `callee` selects which call on the line produced the value
   * (one line can hold nested calls, e.g. `send(buildUrl(…))`).
   */
  private forwardFromCallResult(
    module: string,
    line: number,
    callee: string,
    depth: number,
  ): void {
    const entry = this.ws.modules.get(module);
    if (entry === undefined) return;
    const ast = getAst(entry);
    if (ast === undefined) return;
    let call: NodePath | undefined;
    let fallback: NodePath | undefined;
    traverse(ast, {
      enter(path) {
        if (call !== undefined) {
          path.skip();
          return;
        }
        if (
          (path.isCallExpression() ||
            path.isOptionalCallExpression() ||
            path.isNewExpression()) &&
          path.node.loc?.start.line === line
        ) {
          if (fallback === undefined) fallback = path;
          if (calleeText(path.node.callee) === callee) call = path;
        }
      },
    });
    call ??= fallback;
    if (call === undefined) return;
    // Reuse the read classifier on the call itself: it climbs to the parent.
    const asUse = classifyCallResult(call);
    if (asUse === undefined) return;
    this.forwardFromUseCallResult(module, asUse, depth);
  }

  private forwardFromUseCallResult(
    module: string,
    target: ReadTarget,
    depth: number,
  ): void {
    switch (target.kind) {
      case 'call':
        this.push({ module, line: target.line, role: 'call', code: '' });
        this.forwardIntoCall(
          module,
          target.line,
          target.callee,
          target.argIndex,
          depth,
        );
        return;
      case 'callee':
        this.push({ module, line: target.line, role: 'call', code: '' });
        this.forwardFromCallResult(module, target.line, target.callee, depth);
        return;
      case 'var':
        this.push({
          module,
          line: target.line,
          role: target.assign ? 'assign' : 'init',
          code: '',
        });
        this.forwardFromIdentifier(module, target.name, target.line, depth);
        return;
      case 'return':
        this.push({ module, line: target.line, role: 'return', code: '' });
        this.forwardReturnToCallers(module, target.caller, depth);
        return;
      case 'other':
        return;
    }
  }

  /** A returned value flows to the callers of its function. */
  private forwardReturnToCallers(
    module: string,
    caller: string | undefined,
    depth: number,
  ): void {
    if (caller === undefined || depth + 1 > this.maxDepth) {
      if (caller !== undefined) this.capped = true;
      return;
    }
    const symbol = this.ws.index.symbols.find(
      (s) => s.module === module && s.name === caller && s.kind !== 'import',
    );
    if (symbol === undefined) return;
    for (const site of callSitesOf(this.ws, symbol)) {
      if (
        !this.push({
          module: site.module,
          line: site.line,
          role: 'call',
          code: '',
        })
      ) {
        return;
      }
      const next = depth + 1;
      if (next > this.maxDepth) {
        this.capped = true;
        return;
      }
      this.forwardFromCallResult(site.module, site.line, caller, next);
    }
  }
}

/** Classify the parent context of a call expression itself. */
function classifyCallResult(call: NodePath): ReadTarget | undefined {
  const parent = call.parentPath;
  if (parent === null) return undefined;
  const node = parent.node;
  switch (node.type) {
    case 'VariableDeclarator': {
      const id = node.id;
      if (node.init === call.node && id.type === 'Identifier') {
        return {
          kind: 'var',
          line: nodeLine(node, 1),
          name: id.name,
          assign: false,
        };
      }
      return { kind: 'other', line: nodeLine(node, 1) };
    }
    case 'AssignmentExpression':
      if (node.right === call.node && node.left.type === 'Identifier') {
        return {
          kind: 'var',
          line: nodeLine(node, 1),
          name: node.left.name,
          assign: true,
        };
      }
      return { kind: 'other', line: nodeLine(node, 1) };
    case 'ReturnStatement':
      return {
        kind: 'return',
        line: nodeLine(node, 1),
        caller: enclosingFunctionName(parent) ?? undefined,
      };
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression': {
      const argIndex = node.arguments.findIndex((a) => a === call.node);
      if (argIndex === -1) return { kind: 'other', line: nodeLine(node, 1) };
      return {
        kind: 'call',
        line: nodeLine(node, 1),
        callee: calleeText(node.callee),
        argIndex,
      };
    }
    case 'ObjectProperty':
    case 'ArrayExpression':
    case 'SpreadElement':
    case 'TemplateLiteral':
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
    case 'SequenceExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'UnaryExpression':
      // Climb through wrappers to the real consumer.
      return classifyCallResult(parent);
    default:
      return { kind: 'other', line: nodeLine(node, 1) };
  }
}

/** Nearest preceding `name = …` for a binding (reaching assignment). */
function previousAssignment(
  binding: Binding,
  beforeLine: number,
): { line: number; init: Node } | undefined {
  const name = binding.identifier.name;
  const scopePath = binding.scope.path;
  let best: { line: number; init: Node } | undefined;
  scopePath.traverse({
    AssignmentExpression(path) {
      const node = path.node;
      if (node.left.type !== 'Identifier' || node.left.name !== name) return;
      const line = nodeLine(node, beforeLine);
      if (line >= beforeLine) return;
      if (path.scope.getBinding(name) !== binding) return;
      if (best === undefined || line > best.line) {
        best = { line, init: node.right };
      }
    },
  });
  return best;
}

/** A top-level function/method symbol enclosing `module:line`, if any. */
function findEnclosingSymbol(
  ws: Workspace,
  module: string,
  line: number,
): SymbolEntry | undefined {
  let best: SymbolEntry | undefined;
  for (const symbol of ws.index.symbols) {
    if (symbol.module !== module) continue;
    if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;
    if (symbol.line <= line && line <= symbol.endLine) {
      if (best === undefined || symbol.line > best.line) best = symbol;
    }
  }
  return best;
}

/** Call sites whose callee resolves to `symbol` (index.calls + resolveSymbol). */
function callSitesOf(
  ws: Workspace,
  symbol: SymbolEntry,
): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  for (const call of ws.index.calls) {
    let target: SymbolEntry | undefined;
    try {
      target = resolveSymbol(ws, call.callee, `${call.module}:${call.line}`);
    } catch {
      continue;
    }
    if (
      target.module === symbol.module &&
      target.line === symbol.line &&
      target.name === symbol.name
    ) {
      if (!out.some((s) => s.module === call.module && s.line === call.line)) {
        out.push({ module: call.module, line: call.line });
      }
    }
  }
  return out;
}

/**
 * AST argument nodes of the call to `callee` starting on `module:line`
 * (one line can hold nested calls, so the callee name disambiguates).
 */
function callArguments(
  ws: Workspace,
  module: string,
  line: number,
  callee?: string,
): Node[] {
  const entry = ws.modules.get(module);
  if (entry === undefined) return [];
  const ast = getAst(entry);
  if (ast === undefined) return [];
  let args: Node[] = [];
  let fallback: Node[] = [];
  traverse(ast, {
    enter(path) {
      if (args.length > 0) {
        path.skip();
        return;
      }
      if (
        (path.isCallExpression() ||
          path.isOptionalCallExpression() ||
          path.isNewExpression()) &&
        path.node.loc?.start.line === line
      ) {
        const collected: Node[] = [];
        for (const a of path.node.arguments) {
          if (a.type !== 'SpreadElement' && a.type !== 'ArgumentPlaceholder') {
            collected.push(a);
          }
        }
        if (fallback.length === 0) fallback = collected;
        if (callee === undefined || calleeText(path.node.callee) === callee) {
          args = collected;
        }
      }
    },
  });
  return args.length > 0 ? args : fallback;
}

/** Resolve a call callee to a workspace function/method symbol, if any. */
function resolveCallTarget(
  ws: Workspace,
  callee: string,
  module: string,
  line: number,
): SymbolEntry | undefined {
  try {
    const target = resolveSymbol(ws, callee, `${module}:${line}`);
    if (target.kind === 'function' || target.kind === 'method') return target;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sink labels from the normalized callee name (index convention) plus
 * `document.cookie`, which is an assignment rather than a call.
 */
function sinkLabel(
  ws: Workspace,
  callee: string,
  module: string,
  line: number,
): string | undefined {
  if (callee === 'fetch') return 'fetch';
  if (callee.startsWith('axios.')) return callee;
  if (callee === 'XMLHttpRequest') return 'XMLHttpRequest';
  if (
    callee.endsWith('.open') ||
    callee.endsWith('.send') ||
    callee.endsWith('.setRequestHeader')
  ) {
    return `XMLHttpRequest ${lastSegment(callee)}`;
  }
  if (callee === 'WebSocket') return 'WebSocket';
  if (callee === 'postMessage' || callee.endsWith('.postMessage')) {
    return 'postMessage';
  }
  if (callee.endsWith('.setItem')) return callee;
  if (/document\.cookie/.test(lineAt(ws, module, line)))
    return 'document.cookie';
  return undefined;
}
