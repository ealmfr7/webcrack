import type { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
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

          const truthy = path.get('test').evaluateTruthy();
          if (truthy == null) return;

          if (truthy) {
            replace(path, path.get('consequent'));
          } else if (path.node.alternate) {
            replace(path, path.get('alternate') as NodePath);
          } else if (path.isIfStatement()) {
            path.remove();
          } else {
            return;
          }

          this.changes++;
        },
      },
      LogicalExpression(path) {
        if (path.node.operator !== '&&' && path.node.operator !== '||')
          return;

        const truthy = path.get('left').evaluateTruthy();
        if (truthy == null) return;

        const takeRight =
          (path.node.operator === '&&' && truthy) ||
          (path.node.operator === '||' && !truthy);
        path.replaceWith(takeRight ? path.get('right').node : path.get('left').node);
        this.changes++;
      },
      WhileStatement(path) {
        const truthy = path.get('test').evaluateTruthy();
        // A truthy test means an infinite loop, leave it alone.
        if (truthy == null || truthy) return;
        path.remove();
        this.changes++;
      },
    };
  },
} satisfies Transform;

function replace(
  path: NodePath<t.IfStatement | t.ConditionalExpression>,
  replacement: NodePath,
) {
  if (t.isBlockStatement(replacement.node)) {
    if (path.isIfStatement() && collides(replacement, path.scope)) {
      // Hoisting `let`/`const` out of the block would change scoping,
      // keep the block so the declarations stay scoped.
      path.replaceWith(replacement.node);
      return;
    }
    // If statements can contain variables that shadow variables in the parent scope.
    // Since the block scope is merged with the parent scope, we need to rename those
    // variables to avoid duplicate declarations.
    const childBindings = replacement.scope.bindings;
    for (const name in childBindings) {
      const binding = childBindings[name];
      if (path.scope.hasOwnBinding(name)) {
        renameFast(binding, path.scope.generateUid(name));
      }
      binding.scope = path.scope;
      path.scope.bindings[binding.identifier.name] = binding;
    }
    path.replaceWithMultiple(replacement.node.body);
  } else {
    path.replaceWith(replacement);
  }
}

function collides(block: NodePath, scope: Scope): boolean {
  const bindings = block.scope?.bindings ?? {};
  return Object.keys(bindings).some((name) => scope.hasBinding(name));
}
