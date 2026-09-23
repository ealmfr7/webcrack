import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, readOnly, workspaceArg } from './define';

export const goto = defineTool({
  name: 'wc_goto',
  title: 'Go to definition',
  description:
    'Jump to the definition of a symbol: location, signature and first lines. Pass `from` (module:line where the name is used) to resolve it through scopes and imports exactly.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('Name or module:name.'),
    from: z.string().optional().describe('module:line where the name appears.'),
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.7'),
});
