import traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import debug from 'debug';
import type { AsyncTransform } from '../ast-utils';
import { generate } from '../ast-utils';
import type { Sandbox } from './vm';

// Results longer than this are left in place: inlining them would bloat the
// output and they are usually bulk data rather than decoded strings.
const MAX_RESULT_LENGTH = 10_000;

// Globals that a pure decoder may reference. Everything else (console,
// process, Date, ...) makes a function ineligible. Note `Math` is allowlisted
// but `Math.random` is rejected separately below.
const PURE_GLOBALS = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Math',
  'JSON',
  'Array',
  'Object',
  'RegExp',
  'parseInt',
  'parseFloat',
  'atob',
  'btoa',
  'escape',
  'unescape',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isNaN',
  'isFinite',
]);

type FunctionPath = NodePath<
  t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression
>;

interface Candidate {
  name: string;
  binding: Binding;
  fnPath: FunctionPath;
  /** Other candidates referenced by this function. */
  helpers: Set<string>;
  /** Snapshot of reference paths taken before any mutation. */
  refs: NodePath[];
  /**
   * Name of the candidate whose body contains each ref, or null for
   * top-level uses. Parallel to `refs`.
   */
  refOwners: (string | null)[];
  pure: boolean;
}

function isLocalBinding(binding: Binding, fnScope: Scope): boolean {
  let scope: Scope | null = binding.scope;
  while (scope) {
    if (scope === fnScope) return true;
    scope = scope.parent;
  }
  return false;
}

/**
 * Name of the candidate whose function body contains `ref`, or null when
 * the use is at the top level of the program.
 */
function enclosingCandidate(
  ref: NodePath,
  candidates: Map<string, Candidate>,
): string | null {
  let path: NodePath | null = ref;
  while (path) {
    for (const candidate of candidates.values()) {
      if (candidate.fnPath.node === path.node) return candidate.name;
    }
    path = path.parentPath;
  }
  return null;
}

function isLiteralArg(node: t.Node): boolean {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isBigIntLiteral(node) ||
    (t.isTemplateLiteral(node) && node.expressions.length === 0) ||
    (t.isUnaryExpression(node, { prefix: true }) &&
      node.operator !== 'delete' &&
      isLiteralArg(node.argument))
  );
}

function isPrimitiveResult(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  );
}

/**
 * Checks that the function only reads its params, locals, other candidates
 * and whitelisted globals, and performs no observable side effects.
 * Returns the set of other candidates it references, or null if impure.
 */
function analyzePurity(
  candidate: Candidate,
  candidates: Map<string, Candidate>,
): Set<string> | null {
  const { fnPath, name: ownName } = candidate;
  const fnScope = fnPath.scope;
  const helpers = new Set<string>();
  let pure = true;

  fnPath.traverse({
    ReferencedIdentifier(path) {
      if (!pure) return;
      const name = path.node.name;
      // `arguments` behaves like a local
      if (name === 'arguments') return;
      const binding = path.scope.getBinding(name);
      if (!binding) {
        if (!PURE_GLOBALS.has(name)) pure = false;
        return;
      }
      if (isLocalBinding(binding, fnScope)) return;
      // Self-recursion stays pure; other candidates are pure helpers
      // (their own purity is resolved with a fixpoint below).
      if (name === ownName || candidates.has(name)) {
        if (name !== ownName) helpers.add(name);
        return;
      }
      pure = false;
    },
    AssignmentExpression(path) {
      if (!pure) return;
      const target = path.get('left');
      // Writes through a member expression may mutate params or outer
      // objects, so they always disqualify the function.
      if (target.isMemberExpression() || target.isOptionalMemberExpression()) {
        pure = false;
        return;
      }
      for (const name of Object.keys(target.getBindingIdentifiers())) {
        const binding = target.scope.getBinding(name);
        if (!binding || !isLocalBinding(binding, fnScope)) {
          pure = false;
          return;
        }
      }
    },
    UpdateExpression(path) {
      if (!pure) return;
      const argument = path.get('argument');
      if (!argument.isIdentifier()) {
        pure = false;
        return;
      }
      const binding = argument.scope.getBinding(argument.node.name);
      if (!binding || !isLocalBinding(binding, fnScope)) pure = false;
    },
    UnaryExpression(path) {
      if (path.node.operator === 'delete') pure = false;
    },
    MemberExpression(path) {
      if (!pure) return;
      // `Math.random()` is non-deterministic, unlike the rest of `Math`.
      // Computed access (`Math[expr]`) may resolve to `random` at runtime
      // (`Math[atob("cmFuZG9t")]`, `Math['ran' + 'dom']`), so every
      // computed access on the global `Math` is rejected.
      const object = path.get('object');
      if (!object.isIdentifier({ name: 'Math' })) return;
      if (object.scope.getBinding('Math')) return;
      const property = path.get('property');
      if (
        path.node.computed ||
        (property.isIdentifier() && property.node.name === 'random') ||
        (property.isStringLiteral() && property.node.value === 'random')
      ) {
        pure = false;
      }
    },
    'ThisExpression|Super|YieldExpression|AwaitExpression|Import|JSXElement|JSXFragment'() {
      pure = false;
    },
  });

  return pure ? helpers : null;
}

/**
 * Replaces calls to generic pure decoder functions with the evaluated
 * result. E.g. `xor('ab', 3)` -> `'b`'`.
 *
 * Unlike the string-array decoders this works on any sufficiently pure
 * function (base64/xor/charCode-shift helpers, ...) as long as it is called
 * at least twice with only literal arguments.
 */
export default {
  name: 'generic-decoders',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    if (!sandbox) return;

    const scopes: Scope[] = [];
    traverse(ast, {
      Program(path) {
        scopes.push(path.scope);
        path.stop();
      },
    });
    const programScope = scopes[0];
    if (!programScope) return;

    // Collect top-level functions bound to a constant: only those can be
    // safely regenerated as standalone code for the sandbox.
    const candidates = new Map<string, Candidate>();
    for (const [name, binding] of Object.entries(programScope.bindings)) {
      if (!binding.constant) continue;
      const bindingPath = binding.path;
      let fnPath: FunctionPath | null = null;
      if (
        bindingPath.isFunctionDeclaration() &&
        bindingPath.node.id?.name === name
      ) {
        fnPath = bindingPath;
      } else if (bindingPath.isVariableDeclarator()) {
        const { id, init } = bindingPath.node;
        if (
          t.isIdentifier(id, { name }) &&
          (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))
        ) {
          fnPath = bindingPath.get('init') as FunctionPath;
        }
      }
      if (!fnPath) continue;
      if (fnPath.node.async || fnPath.node.generator) continue;
      candidates.set(name, {
        name,
        binding,
        fnPath,
        helpers: new Set(),
        refs: [...binding.referencePaths],
        refOwners: [],
        pure: false,
      });
    }
    if (candidates.size === 0) return;

    for (const candidate of candidates.values()) {
      candidate.refOwners = candidate.refs.map((ref) =>
        enclosingCandidate(ref, candidates),
      );
    }

    for (const candidate of candidates.values()) {
      const helpers = analyzePurity(candidate, candidates);
      if (helpers) {
        candidate.helpers = helpers;
        candidate.pure = true;
      }
    }

    // A function that (transitively) depends on an impure helper is impure.
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of candidates.values()) {
        if (!candidate.pure) continue;
        for (const helper of candidate.helpers) {
          if (!candidates.get(helper)?.pure) {
            candidate.pure = false;
            changed = true;
            break;
          }
        }
      }
    }

    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };
    const setupSource = new Map<string, string>();
    const buildSetup = (
      name: string,
      ordered: string[],
      seen: Set<string>,
    ): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const candidate = candidates.get(name);
      if (!candidate?.pure) return;
      for (const helper of candidate.helpers) buildSetup(helper, ordered, seen);
      let source = setupSource.get(name);
      if (!source) {
        const { fnPath } = candidate;
        source = fnPath.isFunctionDeclaration()
          ? generate(fnPath.node, generateOptions)
          : `const ${name}=${generate(fnPath.node, generateOptions)};`;
        setupSource.set(name, source);
      }
      if (!ordered.includes(source)) ordered.push(source);
    };

    const isDirectLiteralCall = (
      ref: NodePath,
    ): ref is NodePath<t.Identifier> => {
      const parent = ref.parentPath;
      return (
        !!parent &&
        parent.isCallExpression() &&
        parent.node.callee === ref.node &&
        parent.node.arguments.every(isLiteralArg)
      );
    };

    const removed = new Set<string>();
    for (const candidate of candidates.values()) {
      if (!candidate.pure || candidate.refs.length < 2) continue;
      // Every use must be a direct call with only literal arguments;
      // anything else (aliases, non-literal args) leaves the function alone.
      if (!candidate.refs.every(isDirectLiteralCall)) continue;
      const calls = candidate.refs.map(
        (ref) => ref.parentPath as NodePath<t.CallExpression>,
      );

      const setup: string[] = [];
      buildSetup(candidate.name, setup, new Set());
      const code = `(()=>{${setup.join('')}return [${calls
        .map((call) => generate(call.node, generateOptions))
        .join(',')}]})()`;
      let results: unknown[];
      try {
        const value: unknown = await sandbox(code);
        if (!Array.isArray(value) || value.length !== calls.length) continue;
        results = value;
      } catch {
        continue;
      }

      let replaced = 0;
      for (let i = 0; i < calls.length; i++) {
        const value = results[i];
        if (!isPrimitiveResult(value)) continue;
        if (typeof value === 'string' && value.length > MAX_RESULT_LENGTH)
          continue;
        calls[i].replaceWith(t.valueToNode(value));
        replaced++;
      }
      state.changes += replaced;
      debug('webcrack:deobfuscate')(
        `Generic Decoder: ${candidate.name}, inlined ${replaced}/${calls.length} calls`,
      );

      if (replaced === calls.length) {
        removeCandidate(candidate);
        removed.add(candidate.name);
        state.changes += 1;
      }
    }

    // Helpers referenced only from functions removed above are dead now
    // too. Functions that were never referenced to begin with are left
    // alone for the dead-code pass.
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
        path.stop();
      },
    });
    for (const candidate of candidates.values()) {
      if (!candidate.pure || removed.has(candidate.name)) continue;
      if (candidate.refs.length === 0) continue;
      // A remaining use outside the removed functions keeps it alive.
      const stillReferenced = candidate.refOwners.some(
        (owner) => owner === null || !removed.has(owner),
      );
      if (stillReferenced) continue;
      removeCandidate(candidate);
      removed.add(candidate.name);
      state.changes += 1;
    }

    function removeCandidate(candidate: Candidate): void {
      const bindingPath = candidate.binding.path;
      if (bindingPath.isFunctionDeclaration()) {
        bindingPath.remove();
      } else if (bindingPath.isVariableDeclarator()) {
        const declaration = bindingPath.parentPath;
        if (
          declaration.isVariableDeclaration() &&
          declaration.node.declarations.length === 1
        ) {
          declaration.remove();
        } else {
          bindingPath.remove();
        }
      }
    }
  },
} satisfies AsyncTransform<Sandbox>;
