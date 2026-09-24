#!/usr/bin/env node

import { CommanderError } from 'commander';
import debug from 'debug';
import { installEpipeGuard, runCli } from './cli-lib.js';

debug.enable('webcrack:*');

installEpipeGuard(process.stdout);
installEpipeGuard(process.stderr);
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
