import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, readOnly, workspaceArg } from './define';

export const outline = defineTool({
  name: 'wc_outline',
  title: 'Module outline',
  description:
    'List the symbols of one module (functions, classes, methods, top-level variables, imports, exports) with line numbers, parameters and reference counts. Cheaper than reading the whole module.',
  inputSchema: {
    workspace: workspaceArg,
    module: z.string().describe('Module path from wc_map, e.g. src/api.js.'),
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.5'),
});
