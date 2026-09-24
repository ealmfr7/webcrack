import traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { WcError } from '../format/errors';
import type { Annotation, SymbolEntry, Workspace } from './types';
import { parseClean } from './parse';

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Rename a top-level binding everywhere it is used, without regenerating
 * the code (so line numbers stay stable).
 *
 * The module is parsed with `@babel/parser` and the binding is found
 * through the program scope. Every use — the declaration identifier,
 * reads, writes, shorthand object properties (`{x}` becomes `{x: newName}`)
 * and local export specifiers — is spliced into the existing text from
 * last to first, so no other line moves.
 *
 * Export-name stability: importers refer to the *exported* name, not the
 * local one, so the export keeps working after the rename:
 * - `export { x }` becomes `export { newName as x }` (an already-aliased
 *   `export { x as y }` becomes `export { newName as y }`);
 * - `export function x` / `export const x = …` / `export class x` lose
 *   their `export` prefix on the declaration line and gain an appended
 *   `export { newName as x };` line at the end of the module (append-only,
 *   so existing line numbers do not change);
 * - `export default … x …` needs nothing extra: the default export is
 *   unaffected by the local name, and neither are CJS `exports.x = x`
 *   properties (only the value identifier is renamed).
 *
 * Returns the changed module paths (just the defining module: importers
 * keep referring to the stable export name, so they are untouched) plus
 * the number of splices actually applied (`sites`), so callers never have
 * to estimate it with a word count over the text (which would also match
 * the name inside strings and comments).
 */
export interface RenameResult {
  changed: string[];
  /** Number of source splices applied (unique, non-overlapping edits). */
  sites: number;
}

export function renameSymbol(
  ws: Workspace,
  symbol: SymbolEntry,
  newName: string,
): RenameResult {
  if (!t.isValidIdentifier(newName)) {
    throw new WcError(
      `"${newName}" is not a valid JavaScript identifier. Pass a name like "hmacSign" (letters, digits, _ and $, not starting with a digit).`,
    );
  }
  if (newName === symbol.name) {
    throw new WcError(
      `"${symbol.name}" is already called that. Pass a different "name" or record a "note" instead.`,
    );
  }
  if (symbol.kind === 'import') {
    const from = symbol.from ?? '?';
    throw new WcError(
      `"${symbol.name}" in ${symbol.module} is an import. Rename it at its definition: ${from}:${symbol.importedName ?? symbol.name}.`,
    );
  }
  if (symbol.name.includes('.')) {
    throw new WcError(
      `Renaming methods ("${symbol.name}") is not supported. Rename the class instead: ${symbol.module}:${symbol.name.slice(0, symbol.name.indexOf('.'))}.`,
    );
  }
  const entry = ws.modules.get(symbol.module);
  if (!entry) {
    throw new WcError(
      `Unknown module "${symbol.module}". Call wc_map to list modules.`,
    );
  }

  const ast = parseClean(entry.code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ['jsx'],
  });

  let program: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  if (!program) {
    throw new WcError(
      `Could not parse ${symbol.module}. The module may use syntax the parser does not understand.`,
    );
  }
  const binding = program.scope.getBinding(symbol.name);
  if (!binding) {
    throw new WcError(
      `No local binding "${symbol.name}" in ${symbol.module}. Only locally declared bindings can be renamed; it may be declared dynamically (e.g. via module.exports).`,
    );
  }

  // A collision is a visible `newName` binding where the old name is used:
  // in the binding's own scope, or in any scope containing a use of it
  // (renaming past a shadowing declaration would rebind those uses).
  const bound = binding.scope.getBinding(newName);
  if (bound) {
    const line = bound.identifier.loc?.start.line;
    throw new WcError(
      `"${newName}" is already declared${line !== undefined ? ` (line ${line})` : ''} in ${symbol.module}. Choose another name.`,
    );
  }
  const usePaths: NodePath[] = [
    ...binding.referencePaths,
    ...binding.constantViolations,
  ];
  for (const use of usePaths) {
    if (use.scope.getBinding(newName)) {
      const line = use.node.loc?.start.line;
      throw new WcError(
        `"${newName}" is already declared in a scope where "${symbol.name}" is used${line !== undefined ? ` (${symbol.module}:${line})` : ''}. Renaming would rebind those uses; choose another name.`,
      );
    }
  }

  const oldName = symbol.name;
  const edits: Edit[] = [];
  const pushEdit = (
    node: t.Node | null | undefined,
    text: string,
    startOverride?: number,
    endOverride?: number,
  ): void => {
    const start = startOverride ?? node?.start;
    const end = endOverride ?? node?.end;
    if (
      !node ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      start > end
    ) {
      throw new WcError(
        `Could not rename "${oldName}" in ${symbol.module}: a use has no source range. The module may need re-parsing.`,
      );
    }
    edits.push({ start, end, text });
  };

  pushEdit(binding.identifier, newName);

  const exportAppendix: string[] = [];
  const declarationStatement = exportedDeclaration(binding);
  if (declarationStatement) {
    // `export function x` → `function newName` + appended export specifier.
    pushEdit(
      declarationStatement.node,
      '',
      declarationStatement.node.start ?? undefined,
      declarationStatement.declarationStart,
    );
    const kept = [`${newName} as ${oldName}`, ...declarationStatement.siblings];
    exportAppendix.push(`export { ${kept.join(', ')} };`);
  }

  for (const use of usePaths) {
    if (use.isIdentifier()) {
      const parent = use.parent;
      if (
        t.isObjectProperty(parent) &&
        parent.shorthand &&
        parent.value === use.node
      ) {
        // `{x}` → `{x: newName}`: keep the property key stable.
        const keyText = entry.code.slice(parent.key.start!, parent.key.end!);
        pushEdit(use.node, `${keyText}: ${newName}`);
      } else if (t.isExportSpecifier(parent) && parent.local === use.node) {
        const exportedName = t.isIdentifier(parent.exported)
          ? parent.exported.name
          : parent.exported.value;
        if (exportedName === oldName) {
          // `export { x }` → `export { newName as x }`.
          pushEdit(parent, `${newName} as ${oldName}`);
        } else {
          // `export { x as y }` → `export { newName as y }`.
          pushEdit(use.node, newName);
        }
      } else if (t.isExportNamedDeclaration(parent)) {
        // The declaration statement itself (e.g. `export const x = …`):
        // handled via the declaration-statement edit above, not here.
      } else {
        pushEdit(use.node, newName);
      }
    } else if (t.isExportNamedDeclaration(use.node)) {
      // Same: the exported declaration statement, handled above.
    } else if (
      t.isAssignmentExpression(use.node) &&
      t.isIdentifier(use.node.left)
    ) {
      pushEdit(use.node.left, newName);
    } else if (
      t.isUpdateExpression(use.node) &&
      t.isIdentifier(use.node.argument)
    ) {
      pushEdit(use.node.argument, newName);
    }
    // Anything else (e.g. a for-of left pattern) already had its
    // identifier covered by binding.identifier or a reference above.
  }

  const applied = applyEdits(entry.code, edits, exportAppendix);
  entry.code = applied.code;
  return { changed: [entry.path], sites: applied.sites };
}

/**
 * Find the annotation for a binding, matching the current key
 * (`module:name`) or an old name (`originalName`, or a previous `rename`
 * kept by entries written before re-keying existed). There is only ever
 * one entry per binding: renames re-key the entry in place.
 *
 * The exact current-key match wins over an old-name match, so a recycled
 * name (another binding renamed onto a freed old name) still resolves to
 * its own entry.
 */
export function findAnnotation(
  annotations: Annotation[],
  module: string,
  name: string,
): Annotation | undefined {
  const key = `${module}:${name}`;
  const direct = annotations.find((annotation) => annotation.symbol === key);
  if (direct) return direct;
  return annotations.find((annotation) => {
    const colon = annotation.symbol.lastIndexOf(':');
    if (colon === -1) return false;
    if (annotation.symbol.slice(0, colon) !== module) return false;
    return annotation.originalName === name || annotation.rename === name;
  });
}

interface ExportedDeclaration {
  node: t.ExportNamedDeclaration;
  declarationStart: number;
  /** Sibling names sharing the statement (`export const x = 1, y = 2`). */
  siblings: string[];
}

/**
 * The `export …` statement wrapping the binding's declaration, when the
 * binding is declared as `export function/class/const/let/var x` (not a
 * default export and not a bare `export { x }` specifier list). Siblings
 * sharing a multi-declarator statement keep their exports via the appended
 * specifier, so stripping the prefix drops nothing.
 */
function exportedDeclaration(
  binding: Binding,
): ExportedDeclaration | undefined {
  const statement =
    binding.path.isVariableDeclarator() &&
    binding.path.parentPath.isVariableDeclaration()
      ? binding.path.parentPath.parentPath
      : binding.path.parentPath;
  if (
    statement?.isExportNamedDeclaration() &&
    statement.node.declaration &&
    typeof statement.node.start === 'number' &&
    typeof statement.node.declaration.start === 'number'
  ) {
    const siblings: string[] = [];
    const declaration = statement.node.declaration;
    if (t.isVariableDeclaration(declaration)) {
      for (const declarator of declaration.declarations) {
        if (
          t.isIdentifier(declarator.id) &&
          declarator.id.name !== binding.identifier.name
        ) {
          siblings.push(declarator.id.name);
        }
      }
    }
    return {
      node: statement.node,
      declarationStart: statement.node.declaration.start,
      siblings,
    };
  }
  return undefined;
}

/**
 * Splice edits into `code` from last to first so earlier ranges stay
 * valid, then append export-specifier lines (append-only: existing line
 * numbers never shift). Reports the spliced code and how many unique
 * splices were applied (the appended alias lines are not splices).
 */
function applyEdits(
  code: string,
  edits: Edit[],
  appendix: string[],
): { code: string; sites: number } {
  const seen = new Set<string>();
  const unique = edits.filter((edit) => {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.start - a.start);
  for (let i = 1; i < unique.length; i++) {
    if (unique[i].end > unique[i - 1].start) {
      throw new WcError(
        'Could not rename: two uses overlap in the source. The module may need re-parsing.',
      );
    }
  }
  let out = code;
  for (const edit of unique) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  for (const line of appendix) {
    out = out.endsWith('\n') ? `${out}${line}\n` : `${out}\n${line}\n`;
  }
  return { code: out, sites: unique.length };
}
