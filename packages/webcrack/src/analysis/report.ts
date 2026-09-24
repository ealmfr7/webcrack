import traverse from '@babel/traverse';
import * as t from '@babel/types';

/**
 * A 1-based line / 0-based column source position (Babel `loc.start`).
 */
export interface ReportPosition {
  line: number;
  column: number;
}

export interface UrlEntry extends ReportPosition {
  value: string;
}

export interface EndpointEntry extends ReportPosition {
  /** Upper-cased HTTP method, or `null` when it is not statically known. */
  method: string | null;
  /** URL, or `null` when it is not statically known. */
  url: string | null;
}

export interface SecretEntry extends ReportPosition {
  value: string;
  rule: string;
}

export interface RegexEntry extends ReportPosition {
  /** Normalized to `/source/flags` form. */
  value: string;
}

export interface InterestingEntry extends ReportPosition {
  value: string;
  kind: 'email' | 'ip' | 'path';
}

export interface Report {
  urls: UrlEntry[];
  endpoints: EndpointEntry[];
  secrets: SecretEntry[];
  regexes: RegexEntry[];
  interesting: InterestingEntry[];
}

// -- URL detection --------------------------------------------------------

const URL_SCHEME = /^(https?|wss?):\/\//;

/**
 * Resolve an expression to a string when it is fully static: a string
 * literal, a template literal without expressions, or a `+` concatenation
 * of static strings. Returns `null` for anything dynamic.
 */
function staticString(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length > 0) return null;
    const quasi = node.quasis[0];
    return quasi?.value.cooked ?? quasi?.value.raw ?? null;
  }
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/**
 * Method from a `fetch`/`$.ajax`-style options object: the default applies
 * only when no method key is present; a present-but-dynamic key yields
 * `null` since the method is not statically known.
 */
function configMethod(
  options: t.Node | null,
  names: string[],
  defaultMethod: string,
): string | null {
  if (!options || !t.isObjectExpression(options)) return defaultMethod;
  if (staticPropNode(options, names) === null) return defaultMethod;
  return staticProp(options, names)?.toUpperCase() ?? null;
}

/** Read a statically-known string property (`{ method: "POST" }`). */
function staticProp(obj: t.ObjectExpression, names: string[]): string | null {
  for (const prop of obj.properties) {
    if (
      t.isObjectProperty(prop) &&
      !prop.computed &&
      ((t.isIdentifier(prop.key) && names.includes(prop.key.name)) ||
        (t.isStringLiteral(prop.key) && names.includes(prop.key.value)))
    ) {
      const value = staticString(prop.value);
      if (value !== null) return value;
    }
  }
  return null;
}

// -- Secrets ----------------------------------------------------------------

/**
 * Entropy heuristic for the generic secret rule (rule `generic-high-entropy`):
 *
 * - candidate length must be within [20, 512] characters,
 * - Shannon entropy must be >= 4.0 bits per character,
 * - must contain no whitespace and mix letters with digits/symbols,
 * - `data:` URIs, pure hex strings (commit hashes etc.), hex/uuid-like
 *   strings, `sha1-`/`sha512-` integrity hashes and long (>100 chars)
 *   pure-base64 blobs (inlined images etc.) are excluded.
 *
 * Named rules below always win: when one of them matches a string, the
 * generic rule is skipped for that string. The thresholds are deliberately
 * conservative (low false positives over full recall).
 */
export const MIN_GENERIC_SECRET_LENGTH = 20;
export const MAX_GENERIC_SECRET_LENGTH = 512;
export const GENERIC_SECRET_ENTROPY = 4.0;
const LONG_BASE64_CUTOFF = 100;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isGenericSecret(candidate: string): boolean {
  if (
    candidate.length < MIN_GENERIC_SECRET_LENGTH ||
    candidate.length > MAX_GENERIC_SECRET_LENGTH ||
    /\s/.test(candidate) ||
    candidate.startsWith('data:')
  ) {
    return false;
  }
  // Commit hashes, UUIDs, SRI integrity hashes: not secrets on their own.
  if (/^[0-9a-fA-F-]+$/.test(candidate)) return false;
  if (/^(sha\d+|md5)-/i.test(candidate)) return false;
  // Long pure-base64 blobs are almost always inlined assets, not keys.
  if (
    candidate.length > LONG_BASE64_CUTOFF &&
    /^[A-Za-z0-9+/=]+$/.test(candidate)
  ) {
    return false;
  }
  if (!/[A-Za-z]/.test(candidate)) return false;
  if (!/[0-9_\-+/=.]/.test(candidate) && !/[^A-Za-z0-9]/.test(candidate)) {
    return false;
  }
  return shannonEntropy(candidate) >= GENERIC_SECRET_ENTROPY;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  {
    name: 'stripe-key',
    pattern: /\b[ps]k_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
];

// -- Interesting strings ----------------------------------------------------

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_PATTERN = /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;
const API_PATH_PATTERN =
  /\/api(?=$|[/\s"'`?#])(\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/g;

function validIpv4(ip: string): boolean {
  return ip.split('.').every((octet) => {
    if (octet.length > 1 && octet.startsWith('0')) return false;
    const n = Number(octet);
    return octet !== '' && Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

// -- Endpoints ---------------------------------------------------------------

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

const AXIOS_METHODS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
};

function isMember(
  node: t.Node | null | undefined,
): node is t.MemberExpression | t.OptionalMemberExpression {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

function propName(
  member: t.MemberExpression | t.OptionalMemberExpression,
): string | null {
  const prop = member.property;
  if (!member.computed && t.isIdentifier(prop)) return prop.name;
  if (t.isStringLiteral(prop)) return prop.value;
  return null;
}

function objectName(obj: t.MemberExpression['object']): string | null {
  if (t.isIdentifier(obj)) return obj.name;
  if (isMember(obj) && t.isIdentifier(obj.object) && propName(obj) !== null) {
    return `${obj.object.name}.${propName(obj)}`;
  }
  return null;
}

/** Receivers whose `.fetch(url, ...)` is the global `fetch`. */
const FETCH_RECEIVERS = new Set(['window', 'globalThis', 'self']);

/**
 * Extract `{ method, url }` from a `fetch`/`axios`/`$.ajax` style call.
 * Non-static parts come back as `null`.
 *
 * `isGlobal` reports whether a name resolves to the global scope (no
 * shadowing binding): bare `fetch(...)` and `window`/`globalThis`/`self`
 * receivers only count when unshadowed, so `db.fetch(...)` or a local
 * `fetch` binding is never reported as a network endpoint.
 */
function endpointFromCall(
  callee: t.Expression | t.V8IntrinsicIdentifier,
  args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
  isGlobal: (name: string) => boolean = () => true,
): EndpointEntry | null {
  const arg = (i: number): t.Node | null =>
    i < args.length && !t.isSpreadElement(args[i]) ? args[i] : null;

  // fetch(url, { method })
  if (t.isIdentifier(callee) && callee.name === 'fetch') {
    if (!isGlobal('fetch')) return null;
    const method = configMethod(arg(1), ['method'], 'GET');
    return { method, url: staticString(arg(0)), line: 0, column: 0 };
  }
  // window.fetch(url, ...) — same shape as fetch, other receivers (e.g.
  // `db.fetch(...)`) are not the global fetch.
  if (isMember(callee) && propName(callee) === 'fetch') {
    const receiver = callee.object;
    if (
      !t.isIdentifier(receiver) ||
      !FETCH_RECEIVERS.has(receiver.name) ||
      !isGlobal(receiver.name)
    ) {
      return null;
    }
    const method = configMethod(arg(1), ['method'], 'GET');
    return { method, url: staticString(arg(0)), line: 0, column: 0 };
  }
  if (!isMember(callee)) {
    // axios(url | config)
    if (t.isIdentifier(callee) && callee.name === 'axios') {
      const first = arg(0);
      if (first && t.isObjectExpression(first)) {
        return {
          method: staticProp(first, ['method'])?.toUpperCase() ?? null,
          url: staticString(staticPropNode(first, ['url'])),
          line: 0,
          column: 0,
        };
      }
      return { method: 'GET', url: staticString(first), line: 0, column: 0 };
    }
    return null;
  }

  const obj = objectName(callee.object);
  const prop = propName(callee);

  // axios.get(url), axios.post(url, ...), axios.request(config)
  if (obj === 'axios' && prop !== null) {
    if (prop === 'request' || prop === 'create') {
      const first = arg(0);
      if (first && t.isObjectExpression(first)) {
        return {
          method: staticProp(first, ['method'])?.toUpperCase() ?? null,
          url: staticString(staticPropNode(first, ['url'])),
          line: 0,
          column: 0,
        };
      }
      return prop === 'request'
        ? { method: null, url: staticString(first), line: 0, column: 0 }
        : null;
    }
    if (prop in AXIOS_METHODS) {
      return {
        method: AXIOS_METHODS[prop],
        url: staticString(arg(0)),
        line: 0,
        column: 0,
      };
    }
    return null;
  }

  // xhr.open(method, url) — any receiver; a static first arg must look like
  // an HTTP method so `window.open(url, target)` is not misread.
  if (prop === 'open' && args.length >= 2) {
    const rawMethod = staticString(arg(0));
    if (rawMethod !== null && !HTTP_METHODS.has(rawMethod.toUpperCase())) {
      return null;
    }
    return {
      method: rawMethod?.toUpperCase() ?? null,
      url: staticString(arg(1)),
      line: 0,
      column: 0,
    };
  }

  // navigator.sendBeacon(url, ...) is always a POST
  if (prop === 'sendBeacon') {
    return { method: 'POST', url: staticString(arg(0)), line: 0, column: 0 };
  }

  // $.ajax(url | settings, ...) / jQuery.ajax(...)
  if ((obj === '$' || obj === 'jQuery') && prop === 'ajax') {
    const first = arg(0);
    if (first && t.isObjectExpression(first)) {
      return {
        method: configMethod(first, ['method', 'type'], 'GET'),
        url: staticString(staticPropNode(first, ['url'])),
        line: 0,
        column: 0,
      };
    }
    const method = configMethod(arg(1), ['method', 'type'], 'GET');
    return { method, url: staticString(first), line: 0, column: 0 };
  }

  return null;
}

function staticPropNode(
  obj: t.ObjectExpression,
  names: string[],
): t.Node | null {
  for (const prop of obj.properties) {
    if (
      t.isObjectProperty(prop) &&
      !prop.computed &&
      ((t.isIdentifier(prop.key) && names.includes(prop.key.name)) ||
        (t.isStringLiteral(prop.key) && names.includes(prop.key.value)))
    ) {
      return prop.value;
    }
  }
  return null;
}

// -- Main --------------------------------------------------------------------

function pos(node: t.Node): ReportPosition {
  return {
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
  };
}

function pushUnique<T extends ReportPosition>(
  list: T[],
  seen: Set<string>,
  key: string,
  entry: T,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  list.push(entry);
}

/**
 * Walk `ast` and collect URLs, network endpoints, secrets, regexes and
 * other interesting strings into a JSON-serializable report.
 *
 * Every category is deduplicated by value (first occurrence wins) and kept
 * in source order, so output is stable across runs. Locations are Babel
 * `loc.start` positions (1-based line, 0-based column).
 */
export function extractReport(ast: t.File): Report {
  const report: Report = {
    urls: [],
    endpoints: [],
    secrets: [],
    regexes: [],
    interesting: [],
  };
  const seenUrls = new Set<string>();
  const seenEndpoints = new Set<string>();
  const seenSecrets = new Set<string>();
  const seenRegexes = new Set<string>();
  const seenInteresting = new Set<string>();

  const addUrl = (value: string, node: t.Node): void => {
    const candidate = value.trim();
    if (!URL_SCHEME.test(candidate)) return;
    pushUnique(report.urls, seenUrls, candidate, {
      value: candidate,
      ...pos(node),
    });
  };

  const addSecrets = (value: string, node: t.Node): void => {
    let named = false;
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of value.matchAll(rule.pattern)) {
        named = true;
        pushUnique(report.secrets, seenSecrets, `${rule.name}\n${match[0]}`, {
          value: match[0],
          rule: rule.name,
          ...pos(node),
        });
      }
    }
    if (!named && isGenericSecret(value)) {
      pushUnique(
        report.secrets,
        seenSecrets,
        `generic-high-entropy\n${value}`,
        {
          value,
          rule: 'generic-high-entropy',
          ...pos(node),
        },
      );
    }
  };

  const addInteresting = (value: string, node: t.Node): void => {
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      pushUnique(report.interesting, seenInteresting, `email\n${match[0]}`, {
        value: match[0],
        kind: 'email',
        ...pos(node),
      });
    }
    for (const match of value.matchAll(IPV4_PATTERN)) {
      if (!validIpv4(match[0])) continue;
      pushUnique(report.interesting, seenInteresting, `ip\n${match[0]}`, {
        value: match[0],
        kind: 'ip',
        ...pos(node),
      });
    }
    for (const match of value.matchAll(IPV6_PATTERN)) {
      // Bare `12:34:56`-style times are not IPs: require `::` or hex letters.
      if (!match[0].includes('::') && !/[a-fA-F]/.test(match[0])) continue;
      pushUnique(report.interesting, seenInteresting, `ip\n${match[0]}`, {
        value: match[0],
        kind: 'ip',
        ...pos(node),
      });
    }
    for (const match of value.matchAll(API_PATH_PATTERN)) {
      pushUnique(report.interesting, seenInteresting, `path\n${match[0]}`, {
        value: match[0],
        kind: 'path',
        ...pos(node),
      });
    }
  };

  const scanString = (value: string, node: t.Node): void => {
    addUrl(value, node);
    addSecrets(value, node);
    addInteresting(value, node);
  };

  // Shared by CallExpression and OptionalCallExpression so `f?.(url)` and
  // `RegExp?.("src")` are handled exactly like their non-optional forms.
  const scanCall = (
    callee: t.Expression | t.V8IntrinsicIdentifier,
    args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
    node: t.Node,
    isGlobal: (name: string) => boolean,
  ): void => {
    const entry = endpointFromCall(callee, args, isGlobal);
    if (entry) {
      const at = pos(node);
      entry.line = at.line;
      entry.column = at.column;
      pushUnique(
        report.endpoints,
        seenEndpoints,
        `${entry.method ?? ''}\n${entry.url ?? ''}`,
        entry,
      );
    }
    // new RegExp("src", "flags") handled under NewExpression; also allow
    // direct RegExp("src") calls here.
    if (
      t.isIdentifier(callee) &&
      callee.name === 'RegExp' &&
      args.length > 0 &&
      !t.isSpreadElement(args[0])
    ) {
      const source = staticString(args[0]);
      const flags =
        args.length > 1 && !t.isSpreadElement(args[1])
          ? (staticString(args[1]) ?? '')
          : '';
      if (source !== null) {
        const value = `/${source}/${flags}`;
        pushUnique(report.regexes, seenRegexes, value, {
          value,
          ...pos(node),
        });
      }
    }
  };

  traverse(ast, {
    StringLiteral(path) {
      scanString(path.node.value, path.node);
    },
    TemplateLiteral(path) {
      for (const quasi of path.node.quasis) {
        const cooked = quasi.value.cooked ?? quasi.value.raw;
        scanString(cooked, path.node);
        // Static templates are also scanned whole via their single quasi.
      }
    },
    RegExpLiteral(path) {
      const value = `/${path.node.pattern}/${path.node.flags}`;
      pushUnique(report.regexes, seenRegexes, value, {
        value,
        ...pos(path.node),
      });
    },
    CallExpression(path) {
      // NB: `hasBinding` is wrong here — it returns true for names on
      // Babel's known-globals list (e.g. `globalThis`). `getBinding`
      // only finds real bindings, i.e. actual shadowing declarations.
      const isGlobal = (name: string): boolean =>
        path.scope.getBinding(name) === undefined;
      scanCall(path.node.callee, path.node.arguments, path.node, isGlobal);
    },
    OptionalCallExpression(path) {
      const isGlobal = (name: string): boolean =>
        path.scope.getBinding(name) === undefined;
      scanCall(path.node.callee, path.node.arguments, path.node, isGlobal);
    },
    NewExpression(path) {
      const callee = path.node.callee;
      if (
        t.isIdentifier(callee) &&
        callee.name === 'RegExp' &&
        path.node.arguments.length > 0 &&
        !t.isSpreadElement(path.node.arguments[0])
      ) {
        const source = staticString(path.node.arguments[0]);
        const flags =
          path.node.arguments.length > 1 &&
          !t.isSpreadElement(path.node.arguments[1])
            ? (staticString(path.node.arguments[1]) ?? '')
            : '';
        if (source !== null) {
          const value = `/${source}/${flags}`;
          pushUnique(report.regexes, seenRegexes, value, {
            value,
            ...pos(path.node),
          });
        }
      }
    },
  });

  return report;
}
