import type { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Transform } from '../ast-utils';
import { renameFast } from '../ast-utils';

export default {
  name: 'opaque-predicates',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      'IfStatement|ConditionalExpression': {
        exit(_path) {
          const path = _path as NodePath<
            t.IfStatement | t.ConditionalExpression
          >;

          // evaluateTruthy() is confident even for tests with side effects
          // (e.g. sequence expressions), so bail unless the test is pure.
          if (!isSideEffectFree(path.node.test)) return;

          // Babel's evaluateTruthy() dereferences path.scope, which is null
          // for nodes created during the traversal: the deobfuscate
          // fixpoint loop runs with noScope.
          const truthy = safeEvaluateTruthy(path.get('test'));
          if (truthy == null) return;

          if (truthy) {
            replace(path, path.get('consequent'), path.node.alternate);
          } else if (path.node.alternate) {
            replace(
              path,
              path.get('alternate') as NodePath,
              path.node.consequent,
            );
          } else if (path.isIfStatement()) {
            removePreservingHoisted(path, path.node.consequent);
          } else {
            return;
          }

          this.changes++;
        },
      },
      LogicalExpression(path) {
        if (path.node.operator !== '&&' && path.node.operator !== '||') return;
        if (!isSideEffectFree(path.node.left)) return;

        const truthy = safeEvaluateTruthy(path.get('left'));
        if (truthy == null) return;

        const takeRight =
          (path.node.operator === '&&' && truthy) ||
          (path.node.operator === '||' && !truthy);
        path.replaceWith(
          takeRight ? path.get('right').node : path.get('left').node,
        );
        this.changes++;
      },
      WhileStatement(path) {
        if (!isSideEffectFree(path.node.test)) return;
        const truthy = safeEvaluateTruthy(path.get('test'));
        // A truthy test means an infinite loop, leave it alone.
        if (truthy == null || truthy) return;
        removePreservingHoisted(path, path.node.body);
        this.changes++;
      },
    };
  },
} satisfies Transform;

function replace(
  path: NodePath<t.IfStatement | t.ConditionalExpression>,
  replacement: NodePath,
  dropped: t.Node | null | undefined,
) {
  // `var` and function declarations in the dropped branch are hoisted, so
  // they must survive in the replacement itself (`var` is function-scoped,
  // so it can go anywhere in it). insertBefore must not be used: outside a
  // statement list Babel wraps the node in a block and repoints `path`, so
  // the following replacement would discard the var.
  const varDecl =
    path.isIfStatement() && dropped ? hoistedVarDecl(dropped) : null;
  // The deobfuscate fixpoint loop runs with noScope, where path.scope is
  // null. Binding-based checks and renames are skipped then; the fallback
  // is always the safe option (keep the block).
  const scope: Scope | null = path.scope ?? null;
  if (t.isBlockStatement(replacement.node)) {
    const body = varDecl
      ? [varDecl, ...replacement.node.body]
      : [...replacement.node.body];
    const keepBlock =
      path.parentPath.isLabeledStatement() ||
      (scope
        ? collides(replacement, scope)
        : hasLexicalDeclarations(replacement.node));
    if (path.isIfStatement() && keepBlock) {
      // Splicing would drop the label (breaking `break label`), or hoist
      // `let`/`const` into the outer scope unsafely: keep the block.
      path.replaceWith(t.blockStatement(body));
      return;
    }
    if (!Array.isArray(path.container)) {
      // Single-statement position (else-if alternate, loop body, ...):
      // multiple statements cannot be spliced here, keep the block.
      path.replaceWith(t.blockStatement(body));
      return;
    }
    if (scope !== null) {
      // If statements can contain variables that shadow variables in the parent scope.
      // Since the block scope is merged with the parent scope, we need to rename those
      // variables to avoid duplicate declarations.
      const childBindings = replacement.scope.bindings;
      for (const name in childBindings) {
        const binding = childBindings[name];
        if (scope.hasOwnBinding(name)) {
          renameFast(binding, scope.generateUid(name));
        }
        binding.scope = scope;
        scope.bindings[binding.identifier.name] = binding;
      }
    }
    path.replaceWithMultiple(body);
  } else if (varDecl && path.isIfStatement()) {
    path.replaceWith(
      t.blockStatement([varDecl, replacement.node as t.Statement]),
    );
  } else {
    path.replaceWith(replacement);
  }
}

function hoistedVarDecl(node: t.Node): t.VariableDeclaration | null {
  const names = collectHoistedVars(node);
  return names.length ? varDeclaration(names) : null;
}

function removePreservingHoisted(
  path: NodePath<t.IfStatement | t.WhileStatement>,
  removed: t.Statement,
) {
  const hoisted = collectHoistedVars(removed);
  if (hoisted.length) {
    // replaceWith keeps an enclosing label, unlike remove().
    path.replaceWith(varDeclaration(hoisted));
  } else {
    path.remove();
  }
}

// Syntactic fallback for collides() when there is no scope: splicing a
// block with lexical declarations is unsafe without binding info, since an
// outer reference to the same name would be captured.
function hasLexicalDeclarations(node: t.Node): boolean {
  let found = false;
  const visit = (n: t.Node, isRoot: boolean): void => {
    if (found) return;
    if (!isRoot && (t.isFunction(n) || t.isClass(n))) return;
    if (
      (t.isVariableDeclaration(n) && n.kind !== 'var') ||
      t.isClassDeclaration(n) ||
      t.isFunctionDeclaration(n)
    ) {
      found = true;
      return;
    }
    for (const key of VISITOR_KEYS[n.type] ?? []) {
      const child = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) if (t.isNode(c)) visit(c, false);
      } else if (t.isNode(child)) {
        visit(child, false);
      }
    }
  };
  visit(node, true);
  return found;
}

// evaluateTruthy() dereferences path.scope, which is null for nodes
// created during a noScope traversal (the deobfuscate fixpoint loop).
// Skip those instead of crashing; same try/catch pattern as
// constant-folding.
function safeEvaluateTruthy(test: NodePath): boolean | undefined {
  try {
    return test.evaluateTruthy();
  } catch {
    return undefined;
  }
}

function collides(block: NodePath, scope: Scope): boolean {
  const bindings = block.scope?.bindings ?? {};
  return Object.keys(bindings).some(
    (name) =>
      scope.hasBinding(name) ||
      // A spliced `let`/`const` would also capture unbound references to
      // the same name elsewhere, e.g. after the block.
      scope.hasGlobal(name),
  );
}

// `evaluateTruthy()` reports confident for tests with side effects such as
// `(sideEffect(), true)` or `void sideEffect()`, which must not be dropped.
function isSideEffectFree(node: t.Node | null | undefined): boolean {
  if (node == null) return true;
  switch (node.type) {
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'SequenceExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
      return false;
    case 'UnaryExpression':
      return (
        node.operator !== 'void' &&
        node.operator !== 'delete' &&
        isSideEffectFree(node.argument)
      );
    default: {
      const keys = VISITOR_KEYS[node.type];
      if (!keys) return true;
      return keys.every((key) => {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child))
          return child.every((c) => !t.isNode(c) || isSideEffectFree(c));
        return !t.isNode(child) || isSideEffectFree(child);
      });
    }
  }
}

// `var` declarations and function declarations hoist out of dead code, so
// removing it outright would turn later uses into ReferenceErrors. Collect
// the names without crossing function/class boundaries (`var` inside a
// nested function belongs to that function, not the outer scope).
function collectHoistedVars(node: t.Node): string[] {
  const names = new Set<string>();
  const visit = (n: t.Node, isRoot: boolean) => {
    if (t.isVariableDeclaration(n) && n.kind === 'var') {
      for (const name of Object.keys(t.getBindingIdentifiers(n)))
        names.add(name);
    }
    if (t.isFunctionDeclaration(n) && n.id) names.add(n.id.name);
    if (!isRoot && (t.isFunction(n) || t.isClass(n))) return;
    for (const key of VISITOR_KEYS[n.type] ?? []) {
      const child = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) if (t.isNode(c)) visit(c, false);
      } else if (t.isNode(child)) {
        visit(child, false);
      }
    }
  };
  visit(node, true);
  return [...names];
}

function varDeclaration(names: string[]): t.VariableDeclaration {
  return t.variableDeclaration(
    'var',
    names.map((name) => t.variableDeclarator(t.identifier(name))),
  );
}
