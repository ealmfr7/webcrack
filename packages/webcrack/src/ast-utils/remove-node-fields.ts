import * as t from '@babel/types';

export interface RemoveNodeFieldsOptions {
  /**
   * Keep `loc` on every node so positions survive the `prepare` stage.
   * Needed when a source map is generated from the final AST
   * (see `generateWithMap`); off by default to keep memory usage low.
   * @default false
   */
  keepLoc?: boolean;
}

// Adapted https://github.com/babel/babel/blob/2688fbd1999f5be276142ad0cf60ef182e60fb65/packages/babel-types/src/traverse/traverseFast.ts
export function removeNodeFields(
  node: t.Node,
  options: RemoveNodeFieldsOptions = {},
) {
  if (!node) return;

  if (!options.keepLoc) {
    node.loc = undefined;
  }
  node.extra = undefined;

  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;

  for (const key of keys) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const subNode: t.Node | t.Node[] | undefined | null =
      // @ts-expect-error key must present in node
      node[key];
    if (!subNode) continue;

    if (Array.isArray(subNode)) {
      for (const node of subNode) {
        removeNodeFields(node, options);
      }
    } else {
      removeNodeFields(subNode, options);
    }
  }
}
