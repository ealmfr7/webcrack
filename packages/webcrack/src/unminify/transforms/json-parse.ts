import { parseExpression } from '@babel/parser';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { constMemberExpression } from '../../ast-utils';

// Nodes re-parsed from the decoded JSON string carry `loc` relative to
// that string. With Options.sourceMap (keepLoc) those positions would map
// the output to made-up input locations, so strip them and point the
// replacement expression at the JSON.parse call it replaces instead.
function stripLoc(node: t.Node): void {
  node.loc = undefined;
  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;
  for (const key of keys) {
    const value: unknown = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (t.isNode(child)) stripLoc(child);
      }
    } else if (t.isNode(value)) {
      stripLoc(value);
    }
  }
}

export default {
  name: 'json-parse',
  tags: ['safe'],
  scope: true,
  visitor: () => {
    const string = m.capture(m.anyString());
    const matcher = m.callExpression(constMemberExpression('JSON', 'parse'), [
      m.stringLiteral(string),
    ]);

    return {
      CallExpression: {
        exit(path) {
          if (
            matcher.match(path.node) &&
            !path.scope.hasBinding('JSON', { noGlobals: true })
          ) {
            try {
              JSON.parse(string.current!);
              const parsed = parseExpression(string.current!);
              stripLoc(parsed);
              parsed.loc = path.node.loc;
              path.replaceWith(parsed);
              this.changes++;
            } catch {
              // ignore
            }
          }
        },
      },
    };
  },
} satisfies Transform;
