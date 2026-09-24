import generatorModule from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { Command } from 'commander';
import debug from 'debug';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renameWithLLM,
  unpackChunks,
  webcrack,
  type Options,
  type RenameLogEntry,
  type SuggestNames,
  type UnpackChunksResult,
  type WebcrackResult,
} from './index.js';

const log = debug('webcrack:cli');

// Mirrors `generate` from src/ast-utils (which cli-lib cannot import: with
// `bundle: false` only built entries exist in dist, so internal source files
// are imported through the bundled `./index.js` and externals directly).
// The `default ?? module` dance matches the `babelImportPlugin` in
// esbuild.config.js (see https://github.com/babel/babel/issues/15269).
const babelGenerate =
  (generatorModule as unknown as { default?: unknown }).default ??
  generatorModule;

function generate(ast: t.Node): string {
  return (
    babelGenerate as (
      ast: t.Node,
      options: Record<string, unknown>,
    ) => { code: string }
  )(ast, { jsescOption: { minimal: true } }).code;
}

/**
 * Flags shared by the single- and multi-input CLI drivers. They map 1:1 to
 * the matching {@link Options} of {@link webcrack}.
 */
export interface CLIFlags {
  mangle?: boolean;
  jsx?: boolean;
  unpack?: boolean;
  deobfuscate?: boolean;
  unminify?: boolean;
  renameHeuristics?: boolean;
  report?: boolean;
  graph?: boolean;
  trace?: boolean;
  sourceMap?: boolean;
  libraryMappings?: boolean;
}

export function toWebcrackOptions(flags: CLIFlags): Options {
  const options: Options = {};
  if (flags.jsx !== undefined) options.jsx = flags.jsx;
  if (flags.unpack !== undefined) options.unpack = flags.unpack;
  if (flags.deobfuscate !== undefined) options.deobfuscate = flags.deobfuscate;
  if (flags.unminify !== undefined) options.unminify = flags.unminify;
  if (flags.mangle !== undefined) options.mangle = flags.mangle;
  if (flags.renameHeuristics !== undefined)
    options.renameHeuristics = flags.renameHeuristics;
  if (flags.report !== undefined) options.report = flags.report;
  if (flags.graph !== undefined) options.graph = flags.graph;
  if (flags.trace !== undefined) options.trace = flags.trace;
  if (flags.sourceMap !== undefined) options.sourceMap = flags.sourceMap;
  if (flags.libraryMappings !== undefined)
    options.libraryMappings = flags.libraryMappings;
  return options;
}

function warn(message: string): void {
  log(message);
  console.warn(message);
}

function runCommand(command: string, input: string, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    // `detached` puts the shell and its children in their own process group
    // so a timeout kills the whole group: with `shell: true` the sleep/body
    // runs as a grandchild that would otherwise hold the pipes open and
    // delay the `close` event.
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`LLM command timed out after ${timeoutMs}ms: ${command}`));
      if (child.pid !== undefined) {
        try {
          process.kill(
            process.platform === 'win32' ? child.pid : -child.pid,
            'SIGKILL',
          );
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => fail(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout);
      } else if (signal !== null) {
        fail(
          new Error(`LLM command terminated by signal ${signal}: ${command}`),
        );
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        fail(new Error(`LLM command exited with code ${code}${detail}`));
      }
    });
    child.stdin.on('error', (error) => {
      // The command may exit without reading stdin (e.g. `exit 3`): the
      // write then fails with EPIPE. Ignore it so the `close` handler
      // below reports the real exit code instead of "write EPIPE".
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
      fail(error);
    });
    child.stdin.end(input);
  });
}

/**
 * Builds a {@link SuggestNames} callback backed by an external command. The
 * command is spawned with a shell, the batch (a JSON array of
 * `LLMBindingInfo`) is written to its stdin and a JSON `{oldName: newName}`
 * map is read from its stdout.
 *
 * A non-zero exit, a timeout or invalid JSON output fails the batch: a
 * warning is printed and the error is rethrown so that {@link renameWithLLM}
 * skips that batch while other batches still apply.
 */
export function commandSuggestNames(
  command: string,
  timeoutMs: number,
): SuggestNames {
  return async (batch) => {
    let stdout: string;
    try {
      stdout = await runCommand(command, JSON.stringify(batch), timeoutMs);
    } catch (error) {
      warn(
        `webcrack: skipping LLM rename batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const message = `webcrack: skipping LLM rename batch: invalid JSON output: ${stdout.slice(0, 200)}`;
      warn(message);
      throw new Error(message);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const message = `webcrack: skipping LLM rename batch: expected a JSON object, got: ${stdout.slice(0, 200)}`;
      warn(message);
      throw new Error(message);
    }
    return parsed as Record<string, string>;
  };
}

/**
 * Validates the `--llm-rename-command` / `--llm-timeout` / `--source-map`
 * flag combination. Returns an error message when the combination is
 * invalid, `undefined` when it is valid.
 */
export function validateLLMFlags({
  sourceMap,
  llmRenameCommand,
  llmTimeout,
}: {
  sourceMap?: boolean;
  llmRenameCommand?: string;
  llmTimeout?: unknown;
}): string | undefined {
  if (sourceMap && llmRenameCommand !== undefined) {
    return '--source-map cannot be used with --llm-rename-command';
  }
  if (llmTimeout !== undefined) {
    const timeout =
      typeof llmTimeout === 'string' ? Number(llmTimeout) : llmTimeout;
    if (
      typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      timeout > 2147483647
    ) {
      return '--llm-timeout must be a positive integer';
    }
  }
  return undefined;
}

/**
 * Renames bindings in an already-produced {@link WebcrackResult} using
 * {@link renameWithLLM}: when a bundle exists only every module AST is
 * renamed and its code regenerated via `module.regenerateCode()` (the
 * module code also appears in the top-level code, so renaming both would
 * offer every binding to `suggestNames` twice); otherwise the top-level
 * code is re-parsed, renamed and regenerated.
 *
 * Pass `options.target: 'code'` to rename the top-level `result.code`
 * instead of the modules (used by the CLI when printing to stdout without
 * `-o`, where only `result.code` is shown). The default `'modules'`
 * preserves the bundle behavior above.
 *
 * `result.save()` is patched (in the no-bundle case, and in the bundle
 * case with `target: 'code'`) so the saved `deobfuscated.js` contains the
 * renamed code (`save` closes over the pre-rename output internally).
 */
export async function applyLLMRename(
  result: WebcrackResult,
  suggestNames: SuggestNames,
  options?: { target?: 'modules' | 'code' },
): Promise<RenameLogEntry[]> {
  if (result.bundle && options?.target !== 'code') {
    const logEntries: RenameLogEntry[] = [];
    for (const module of result.bundle.modules.values()) {
      logEntries.push(...(await renameWithLLM(module.ast, { suggestNames })));
      module.regenerateCode();
    }
    return logEntries;
  }

  const ast = parse(result.code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ['jsx'],
  });
  const logEntries = await renameWithLLM(ast, { suggestNames });
  const renamedCode = generate(ast);
  (result as { code: string }).code = renamedCode;

  const originalSave = result.save.bind(result);
  const hasMap = result.map !== undefined;
  result.save = async (path: string) => {
    await originalSave(path);
    await writeFile(
      join(normalize(path), 'deobfuscated.js'),
      hasMap
        ? `${renamedCode}\n//# sourceMappingURL=deobfuscated.js.map\n`
        : renamedCode,
      'utf8',
    );
  };
  return logEntries;
}

/**
 * IO streams for {@link runCli}. `stdout`/`stderr` receive everything the
 * CLI prints (including `--help`/`--version` and `program.error` output);
 * `stdin` is read when no input file is given (defaults to
 * `process.stdin`).
 */
export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
}

interface RunCliOptions extends CLIFlags {
  force?: boolean;
  output?: string;
  llmRenameCommand?: string;
  llmTimeout?: number;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  const withEncoding = stdin as NodeJS.ReadableStream &
    Partial<Pick<NodeJS.ReadStream, 'setEncoding'>>;
  withEncoding.setEncoding?.('utf8');
  for await (const chunk of stdin)
    data += typeof chunk === 'string' ? chunk : String(chunk);
  return data;
}

/**
 * Runs the `webcrack` CLI for the given argv (parsed with the default
 * `from: 'node'`, i.e. `['node', 'webcrack', ...args]`).
 *
 * A fresh `Command` is built on every call so concurrent/sequential calls
 * never share state (the test runner uses `--no-isolate`). Output goes to
 * `io` instead of the process streams. Resolves on success; rejects with
 * the `CommanderError` from `--help`/`--version` (exitCode 0) or
 * `program.error` (exitCode 1), or with the raw error (e.g. a missing
 * input file).
 */
export async function runCli(argv: string[], io: CliIO): Promise<void> {
  const { version, description } = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    ),
  ) as { version: string; description: string };

  const program = new Command();
  program
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .version(version)
    .description(description)
    .option('-o, --output <path>', 'output directory for bundled files')
    .option('-f, --force', 'overwrite output directory')
    .option('-m, --mangle', 'mangle variable names')
    .option('--no-jsx', 'do not decompile JSX')
    .option('--no-unpack', 'do not extract modules from the bundle')
    .option('--no-deobfuscate', 'do not deobfuscate the code')
    .option('--no-unminify', 'do not unminify the code')
    .option('--report', 'collect URLs, endpoints, secrets and other findings')
    .option('--graph', 'build the module dependency and call graphs')
    .option('--trace', 'record a per-stage transform trace')
    .option('--source-map', 'emit a source map of the deobfuscated code')
    .option(
      '--rename-heuristics',
      'rename short or mangled variable names using heuristics',
    )
    .option(
      '--library-mappings',
      'name modules matching known open-source libraries',
    )
    .option(
      '--llm-rename-command <cmd>',
      'external command for LLM-based renaming (batch JSON on stdin, {old:new} map on stdout)',
    )
    .option(
      '--llm-timeout <ms>',
      'timeout in ms for the LLM rename command',
      (value) => Number(value),
      30000,
    )
    .argument('[files...]', 'input files, defaults to stdin')
    .action(async (files: string[]) => {
      const {
        output,
        force,
        llmRenameCommand,
        llmTimeout = 30000,
        ...flags
      } = program.opts<RunCliOptions>();
      const validationError = validateLLMFlags({
        sourceMap: flags.sourceMap,
        llmRenameCommand,
        llmTimeout,
      });
      if (validationError !== undefined) program.error(validationError);
      const options = toWebcrackOptions(flags);
      const suggestNames =
        llmRenameCommand === undefined
          ? undefined
          : commandSuggestNames(llmRenameCommand, llmTimeout);

      if (files.length > 1 && !output) {
        program.error('multiple input files require the --output option');
      }

      if (output) {
        if (force || !existsSync(output)) {
          await rm(output, { recursive: true, force: true });
        } else {
          program.error('output directory already exists');
        }
      }

      if (files.length > 1) {
        const inputs = await Promise.all(
          files.map(async (file) => ({
            name: file,
            code: await readFile(file, 'utf8'),
          })),
        );
        await runMultiInput(inputs, output!, flags, suggestNames);
        return;
      }

      const code = await (files[0]
        ? readFile(files[0], 'utf8')
        : readStdin(io.stdin ?? process.stdin));
      const result = await webcrack(code, options);
      if (suggestNames)
        await applyLLMRename(
          result,
          suggestNames,
          output ? undefined : { target: 'code' },
        );

      if (output) {
        await result.save(output);
      } else {
        io.stdout.write(result.code + '\n');
        if (result.bundle) {
          debug('webcrack:unpack')(
            'Modules are not displayed in the terminal. Use the --output option to save them to a directory.',
          );
        }
      }
    });
  await program.parseAsync(argv);
}

export function installEpipeGuard(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
    throw error;
  });
}

export interface MultiInputItem {
  /** Input file path (used for the per-input output directory name). */
  name: string;
  code: string;
}

export interface MultiInputResult extends UnpackChunksResult {
  results: WebcrackResult[];
}

/**
 * Directory names for each input under the output directory: each input's
 * base file name without extension. The names are unique — the first
 * occurrence keeps the bare name, later ones get `-2`, `-3`, … — and never
 * clash with `reserved` (compared with and without extension), so per-input
 * directories overwrite neither each other nor files saved from a bundle.
 */
export function perInputDirNames(
  names: string[],
  reserved: Iterable<string> = [],
): string[] {
  const blocked = new Set<string>();
  for (const entry of reserved) {
    blocked.add(entry);
    const ext = extname(entry);
    if (ext) blocked.add(entry.slice(0, -ext.length));
  }
  const used = new Set<string>();
  return names.map((name) => {
    const base = basename(name);
    const ext = extname(base);
    const bare = ext ? base.slice(0, -ext.length) : base;
    let candidate = bare;
    let suffix = 2;
    while (used.has(candidate) || blocked.has(candidate)) {
      candidate = `${bare}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Deobfuscates several chunk files of the same app and merges them into a
 * single bundle. Each input is processed with
 * `webcrack(code, {unpack: false, ...flags})` one input at a time, the
 * outputs are merged with {@link unpackChunks} and the merged bundle is
 * saved to `outDir`.
 *
 * `--report`/`--graph`/`--trace`/`--source-map` artifacts are written per
 * input under `<outDir>/<basename>/` via each result's `save()`; the
 * directory names are unique per input and never clash with files saved
 * from the merged bundle. LLM renaming runs once per piece of code: on the
 * merged bundle when one was detected, otherwise per input.
 * Warnings and unresolved specifiers are printed to stderr.
 */
export async function runMultiInput(
  inputs: MultiInputItem[],
  outDir: string,
  flags: CLIFlags = {},
  suggestNames?: SuggestNames,
): Promise<MultiInputResult> {
  const results: WebcrackResult[] = [];
  for (const input of inputs) {
    const result = await webcrack(input.code, {
      ...toWebcrackOptions(flags),
      unpack: false,
    });
    results.push(result);
  }

  const { bundle, unresolved, warnings } = unpackChunks(
    results.map((result) => result.code),
  );

  if (suggestNames) {
    if (bundle) {
      for (const module of bundle.modules.values()) {
        await renameWithLLM(module.ast, { suggestNames });
        module.regenerateCode();
      }
    } else {
      for (const result of results) {
        await applyLLMRename(result, suggestNames);
      }
    }
  }

  const reserved = bundle
    ? [...bundle.modules.values()].map(
        (module) => module.path.replace(/^\.\//, '').split('/')[0],
      )
    : [];
  const dirNames = perInputDirNames(
    inputs.map((input) => input.name),
    reserved,
  );

  for (let i = 0; i < inputs.length; i++) {
    await results[i].save(join(outDir, dirNames[i]));
  }

  if (bundle) {
    await bundle.save(outDir);
  } else {
    warn('webcrack: no known chunk format detected in any input');
  }

  for (const warning of warnings) warn(`webcrack: ${warning}`);
  for (const specifier of unresolved) {
    warn(`webcrack: unresolved reference '${specifier}'`);
  }

  return { bundle, unresolved, warnings, results };
}
