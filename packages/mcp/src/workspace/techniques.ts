import { parse } from '@babel/parser';
import { detectInterpreters } from 'webcrack/analysis';
import type { InterpreterSummary } from './types';

/**
 * Obfuscation-technique detection for the `wc_open` overview
 * (`Obfuscation: …`, ROADMAP_MCP §3.4 / M1.3).
 *
 * Every technique is a cheap string-level heuristic over the original source,
 * except `vm-interpreter`, which reuses webcrack's `detectInterpreters`
 * (no new VM heuristic lives here). All patterns are linear-time
 * (`indexOf` or regexes without nested quantifiers, most with early exit),
 * so multi-MB inputs stay fast; only the jsfuck ratio samples a capped
 * prefix and only the VM check parses the code.
 */

/** `while (!![])` rotation-loop head, allowing arbitrary spacing. */
const WHILE_TRUE = /while\s*\(\s*!!\[\s*\]\s*\)/;
/** A control-flow order string such as `'4|3|0|5|2|6|1'`. */
const PIPE_ORDER = /['"][0-9]+(?:\|[0-9]+)+['"]/;
const BASE64_TAIL = '0123456789+/=';
const RC4_MODULO = /%\s*(?:0x100|256)\b/;
/** Two constant string literals compared: the dead-code-injection shape. */
const TWO_LITERAL_COMPARISON =
  /['"][^'"]{1,40}['"]\s*(?:===|!==|==|!=)\s*['"][^'"]{1,40}['"]/;
const HEX_IDENTIFIER = /_0x[0-9a-f]{4,}/g;
const CONSTRUCTOR_DEBUGGER = /constructor\s*\(\s*['"]debugger['"]\s*\)/;
/** Dean Edwards packer head; parameter names vary, arity does not. */
const EVAL_PACKER = /eval\s*\(\s*function\s*\(\w+,\w+,\w+,\w+,\w+/;
/** `fn.apply(context, arguments)`: the self-defending controller body. */
const APPLY_WITH_ARGUMENTS = /\.apply\s*\([^()]*\barguments\b[^()]*\)/;
/** The controller's `: function () {}` fallback branch. */
const EMPTY_FUNCTION_BRANCH = /:\s*function\s*\(\s*\)\s*\{\s*\}/;

/** JerryScript-style halfwidth katakana used by aaencode emoticons. */
const AA_MARK = 'ﾟ';
const JSFUCK_ALPHABET = new Set(['[', ']', '(', ')', '!', '+']);
/** Prefix sampled for the jsfuck alphabet ratio (representative head). */
const JSFUCK_SAMPLE_LENGTH = 8192;
const JSFUCK_MIN_CHARS = 100;
const JSFUCK_MIN_RATIO = 0.9;
/** At least this many `_0x…` hits before calling it hex identifiers. */
const HEX_IDENTIFIER_MIN = 3;
/** "Few, very long lines": the minified shape. */
const MINIFIED_MAX_LINES = 16;
const MINIFIED_MIN_LONGEST_LINE = 500;

/** Rotation IIFE: `while (!![])` loop shuffling an array with push/shift. */
function hasStringArrayRotator(code: string): boolean {
  return (
    WHILE_TRUE.test(code) && code.includes('push') && code.includes('shift')
  );
}

/** Custom base64 alphabet embedded in a string-array decoder. */
function hasBase64Decoder(code: string): boolean {
  return code.includes(BASE64_TAIL);
}

/** RC4 decoder: `charCodeAt`/`fromCharCode` keystream with `% 0x100`. */
function hasRc4Decoder(code: string): boolean {
  return (
    code.includes('charCodeAt') &&
    code.includes('fromCharCode') &&
    RC4_MODULO.test(code)
  );
}

/**
 * Pipe-separated order string (`"1|0|2"`) driving a `switch` dispatcher
 * loop. VM-style switches over decoded arrays have no such literal and
 * are reported as `vm-interpreter` instead.
 */
function hasControlFlowFlattening(code: string): boolean {
  return (
    PIPE_ORDER.test(code) && code.includes('switch') && WHILE_TRUE.test(code)
  );
}

/**
 * Single-call controller: `.apply(…, arguments)` plus a null-out, guarded
 * by a ternary with an empty-function branch. Identifier names do not
 * survive mangling, so only this structure is matched.
 */
function hasSelfDefending(code: string): boolean {
  return APPLY_WITH_ARGUMENTS.test(code) && EMPTY_FUNCTION_BRANCH.test(code);
}

/** A `debugger` statement behind an interval or `constructor("debugger")`. */
function hasDebugProtection(code: string): boolean {
  return (
    code.includes('debugger') &&
    (code.includes('setInterval') || CONSTRUCTOR_DEBUGGER.test(code))
  );
}

function hasDeadCode(code: string): boolean {
  return TWO_LITERAL_COMPARISON.test(code);
}

function hasHexIdentifiers(code: string): boolean {
  HEX_IDENTIFIER.lastIndex = 0;
  let count = 0;
  while (HEX_IDENTIFIER.exec(code) !== null) {
    count += 1;
    if (count >= HEX_IDENTIFIER_MIN) return true;
  }
  return false;
}

/** jsfuck: the whole file is (almost) only `[]()!+`. */
function isJsfuck(code: string): boolean {
  const sample = code.slice(0, JSFUCK_SAMPLE_LENGTH);
  let total = 0;
  let alphabet = 0;
  for (const char of sample) {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      continue;
    }
    total += 1;
    if (JSFUCK_ALPHABET.has(char)) alphabet += 1;
  }
  return total >= JSFUCK_MIN_CHARS && alphabet / total >= JSFUCK_MIN_RATIO;
}

/** jjencode: `$_, $__` dollar identifiers decoding with `~[]`. */
function hasJjencode(code: string): boolean {
  return code.includes('~[]') && (code.includes('$_') || code.includes('$__'));
}

/** aaencode: Japanese emoticon identifiers such as `(ﾟДﾟ)`. */
function hasAaencode(code: string): boolean {
  return code.includes(AA_MARK);
}

function hasEvalPacker(code: string): boolean {
  return EVAL_PACKER.test(code);
}

function longestLineStats(code: string): { lines: number; longest: number } {
  const lines = code.split('\n');
  let longest = 0;
  for (const line of lines) {
    if (line.length > longest) longest = line.length;
  }
  return { lines: lines.length, longest };
}

function isMinified(code: string): boolean {
  const { lines, longest } = longestLineStats(code);
  return lines <= MINIFIED_MAX_LINES && longest >= MINIFIED_MIN_LONGEST_LINE;
}

function countVmInterpreters(code: string): number {
  let ast: Parameters<typeof detectInterpreters>[0];
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch {
    return 0;
  }
  try {
    return detectInterpreters(ast).length;
  } catch {
    return 0;
  }
}

interface Technique {
  /** Stable human-readable label, e.g. `string-array (rotated, base64)`. */
  label: (code: string) => string | undefined;
  /** Same predicate re-run on the clean code for the `(removed)` marker. */
  present: (code: string) => boolean;
}

/**
 * Detect obfuscation techniques in `original`.
 *
 * `cleanModules` holds the deobfuscated module sources: a technique whose
 * signature is present in the original but gone from the clean code is
 * reported with a ` (removed)` suffix. `interpreters` lets the caller pass
 * the `detectInterpreters()` result computed at open time; when omitted it
 * is computed here from the parsed original.
 */
export function detectTechniques(
  original: string,
  cleanModules: string[],
  interpreters?: InterpreterSummary[],
): string[] {
  const clean = cleanModules.join('\n');
  const removedKnown = clean.trim().length > 0;

  const vmCount =
    interpreters === undefined
      ? countVmInterpreters(original)
      : interpreters.length;
  const vmInClean = (): boolean => {
    if (!removedKnown || vmCount === 0) return true;
    // Re-run the real heuristic on the clean code; an unparseable clean
    // tree keeps the label without the `(removed)` marker.
    try {
      const ast = parse(clean, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
      });
      return detectInterpreters(ast).length > 0;
    } catch {
      return true;
    }
  };

  const techniques: Technique[] = [
    {
      label: (code) => {
        if (!hasStringArrayRotator(code)) return undefined;
        const details = ['rotated'];
        if (hasBase64Decoder(code)) details.push('base64');
        if (hasRc4Decoder(code)) details.push('rc4');
        return `string-array (${details.join(', ')})`;
      },
      present: hasStringArrayRotator,
    },
    {
      label: (code) =>
        hasControlFlowFlattening(code) ? 'control-flow-flattening' : undefined,
      present: hasControlFlowFlattening,
    },
    {
      label: (code) => (hasSelfDefending(code) ? 'self-defending' : undefined),
      present: hasSelfDefending,
    },
    {
      label: (code) =>
        hasDebugProtection(code) ? 'debug-protection' : undefined,
      present: hasDebugProtection,
    },
    {
      label: (code) => (hasDeadCode(code) ? 'dead-code-injection' : undefined),
      present: hasDeadCode,
    },
    {
      label: (code) =>
        hasHexIdentifiers(code) ? 'hex-identifiers' : undefined,
      present: hasHexIdentifiers,
    },
    {
      label: (code) => (isJsfuck(code) ? 'jsfuck' : undefined),
      present: isJsfuck,
    },
    {
      label: (code) => (hasJjencode(code) ? 'jjencode' : undefined),
      present: hasJjencode,
    },
    {
      label: (code) => (hasAaencode(code) ? 'aaencode' : undefined),
      present: hasAaencode,
    },
    {
      label: (code) => (hasEvalPacker(code) ? 'eval-packer' : undefined),
      present: hasEvalPacker,
    },
    {
      label: () => (vmCount > 0 ? 'vm-interpreter' : undefined),
      present: () => vmInClean(),
    },
    {
      label: (code) => (isMinified(code) ? 'minified' : undefined),
      present: isMinified,
    },
  ];

  const found: string[] = [];
  for (const technique of techniques) {
    const label = technique.label(original);
    if (label === undefined) continue;
    if (removedKnown && !technique.present(clean)) {
      found.push(`${label} (removed)`);
    } else {
      found.push(label);
    }
  }
  return found;
}
