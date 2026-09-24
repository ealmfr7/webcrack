import type { ModuleEntry, ModuleIndex, ModuleTag } from './types';

/**
 * Heuristic module tags from the module's own index slice plus its
 * path/code. Canonical order: `network`, `auth`, `crypto`, `storage`,
 * `dom`, `vendor`.
 *
 * `vm` is NEVER returned here: the store adds `vm` from
 * `detectInterpreters()` hits (interpreter loop + dispatch), which the
 * index slice cannot see. A wave-C task dedupes the callee tables below
 * against `workspace/findings.ts` (different owner) — keep them local
 * until then.
 *
 * Callees are the normalized names from `index.calls` (`fetch`,
 * `axios.post`, `localStorage.setItem`, `*.json` for a local root). Every
 * rule:
 *
 * | tag      | source          | rule |
 * |----------|-----------------|------|
 * | `network` | call           | callee is `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` |
 * | `network` | call           | callee starts with `axios.` |
 * | `network` | call           | callee ends with `.open` or `.send` (covers `xhr.open`, `ws.send`, `*.open`, `*.send`) |
 * | `network` | string         | value starts with `http://` or `https://` |
 * | `auth`    | string         | value contains `authorization`, `bearer`, `token`, `login`, `password` or `jwt` (case-insensitive substring) |
 * | `crypto`  | call           | callee is `btoa` or `atob` |
 * | `crypto`  | call           | callee starts with `crypto.` (covers `crypto.subtle.*`, `crypto.getRandomValues`, …) |
 * | `storage` | call           | callee starts with `localStorage.`, `sessionStorage.` or `indexedDB.` |
 * | `storage` | code           | code matches `document.cookie` (cookie access is a property read, never a call site) |
 * | `dom`     | call           | callee starts with `document.` or `window.` |
 * | `dom`     | call           | callee is `addEventListener` or ends with `.addEventListener` |
 * | `dom`     | call           | callee ends with `.innerHTML`, `.outerHTML`, `.createElement`, `.getElementById`, `.getElementsByTagName`, `.getElementsByClassName`, `.querySelector`, `.querySelectorAll`, `.appendChild` or `.removeChild` (covers `*.` roots from local aliases such as `var d = document`) |
 * | `vendor`  | path           | path contains `node_modules/`, a segment is exactly `vendor`, or a file/dir name is a known library name (react, lodash, jquery, vue, …), exactly or as a `name.`/`name-` prefix |
 * | `vendor`  | code           | code contains an `@license`/`@preserve` banner or a known library signature (`jQuery JavaScript Library`, `lodash`, `regeneratorRuntime`, `core-js`, `__REACT_DEVTOOLS_GLOBAL_HOOK__`) |
 */
export function tagModule(
  module: ModuleEntry,
  index: ModuleIndex,
): ModuleTag[] {
  const tags = new Set<ModuleTag>();
  const calls = index.calls
    .filter((call) => call.module === module.path)
    .map((call) => call.callee);
  const strings = index.strings
    .filter((entry) => entry.module === module.path)
    .map((entry) => entry.value);

  if (
    calls.some(
      (callee) =>
        NETWORK_CALLS.has(callee) ||
        NETWORK_PREFIXES.some((prefix) => callee.startsWith(prefix)) ||
        NETWORK_SUFFIXES.some((suffix) => callee.endsWith(suffix)),
    ) ||
    strings.some((value) => NETWORK_URL_RE.test(value))
  ) {
    tags.add('network');
  }

  if (
    strings.some((value) => {
      const lower = value.toLowerCase();
      return AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
    })
  ) {
    tags.add('auth');
  }

  if (
    calls.some(
      (callee) =>
        CRYPTO_CALLS.has(callee) ||
        CRYPTO_PREFIXES.some((prefix) => callee.startsWith(prefix)),
    )
  ) {
    tags.add('crypto');
  }

  if (
    calls.some((callee) =>
      STORAGE_PREFIXES.some((prefix) => callee.startsWith(prefix)),
    ) ||
    COOKIE_RE.test(module.code)
  ) {
    tags.add('storage');
  }

  if (
    calls.some(
      (callee) =>
        DOM_CALLS.has(callee) ||
        DOM_PREFIXES.some((prefix) => callee.startsWith(prefix)) ||
        DOM_SUFFIXES.some((suffix) => callee.endsWith(suffix)),
    )
  ) {
    tags.add('dom');
  }

  if (isVendorPath(module.path) || isVendorCode(module.code)) {
    tags.add('vendor');
  }

  return TAG_ORDER.filter((tag) => tags.has(tag));
}

/** Canonical output order (`vm` excluded: the store owns it). */
const TAG_ORDER: ModuleTag[] = [
  'network',
  'auth',
  'crypto',
  'storage',
  'dom',
  'vendor',
];

const NETWORK_CALLS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
]);
const NETWORK_PREFIXES = ['axios.'];
const NETWORK_SUFFIXES = ['.open', '.send'];
const NETWORK_URL_RE = /^https?:\/\//i;

const AUTH_KEYWORDS = [
  'authorization',
  'bearer',
  'token',
  'login',
  'password',
  'jwt',
];

const CRYPTO_CALLS = new Set(['btoa', 'atob']);
const CRYPTO_PREFIXES = ['crypto.'];

const STORAGE_PREFIXES = ['localStorage.', 'sessionStorage.', 'indexedDB.'];
const COOKIE_RE = /document\.cookie/;

const DOM_CALLS = new Set(['addEventListener']);
const DOM_PREFIXES = ['document.', 'window.'];
const DOM_SUFFIXES = [
  '.addEventListener',
  '.innerHTML',
  '.outerHTML',
  '.createElement',
  '.getElementById',
  '.getElementsByTagName',
  '.getElementsByClassName',
  '.querySelector',
  '.querySelectorAll',
  '.appendChild',
  '.removeChild',
];

/**
 * The file name is matched without its last extension, exactly or as a
 * `name.` / `name-` prefix (`jquery.js` and `jquery.min.js` hit;
 * `reaction.js` does not).
 */
const KNOWN_LIBS = new Set([
  'react',
  'react-dom',
  'lodash',
  'underscore',
  'jquery',
  'vue',
  'angular',
  'moment',
  'axios',
  'core-js',
  'tslib',
  'regenerator-runtime',
  'bluebird',
  'immutable',
  'rxjs',
  'd3',
  'three',
  'ember',
  'backbone',
  'knockout',
  'sizzle',
  'popper',
  'bootstrap',
]);

function isVendorPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes('node_modules/')) return true;
  const segments = lower.split(/[\\/]/);
  return segments.some((segment, i) => {
    if (segment === 'vendor') return true;
    const name =
      i === segments.length - 1 ? segment.replace(/\.[^.]*$/, '') : segment;
    if (KNOWN_LIBS.has(name)) return true;
    return [...KNOWN_LIBS].some(
      (lib) => name.startsWith(`${lib}.`) || name.startsWith(`${lib}-`),
    );
  });
}

const VENDOR_BANNER_RE = /@license|@preserve/i;
const VENDOR_SIGNATURE_RE =
  /jQuery JavaScript Library|\blodash\b|regeneratorRuntime|core-js|__REACT_DEVTOOLS_GLOBAL_HOOK__/;

function isVendorCode(code: string): boolean {
  return VENDOR_BANNER_RE.test(code) || VENDOR_SIGNATURE_RE.test(code);
}
