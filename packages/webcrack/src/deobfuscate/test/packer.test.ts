import { parse } from '@babel/parser';
import { describe, expect, test } from 'vitest';
import { applyTransform, applyTransformAsync, generate } from '../../ast-utils';
import deobfuscate from '../index';
import packer from '../packer';

function parseJS(input: string) {
  return parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });
}

function unpackJS(input: string): string {
  const ast = parseJS(input);
  applyTransform(ast, packer);
  return generate(ast);
}

function normalize(input: string): string {
  return generate(parseJS(input));
}

// Minimal reimplementation of the Dean Edwards packer *encoding* side, used
// to build fixtures with the same shapes real packer output has. The token
// mappings were differentially checked against the real encoder functions
// (`c.toString(a)`, the base62 `fromCharCode(c+29)` encoder and the high
// ascii `fromCharCode(c+161)` encoder) for indices 0..4999.
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encodeToken(radix: number, index: number): string {
  if (radix === 62) {
    if (index < 62) return BASE62[index];
    return encodeToken(62, Math.floor(index / 62)) + BASE62[index % 62];
  }
  if (radix === 95) {
    if (index < 95) return String.fromCharCode(index + 161);
    return (
      encodeToken(95, Math.floor(index / 95)) +
      String.fromCharCode((index % 95) + 161)
    );
  }
  return index.toString(radix);
}

function quote(text: string): string {
  return (
    "'" +
    text.replace(/['\\\n\r\u2028\u2029]/g, (char) => {
      switch (char) {
        case "'":
          return "\\'";
        case '\\':
          return '\\\\';
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        default:
          return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      }
    }) +
    "'"
  );
}

type Template = 'classic' | 'flat' | 'base62' | 'high-ascii';

const ENCODERS: Record<Template, string> = {
  classic: 'function(c){return c.toString(a)}',
  flat: 'function(c){return c.toString(a)}',
  base62:
    "function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))}",
  'high-ascii':
    "function(c){return(c<a?'':e(parseInt(c/a)))+String.fromCharCode(c%a+161)}",
};

function packerCall(
  source: string,
  radix: number,
  template: Template,
  params = ['p', 'a', 'c', 'k', 'e', 'd'],
): string {
  const seen = [...new Set(source.match(/\w+/g) ?? [])];
  // Order the dictionary so decoding is unambiguous: a keyword that is also
  // another word's token must decode at the same time or earlier, otherwise
  // the earlier substitution's output gets re-replaced. This holds for real
  // packer output too (verified: engine execution of a packed function with
  // a colliding dictionary corrupts the same way). Keywords equal to some
  // token come first, sorted by that token's index, so each either maps to
  // itself or to an already-decoded token; all other words keep first-seen
  // order and can never collide with a token.
  const tokenIndex = new Map<string, number>();
  for (let i = 0; i < seen.length; i++) {
    tokenIndex.set(encodeToken(radix, i), i);
  }
  const shaped = seen
    .filter((word) => tokenIndex.has(word))
    .sort((a, b) => tokenIndex.get(a)! - tokenIndex.get(b)!);
  const words = [...shaped, ...seen.filter((word) => !tokenIndex.has(word))];
  const payload = source.replace(
    new RegExp(
      `\\b(${[...words].sort((x, y) => y.length - x.length).join('|')})\\b`,
      'g',
    ),
    (word) => encodeToken(radix, words.indexOf(word)),
  );
  const [p, a, c, k, e, d] = params;
  const encoder = ENCODERS[template].replaceAll(
    /\b[pace]\b/g,
    (name) => ({ p, a, c, e })[name as 'p' | 'a' | 'c' | 'e'] ?? name,
  );
  const decoderLoop = `${c}--){if(${k}[${c}]){${p}=${p}.replace(new RegExp('\\\\b'+${e}(${c})+'\\\\b','g'),${k}[${c}])}}`;
  const symbian =
    template === 'classic'
      ? `if(!''.replace(/^/,String)){while(${c}--){${d}[${c}.toString(${a})]=${k}[${c}]||${c}.toString(${a})}${k}=[function(${e}){return ${d}[${e}]}];${e}=function(){return'\\\\w+'};${c}=1};`
      : '';
  return (
    `eval(function(${params.join(',')}){${e}=${encoder};${symbian}while(${decoderLoop}return ${p}}` +
    `(${quote(payload)},${radix},${words.length},${quote(words.join('|'))}.split('|'),0,{}))`
  );
}

const SAMPLE = 'var hello = "hi";\nalert(hello);';

describe('packer', () => {
  test('unpacks radix 10 (numeric) with symbian branch', () => {
    expect(unpackJS(packerCall(SAMPLE, 10, 'classic'))).toBe(normalize(SAMPLE));
  });

  test('unpacks radix 36 without symbian branch', () => {
    expect(unpackJS(packerCall(SAMPLE, 36, 'flat'))).toBe(normalize(SAMPLE));
  });

  test('unpacks radix 62 (base62 encoder, r parameter)', () => {
    const vars = Array.from({ length: 70 }, (_, i) => `var w${i} = ${i};`).join(
      '\n',
    );
    const source = `${vars}\nalert(w69);`;
    // 142 distinct words force multi-character base62 tokens (e.g. `10`).
    expect(
      unpackJS(
        packerCall(source, 62, 'base62', ['p', 'a', 'c', 'k', 'e', 'r']),
      ),
    ).toBe(normalize(source));
  });

  test('unpacks renamed parameters', () => {
    expect(
      unpackJS(
        packerCall(SAMPLE, 10, 'classic', ['_p', '_a', '_c', '_k', '_e', '_r']),
      ),
    ).toBe(normalize(SAMPLE));
  });

  test('unpacks high-ascii radix 95', () => {
    // `\b` only matches the non-word high-ascii tokens when they sit
    // between word characters (also true when the packed function runs),
    // so the fixture embeds the token that way. Verified to decode to the
    // same result when the packed function is executed.
    const input =
      "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+String.fromCharCode(c%a+161)};" +
      "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}" +
      "('x\\xa1y',95,1,'QQ'.split('|'),0,{}))";
    expect(unpackJS(input)).toBe('xQQy;');
  });

  test('inserts keywords with $ patterns literally', () => {
    // `String.replace` would interpret `$&`/`$'` in a string replacement;
    // the unpacker inserts keywords literally to recover the original code.
    const input =
      'eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};' +
      "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}" +
      "('0(\"hi\");',10,1,'a$$b'.split('|'),0,{}))";
    expect(unpackJS(input)).toBe('a$$b("hi");');
  });

  test('double-packed input unwraps through the deobfuscate loop', async () => {
    const once = packerCall(SAMPLE, 62, 'base62');
    const twice = packerCall(once, 10, 'classic');
    const ast = parseJS(twice);
    await applyTransformAsync(ast, deobfuscate, () =>
      Promise.resolve(undefined),
    );
    expect(generate(ast)).toBe(normalize(SAMPLE));
  });

  describe('leaves non-packer code untouched', () => {
    const cases: Record<string, string> = {
      'plain eval string': 'eval("console.log(1);");',
      'wrong function body':
        "eval(function(p,a,c,k,e,d){return p}('0',10,1,'a'.split('|'),0,{}));",
      'five parameters':
        "eval(function(p,a,c,k,e){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0',10,1,'a'.split('|'),0,{}));",
      'non-eval callee':
        "foo(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0',10,1,'a'.split('|'),0,{}));",
      'keywords array instead of split':
        "eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0',10,1,['a'],0,{}));",
      'fromCharCode encoder with radix 10':
        "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0',10,1,'a'.split('|'),0,{}));",
      'radix out of range':
        "eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0',100,1,'a'.split('|'),0,{}));",
      'payload decoding to invalid JS':
        "eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('(((',10,1,'a'.split('|'),0,{}));",
    };
    for (const [name, input] of Object.entries(cases)) {
      test(name, () => {
        const ast = parseJS(input);
        const { changes } = applyTransform(ast, packer);
        expect(changes).toBe(0);
        expect(generate(ast)).toBe(normalize(input));
      });
    }

    test('eval call in expression position', () => {
      const packed = packerCall('alert(1);', 10, 'flat');
      const input = `var x = ${packed};`;
      const ast = parseJS(input);
      const { changes } = applyTransform(ast, packer);
      expect(changes).toBe(0);
    });
  });
});
