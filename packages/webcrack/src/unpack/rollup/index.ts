// Placeholder for the Vite/Rollup ESM chunk unpacker (implemented in a later task).
import type { Transform } from '../../ast-utils';
import type { Bundle } from '../bundle';

export const unpackRollup = {
  name: 'unpack-rollup',
  tags: ['unsafe'],
  scope: true,
  visitor(options?: { bundle: Bundle | undefined }) {
    void options;
    return {};
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
