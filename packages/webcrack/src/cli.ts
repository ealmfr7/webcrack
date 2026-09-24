#!/usr/bin/env node

import { program } from 'commander';
import debug from 'debug';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as url from 'node:url';
import {
  applyLLMRename,
  commandSuggestNames,
  runMultiInput,
  toWebcrackOptions,
  validateLLMFlags,
  type CLIFlags,
} from './cli-lib.js';
import { webcrack } from './index.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const { version, description } = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; description: string };

debug.enable('webcrack:*');

interface Options extends CLIFlags {
  force?: boolean;
  output?: string;
  llmRenameCommand?: string;
  llmTimeout?: number;
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

program
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
    (value) => parseInt(value, 10),
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
    } = program.opts<Options>();
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

    const code = await (files[0] ? readFile(files[0], 'utf8') : readStdin());
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
      console.log(result.code);
      if (result.bundle) {
        debug('webcrack:unpack')(
          'Modules are not displayed in the terminal. Use the --output option to save them to a directory.',
        );
      }
    }
  })
  .parse();
