import { parse } from '@babel/parser';
import * as t from '@babel/types';
import type { Transform } from '../ast-utils';

// Dean Edwards packer unwrapper.
//
// Detects
//   eval(function(p,a,c,k,e,d){...}('payload', radix, count, 'k1|k2'.split('|'), 0, {}))
// (parameter names are flexible, the `d` parameter is sometimes named `r`)
// and decodes the payload statically, without executing the packed function.
//
// Supported encodings, selected by the radix argument and the shape of the
// `e=function(c){...}` encoder:
//   radix <= 36  `.toString(radix)` encoder (numeric/normal output)
//   radix == 62  `String.fromCharCode(c+29)` encoder (base62 output)
//   radix == 95  `String.fromCharCode(c+161)` encoder (high-ascii output)
// The optional `if(!''.replace(/^/,String)){...}` (symbian) branch may be
// present or absent; the static substitution below is valid for both paths.
export default {
  name: 'packer',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    return {
      ExpressionStatement(path) {
        const unpacked = matchPackerEval(path.node);
        if (!unpacked) return;

        let decoded: string;
        try {
          decoded = unpack(unpacked);
        } catch {
          return;
        }

        let program: t.Program;
        try {
          program = parse(decoded, {
            sourceType: 'unambiguous',
            allowReturnOutsideFunction: true,
          }).program;
        } catch {
          // Not valid JS (e.g. a lookalike with garbage payload): leave it.
          return;
        }

        path.replaceWithMultiple(program.body);
        this.changes++;
      },
    };
  },
} satisfies Transform;

interface PackerArgs {
  payload: string;
  radix: number;
  count: number;
  keywords: string[];
  encode: (index: number) => string;
}

// `eval(<packed call>)` as a bare expression statement. Anything else
// (nested eval, `x = eval(...)`, non-eval calls) is left alone.
function matchPackerEval(node: t.ExpressionStatement): PackerArgs | null {
  const { expression } = node;
  if (
    !t.isCallExpression(expression) ||
    !t.isIdentifier(expression.callee, { name: 'eval' }) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  const [arg] = expression.arguments;
  if (!t.isCallExpression(arg)) return null;
  return matchPackerCall(arg);
}

function matchPackerCall(node: t.CallExpression): PackerArgs | null {
  const { callee } = node;
  if (!t.isFunctionExpression(callee) || callee.params.length !== 6) {
    return null;
  }
  const names: string[] = [];
  for (const param of callee.params) {
    if (!t.isIdentifier(param) || names.includes(param.name)) return null;
    names.push(param.name);
  }
  const [p, , c, k, e] = names;

  if (node.arguments.length !== 6) return null;
  const [payloadArg, radixArg, countArg, keywordsArg, eArg, dArg] =
    node.arguments;
  const keywords = matchKeywordsSplit(keywordsArg);
  if (
    !t.isStringLiteral(payloadArg) ||
    !t.isNumericLiteral(radixArg) ||
    !t.isNumericLiteral(countArg) ||
    keywords === null ||
    !t.isNumericLiteral(eArg) ||
    !t.isObjectExpression(dArg) ||
    dArg.properties.length > 0
  ) {
    return null;
  }
  const radix = radixArg.value;
  const count = countArg.value;
  if (!Number.isInteger(radix) || !Number.isInteger(count) || count < 0) {
    return null;
  }

  // Empty statements carry no meaning (`...c=1};while...` in real output
  // parses the `;` as one) and are ignored for the shape check.
  const body = callee.body.body.filter((node) => !t.isEmptyStatement(node));
  // [e = function(c){...}, (if(...){...},)? while(c--){...}, return p]
  if (body.length !== 3 && body.length !== 4) return null;
  const [first, ...rest] = body;
  const encoder = matchEncoderAssignment(first, e);
  if (!encoder) return null;
  const last = rest[rest.length - 1];
  if (
    !t.isReturnStatement(last) ||
    !t.isIdentifier(last.argument, { name: p })
  ) {
    return null;
  }
  const middle = rest.slice(0, -1);
  const loop = middle.length === 2 ? middle[1] : middle[0];
  if (middle.length === 2 && !isSymbianBranch(middle[0])) return null;
  if (!isSubstituteLoop(loop, { p, c, k })) return null;

  const encode = matchEncoder(encoder, radix);
  if (!encode) return null;

  return {
    payload: payloadArg.value,
    radix,
    count,
    keywords,
    encode,
  };
}

function matchEncoderAssignment(
  node: t.Statement,
  eName: string,
): t.FunctionExpression | null {
  if (
    !t.isExpressionStatement(node) ||
    !t.isAssignmentExpression(node.expression, { operator: '=' }) ||
    !t.isIdentifier(node.expression.left, { name: eName }) ||
    !t.isFunctionExpression(node.expression.right) ||
    node.expression.right.params.length !== 1 ||
    !t.isIdentifier(node.expression.right.params[0])
  ) {
    return null;
  }
  return node.expression.right;
}

// `if(!''.replace(/^/,String)){...}` symbian workaround branch. Only the
// outer shape is checked; it does not affect the static decoding.
function isSymbianBranch(node: t.Statement): boolean {
  return (
    t.isIfStatement(node) &&
    t.isUnaryExpression(node.test, { operator: '!' }) &&
    t.isCallExpression(node.test.argument)
  );
}

// `while(c--){if(k[c]){p=p.replace(new RegExp(...),k[c])}}`
// (allowing brace variations: bodies may be blocks or single statements,
// and the `if(k[c])` guard may be omitted).
function isSubstituteLoop(
  node: t.Statement,
  names: { p: string; c: string; k: string },
): boolean {
  if (
    !t.isWhileStatement(node) ||
    !t.isUpdateExpression(node.test, { operator: '--' }) ||
    !t.isIdentifier(node.test.argument, { name: names.c })
  ) {
    return false;
  }
  return hasSubstituteAssignment(node.body, names);
}

function isSubstituteAssignment(
  node: t.Statement,
  names: { p: string; k: string },
): boolean {
  if (
    !t.isExpressionStatement(node) ||
    !t.isAssignmentExpression(node.expression, { operator: '=' }) ||
    !t.isIdentifier(node.expression.left, { name: names.p }) ||
    !t.isCallExpression(node.expression.right) ||
    !t.isMemberExpression(node.expression.right.callee) ||
    node.expression.right.callee.computed ||
    !t.isIdentifier(node.expression.right.callee.object, {
      name: names.p,
    }) ||
    !t.isIdentifier(node.expression.right.callee.property, {
      name: 'replace',
    }) ||
    node.expression.right.arguments.length !== 2
  ) {
    return false;
  }
  const [pattern] = node.expression.right.arguments;
  return (
    t.isNewExpression(pattern) &&
    t.isIdentifier(pattern.callee, { name: 'RegExp' })
  );
}

// Searches the loop body, tolerating brace variations (bare blocks and the
// `if(k[c])` guard with or without braces).
function hasSubstituteAssignment(
  node: t.Statement,
  names: { p: string; k: string },
): boolean {
  if (isSubstituteAssignment(node, names)) return true;
  if (t.isBlockStatement(node)) {
    return node.body.some((statement) =>
      hasSubstituteAssignment(statement, names),
    );
  }
  if (t.isIfStatement(node)) {
    return hasSubstituteAssignment(node.consequent, names);
  }
  return false;
}

// `'k1|k2|...'.split('|')` (delimiter is usually `|` but any string works).
function matchKeywordsSplit(
  node: t.CallExpression['arguments'][number],
): string[] | null {
  if (
    !t.isCallExpression(node) ||
    !t.isMemberExpression(node.callee) ||
    node.callee.computed ||
    !t.isStringLiteral(node.callee.object) ||
    !t.isIdentifier(node.callee.property, { name: 'split' }) ||
    node.arguments.length !== 1 ||
    !t.isStringLiteral(node.arguments[0])
  ) {
    return null;
  }
  return node.callee.object.value.split(node.arguments[0].value);
}

// Selects the static encoder matching the packed function's `e` encoder
// for the given radix, or null when they are inconsistent (lookalike).
function matchEncoder(
  encoder: t.FunctionExpression,
  radix: number,
): ((index: number) => string) | null {
  const usesFromCharCode = containsFromCharCode(encoder.body);
  if (usesFromCharCode) {
    if (radix === 62) return encode62;
    if (radix === 95) return encode95;
    return null;
  }
  if (radix >= 2 && radix <= 36) return (index) => index.toString(radix);
  return null;
}

function containsFromCharCode(node: t.Node): boolean {
  if (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.object, { name: 'String' }) &&
    t.isIdentifier(node.property, { name: 'fromCharCode' })
  ) {
    return true;
  }
  return Object.values(node).some((value) => {
    if (Array.isArray(value)) {
      return value.some((item) => t.isNode(item) && containsFromCharCode(item));
    }
    return t.isNode(value) && containsFromCharCode(value);
  });
}

const BASE62_DIGITS =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encode62(index: number): string {
  if (index < 62) return BASE62_DIGITS[index];
  return encode62(Math.floor(index / 62)) + BASE62_DIGITS[index % 62];
}

function encode95(index: number): string {
  if (index < 95) return String.fromCharCode((index % 95) + 161);
  return (
    encode95(Math.floor(index / 95)) + String.fromCharCode((index % 95) + 161)
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Static equivalent of the packer's
// `while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}`.
// The replacement uses a function so keywords containing `$` patterns
// (`$&`, `$'`, ...) are inserted literally instead of being interpreted
// by `String.replace`.
function unpack({ payload, count, keywords, encode }: PackerArgs): string {
  let text = payload;
  for (let index = count - 1; index >= 0; index--) {
    const word = keywords[index];
    if (!word) continue;
    const token = encode(index);
    text = text.replace(
      new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'),
      () => word,
    );
  }
  return text;
}
