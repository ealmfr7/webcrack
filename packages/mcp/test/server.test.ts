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
  const result = await client.callTool({
    name: 'wc_open',
    arguments: { source: 'var a = 1;' },
  });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: 'text', text: expect.stringContaining('M1.3') },
  ]);
});

test('preloaded workspaces are available to tools', async () => {
  const { call } = await connect(fixtureWorkspace());
  // wc_map is a stub until M1.4: it reaches the handler instead of failing
  // with "No workspace is open".
  await expect(call('wc_map')).rejects.toThrow('M1.4');
});
