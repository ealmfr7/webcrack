import generate from '@babel/generator';
import { parse, parseExpression } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { createNodeSandbox } from 'webcrack/analysis';
import { WcError } from '../format/errors';

/** Options for {@link evaluateInModule}. */
export interface EvaluateInModuleOptions {
  /** Per-evaluation time limit in milliseconds. */
  timeoutMs: number;
  /** Isolate heap limit in megabytes. */
  memoryLimitMb: number;
  /**
   * Overridable sandbox factory. Defaults to `createNodeSandbox`; tests
   * inject fakes here so no module mocking is needed.
   */
  sandboxFactory?: typeof createNodeSandbox;
}

/** Results longer than this are truncated (with a note). */
const MAX_RESULT_CHARS = 10_000;

/**
 * Evaluate `expression` with the module `code` in scope, inside an
 * isolated-vm sandbox. The module runs with `module`/`exports`, stub
 * `require`/`__req` (returning `{}`), and `window`/`self` aliases; ESM
 * syntax is transpiled to script form first, and a throwing module does not
 * stop the expression. The result is always returned as a string.
 */
export async function evaluateInModule(
  code: string,
  expression: string,
  opts: EvaluateInModuleOptions,
): Promise<string> {
  validateExpression(expression);
  const safe = sanitizeModuleCode(code);
  const runnable = tryTranspileEsm(safe) ?? safe;
  const script = [
    'var module={exports:{}},exports=module.exports,require=function(){return {}},__req=require,window=globalThis,self=globalThis;',
    `try{\n${runnable}\n}catch(e){};`,
    `(function(){try{var r=(${expression});return typeof r==='string'?r:(JSON.stringify(r)??String(r))}catch(e){return 'Error: '+e}})()`,
  ].join('');
  const factory = opts.sandboxFactory ?? createNodeSandbox;
  let result: unknown;
  try {
    const sandbox = factory({
      timeout: opts.timeoutMs,
      memoryLimit: opts.memoryLimitMb,
    });
    result = await sandbox(script);
  } catch (error) {
    throw sandboxError(error, opts);
  }
  const text = typeof result === 'string' ? result : String(result);
  if (text.length > MAX_RESULT_CHARS) {
    return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated to ${MAX_RESULT_CHARS} characters]`;
  }
  return text;
}

/**
 * Make module code safe to splice into the `try{...}catch(e){}` wrapper.
 * Newlines around the code stop a trailing line comment (e.g. a
 * `//# sourceMappingURL=` footer with no trailing newline) from commenting
 * out the wrapper's closing brace. A leading hashbang is stripped so the
 * code parses as ordinary JS. A trailing unterminated block comment is
 * closed so it cannot swallow the rest of the wrapper; its content is inert,
 * so the expression still runs.
 */
function sanitizeModuleCode(code: string): string {
  const noHashbang = code.replace(/^\uFEFF?#!.*(?:\r\n|[\n\r])?/, '');
  if (hasUnterminatedBlockComment(noHashbang)) return `${noHashbang}\n*/`;
  return noHashbang;
}

/** True when the code ends inside a `/* ...` comment that never closes. */
function hasUnterminatedBlockComment(code: string): boolean {
  try {
    parse(code, { sourceType: 'script' });
    return false;
  } catch (error) {
    return (
      error instanceof Error && /unterminated comment/i.test(error.message)
    );
  }
}

/**
 * Rewrite ESM syntax into script form so the module can be spliced into the
 * classic-script wrapper: imports become `var` bindings over the `__req`
 * stub (bare `import 'm'` is dropped), exports become `module.exports`
 * assignments (`export … from` is dropped), and `import.meta` becomes `{}`.
 * Exported `const`/`let`/`class` become `var` so the expression can see the
 * binding outside the wrapper's `try` block. Non-exported top-level
 * `const`/`let` become `var` and top-level `class X` becomes
 * `var X = class X` for the same reason; only statements directly in
 * `Program.body` are rewritten, so `for (let …)` headers and block-level
 * declarations keep their semantics. CJS/script modules get only that
 * top-level binding rewrite. Returns `undefined` when the code needed no
 * rewrite or the rewrite fails; callers splice the raw code.
 */
function tryTranspileEsm(code: string): string | undefined {
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
    });
  } catch {
    return undefined;
  }
  let touched = false;
  try {
    traverse(ast, {
      ImportDeclaration(path) {
        touched = true;
        const source = path.node.source.value;
        const bindings = path.node.specifiers.map((specifier) => {
          if (
            t.isImportDefaultSpecifier(specifier) ||
            t.isImportNamespaceSpecifier(specifier)
          ) {
            return stubBinding(specifier.local.name, requireCall(source));
          }
          const imported = specifier.imported;
          return stubBinding(
            specifier.local.name,
            t.memberExpression(
              requireCall(source),
              imported,
              t.isStringLiteral(imported),
            ),
          );
        });
        if (bindings.length === 0) path.remove();
        else path.replaceWithMultiple(bindings);
      },
      ExportNamedDeclaration(path) {
        touched = true;
        const { node } = path;
        if (node.source !== null || node.declaration == null) {
          // `export … from 'm'` re-exports another module: drop it.
          // `export {a as b}` reads locals, so keep it as assignments.
          const assignments: t.ExpressionStatement[] = [];
          if (node.source === null) {
            for (const specifier of node.specifiers) {
              if (t.isExportSpecifier(specifier)) {
                assignments.push(
                  exportAssignment(specifier.exported, specifier.local.name),
                );
              }
            }
          }
          if (assignments.length === 0) path.remove();
          else path.replaceWithMultiple(assignments);
          return;
        }
        const declaration = node.declaration;
        if (t.isVariableDeclaration(declaration)) {
          const names = declaration.declarations.flatMap((declarator) =>
            Object.keys(t.getBindingIdentifiers(declarator.id)),
          );
          declaration.kind = 'var';
          path.replaceWithMultiple([
            declaration,
            ...names.map((name) => exportAssignment(t.identifier(name), name)),
          ]);
          return;
        }
        if (t.isFunctionDeclaration(declaration) && declaration.id) {
          const id = declaration.id;
          path.replaceWithMultiple([
            declaration,
            exportAssignment(t.cloneNode(id), id.name),
          ]);
          return;
        }
        if (t.isClassDeclaration(declaration) && declaration.id) {
          const id = declaration.id;
          // A block-scoped class would be invisible to the expression, so
          // bind it with `var` instead of keeping the declaration.
          path.replaceWithMultiple([
            stubBinding(
              id.name,
              t.classExpression(
                t.cloneNode(id),
                declaration.superClass,
                declaration.body,
                declaration.decorators ?? undefined,
              ),
            ),
            exportAssignment(t.cloneNode(id), id.name),
          ]);
          return;
        }
        // Unreachable for plain JS (every declaration above is handled).
        path.remove();
      },
      Program(path) {
        // Hoist non-exported top-level bindings out of the wrapper's `try`
        // so the expression can see them. Only direct Program.body
        // statements are touched; nested and block-level declarations
        // (including `for (let …)` headers) are left alone. A rewrite
        // here counts as a change, so CJS/script modules get the
        // rewritten code back even with no ESM syntax.
        for (const statementPath of path.get('body')) {
          if (statementPath.isVariableDeclaration()) {
            if (statementPath.node.kind !== 'var') {
              statementPath.node.kind = 'var';
              touched = true;
            }
          } else if (statementPath.isClassDeclaration()) {
            const node = statementPath.node;
            const id = node.id;
            if (!id) continue;
            statementPath.replaceWith(
              stubBinding(
                id.name,
                t.classExpression(
                  t.cloneNode(id),
                  node.superClass,
                  node.body,
                  node.decorators ?? undefined,
                ),
              ),
            );
            touched = true;
          }
        }
      },
      ExportDefaultDeclaration(path) {
        touched = true;
        const declaration = path.node.declaration;
        if (
          t.isFunctionDeclaration(declaration) ||
          t.isClassDeclaration(declaration)
        ) {
          if (declaration.id) {
            const id = declaration.id;
            path.replaceWithMultiple([
              declaration,
              exportAssignment(t.identifier('default'), id.name),
            ]);
            return;
          }
          // Anonymous `export default function () {}`: keep it hoisted by
          // emitting a function declaration under a scope-unique name (a
          // fixed name would collide with a user binding and break the
          // transpile). Anonymous classes stay as expressions (classes
          // aren't hoisted anyway). Both get the name "default".
          if (t.isFunctionDeclaration(declaration)) {
            const uid = path.scope.generateUidIdentifier('default');
            const fn = t.functionDeclaration(
              uid,
              declaration.params,
              declaration.body,
              declaration.generator,
              declaration.async,
            );
            path.replaceWithMultiple([
              fn,
              exportAssignment(t.identifier('default'), t.cloneNode(uid)),
              defineNameStatement(t.cloneNode(uid)),
            ]);
            return;
          }
          path.replaceWithMultiple([
            exportAssignment(
              t.identifier('default'),
              t.toExpression(declaration),
            ),
            defineNameStatement(defaultExportAccess()),
          ]);
          return;
        }
        path.replaceWith(
          exportAssignment(
            t.identifier('default'),
            declaration as t.Expression,
          ),
        );
      },
      ExportAllDeclaration(path) {
        touched = true;
        path.remove();
      },
      MetaProperty(path) {
        if (
          path.node.meta.name === 'import' &&
          path.node.property.name === 'meta'
        ) {
          touched = true;
          path.replaceWith(t.objectExpression([]));
        }
      },
    });
  } catch {
    return undefined;
  }
  if (!touched) return undefined;
  try {
    return generate(ast).code;
  } catch {
    return undefined;
  }
}

/** `var <name> = <init>;` for a stubbed import binding. */
function stubBinding(name: string, init: t.Expression): t.VariableDeclaration {
  return t.variableDeclaration('var', [
    t.variableDeclarator(t.identifier(name), init),
  ]);
}

/** `__req('<source>')`, the stub import target (returns `{}`). */
function requireCall(source: string): t.CallExpression {
  return t.callExpression(t.identifier('__req'), [t.stringLiteral(source)]);
}

/** `module.exports.default`, the default-export binding. */
function defaultExportAccess(): t.MemberExpression {
  return t.memberExpression(
    t.memberExpression(t.identifier('module'), t.identifier('exports')),
    t.identifier('default'),
  );
}

/**
 * `Object.defineProperty(<target>, 'name', { value: 'default' });` so an
 * anonymous default export reports its name as "default".
 */
function defineNameStatement(target: t.Expression): t.ExpressionStatement {
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(
        t.identifier('Object'),
        t.identifier('defineProperty'),
      ),
      [
        target,
        t.stringLiteral('name'),
        t.objectExpression([
          t.objectProperty(t.identifier('value'), t.stringLiteral('default')),
        ]),
      ],
    ),
  );
}

/** `module.exports.<exported> = <value>;` (string names need computed). */
function exportAssignment(
  exported: t.Identifier | t.StringLiteral,
  value: string | t.Expression,
): t.ExpressionStatement {
  const target = t.memberExpression(
    t.memberExpression(t.identifier('module'), t.identifier('exports')),
    exported,
    t.isStringLiteral(exported),
  );
  return t.expressionStatement(
    t.assignmentExpression(
      '=',
      target,
      typeof value === 'string' ? t.identifier(value) : value,
    ),
  );
}

/**
 * Reject anything that is not a single JS expression, so the expression
 * cannot break out of the `(...)` wrapper (e.g. with `)}` injection).
 */
function validateExpression(expression: string): void {
  try {
    parseExpression(expression);
  } catch {
    throw new WcError(
      `Invalid expression ${JSON.stringify(expression)}: pass a single JavaScript expression (e.g. a decoder call like "decode(0)"). ` +
        `Statements and extra tokens are not allowed.`,
    );
  }
}

function sandboxError(error: unknown, opts: EvaluateInModuleOptions): WcError {
  if (error instanceof WcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  if (
    code === 'ERR_MODULE_NOT_FOUND' ||
    /cannot find (module|package)|failed to resolve|isolated-vm/i.test(message)
  ) {
    return new WcError(
      'isolated-vm is not available; install it or use wc_read to inspect the decoder manually.',
    );
  }
  if (/timed out|timeout/i.test(message)) {
    return new WcError(
      `Expression evaluation timed out after ${opts.timeoutMs}ms. ` +
        `Try a simpler expression or a larger timeout.`,
    );
  }
  if (
    /memory limit|array buffer allocation failed|out of memory|heap out of memory/i.test(
      message,
    )
  ) {
    return new WcError(
      `Expression evaluation exceeded the ${opts.memoryLimitMb}MB isolate memory limit. ` +
        `Try a simpler expression or a larger memory limit.`,
    );
  }
  return new WcError(`Expression evaluation failed: ${message}`);
}
