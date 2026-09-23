import { Bundle } from '../bundle';
import type { TurbopackModule } from './module';

export class TurbopackBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, TurbopackModule>) {
    super('turbopack', entryId, modules);
  }
}
