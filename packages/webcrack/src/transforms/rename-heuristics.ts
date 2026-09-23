import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { toIdentifier } from '@babel/types';
import { renameFast, type Transform } from '../ast-utils';
import { generateUid } from '../ast-utils/scope';

/**
 * Rename short/mangled bindings using heuristics:
 * - `const x = require('axios')` / `import x from 'axios'` -> `axios`
 * - event handler params (`addEventListener`, `on*`) -> `event`
 * - numeric for-loop indices -> `i`, `j`, `k` by nesting depth
 * - first param of functions returning JSX / `React.createElement` -> `props`
 * - `.map((x, y) => ...)` params -> `item`, `index`
 *
 * Only bindings with short/mangled names are renamed. Globals, exports
 * and already descriptive names are never touched. New names are made
 * collision-safe with {@link generateUid}.
 */
export default {
  name: 'rename-heuristics',
  tags: ['safe'],
  scope: true,
  visitor() {
    const renamed = new Set<Binding>();
    return {
      VariableDeclarator(path) {
        const id = path.get('id');
        if (!id.isIdentifier()) return;
        const init = path.get('init');
        if (!init.isCallExpression()) return;
        if (!init.get('callee').isIdentifier({ name: 'require' })) return;
        // Ignore shadowed `require`
        if (path.scope.getBinding('require')) return;
        const args = init.get('arguments');
        if (args.length !== 1 || !args[0].isStringLiteral()) return;
        const base = moduleToName(args[0].node.value);
        if (!base) return;
        const binding = path.scope.getBinding(id.node.name);
        if (binding) safeRename(binding, base, renamed);
      },
      ImportDeclaration(path) {
        const base = moduleToName(path.node.source.value);
        if (!base) return;
        for (const specifier of path.get('specifiers')) {
          if (
            !specifier.isImportDefaultSpecifier() &&
            !specifier.isImportNamespaceSpecifier()
          )
            continue;
          const binding = path.scope.getBinding(specifier.node.local.name);
          if (binding) safeRename(binding, base, renamed);
        }
      },
      CallExpression(path) {
        const callee = path.get('callee');
        if (!callee.isMemberExpression()) return;
        const propName = memberKey(callee);
        if (!propName) return;
        const args = path.get('arguments');
        // `addEventListener(type, handler)` takes the handler second,
        // `.map(callback)` takes it first
        const handler = args[propName === 'addEventListener' ? 1 : 0];
        if (propName !== 'addEventListener' && propName !== 'map') return;
        if (
          !handler ||
          (!handler.isFunctionExpression() &&
            !handler.isArrowFunctionExpression())
        )
          return;
        if (propName === 'addEventListener') {
          renameParamAt(handler, 0, 'event', renamed);
        } else {
          renameParamAt(handler, 0, 'item', renamed);
          renameParamAt(handler, 1, 'index', renamed);
        }
      },
      AssignmentExpression(path) {
        if (path.node.operator !== '=') return;
        const left = path.get('left');
        if (!left.isMemberExpression()) return;
        const key = memberKey(left);
        if (!key || key.length <= 2 || !key.toLowerCase().startsWith('on'))
          return;
        const right = path.get('right');
        if (!right.isFunctionExpression() && !right.isArrowFunctionExpression())
          return;
        renameParamAt(right, 0, 'event', renamed);
      },
      ObjectProperty(path) {
        const key = path.node.key;
        const name =
          !path.node.computed && key.type === 'Identifier'
            ? key.name
            : key.type === 'StringLiteral'
              ? key.value
              : undefined;
        if (!name || name.length <= 2 || !name.toLowerCase().startsWith('on'))
          return;
        const value = path.get('value');
        if (!value.isFunctionExpression() && !value.isArrowFunctionExpression())
          return;
        renameParamAt(value, 0, 'event', renamed);
      },
      ForStatement(path) {
        const name = getNumericLoopVar(path);
        if (!name) return;
        const binding = path.scope.getBinding(name);
        if (!binding) return;
        let depth = 0;
        let parent: NodePath | null = path.parentPath;
        while (parent) {
          if (parent.isForStatement()) depth++;
          parent = parent.parentPath;
        }
        safeRename(binding, LOOP_NAMES[depth] ?? `i${depth + 1}`, renamed);
      },
      Function(path) {
        if (!returnsJsx(path)) return;
        renameParamAt(path, 0, 'props', renamed);
      },
    };
  },
} satisfies Transform;

const LOOP_NAMES = ['i', 'j', 'k'];

const MINIFIED_PATTERNS = [
  /^_0x[0-9a-f]+$/i, // javascript-obfuscator identifiers
  /^\$[a-zA-Z0-9_$]*$/, // $a, $$, ...
  /^[a-zA-Z_$][a-zA-Z0-9_$]*\$\d+$/, // e$1, foo$2 (bundler scope joins)
];

function isMangledName(name: string): boolean {
  return (
    name.length <= 2 || MINIFIED_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/**
 * `axios` -> `axios`, `@scope/foo-bar` -> `fooBar`, `node:fs` -> `fs`.
 */
function moduleToName(source: string): string | undefined {
  let name = source.replace(/^node:/, '');
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) return undefined;
    name = name.slice(slash + 1);
  }
  name = name.split('/')[0];
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const [first, ...rest] = words;
  const base =
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return base || undefined;
}

function memberKey(path: NodePath<t.MemberExpression>): string | undefined {
  const property = path.get('property');
  if (!path.node.computed && property.isIdentifier()) {
    return property.node.name;
  }
  if (property.isStringLiteral()) {
    return property.node.value;
  }
  return undefined;
}

function paramNameAt(
  fn: NodePath<t.Function>,
  index: number,
): string | undefined {
  const param = fn.node.params[index];
  if (!param) return undefined;
  if (param.type === 'Identifier') return param.name;
  if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
    return param.left.name;
  }
  return undefined;
}

function renameParamAt(
  fn: NodePath<t.Function>,
  index: number,
  base: string,
  renamed: Set<Binding>,
): void {
  const name = paramNameAt(fn, index);
  if (!name) return;
  const binding = fn.scope.getBinding(name);
  if (!binding || binding.kind !== 'param') return;
  safeRename(binding, base, renamed);
}

function getNumericLoopVar(path: NodePath<t.ForStatement>): string | undefined {
  const init = path.get('init');
  let name: string | undefined;
  if (init.isVariableDeclaration() && init.node.declarations.length === 1) {
    const declarator = init.node.declarations[0];
    if (
      declarator.id.type === 'Identifier' &&
      declarator.init?.type === 'NumericLiteral'
    ) {
      name = declarator.id.name;
    }
  } else if (
    init.isAssignmentExpression({ operator: '=' }) &&
    init.get('left').isIdentifier() &&
    init.get('right').isNumericLiteral()
  ) {
    name = (init.get('left') as NodePath<t.Identifier>).node.name;
  }
  if (!name) return undefined;

  const update = path.get('update');
  const updatesVar =
    (update.isUpdateExpression() &&
      update.get('argument').isIdentifier({ name })) ||
    (update.isAssignmentExpression() &&
      update.get('left').isIdentifier({ name }));
  if (!updatesVar) return undefined;

  let usedInTest = false;
  const test = path.get('test');
  if (test.isExpression()) {
    test.traverse({
      Identifier(identifier) {
        if (identifier.node.name === name) {
          usedInTest = true;
          identifier.stop();
        }
      },
    });
  }
  if (!usedInTest) return undefined;
  return name;
}

function returnsJsx(fn: NodePath<t.Function>): boolean {
  let found = false;
  fn.traverse({
    Function(inner) {
      if (inner.node !== fn.node) inner.skip();
    },
    JSXElement() {
      found = true;
    },
    JSXFragment() {
      found = true;
    },
    CallExpression(path) {
      const callee = path.get('callee');
      if (
        callee.isMemberExpression() &&
        !callee.node.computed &&
        callee.get('property').isIdentifier({ name: 'createElement' })
      ) {
        found = true;
      }
    },
  });
  return found;
}

function safeRename(
  binding: Binding,
  base: string,
  renamed: Set<Binding>,
): void {
  if (renamed.has(binding)) return;
  const current = binding.identifier.name;
  if (!isMangledName(current)) return;
  const desired = toIdentifier(base);
  if (!desired || desired === current) return;
  // Never rename exports
  if (
    binding.path.findParent(
      (parent) =>
        parent.isExportNamedDeclaration() ||
        parent.isExportDefaultDeclaration(),
    )
  )
    return;
  if (
    binding.referencePaths.some(
      (reference) =>
        reference.isExportNamedDeclaration() ||
        reference.isExportDefaultDeclaration(),
    )
  )
    return;
  const newName = generateUid(binding.scope, desired);
  if (newName === current) return;
  renamed.add(binding);
  renameFast(binding, newName);
}
