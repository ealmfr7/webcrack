// Placeholder for the Parcel bundle unpacker (implemented in a later task).
import type { Transform } from '../../ast-utils';
import type { Bundle } from '../bundle';

export const unpackParcel = {
  name: 'unpack-parcel',
  tags: ['unsafe'],
  scope: true,
  visitor(options?: { bundle: Bundle | undefined }) {
    void options;
    return {};
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
