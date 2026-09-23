import { Bundle } from '../bundle';
import type { EsbuildModule } from './module';

export class EsbuildBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, EsbuildModule>) {
    super('esbuild', entryId, modules);
  }
}
