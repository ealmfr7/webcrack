import { expect, test } from 'vitest';
import { connect } from './helpers';

const FOCUSES = [
  'network',
  'auth',
  'crypto',
  'storage',
  'obfuscation',
  'all',
] as const;

/** Per focus: the map tag and findings category the prompt must steer to. */
const EXPECTED: Record<(typeof FOCUSES)[number], string[]> = {
  network: ['tag=network', 'category=endpoints'],
  auth: ['tag=auth', 'category=secrets'],
  crypto: ['tag=crypto', 'category=crypto'],
  storage: ['tag=storage', 'category=storage'],
  obfuscation: ['tag=vm', 'category=vm', 'wc_deobfuscate'],
  all: ['category=endpoints', 'category=secrets', 'category=crypto'],
};

async function promptText(args: Record<string, string>): Promise<string> {
  const { client } = await connect();
  const result = await client.getPrompt({ name: 'audit', arguments: args });
  const first = result.messages[0]?.content;
  if (first?.type !== 'text') throw new Error('audit prompt is not text');
  return first.text;
}

for (const focus of FOCUSES) {
  test(`audit prompt for focus=${focus} contains the right tool calls`, async () => {
    const text = await promptText({ source: 'app.js', focus });
    for (const expected of EXPECTED[focus]) {
      expect(text).toContain(expected);
    }
    // Shared workflow spine, whatever the focus.
    for (const tool of [
      'wc_open',
      'wc_map',
      'wc_outline',
      'wc_read',
      'wc_goto',
      'wc_refs',
      'wc_annotate',
    ]) {
      expect(text).toContain(tool);
    }
  });
}

test('every wc_* name in the prompt exists as a tool (wc_trace allowlisted)', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  // wc_trace is being added and is not registered yet; mentioning it in the
  // prompt is intentional, so it is allowlisted here until it lands.
  const allowlisted = new Set(['wc_trace']);
  const text = await promptText({ source: 'app.js', focus: 'all' });
  const mentioned = new Set(text.match(/wc_[a-z_]+/g) ?? []);
  expect(mentioned.size).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(
      names.has(name) || allowlisted.has(name),
      `${name} is mentioned but is not a registered tool`,
    ).toBe(true);
  }
});

test('audit prompt stays concise', async () => {
  const text = await promptText({ source: 'app.js' });
  expect(text.split('\n').length).toBeLessThanOrEqual(60);
});

test('audit prompt requires a source', async () => {
  const { client } = await connect();
  await expect(
    client.getPrompt({ name: 'audit', arguments: {} }),
  ).rejects.toThrow();
});
