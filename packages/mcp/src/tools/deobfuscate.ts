import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, workspaceArg } from './define';

export const deobfuscate = defineTool({
  name: 'wc_deobfuscate',
  title: 'Deobfuscate region',
  description:
    'Clean up code that is still obfuscated after wc_open: run deobfuscation passes on a function, range or module and show a before/after diff (apply=true saves it into the workspace). Or pass `expression` to evaluate it safely in the sandbox, e.g. to decode a string.',
  inputSchema: {
    workspace: workspaceArg,
    target: z
      .string()
      .optional()
      .describe('module, module:start-end or module:symbol.'),
    passes: z
      .array(z.string())
      .optional()
      .describe('Specific passes; defaults to the full pipeline.'),
    expression: z
      .string()
      .optional()
      .describe(
        'JS expression to evaluate in the sandbox (target module in scope).',
      ),
    apply: z.boolean().default(false),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: () => notImplemented('M2.4'),
});
