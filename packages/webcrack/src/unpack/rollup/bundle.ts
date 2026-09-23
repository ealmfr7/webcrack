import { Bundle } from '../bundle';
import type { RollupModule } from './module';

export class RollupBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, RollupModule>) {
    super('rollup', entryId, modules);
  }
}
