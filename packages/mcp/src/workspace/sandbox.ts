import { parse, parseExpression } from '@babel/parser';
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
 * isolated-vm sandbox. The module runs with `module`/`exports`, a stub
 * `require`, and `window`/`self` aliases; a throwing module does not stop
 * the expression. The result is always returned as a string.
 */
export async function evaluateInModule(
  code: string,
  expression: string,
  opts: EvaluateInModuleOptions,
): Promise<string> {
  validateExpression(expression);
  const safe = sanitizeModuleCode(code);
  const script = [
    'var module={exports:{}},exports=module.exports,require=function(){return {}},window=globalThis,self=globalThis;',
    `try{\n${safe}\n}catch(e){};`,
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
