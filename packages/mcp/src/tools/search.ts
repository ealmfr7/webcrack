import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const search = defineTool({
  name: 'wc_search',
  title: 'Search code',
  description:
    'Search the clean code. kind: text (substring), regex, string (string literals only), identifier (bindings by name), call (call sites, e.g. "fetch", "axios.post", "*.postMessage"), ast (structural pattern with $X / $$ARGS wildcards, e.g. `fetch($URL, { method: "POST", $$REST })`). Returns module:line hits with one line of context.',
  inputSchema: {
    workspace: workspaceArg,
    query: z.string(),
    kind: z
      .enum(['text', 'regex', 'string', 'identifier', 'call', 'ast'])
      .default('text'),
    module: z.string().optional().describe('Limit to one module or folder.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.6 / M2.5'),
});
