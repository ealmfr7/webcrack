import { Bundle } from '../bundle';
import type { EsbuildModule } from './module';

export class EsbuildBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, EsbuildModule>) {
    // The base `Bundle` type union does not include 'esbuild' yet;
    // widening it is left to the integrator. The runtime value is correct.
    super('esbuild' as 'webpack', entryId, modules);
  }
}
