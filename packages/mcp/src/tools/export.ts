import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, workspaceArg } from './define';

export const exportWorkspace = defineTool({
  name: 'wc_export',
  title: 'Export workspace',
  description:
    'Write the reconstructed project to a directory: clean modules with renames, report.json, notes.md and .dot graphs.',
  inputSchema: {
    workspace: workspaceArg,
    dir: z
      .string()
      .describe('Output directory (must be inside the allowed roots).'),
    include: z
      .array(z.enum(['code', 'report', 'notes', 'graph']))
      .default(['code', 'report', 'notes']),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  handler: () => notImplemented('M3.1'),
});
