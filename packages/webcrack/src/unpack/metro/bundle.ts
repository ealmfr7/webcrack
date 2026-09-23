import { Bundle } from '../bundle';
import type { MetroModule } from './module';

export class MetroBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, MetroModule>) {
    super('metro', entryId, modules);
  }
}
