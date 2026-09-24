import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Config } from '../config';
import { WcError } from '../format/errors';
import type { LoadedSource } from './types';

/**
 * Resolve a `wc_open` source (M1.1): a path inside `config.roots`, an
 * `http(s)` URL (size limit + timeout, never following to `file:`), or
 * literal code. The type is auto-detected.
 */
export async function loadSource(
  source: string,
  config: Config,
): Promise<LoadedSource> {
  const scheme = schemeOf(source);
  if (scheme !== undefined) {
    if (scheme === 'http' || scheme === 'https') {
      return loadUrl(source, config);
    }
    throw new WcError(
      `Unsupported URL scheme "${scheme}:" in ${JSON.stringify(source)}. ` +
        `Pass an http(s) URL, a file path inside WEBCRACK_MCP_ROOTS, or literal JavaScript code.`,
    );
  }
  const exists = await stat(resolve(source)).then(
    () => true,
    () => false,
  );
  if (!exists) {
    if (looksLikePath(source)) {
      throw new WcError(
        `File not found: ${JSON.stringify(source)} (resolved against the current working directory). ` +
          `Check the spelling, or pass literal code or an http(s) URL instead.`,
      );
    }
    return {
      kind: 'code',
      label: '<code>',
      code: source,
      bytes: Buffer.byteLength(source),
    };
  }
  return loadPath(resolve(source), config);
}

/** Lowercased URI scheme, or `undefined` when `source` has none. */
function schemeOf(source: string): string | undefined {
  // A Windows drive letter (`C:\…`) is a path, not a scheme.
  if (/^[a-zA-Z]:[\\/]/.test(source)) return undefined;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(source);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Heuristic for "the user meant a file, but it does not exist": a single
 * line ending in a JS extension with at least one path separator.
 */
function looksLikePath(source: string): boolean {
  return (
    !/[\r\n]/.test(source) && /\.[cm]?js$/i.test(source) && /[/\\]/.test(source)
  );
}

async function loadPath(
  resolved: string,
  config: Config,
): Promise<LoadedSource> {
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new WcError(
      `Cannot read ${JSON.stringify(resolved)}: ${(error as Error).message}. ` +
        `Check the path and its permissions, or pass literal code or an http(s) URL instead.`,
    );
  }
  if (info.isDirectory()) {
    throw new WcError(
      `${JSON.stringify(resolved)} is a directory, not a file. ` +
        `Pass a single JavaScript file inside it, or paste its contents as literal code.`,
    );
  }
  if (info.size > config.maxInputBytes) {
    throw new WcError(
      `File ${JSON.stringify(resolved)} is ${info.size} bytes, over the ${config.maxInputBytes}-byte limit. ` +
        `Raise WEBCRACK_MCP_MAX_INPUT or open a smaller file.`,
    );
  }
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    throw new WcError(
      `Cannot resolve ${JSON.stringify(resolved)}: ${(error as Error).message}. ` +
        `Check the path, or pass literal code or an http(s) URL instead.`,
    );
  }
  const checked = await checkInsideRoots(real, config);
  const match = checked.match;
  let code: string;
  try {
    code = await readFile(real, 'utf8');
  } catch (error) {
    throw new WcError(
      `Cannot read ${JSON.stringify(real)}: ${(error as Error).message}. ` +
        `Check the file's permissions, or paste its contents as literal code.`,
    );
  }
  const bytes = Buffer.byteLength(code);
  if (bytes > config.maxInputBytes) {
    throw new WcError(
      `File ${JSON.stringify(real)} is ${bytes} bytes, over the ${config.maxInputBytes}-byte limit. ` +
        `Raise WEBCRACK_MCP_MAX_INPUT or open a smaller file.`,
    );
  }
  return { kind: 'path', label: relative(match, real), code, bytes };
}

/** A real path known to sit inside `match` (one of the real roots). */
interface RootsCheck {
  roots: string[];
  match: string;
}

/** Real paths of the configured roots (unresolvable roots stay resolved). */
async function resolveRoots(config: Config): Promise<string[]> {
  const roots: string[] = [];
  for (const root of config.roots) {
    try {
      roots.push(await realpath(root));
    } catch {
      roots.push(resolve(root));
    }
  }
  return roots;
}

/**
 * Throw a `WcError` unless `real` (already a real path) sits inside one of
 * the configured roots. Shared by `loadPath` and `assertInsideRoots` so
 * both enforce exactly the same boundary with the same message.
 */
async function checkInsideRoots(
  real: string,
  config: Config,
): Promise<RootsCheck> {
  const roots = await resolveRoots(config);
  const match = roots.find(
    (root) => real === root || real.startsWith(root + sep),
  );
  if (match === undefined) {
    throw new WcError(
      `Path ${JSON.stringify(real)} is outside the allowed roots (${roots.join(', ') || '(none)'}). ` +
        `Move the file under one of them or set WEBCRACK_MCP_ROOTS to include it.`,
    );
  }
  return { roots, match };
}

/**
 * Ensure `dir` is a directory inside the configured roots and return its
 * real path. The directory may not exist yet: the nearest existing ancestor
 * is resolved (following symlinks) and checked, then the full directory is
 * created with `mkdir -p`. A symlink pointing outside the roots is refused,
 * exactly like a path source in `loadSource`.
 */
export async function assertInsideRoots(
  dir: string,
  config: Config,
): Promise<string> {
  const resolved = resolve(dir);
  let ancestor = resolved;
  for (;;) {
    try {
      await stat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new WcError(
          `Cannot resolve ${JSON.stringify(resolved)}: no existing ancestor directory. ` +
            `Create one of its parent directories first, or pick a directory inside WEBCRACK_MCP_ROOTS.`,
        );
      }
      ancestor = parent;
    }
  }
  let realAncestor: string;
  try {
    realAncestor = await realpath(ancestor);
  } catch (error) {
    throw new WcError(
      `Cannot resolve ${JSON.stringify(resolved)}: ${(error as Error).message}. ` +
        `Check the path, or pick a directory inside WEBCRACK_MCP_ROOTS instead.`,
    );
  }
  await checkInsideRoots(realAncestor, config);
  try {
    await mkdir(resolved, { recursive: true });
  } catch (error) {
    throw new WcError(
      `Cannot create directory ${JSON.stringify(resolved)}: ${(error as Error).message}. ` +
        `Check the path and its permissions, or pick another directory inside WEBCRACK_MCP_ROOTS.`,
    );
  }
  return realpath(resolved);
}

/** Maximum redirects followed for `url` sources. */
const MAX_REDIRECTS = 5;

async function loadUrl(source: string, config: Config): Promise<LoadedSource> {
  const first = splitAuth(source);
  let current = first.url;
  let authorization = first.authorization;
  let authOrigin = first.origin;
  for (let hop = 0; ; hop++) {
    const label = stripCredentials(current);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: authorization ? { authorization } : undefined,
      });
    } catch (error) {
      throw fetchError(error, label, config);
    }
    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      await cancel(response);
      if (location === null) {
        throw new WcError(
          `URL ${label} returned status ${response.status} without a Location header. ` +
            `Check the URL or try downloading the file and opening it as a path.`,
        );
      }
      let nextRaw: string;
      try {
        nextRaw = new URL(location, current).toString();
      } catch {
        throw new WcError(
          `URL ${label} redirects to an invalid URL ${JSON.stringify(stripCredentials(location))}. ` +
            `Check the URL or try downloading the file and opening it as a path.`,
        );
      }
      const scheme = schemeOf(nextRaw);
      if (scheme !== 'http' && scheme !== 'https') {
        throw new WcError(
          `Refused to follow a redirect from ${label} to ${stripCredentials(nextRaw)}: only http(s) targets are allowed. ` +
            `Download the file yourself and open it as a path instead.`,
        );
      }
      if (hop >= MAX_REDIRECTS) {
        throw new WcError(
          `URL ${label} redirected more than ${MAX_REDIRECTS} times. ` +
            `Open the final URL directly, or download the file and open it as a path.`,
        );
      }
      const next = splitAuth(nextRaw);
      // Never forward credentials to another origin.
      if (authOrigin !== undefined && next.origin !== authOrigin) {
        authorization = undefined;
        authOrigin = undefined;
      }
      current = next.url;
      continue;
    }
    if (!response.ok) {
      await cancel(response);
      throw new WcError(
        `Fetching ${label} failed with status ${response.status}. ` +
          `Check the URL, or download the file and open it as a path.`,
      );
    }
    const code = await readBounded(response, label, config.maxInputBytes);
    return {
      kind: 'url',
      label: stripCredentials(current),
      code,
      bytes: Buffer.byteLength(code),
    };
  }
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function fetchError(error: unknown, label: string, config: Config): WcError {
  const cause = error as { name?: string; message?: string };
  if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
    return new WcError(
      `Fetching ${label} timed out after ${config.timeoutMs}ms. ` +
        `Raise WEBCRACK_MCP_TIMEOUT_MS, or download the file and open it as a path.`,
    );
  }
  const detail = cause?.message ? `: ${scrubCredentials(cause.message)}` : '';
  return new WcError(
    `Fetching ${label} failed${detail}. ` +
      `Check the URL and your network connection, or download the file and open it as a path.`,
  );
}

async function cancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore teardown errors; the informative error is thrown by the caller.
  }
}

/** Read the whole body as text, rejecting once it exceeds `maxBytes`. */
async function readBounded(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<string> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    /^\d+$/.test(length.trim()) &&
    Number(length) > maxBytes
  ) {
    await cancel(response);
    throw new WcError(
      `Response from ${label} is ${length.trim()} bytes, over the ${maxBytes}-byte limit. ` +
        `Raise WEBCRACK_MCP_MAX_INPUT or download a smaller file and open it as a path.`,
    );
  }
  if (!response.body) {
    const code = await response.text();
    if (Buffer.byteLength(code) > maxBytes) {
      throw new WcError(
        `Response from ${label} exceeds the ${maxBytes}-byte limit. ` +
          `Raise WEBCRACK_MCP_MAX_INPUT or download a smaller file and open it as a path.`,
      );
    }
    return code;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WcError(
          `Response from ${label} exceeds the ${maxBytes}-byte limit. ` +
            `Raise WEBCRACK_MCP_MAX_INPUT or download a smaller file and open it as a path.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WcError) throw error;
    const cause = error as { name?: string };
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      throw new WcError(
        `Fetching ${label} timed out while reading the response body. ` +
          `Raise WEBCRACK_MCP_TIMEOUT_MS, or download the file and open it as a path.`,
      );
    }
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

/**
 * Split `user:password@` credentials off a URL: fetch the clean URL and,
 * when credentials were present, send them as an `Authorization` header
 * instead (undici refuses URLs with userinfo). `origin` is the clean URL's
 * origin, so redirects can drop the header cross-origin.
 */
function splitAuth(raw: string): {
  url: string;
  authorization?: string;
  origin?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw };
  }
  const { username, password } = parsed;
  parsed.username = '';
  parsed.password = '';
  if (!username && !password) return { url: parsed.toString() };
  let userinfo: string;
  try {
    userinfo = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  } catch {
    userinfo = `${username}:${password}`;
  }
  return {
    url: parsed.toString(),
    authorization: `Basic ${Buffer.from(userinfo).toString('base64')}`,
    origin: parsed.origin,
  };
}

/** Remove `user:password@` userinfo from arbitrary text (error details). */
function scrubCredentials(text: string): string {
  return text.replace(/:\/\/[^/\s@]*@/g, '://');
}

/** The URL with any `user:password@` credentials removed. */
function stripCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}
