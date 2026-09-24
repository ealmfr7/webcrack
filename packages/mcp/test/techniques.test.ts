import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { detectTechniques } from '../src/workspace/techniques';
import type { InterpreterSummary } from '../src/workspace/types';

function corpus(name: string): string {
  return readFileSync(
    new URL(`../../webcrack/test/corpus/${name}`, import.meta.url),
    'utf8',
  );
}

const PRETTY_CLEAN = ['function add(a, b) {\n  return a + b;\n}\n'];

const SELF_DEFENDING = `var _0x1a2b = function () {
  var _0x3c4d = true;
  return function (_0x5e6f, _0x7890) {
    var _0xabcd = _0x3c4d ? function () {
      if (_0x7890) {
        var _0xef01 = _0x7890.apply(_0x5e6f, arguments);
        _0x7890 = null;
        return _0xef01;
      }
    } : function () {};
    _0x3c4d = false;
    return _0xabcd;
  };
}();
var _0x2345 = _0x1a2b(this, function () {});
_0x2345();`;

const DEBUG_INTERVAL = `(function () {
  function _0xa1(_0xb2) {
    function _0xc3(_0xd4) {
      if ((_0xd4 + '' / _0xd4).length !== 1) {
        (function () {}.constructor('debugger')('call'));
      } else {
        debugger;
      }
    }
    _0xc3(++_0xb2);
  }
  try {
    _0xa1(0);
  } catch (e) {}
  setInterval(_0xa1, 4000);
})();`;

const DEBUG_CONSTRUCTOR_ONLY = `function check(x) {
  if (x) {
    check.constructor("debugger")("call");
  }
  return x;
}`;

const DEAD_CODE = `function load() {
  if ('0x3f2a' === '0x7b1c') {
    init();
  } else {
    fallback();
  }
}`;

// ~300 chars drawn only from the jsfuck alphabet.
const JSFUCK = `+!![]${'+!![]'.repeat(60)}[![]+[]][+[]]${'[+[]]'.repeat(20)}`;

const JJENCODE = `$_=~[];$_={___:++$_,$$$$:(![]+'')[$_],__$:++$_,$_$_:(![]+'')[$_],_$_:++$_,$_$$:({}+'')[$_],$$_$:++$_};$_.$_+$_.__$;`;

const AAENCODE = `(ﾟДﾟ)[ﾟoﾟ]='o';ﾟωﾟﾉ='test';(ﾟДﾟ)['_' + (ﾟДﾟ)[ﾟoﾟ]]((ﾟДﾟ)[ﾟoﾟ]);`;

const EVAL_PACKER = `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0 2 1',3,3,'var|alert|hi'.split('|'),0,{}))`;

const RC4_DECODER = `(function (u, v) {
  var p = u();
  while (!![]) {
    try {
      var s = parseInt(p(0x1)) + parseInt(p(0x2));
      if (s === v) break;
      else p['push'](p['shift']());
    } catch (e) {
      p['push'](p['shift']());
    }
  }
})(_0xa, 0x123);
function _0xb(_0xc, _0xd) {
  var _0xe = [], _0xf = 0;
  for (var _0xi = 0; _0xi < 0x100; _0xi++) { _0xe[_0xi] = _0xi; }
  for (var _0xj = 0; _0xj < 0x100; _0xj++) {
    _0xf = (_0xf + _0xe[_0xj] + _0xc.charCodeAt(_0xj % _0xc.length)) % 0x100;
  }
  var _0xr = '';
  for (var _0xk = 0; _0xk < _0xd.length; _0xk++) {
    _0xr += String.fromCharCode(_0xd.charCodeAt(_0xk) ^ _0xe[_0xk % 0x100]);
  }
  return _0xr;
}`;

const VM_LOOP = `var bc = [2, 0, 1, 0];
var pc = 0;
var acc = 0;
while (true) {
  var op = bc[pc++];
  switch (op) {
    case 0: acc += 1; break;
    case 1: acc += 10; break;
    case 2: acc *= 2; break;
    default: pc = -1;
  }
  if (pc < 0 || pc >= bc.length) break;
}
console.log(acc);`;

const PLAIN = `function add(a, b) {
  return a + b;
}

const total = add(1, 2);
console.log(total);
`;

describe('corpus samples', () => {
  test('obfuscator default: rotated string-array', () => {
    expect(detectTechniques(corpus('obfuscator-default.js'), [])).toEqual([
      'string-array (rotated)',
    ]);
  });

  test('obfuscator control-flow: string-array, flattening, vm', () => {
    expect(detectTechniques(corpus('obfuscator-control-flow.js'), [])).toEqual([
      'string-array (rotated)',
      'control-flow-flattening',
      'vm-interpreter',
    ]);
  });

  test('obfuscator high: base64 array, hex ids, vm, minified', () => {
    expect(detectTechniques(corpus('obfuscator-high.js'), [])).toEqual([
      'string-array (rotated, base64)',
      'hex-identifiers',
      'vm-interpreter',
      'minified',
    ]);
  });

  test('minified bundle: only minified', () => {
    expect(detectTechniques(corpus('minified-iife.js'), [])).toEqual([
      'minified',
    ]);
  });

  test('plain bundles: no techniques', () => {
    for (const name of [
      'esbuild-iife.js',
      'babel-transpiled.js',
      'bookmarklet.js',
    ]) {
      expect(detectTechniques(corpus(name), []), name).toEqual([]);
    }
  });
});

describe('handmade snippets', () => {
  test('self-defending controller', () => {
    // The mangled `_0x…` names also (correctly) report hex-identifiers.
    expect(detectTechniques(SELF_DEFENDING, [])).toEqual([
      'self-defending',
      'hex-identifiers',
    ]);
  });

  test('debug-protection via interval and via constructor', () => {
    expect(detectTechniques(DEBUG_INTERVAL, [])).toEqual(['debug-protection']);
    expect(detectTechniques(DEBUG_CONSTRUCTOR_ONLY, [])).toEqual([
      'debug-protection',
    ]);
  });

  test('dead-code injection', () => {
    expect(detectTechniques(DEAD_CODE, [])).toEqual(['dead-code-injection']);
  });

  test('jsfuck, jjencode, aaencode', () => {
    expect(detectTechniques(JSFUCK, [])).toEqual(['jsfuck']);
    expect(detectTechniques(JJENCODE, [])).toEqual(['jjencode']);
    expect(detectTechniques(AAENCODE, [])).toEqual(['aaencode']);
  });

  test('eval packer', () => {
    expect(detectTechniques(EVAL_PACKER, [])).toEqual(['eval-packer']);
  });

  test('rc4 string-array decoder', () => {
    expect(detectTechniques(RC4_DECODER, [])).toEqual([
      'string-array (rotated, rc4)',
    ]);
  });

  test('vm loop detected without an interpreters hint', () => {
    expect(detectTechniques(VM_LOOP, [])).toEqual(['vm-interpreter']);
  });

  test('interpreters hint is used as given', () => {
    const hint: InterpreterSummary[] = [
      {
        module: 'main.js',
        line: 1,
        endLine: 5,
        dispatchKind: 'switch',
        handlerCount: 2,
      },
    ];
    expect(detectTechniques('var x = 1;\n', [], hint)).toEqual([
      'vm-interpreter',
    ]);
    expect(detectTechniques('var x = 1;\n', [])).toEqual([]);
  });
});

describe('(removed) marking', () => {
  test('signatures gone from clean code are marked', () => {
    const found = detectTechniques(corpus('obfuscator-high.js'), PRETTY_CLEAN);
    expect(found.length).toBeGreaterThan(0);
    for (const label of found) {
      expect(label.endsWith('(removed)')).toBe(true);
    }
  });

  test('no marker without clean code or when the signature persists', () => {
    const found = detectTechniques(corpus('obfuscator-high.js'), []);
    expect(found.length).toBeGreaterThan(0);
    for (const label of found) {
      expect(label.includes('removed')).toBe(false);
    }
    expect(detectTechniques(DEAD_CODE, [DEAD_CODE])).toEqual([
      'dead-code-injection',
    ]);
  });
});

describe('plain code', () => {
  test('unobfuscated code reports nothing', () => {
    expect(detectTechniques(PLAIN, PRETTY_CLEAN)).toEqual([]);
  });

  test('a stray debugger statement alone is not debug-protection', () => {
    expect(detectTechniques(`${PLAIN}\ndebugger;\n`, [])).toEqual([]);
  });
});

describe('performance', () => {
  test('~2 MB input finishes quickly', () => {
    const header = `var _0xpool = ['a', 'b'];
(function (c, d) {
  var e = c();
  while (!![]) {
    try {
      var f = parseInt(e(0x0)) + parseInt(e(0x1));
      if (f === d) break;
      else e['push'](e['shift']());
    } catch (g) {
      e['push'](e['shift']());
    }
  }
})(_0xget, 100);\n`;
    const filler =
      'var abcdefghijklmnopqrstuvwxyz0123456789 = 123456789012345678901234567890;\n';
    const target = 2 * 1024 * 1024;
    const big =
      header +
      filler.repeat(Math.ceil((target - header.length) / filler.length));
    expect(big.length).toBeGreaterThan(target - filler.length);

    const start = Date.now();
    const found = detectTechniques(big, []);
    const elapsed = Date.now() - start;

    expect(found).toContain('string-array (rotated)');
    expect(elapsed).toBeLessThan(1500);
  });
});
