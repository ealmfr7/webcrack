#!/usr/bin/env node

import { CommanderError } from 'commander';
import debug from 'debug';
import { runCli } from './cli-lib.js';

debug.enable('webcrack:*');

runCli(process.argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
}).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode;
    return;
  }
  throw err;
});
