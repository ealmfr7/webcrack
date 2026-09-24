import path from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {},
  resolve: {
    alias: [
      {
        find: 'webcrack/analysis',
        replacement: path.resolve(
          import.meta.dirname,
          '../webcrack/src/analysis-entry.ts',
        ),
      },
      {
        find: 'webcrack',
        replacement: path.resolve(
          import.meta.dirname,
          '../webcrack/src/index.ts',
        ),
      },
    ],
  },
});
