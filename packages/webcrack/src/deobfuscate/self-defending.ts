import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import {
  constMemberExpression,
  falseMatcher,
  findParent,
  iife,
  trueMatcher,
} from '../ast-utils';

// SingleCallController: https://github.com/javascript-obfuscator/javascript-obfuscator/blob/d7f73935557b2cd15a2f7cd0b01017d9cddbd015/src/custom-code-helpers/common/templates/SingleCallControllerTemplate.ts

// Works for
// self defending: https://github.com/javascript-obfuscator/javascript-obfuscator/blob/d7f73935557b2cd15a2f7cd0b01017d9cddbd015/src/custom-code-helpers/self-defending/templates/SelfDefendingTemplate.ts
// domain lock: https://github.com/javascript-obfuscator/javascript-obfuscator/blob/d7f73935557b2cd15a2f7cd0b01017d9cddbd015/src/custom-code-helpers/domain-lock/templates/DomainLockTemplate.ts
// console output: https://github.com/javascript-obfuscator/javascript-obfuscator/blob/d7f73935557b2cd15a2f7cd0b01017d9cddbd015/src/custom-code-helpers/console-output/templates/ConsoleOutputDisableTemplate.ts
// debug protection function call: https://github.com/javascript-obfuscator/javascript-obfuscator/blob/d7f73935557b2cd15a2f7cd0b01017d9cddbd015/src/custom-code-helpers/debug-protection/templates/debug-protection-function-call/DebugProtectionFunctionCallTemplate.ts

export default {
  name: 'self-defending',
  tags: ['safe'],
  scope: true,
  visitor() {
    const callController = m.capture(m.anyString());
    const firstCall = m.capture(m.identifier());
    const rfn = m.capture(m.identifier());
    const context = m.capture(m.identifier());
    const res = m.capture(m.identifier());
    const fn = m.capture(m.identifier());

    // const callControllerFunctionName = (function() { ... })();
    const matcher = m.variableDeclarator(
      m.identifier(callController),
      iife(
        [],
        m.blockStatement([
          // let firstCall = true;
          m.variableDeclaration(undefined, [
            m.variableDeclarator(firstCall, trueMatcher),
          ]),
          // return function (context, fn) {
          m.returnStatement(
            m.functionExpression(
              null,
              [context, fn],
              m.blockStatement([
                m.variableDeclaration(undefined, [
                  // const rfn = firstCall ? function() {
                  m.variableDeclarator(
                    rfn,
                    m.conditionalExpression(
                      m.fromCapture(firstCall),
                      m.functionExpression(
                        null,
                        [],
                        m.blockStatement([
                          // if (fn) {
                          m.ifStatement(
                            m.fromCapture(fn),
                            m.blockStatement([
                              // const res = fn.apply(context, arguments);
                              m.variableDeclaration(undefined, [
                                m.variableDeclarator(
                                  res,
                                  m.callExpression(
                                    constMemberExpression(
                                      m.fromCapture(fn),
                                      'apply',
                                    ),
                                    [
                                      m.fromCapture(context),
                                      m.identifier('arguments'),
                                    ],
                                  ),
                                ),
                              ]),
                              // fn = null;
                              m.expressionStatement(
                                m.assignmentExpression(
                                  '=',
                                  m.fromCapture(fn),
                                  m.nullLiteral(),
                                ),
                              ),
                              // return res;
                              m.returnStatement(m.fromCapture(res)),
                            ]),
                          ),
                        ]),
                      ),
                      // : function() {}
                      m.functionExpression(null, [], m.blockStatement([])),
                    ),
                  ),
                ]),
                // firstCall = false;
                m.expressionStatement(
                  m.assignmentExpression(
                    '=',
                    m.fromCapture(firstCall),
                    falseMatcher,
                  ),
                ),
                // return rfn;
                m.returnStatement(m.fromCapture(rfn)),
              ]),
            ),
          ),
        ]),
      ),
    );

    const emptyIife = iife([], m.blockStatement([]));

    // Accepts the controller shape with leading bare declarations (no
    // initializers) anywhere inside it, left behind when cleanup passes
    // hoist `var`s out of removed dead branches (at the IIFE top level,
    // but also nested inside the returned functions). Runs the shared
    // matcher on a clone with those stripped, so its captures are
    // populated the same way. Removing the original along with the bare
    // declarations is sound: they are scoped inside the removed IIFE, so
    // no outside code can reference them.
    function matchRelaxedController(
      path: NodePath<t.VariableDeclarator>,
    ): boolean {
      const init = path.node.init;
      if (
        !t.isCallExpression(init) ||
        init.arguments.length > 0 ||
        !t.isFunctionExpression(init.callee) ||
        init.callee.params.length > 0
      ) {
        return false;
      }
      const stripped = t.cloneNode(path.node);
      if (!stripLeadingBareVarsDeep(stripped)) return false;
      return matcher.match(stripped);
    }

    // Removes leading initializer-less declarations from every block in
    // the subtree. Returns whether anything was removed.
    function stripLeadingBareVarsDeep(node: t.Node): boolean {
      let removed = false;
      const visit = (n: t.Node): void => {
        if (t.isBlockStatement(n)) {
          while (
            n.body.length > 0 &&
            t.isVariableDeclaration(n.body[0]) &&
            n.body[0].declarations.length > 0 &&
            n.body[0].declarations.every((d) => d.init == null)
          ) {
            n.body.shift();
            removed = true;
          }
        }
        for (const key of VISITOR_KEYS[n.type] ?? []) {
          const child = (n as unknown as Record<string, unknown>)[key];
          if (Array.isArray(child)) {
            for (const c of child) if (t.isNode(c)) visit(c);
          } else if (t.isNode(child)) {
            visit(child);
          }
        }
      };
      visit(node);
      return removed;
    }

    return {
      VariableDeclarator(path) {
        // Cleanup passes may hoist `var` declarations out of a removed dead
        // branch into the controller body (leading `var a;` statements
        // without initializers), breaking the exact-shape match below.
        // Accept that shape: the bare declarations are scoped inside the
        // removed IIFE, so dropping them with it is sound.
        if (!matcher.match(path.node) && !matchRelaxedController(path)) {
          return;
        }
        const binding = path.scope.getBinding(callController.current!);
        if (!binding) return;
        // const callControllerFunctionName = (function() { ... })();
        //       ^ path/binding

        binding.referencePaths
          .filter((ref) => ref.parent.type === 'CallExpression')
          .forEach((ref) => {
            if (ref.parentPath?.parent.type === 'CallExpression') {
              // callControllerFunctionName(this, function () { ... })();
              // ^ ref
              ref.parentPath.parentPath?.remove();
            } else {
              // const selfDefendingFunctionName = callControllerFunctionName(this, function () {
              // selfDefendingFunctionName();      ^ ref
              removeSelfDefendingRefs(ref as NodePath<t.Identifier>);
            }

            // leftover (function () {})() from debug protection function call
            findParent(ref, emptyIife)?.remove();

            this.changes++;
          });

        path.remove();
        this.changes++;
      },
    };
  },
} satisfies Transform;

function removeSelfDefendingRefs(path: NodePath<t.Identifier>) {
  const varName = m.capture(m.anyString());
  const varMatcher = m.variableDeclarator(
    m.identifier(varName),
    m.callExpression(m.identifier(path.node.name)),
  );
  const callMatcher = m.expressionStatement(
    m.callExpression(m.identifier(m.fromCapture(varName)), []),
  );
  const varDecl = findParent(path, varMatcher);

  if (varDecl) {
    const binding = varDecl.scope.getBinding(varName.current!);

    binding?.referencePaths.forEach((ref) => {
      if (callMatcher.match(ref.parentPath?.parent))
        ref.parentPath?.parentPath?.remove();
    });
    varDecl.remove();
  }
}
