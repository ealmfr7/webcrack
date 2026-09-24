import type {
  TextResourceContents,
  ResourceContents,
} from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from 'vitest';
import { connect, fixtureWorkspace } from './helpers';

function text(content: ResourceContents): TextResourceContents {
  if (!('text' in content) || typeof content.text !== 'string') {
    throw new Error('expected text contents');
  }
  return content as TextResourceContents;
}

test('lists resources with the report first, and the templates', async () => {
  const { client } = await connect(fixtureWorkspace());
  const { resources } = await client.listResources();
  expect(resources.map((resource) => resource.uri)).toEqual([
    'webcrack://fixture1/report',
    'webcrack://fixture1/module/src/api.js',
    'webcrack://fixture1/module/src/sign.js',
  ]);

  const { resourceTemplates } = await client.listResourceTemplates();
  expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
    'webcrack://{ws}/report',
    'webcrack://{ws}/module/{+path}',
  ]);
});

test('reads a module as clean code', async () => {
  const { client } = await connect(fixtureWorkspace());
  const { contents } = await client.readResource({
    uri: 'webcrack://fixture1/module/src/api.js',
  });
  expect(contents).toHaveLength(1);
  expect(contents[0].mimeType).toBe('text/javascript');
  expect(text(contents[0]).text).toContain('export async function login');
});

test('reads a module with a leading ./ (percent-encoded)', async () => {
  const { client } = await connect(fixtureWorkspace());
  const { contents } = await client.readResource({
    uri: `webcrack://fixture1/module/${encodeURIComponent('./src/api.js')}`,
  });
  expect(contents).toHaveLength(1);
  expect(text(contents[0]).text).toContain('export async function login');
});

test('reads the report as JSON', async () => {
  const { client } = await connect(fixtureWorkspace());
  const { contents } = await client.readResource({
    uri: 'webcrack://fixture1/report',
  });
  expect(contents).toHaveLength(1);
  expect(contents[0].mimeType).toBe('application/json');
  const report = JSON.parse(text(contents[0]).text) as Record<
    string,
    { endpoints: { url: string }[] }
  >;
  expect(Object.keys(report).sort()).toEqual(['src/api.js', 'src/sign.js']);
  expect(report['src/api.js'].endpoints[0].url).toBe(
    'https://api.example.com/v1/login',
  );
});

test('unknown workspace is an error', async () => {
  const { client } = await connect(fixtureWorkspace());
  await expect(
    client.readResource({ uri: 'webcrack://nope/report' }),
  ).rejects.toThrow(/Unknown workspace/);
});

test('unknown module is an error with a suggestion', async () => {
  const { client } = await connect(fixtureWorkspace());
  await expect(
    client.readResource({ uri: 'webcrack://fixture1/module/src/apiz.js' }),
  ).rejects.toThrow(/Unknown module.*src\/api\.js/);
});
