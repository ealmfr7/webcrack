import { Bundle } from '../bundle';
import type { MetroModule } from './module';

export class MetroBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, MetroModule>) {
    super('webpack', entryId, modules);
    // TODO: add 'metro' to the Bundle type union in ../bundle.ts
    // (owned by the integrator). Until then, patch the runtime value.
    (this as { type: string }).type = 'metro';
  }
}
