import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const map = defineTool({
  name: 'wc_map',
  title: 'Module map',
  description:
    'Browse the modules of the workspace like a file tree: size, imports/exports count and tags (network, auth, crypto, storage, dom, vm, vendor). Use it to decide where to look; filter by folder or tag.',
  inputSchema: {
    workspace: workspaceArg,
    path: z.string().optional().describe('Only modules under this folder.'),
    tag: z
      .enum(['network', 'auth', 'crypto', 'storage', 'dom', 'vm', 'vendor'])
      .optional(),
    sort: z.enum(['path', 'size', 'refs']).default('path'),
    ...pagination,
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.4'),
});
