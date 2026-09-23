import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const refs = defineTool({
  name: 'wc_refs',
  title: 'Find references',
  description:
    'Find where a symbol is used across modules. direction: callers (who calls/uses it), callees (what it calls), all. Returns module:line with one line of context.',
  inputSchema: {
    workspace: workspaceArg,
    symbol: z.string().describe('Name or module:name.'),
    direction: z.enum(['callers', 'callees', 'all']).default('callers'),
    ...pagination,
  },
  annotations: readOnly,
  handler: () => notImplemented('M2.1'),
});
