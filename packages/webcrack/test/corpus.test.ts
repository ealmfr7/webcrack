import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { webcrack } from '../src/index.js';
import type { Bundle } from '../src/unpack/bundle.js';

const CORPUS_DIR = join(__dirname, 'corpus');

// Deterministic text serialization of an unpacked bundle: modules sorted
// by id so Map insertion order (and filesystem readdir ordering) cannot
// make the snapshot flaky.
function serializeBundle(bundle: Bundle): string {
  const modules = [...bundle.modules.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return (
    JSON.stringify(
      {
        type: bundle.type,
        entryId: bundle.entryId,
        modules: modules.map((module) => ({
          id: module.id,
          path: module.path,
          isEntry: module.isEntry,
          code: module.code,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

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

      const bundleSnapshotPath = join(CORPUS_DIR, fileName + '.bundle.snap');
      if (result.bundle === undefined) {
        // A committed bundle snapshot means this sample used to unpack, so a
        // missing bundle is a regression rather than a silent pass.
        expect(existsSync(bundleSnapshotPath)).toBe(false);
        expect(result.bundle).toBeUndefined();
      } else {
        await expect(serializeBundle(result.bundle)).toMatchFileSnapshot(
          bundleSnapshotPath,
        );
      }
    });
  });
});
