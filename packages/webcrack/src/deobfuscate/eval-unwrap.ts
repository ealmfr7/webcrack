// Placeholder: nested eval("...") / Function("...")() unwrapper (implemented in a later task).
import type { Transform } from '../ast-utils';

export default {
  name: 'eval-unwrap',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {};
  },
} satisfies Transform;
