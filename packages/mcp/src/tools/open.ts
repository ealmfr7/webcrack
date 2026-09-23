import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool } from './define';

export const open = defineTool({
  name: 'wc_open',
  title: 'Open bundle',
  description:
    'Load a JavaScript file, URL or code snippet: deobfuscates, unpacks bundles (webpack, browserify, esbuild, rollup, parcel, metro, turbopack) and indexes everything once. Returns an overview (bundler, modules, obfuscation techniques, findings count, where to start) and a workspace id. Call this first; results are cached, so reopening the same input is instant.',
  inputSchema: {
    source: z
      .string()
      .describe('File path, http(s) URL, or the JavaScript code itself.'),
    options: z
      .object({
        unpack: z.boolean().optional(),
        deobfuscate: z.boolean().optional(),
        unminify: z.boolean().optional(),
        jsx: z.boolean().optional(),
        mangle: z.boolean().optional(),
        renameHeuristics: z.boolean().optional(),
      })
      .optional()
      .describe('webcrack options; defaults are fine for almost everything.'),
    refresh: z
      .boolean()
      .default(false)
      .describe('Ignore the cache and process the input again.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: () => notImplemented('M1.3'),
});

export const workspaces = defineTool({
  name: 'wc_workspaces',
  title: 'List workspaces',
  description:
    'List opened and cached workspaces (id, source, bundler, module count).',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: () => notImplemented('M1.3'),
});
