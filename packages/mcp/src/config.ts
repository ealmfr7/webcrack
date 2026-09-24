import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

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

export const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_BUDGET = 20_000;

function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'webcrack-mcp');
}

/**
 * Parse a strictly positive integer. Returns the default when the raw value
 * is missing or empty. Anything else that is not all digits (no signs, no
 * decimals, no suffixes) or that is zero throws an Error naming the variable.
 */
function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  unit: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Invalid ${name}="${raw}": expected a positive integer (${unit}). Default: ${fallback}.`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}="${raw}": expected a positive integer (${unit}). Default: ${fallback}.`,
    );
  }
  return value;
}

const BYTE_SUFFIXES: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/**
 * Parse WEBCRACK_MCP_MAX_INPUT: a positive integer in bytes, optionally with
 * a size suffix (`b`, `kb`, `mb`, `gb`, case-insensitive, e.g. `512kb`,
 * `20mb`, `1gb`). Missing or empty means the default (20 MB).
 */
function parseMaxInputBytes(raw: string | undefined): number {
  const name = 'WEBCRACK_MCP_MAX_INPUT';
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_INPUT_BYTES;
  const text = raw.trim();
  const match = /^(\d+)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(text);
  const expected =
    'expected a positive integer (bytes, e.g. 20971520 or "20mb")';
  if (!match) {
    throw new Error(
      `Invalid ${name}="${raw}": ${expected}. Default: ${DEFAULT_MAX_INPUT_BYTES}.`,
    );
  }
  const value =
    Number(match[1]) * (BYTE_SUFFIXES[match[2]?.toLowerCase() ?? 'b'] ?? 1);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}="${raw}": ${expected}. Default: ${DEFAULT_MAX_INPUT_BYTES}.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootsRaw = env.WEBCRACK_MCP_ROOTS;
  const roots =
    rootsRaw === undefined || rootsRaw.trim() === ''
      ? [process.cwd()]
      : rootsRaw
          .split(delimiter)
          .map((root) => root.trim())
          .filter(Boolean)
          .map((root) => resolve(root));

  const cacheRaw = env.WEBCRACK_MCP_CACHE;
  const cacheDir =
    cacheRaw === undefined || cacheRaw.trim() === ''
      ? defaultCacheDir()
      : cacheRaw;

  return {
    roots: roots.length > 0 ? roots : [process.cwd()],
    cacheDir,
    maxInputBytes: parseMaxInputBytes(env.WEBCRACK_MCP_MAX_INPUT),
    timeoutMs: parsePositiveInt(
      'WEBCRACK_MCP_TIMEOUT_MS',
      env.WEBCRACK_MCP_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      'milliseconds',
    ),
    outputBudget: parsePositiveInt(
      'WEBCRACK_MCP_OUTPUT_BUDGET',
      env.WEBCRACK_MCP_OUTPUT_BUDGET,
      DEFAULT_OUTPUT_BUDGET,
      'characters',
    ),
  };
}
