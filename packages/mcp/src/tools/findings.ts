import { z } from 'zod';
import { notImplemented } from '../format/errors';
import { defineTool, pagination, readOnly, workspaceArg } from './define';

export const findings = defineTool({
  name: 'wc_findings',
  title: 'Security findings',
  description:
    'Precomputed intel with module:line locations. category: summary (counts + top items), endpoints (HTTP calls with method/URL), urls, secrets (API keys/tokens, masked unless reveal=true), regexes, interesting (emails, IPs, paths), sinks (eval, innerHTML, postMessage…), storage (localStorage, cookies, indexedDB), crypto (WebCrypto, hash/cipher constants), vm (VM interpreter loops).',
  inputSchema: {
    workspace: workspaceArg,
    category: z
      .enum([
        'summary',
        'endpoints',
        'urls',
        'secrets',
        'regexes',
        'interesting',
        'sinks',
        'storage',
        'crypto',
        'vm',
      ])
      .default('summary'),
    module: z.string().optional(),
    reveal: z.boolean().default(false).describe('Show secrets unmasked.'),
    ...pagination,
  },
  annotations: readOnly,
  handler: () => notImplemented('M1.7'),
});
