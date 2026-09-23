import { readFile, readdir } from 'fs/promises';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { webcrack } from '../src/index.js';

const CORPUS_DIR = join(__dirname, 'corpus');

describe('corpus', async () => {
  // Sorted so the run order (and `--reporter` output) is stable
  // regardless of filesystem readdir ordering.
  const fileNames = (await readdir(CORPUS_DIR))
    .filter((name) => name.endsWith('.js'))
    .sort();

  fileNames.forEach((fileName) => {
    test(`corpus ${fileName}`, async ({ expect }) => {
      const code = await readFile(join(CORPUS_DIR, fileName), 'utf8');
      const result = await webcrack(code);

      await expect(result.code).toMatchFileSnapshot(
        join(CORPUS_DIR, fileName + '.snap'),
      );
    });
  });
});
