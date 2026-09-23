import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, workspaceArg } from './define';

export const annotate = defineTool({
  name: 'wc_annotate',
  title: 'Rename / annotate',
  description:
    'Record what you understood: rename a symbol (scope-aware, applied everywhere) and/or attach a note. Renames and notes persist across sessions and show up in wc_read, wc_outline and wc_export.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('module:name of the binding.'),
    name: z.string().optional().describe('New name.'),
    note: z.string().optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: () => notImplemented('M2.3'),
});
