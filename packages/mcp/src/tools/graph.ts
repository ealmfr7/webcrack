import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, readOnly, workspaceArg } from './define';

export const graph = defineTool({
  name: 'wc_graph',
  title: 'Dependency graph',
  description:
    'Module dependency graph or call graph around a root, limited by depth. format: tree (compact text, default), json, dot (Graphviz).',
  inputSchema: {
    workspace: workspaceArg,
    kind: z.enum(['modules', 'calls']).default('modules'),
    root: z
      .string()
      .optional()
      .describe('Module path or module:function. Defaults to the entry.'),
    depth: z.number().int().min(1).max(6).default(2),
    format: z.enum(['tree', 'json', 'dot']).default('tree'),
  },
  annotations: readOnly,
  handler: () => notImplemented('M2.2'),
});
