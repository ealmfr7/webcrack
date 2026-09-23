import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { Bundle } from '../bundle';
import { relativePath } from '../path';
import type { ParcelModule } from './module';

export class ParcelBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, ParcelModule>) {
    super('parcel', entryId, modules);
  }

  applyTransforms(): void {
    this.replaceRequirePaths();
  }

  /**
   * Replaces `parcelRequire(id)` / `require(specifier)` calls with
   * `require("./relative/path.js")` calls. Parcel 1 specifiers are resolved
   * through the module's dependency map when it provides them; otherwise the
   * argument itself is treated as a module id (Parcel 2).
   */
  private replaceRequirePaths() {
    const modules = this.modules;
    this.modules.forEach((module) => {
      const parcelModule = module as ParcelModule;
      traverse(module.ast, {
        CallExpression(path) {
          const { callee } = path.node;
          const isRequire = t.isIdentifier(callee, { name: 'require' });
          const isParcelRequire = t.isIdentifier(callee, {
            name: 'parcelRequire',
          });
          if (!isRequire && !isParcelRequire) return;
          if (path.node.arguments.length !== 1) return;
          const [arg] = path.node.arguments;
          if (!t.isStringLiteral(arg) && !t.isNumericLiteral(arg)) return;

          const raw = arg.value.toString();
          // Parcel 1: the dep map translates the specifier to a module id
          const mappedId =
            typeof arg.value === 'string'
              ? parcelModule.dependencies[arg.value]
              : undefined;
          const targetId = mappedId ?? (modules.has(raw) ? raw : undefined);
          if (targetId === undefined) return;

          const target = modules.get(targetId);
          const newPath = relativePath(
            module.path,
            target?.path ?? `./${targetId}.js`,
          );
          if (isParcelRequire) path.node.callee = t.identifier('require');
          path.node.arguments = [t.stringLiteral(newPath)];
        },
        noScope: true,
      });
    });
  }
}
