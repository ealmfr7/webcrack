import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, readOnly, workspaceArg } from './define';

export const read = defineTool({
  name: 'wc_read',
  title: 'Read code',
  description:
    'Read code with line numbers. target: a module ("src/api.js"), a line ("src/api.js:120"), a range ("src/api.js:100-160"), a symbol ("src/api.js:login" or just "login"). view=clean (deobfuscated, default) or raw (original input, by line range). Applies renames and shows notes from wc_annotate.',
  inputSchema: {
    workspace: workspaceArg,
    target: z.string(),
    view: z.enum(['clean', 'raw']).default('clean'),
    context: z
      .number()
      .int()
      .min(0)
      .max(200)
      .default(10)
      .describe('Extra lines around a single-line target.'),
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.5'),
});
