import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AsyncTransform } from '../ast-utils';
import { generate } from '../ast-utils';
import type { Sandbox } from './vm';

/**
 * Decodes real AAEncode output
 * (http://utf-8.jp/public/aaencode.html, Yosuke HASEGAWA).
 *
 * The encoder emits a fixed block of 17 expression statements that builds
 * the original program as a string from emoticon-named variables and then
 * executes it:
 *
 * ```
 * ﾟωﾟﾉ= /｀ｍ´）ﾉ ~┻━┻   /[block comment]/ ["_"];  // opener: regex `["_"]`
 * o=(ﾟｰﾟ)  =_=3; c=(ﾟΘﾟ) =(ﾟｰﾟ)-(ﾟｰﾟ); ...       // numeric/character setup
 * (ﾟДﾟ)={ﾟΘﾟ: "_", ...}; ...                    // character table
 * (ﾟεﾟ)=...; (ﾟｰﾟ)+=(ﾟΘﾟ); ...                  // `ﾟεﾟ` becomes "return", ...
 * (ﾟДﾟ) ["_"] ((ﾟДﾟ) ["_"] (ﾟεﾟ+...+(ﾟДﾟ)[ﾟoﾟ]) (ﾟΘﾟ)) ("_"); // executor
 * ```
 *
 * The executor's inner call evaluates to the decoded source without running
 * it (`Function("return'<escapes>'")(1)`), while the outer call executes it.
 * Only the setup statements plus that inner call are evaluated in the
 * sandbox; the whole block is then rewritten as `Function("<decoded>")()`,
 * which the `evalUnwrap` pass splices open on the next unwrap-loop
 * iteration. Neighbouring user statements are left untouched.
 *
 * Security: every statement sent to the sandbox must match the encoder's
 * grammar exactly — only the encoder's variable names, its literals, the
 * regex trick, the `+ - / ^ == = +=` operators, member access and a single
 * object literal of those. Anything else (calls, other assignments,
 * non-allowlisted identifiers or string values, ...) aborts the run, so
 * arbitrary program statements never reach the sandbox.
 */
export default {
  name: 'aaencode',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    if (!sandbox) return;

    const containers: NodePath<t.Program | t.BlockStatement>[] = [];
    traverse(ast, {
      Program(path) {
        containers.push(path);
      },
      BlockStatement(path) {
        containers.push(path);
      },
    });

    for (const container of containers) {
      if (container.removed) continue;
      await decodeRuns(container, state, sandbox);
    }
  },
} satisfies AsyncTransform<Sandbox>;

// Variables the encoder assigns (implicit globals): the only identifiers
// that may appear as expressions in a run.
const ENCODER_VARIABLES = new Set([
  'ﾟωﾟﾉ',
  'o',
  'ﾟｰﾟ',
  '_',
  'c',
  'ﾟΘﾟ',
  'ﾟДﾟ',
  'ﾟoﾟ',
  'ﾟεﾟ',
  'oﾟｰﾟo',
]);

// Non-computed member names from the encoder's `basic` table
// (`(ﾟДﾟ).ﾟωﾟﾉ`, `(ﾟДﾟ).ﾟΘﾟﾉ`, `(ﾟДﾟ).ﾟｰﾟﾉ`, `(ﾟДﾟ).ﾟДﾟﾉ`).
const DOT_PROPERTIES = new Set(['ﾟωﾟﾉ', 'ﾟΘﾟﾉ', 'ﾟｰﾟﾉ', 'ﾟДﾟﾉ']);

// Keys of the encoder's single object literal.
const OBJECT_KEYS = new Set(['ﾟΘﾟ', 'ﾟωﾟﾉ', 'ﾟｰﾟﾉ', 'ﾟДﾟﾉ']);

// String values the encoder emits. Allowlisted (rather than any literal)
// because the payload becomes a `Function` body in the sandbox: the
// available pieces (`_ c o \ '`, digits and coerced words) cannot form call
// syntax, so the evaluated body stays a `return '<string>'` without breakout.
const ENCODER_STRINGS = new Set(['_', 'c', 'o', '\\', "'"]);

// Operators the encoder emits: arithmetic/comparison for the numeric and
// character building blocks, `=`/`+=` for the setup assignments.
const BINARY_OPERATORS = new Set(['+', '-', '/', '^', '==']);

/**
 * Whether `node` uses only the encoder's grammar: allowlisted identifiers,
 * literals, the regex trick, member access and object literals of those,
 * combined with the encoder's operators. Anything else — calls, functions,
 * assignments outside this shape, other identifiers — is rejected.
 */
function isEncoderExpression(node: t.Node | null | undefined): boolean {
  if (node == null) return false;
  if (t.isIdentifier(node)) return ENCODER_VARIABLES.has(node.name);
  if (t.isStringLiteral(node)) return ENCODER_STRINGS.has(node.value);
  if (t.isNumericLiteral(node) || t.isRegExpLiteral(node)) return true;
  if (t.isAssignmentExpression(node)) {
    if (node.operator !== '=' && node.operator !== '+=') return false;
    const left = node.left;
    if (
      !(
        (t.isIdentifier(left) && ENCODER_VARIABLES.has(left.name)) ||
        (t.isMemberExpression(left) && isEncoderMember(left))
      )
    ) {
      return false;
    }
    return isEncoderExpression(node.right);
  }
  if (t.isBinaryExpression(node)) {
    return (
      BINARY_OPERATORS.has(node.operator) &&
      isEncoderExpression(node.left) &&
      isEncoderExpression(node.right)
    );
  }
  if (t.isMemberExpression(node)) return isEncoderMember(node);
  if (t.isObjectExpression(node)) {
    return node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        t.isIdentifier(property.key) &&
        OBJECT_KEYS.has(property.key.name) &&
        isEncoderExpression(property.value),
    );
  }
  if (t.isParenthesizedExpression(node)) {
    return isEncoderExpression(node.expression);
  }
  return false;
}

function isEncoderMember(node: t.MemberExpression): boolean {
  if (!isEncoderExpression(node.object)) return false;
  if (node.computed) return isEncoderExpression(node.property);
  return (
    t.isIdentifier(node.property) && DOT_PROPERTIES.has(node.property.name)
  );
}

// The opener: `ﾟωﾟﾉ= /.../ ["_"]` (the block comment between the regex and
// `["_"]` is trivia and invisible in the AST).
function isOpener(statement: t.Statement | null | undefined): boolean {
  if (!t.isExpressionStatement(statement)) return false;
  const expression = statement.expression;
  return (
    t.isAssignmentExpression(expression, { operator: '=' }) &&
    t.isIdentifier(expression.left, { name: 'ﾟωﾟﾉ' }) &&
    t.isMemberExpression(expression.right, { computed: true }) &&
    t.isRegExpLiteral(expression.right.object) &&
    t.isStringLiteral(expression.right.property, { value: '_' })
  );
}

function isSetupStatement(statement: t.Statement | null | undefined): boolean {
  return (
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression) &&
    isEncoderExpression(statement.expression)
  );
}

interface Executor {
  /** The inner `(ﾟДﾟ)["_"] (<payload>) (ﾟΘﾟ)` call, evaluating to decoded source. */
  decoder: t.CallExpression;
}

/**
 * Matches the executor `(ﾟДﾟ)["_"]((ﾟДﾟ)["_"] (<payload>) (ﾟΘﾟ))("_")`
 * exactly: outer and inner constructor accesses must target `(ﾟДﾟ)["_"]`,
 * the invocation arguments must be `"_"` and `ﾟΘﾟ`, and the payload must be
 * a pure encoder expression mentioning `ﾟεﾟ` (the `"return"` prefix every
 * real payload carries — a static string would execute as code instead).
 */
function asExecutor(
  statement: t.Statement | null | undefined,
): Executor | null {
  if (!t.isExpressionStatement(statement)) return null;
  const outer = statement.expression;
  if (!t.isCallExpression(outer) || outer.arguments.length !== 1) return null;
  const outerArgument = outer.arguments[0];
  if (!t.isStringLiteral(outerArgument, { value: '_' })) return null;
  const middle = outer.callee;
  if (!t.isCallExpression(middle) || middle.arguments.length !== 1) return null;
  if (!isFunctionAccess(middle.callee)) return null;
  const inner = middle.arguments[0];
  if (!t.isCallExpression(inner) || inner.arguments.length !== 1) return null;
  const innerArgument = inner.arguments[0];
  if (!t.isIdentifier(innerArgument, { name: 'ﾟΘﾟ' })) return null;
  const constructor = inner.callee;
  if (!t.isCallExpression(constructor) || constructor.arguments.length !== 1) {
    return null;
  }
  if (!isFunctionAccess(constructor.callee)) return null;
  const payload = constructor.arguments[0];
  if (!t.isExpression(payload) || !isEncoderExpression(payload)) return null;
  if (!mentions(payload, 'ﾟεﾟ')) return null;
  return { decoder: inner };
}

// `(ﾟДﾟ)["_"]`: the Function constructor access the encoder builds.
function isFunctionAccess(node: t.Node | null | undefined): boolean {
  return (
    t.isMemberExpression(node, { computed: true }) &&
    t.isIdentifier(node.object, { name: 'ﾟДﾟ' }) &&
    t.isStringLiteral(node.property, { value: '_' })
  );
}

function mentions(node: t.Node, name: string): boolean {
  if (t.isIdentifier(node, { name })) return true;
  return (Object.values(node) as unknown[]).some((value) => {
    if (Array.isArray(value)) {
      return value.some(
        (item: unknown) => isNode(item) && mentions(item, name),
      );
    }
    return isNode(value) && mentions(value, name);
  });
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

async function decodeRuns(
  container: NodePath<t.Program | t.BlockStatement>,
  state: { changes: number },
  sandbox: Sandbox,
): Promise<void> {
  // A shadowed `Function` is some user value, so the `Function("...")()`
  // replacement would call the wrong thing; leave such scopes alone.
  if (container.scope.getBinding('Function')) return;

  const body = container.get('body');
  const runs: { start: number; end: number; executor: Executor }[] = [];
  let index = 0;
  while (index < body.length) {
    if (!isOpener(body[index].node)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < body.length && isSetupStatement(body[end].node)) end++;
    const executor = end < body.length ? asExecutor(body[end].node) : null;
    if (executor === null) {
      index++;
      continue;
    }
    runs.push({ start: index, end, executor });
    index = end + 1;
  }
  // Apply right to left: splicing a run only shifts the indices after it,
  // so earlier runs keep valid paths. Within a run the replacement keeps
  // the array length and removals go from last to first for the same reason.
  for (let i = runs.length - 1; i >= 0; i--) {
    const { start, end, executor } = runs[i];
    if (await decodeRun(body.slice(start, end + 1), executor, sandbox)) {
      state.changes++;
    }
  }
}

async function decodeRun(
  run: NodePath<t.Statement>[],
  executor: Executor,
  sandbox: Sandbox,
): Promise<boolean> {
  const setupCode = run
    .slice(0, -1)
    .map((path) => generate(path.node))
    .join('\n');
  let decoded: unknown;
  try {
    decoded = await sandbox(`${setupCode}\n(${generate(executor.decoder)});`);
  } catch {
    // Payloads that throw (or time out) in the sandbox are left untouched.
    return false;
  }
  if (typeof decoded !== 'string') return false;

  run[0].replaceWith(
    t.expressionStatement(
      t.callExpression(
        t.callExpression(t.identifier('Function'), [t.stringLiteral(decoded)]),
        [],
      ),
    ),
  );
  for (let i = run.length - 1; i >= 1; i--) run[i].remove();
  return true;
}
