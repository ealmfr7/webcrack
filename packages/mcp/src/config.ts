import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  /** Directories that `path` sources and exports must live under. */
  roots: string[];
  /** Directory where processed workspaces are cached. */
  cacheDir: string;
  /** Maximum input size in bytes. */
  maxInputBytes: number;
  /** Timeout for a whole `wc_open` run, in milliseconds. */
  timeoutMs: number;
  /** Soft limit for the text of a single tool response, in characters. */
  outputBudget: number;
}

// TODO(M0.3): validate values and report misconfiguration clearly.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    roots: (env.WEBCRACK_MCP_ROOTS ?? process.cwd())
      .split(':')
      .filter(Boolean)
      .map((root) => resolve(root)),
    cacheDir:
      env.WEBCRACK_MCP_CACHE ?? join(homedir(), '.cache', 'webcrack-mcp'),
    maxInputBytes: Number(env.WEBCRACK_MCP_MAX_INPUT ?? 20 * 1024 * 1024),
    timeoutMs: Number(env.WEBCRACK_MCP_TIMEOUT_MS ?? 120_000),
    outputBudget: Number(env.WEBCRACK_MCP_OUTPUT_BUDGET ?? 20_000),
  };
}
