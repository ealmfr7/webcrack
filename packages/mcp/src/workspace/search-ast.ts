import { parse } from '@babel/parser';
import type { File, Node } from '@babel/types';
import { WcError } from '../format/errors';
import { matchModules } from '../format/target';
import type { ModuleEntry, SearchHit, Workspace } from './types';

/**
 * AST-pattern search (M2.5): match a JS pattern with `$X` / `$$ARGS`
 * wildcards (ast-grep style) against the workspace modules (or one module).
 * `search.ts` delegates `kind=ast` here.
 *
 * - `$X` matches exactly one node; a repeated `$X` must match structurally
 *   equal nodes.
 * - `$$ARGS` matches zero or more nodes, but only inside lists (call args,
 *   array elements, object properties, statements, params). A `$$NAME`
 *   written as an object shorthand (`{ $$R }`), a spread (`...$$R`), or a
 *   bare statement (`$$R;`) is also a rest wildcard for that list.
 */

const MAX_HITS = 1000;
const TIME_BUDGET_MS = 2000;
const VISIT_BUDGET = 1000000;
const MAX_TEXT_LENGTH = 200;
const PATTERN_EXAMPLE = 'fetch($URL, $$REST)';

/** Node fields that never participate in matching or equality. */
const IGNORED_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

/** Parse cache keyed on the ModuleEntry OBJECT; reparse when code changed. */
const astCache = new WeakMap<ModuleEntry, { code: string; ast: File }>();

function getModuleAst(entry: ModuleEntry): File {
  const cached = astCache.get(entry);
  if (cached !== undefined && cached.code === entry.code) return cached.ast;
  const ast = parse(entry.code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: ['jsx'],
  });
  astCache.set(entry, { code: entry.code, ast });
  return ast;
}

type ParsedPattern =
  | { kind: 'node'; node: Node }
  | { kind: 'list'; nodes: Node[] };

function patternError(pattern: string, message: string): WcError {
  return new WcError(
    `Invalid AST pattern ${JSON.stringify(pattern)}: ${message} Example: \`${PATTERN_EXAMPLE}\`.`,
  );
}

/**
 * Parse the pattern as an expression first (wrapped in parens, so
 * `{ a: $X }` reads as an object), falling back to a statement (or a
 * statement list). Unparseable input throws a `WcError`.
 */
function parsePattern(pattern: string): ParsedPattern {
  if (pattern.trim() === '') throw patternError(pattern, 'Pattern is empty.');
  const options: {
    sourceType: 'unambiguous';
    errorRecovery: boolean;
    plugins: ['jsx'];
  } = {
    sourceType: 'unambiguous',
    errorRecovery: false,
    plugins: ['jsx'],
  };
  try {
    const file = parse(`(${pattern})`, options);
    const stmt = file.program.body[0];
    if (stmt !== undefined && stmt.type === 'ExpressionStatement') {
      return { kind: 'node', node: stmt.expression };
    }
  } catch {
    // Not an expression: try a statement (or statement list) below.
  }
  try {
    const file = parse(pattern, options);
    const { body } = file.program;
    if (body.length === 1) return { kind: 'node', node: body[0] };
    if (body.length > 1) return { kind: 'list', nodes: [...body] };
    throw patternError(pattern, 'Pattern is empty.');
  } catch (error) {
    if (error instanceof WcError) throw error;
    throw patternError(
      pattern,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

function field(node: Node, key: string): unknown {
  return (node as unknown as Record<string, unknown>)[key];
}

/** A `$Name` (or `$$Name`) wildcard in single-node position. */
function singleWildcardName(node: Node): string | undefined {
  if (node.type !== 'Identifier') return undefined;
  const name = field(node, 'name');
  if (typeof name !== 'string' || !name.startsWith('$')) return undefined;
  return name;
}

/** A `$$Name` identifier standing alone. */
function restNameOfIdentifier(node: Node): string | undefined {
  if (node.type !== 'Identifier') return undefined;
  const name = field(node, 'name');
  if (typeof name !== 'string' || !name.startsWith('$$')) return undefined;
  return name;
}

/**
 * The rest-wildcard name when a list element denotes "zero or more nodes":
 * a bare `$$R`, a `$$R;` statement, a `{ $$R }` shorthand property, or a
 * `...$$R` spread.
 */
function asRestName(element: unknown): string | undefined {
  if (!isNode(element)) return undefined;
  const direct = restNameOfIdentifier(element);
  if (direct !== undefined) return direct;
  if (element.type === 'ExpressionStatement') {
    const expression = field(element, 'expression');
    if (isNode(expression)) return restNameOfIdentifier(expression);
    return undefined;
  }
  if (element.type === 'SpreadElement') {
    const argument = field(element, 'argument');
    if (isNode(argument)) return restNameOfIdentifier(argument);
    return undefined;
  }
  if (element.type === 'ObjectProperty') {
    if (field(element, 'shorthand') !== true) return undefined;
    const key = field(element, 'key');
    const value = field(element, 'value');
    if (!isNode(key) || !isNode(value)) return undefined;
    const name = restNameOfIdentifier(key);
    if (name === undefined) return undefined;
    return field(value, 'name') === name ? name : undefined;
  }
  return undefined;
}

/** Structural equality ignoring location/extra/comments. */
function nodesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = normalize(record[key]);
    }
    return out;
  }
  return value;
}

function restoreBindings(
  bindings: Map<string, unknown>,
  snapshot: Map<string, unknown>,
): void {
  bindings.clear();
  for (const [key, value] of snapshot) bindings.set(key, value);
}

function matchSingleWildcard(
  name: string,
  target: Node,
  bindings: Map<string, unknown>,
): boolean {
  const bound = bindings.get(name);
  if (bound === undefined) {
    bindings.set(name, target);
    return true;
  }
  return !Array.isArray(bound) && nodesEqual(bound, target);
}

function bindRest(
  name: string,
  consumed: unknown[],
  bindings: Map<string, unknown>,
): boolean {
  const bound = bindings.get(name);
  if (bound === undefined) {
    bindings.set(name, consumed);
    return true;
  }
  return (
    Array.isArray(bound) &&
    bound.length === consumed.length &&
    bound.every((node, index) => nodesEqual(node, consumed[index]))
  );
}

/** Structural match of one pattern node against one target node. */
function match(
  pattern: Node,
  target: Node,
  bindings: Map<string, unknown>,
): boolean {
  const wildcard = singleWildcardName(pattern);
  if (wildcard !== undefined) {
    return matchSingleWildcard(wildcard, target, bindings);
  }
  if (pattern.type !== target.type) return false;
  const patternFields = pattern as unknown as Record<string, unknown>;
  for (const key of Object.keys(patternFields)) {
    if (key === 'type' || IGNORED_KEYS.has(key)) continue;
    if (!matchValue(patternFields[key], field(target, key), bindings)) {
      return false;
    }
  }
  return true;
}

function matchValue(
  patternValue: unknown,
  targetValue: unknown,
  bindings: Map<string, unknown>,
): boolean {
  if (Array.isArray(patternValue)) {
    return (
      Array.isArray(targetValue) &&
      matchList(patternValue, targetValue, bindings)
    );
  }
  if (isNode(patternValue)) {
    return isNode(targetValue) && match(patternValue, targetValue, bindings);
  }
  return patternValue === targetValue;
}

/** List match with `$$R` rest wildcards (backtracking over the split). */
function matchList(
  patterns: unknown[],
  targets: unknown[],
  bindings: Map<string, unknown>,
): boolean {
  if (patterns.length === 0) return targets.length === 0;
  const rest = asRestName(patterns[0]);
  if (rest !== undefined) {
    for (let take = 0; take <= targets.length; take++) {
      const snapshot = new Map(bindings);
      if (
        bindRest(rest, targets.slice(0, take), bindings) &&
        matchList(patterns.slice(1), targets.slice(take), bindings)
      ) {
        return true;
      }
      restoreBindings(bindings, snapshot);
    }
    return false;
  }
  if (targets.length === 0) return false;
  const snapshot = new Map(bindings);
  if (!matchValue(patterns[0], targets[0], bindings)) {
    restoreBindings(bindings, snapshot);
    return false;
  }
  if (!matchList(patterns.slice(1), targets.slice(1), bindings)) {
    restoreBindings(bindings, snapshot);
    return false;
  }
  return true;
}

function toHit(entry: ModuleEntry, node: Node): SearchHit {
  const line = node.loc?.start.line ?? 1;
  let text: string;
  if (
    typeof node.start === 'number' &&
    typeof node.end === 'number' &&
    node.end > node.start
  ) {
    text = entry.code.slice(node.start, node.end).split('\n')[0]?.trim() ?? '';
  } else {
    text = (entry.code.split('\n')[line - 1] ?? '').trim();
  }
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  return { module: entry.path, line, text };
}

export function searchAst(
  ws: Workspace,
  pattern: string,
  module?: string,
): SearchHit[] {
  const parsed = parsePattern(pattern);
  const entries = matchModules(ws, module);
  const hits: SearchHit[] = [];
  let truncated: 'hits' | 'budget' | undefined;
  let current: ModuleEntry | undefined;
  const startTime = Date.now();
  let visits = 0;

  const budgetExceeded = (): boolean =>
    visits >= VISIT_BUDGET || Date.now() - startTime > TIME_BUDGET_MS;

  outer: for (const entry of entries) {
    current = entry;
    const ast = getModuleAst(entry);
    const stack: unknown[] = [ast];
    while (stack.length > 0) {
      const value = stack.pop();
      if (Array.isArray(value)) {
        const items: unknown[] = value;
        for (let index = items.length - 1; index >= 0; index--) {
          const element = items[index];
          if (isNode(element) || Array.isArray(element)) {
            stack.push(element);
          }
        }
        continue;
      }
      if (!isNode(value)) continue;
      visits += 1;
      if (visits % 512 === 0 && budgetExceeded()) {
        truncated = 'budget';
        break outer;
      }
      let matched: boolean;
      if (parsed.kind === 'node') {
        matched = match(parsed.node, value, new Map());
      } else {
        matched = false;
        const fields = value as unknown as Record<string, unknown>;
        for (const key of Object.keys(fields)) {
          if (IGNORED_KEYS.has(key)) continue;
          const fieldValue = fields[key];
          if (
            Array.isArray(fieldValue) &&
            fieldValue.length > 0 &&
            matchList(parsed.nodes, fieldValue, new Map())
          ) {
            matched = true;
            break;
          }
        }
      }
      if (matched) {
        if (hits.length >= MAX_HITS) {
          truncated = 'hits';
          break outer;
        }
        hits.push(toHit(entry, value));
      }
      const fields = value as unknown as Record<string, unknown>;
      const keys = Object.keys(fields);
      for (let index = keys.length - 1; index >= 0; index--) {
        const fieldValue = fields[keys[index]];
        if (isNode(fieldValue) || Array.isArray(fieldValue)) {
          stack.push(fieldValue);
        }
      }
    }
  }

  if (truncated !== undefined && current !== undefined) {
    hits.push({
      module: current.path,
      line: 1,
      text:
        truncated === 'hits'
          ? `Search truncated: more than ${MAX_HITS} matches; refine the pattern or narrow the module filter.`
          : 'Search truncated: node/time budget exceeded; refine the pattern or narrow the module filter.',
    });
  }
  return hits;
}
