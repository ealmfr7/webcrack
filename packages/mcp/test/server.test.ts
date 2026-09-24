import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from 'vitest';
import { connect, fixtureWorkspace } from './helpers';

test('registers the explorer tools', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([
    'wc_open',
    'wc_workspaces',
    'wc_map',
    'wc_outline',
    'wc_search',
    'wc_findings',
    'wc_read',
    'wc_goto',
    'wc_refs',
    'wc_graph',
    'wc_diff',
    'wc_deobfuscate',
    'wc_annotate',
    'wc_export',
  ]);
});

test('registers the audit prompt', async () => {
  const { client } = await connect();
  const { prompts } = await client.listPrompts();
  expect(prompts.map((prompt) => prompt.name)).toEqual(['audit']);
});

test('tool errors are returned as actionable tool results', async () => {
  const { client } = await connect();
  const result = (await client.callTool({
    name: 'wc_read',
    arguments: { target: 'src/api.js' },
  })) as CallToolResult;
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: expect.stringContaining('No workspace is open') as string,
    },
  ]);
});

test('preloaded workspaces are available to tools', async () => {
  const { store } = await connect(fixtureWorkspace());
  expect(store.get().id).toBe('fixture1');
  expect(store.get('fixture1').modules.has('src/api.js')).toBe(true);
});
