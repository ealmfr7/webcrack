import { expect, test } from 'vitest';
import {
  createNodeSandbox,
  detectInterpreters,
  extractReport,
  moduleGraph,
} from 'webcrack/analysis';

test('analysis entry exposes the expected functions', () => {
  expect(typeof extractReport).toBe('function');
  expect(typeof moduleGraph).toBe('function');
  expect(typeof detectInterpreters).toBe('function');
  expect(typeof createNodeSandbox).toBe('function');
});

test('extractReport runs on a trivial file', () => {
  // @babel/parser is not a dependency of packages/mcp, so build the
  // minimal File AST by hand instead of parsing.
  const ast = {
    type: 'File',
    program: {
      type: 'Program',
      body: [],
      directives: [],
      sourceType: 'script',
    },
    comments: [],
  } as Parameters<typeof extractReport>[0];
  expect(extractReport(ast)).toEqual({
    urls: [],
    endpoints: [],
    secrets: [],
    regexes: [],
    interesting: [],
  });
});
