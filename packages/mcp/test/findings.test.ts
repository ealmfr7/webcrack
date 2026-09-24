import { expect, test } from 'vitest';
import type { Report } from 'webcrack/analysis';
import {
  collectFindings,
  precomputeModuleFindings,
  summarizeFindings,
} from '../src/workspace/findings';
import type { Workspace } from '../src/workspace/types';
import { connect, fixtureWorkspace } from './helpers';

const EVIL = `eval("x");
el.innerHTML = user;
setTimeout("doIt()", 100);
worker.postMessage(data);
window.addEventListener("message", handler);
location.href = url;
document.write("<b>hi</b>");
const f = new Function("a", "return a");
sessionStorage.getItem("k");
document.cookie = "a=b";`;

const EVIL_REPORT: Report = {
  urls: [],
  endpoints: [],
  secrets: [],
  regexes: [{ value: '/foo+/gi', line: 1, column: 5 }],
  interesting: [{ value: 'a@b.com', kind: 'email', line: 2, column: 0 }],
};

const CRYPTO_MOD = `const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5];
const SBOX = [0x63, 0x7c, 0x77, 0x7b, 0xf2];
const CRC = 0xEDB88320;
const MD5_A = 0x67452301;
async function digest(data) {
  return crypto.subtle.digest("SHA-256", data);
}
function mix(a, b, c) {
  let x = a | b;
  x ^= c;
  x = (x << 5) | (x >>> 27);
  x &= 0xff;
  x = x ^ (x >> 3);
  x <<= 1;
  return ~x;
}`;

const EMPTY_REPORT: Report = {
  urls: [],
  endpoints: [],
  secrets: [],
  regexes: [],
  interesting: [],
};

/** Fixture + an evil module (sinks/storage/regex/interesting) + a crypto
 * module + a VM interpreter summary. */
function richWorkspace(): Workspace {
  const ws = fixtureWorkspace();
  ws.modules.set('src/evil.js', {
    path: 'src/evil.js',
    bundleId: '2',
    isEntry: false,
    code: EVIL,
    tags: [],
  });
  ws.report['src/evil.js'] = EVIL_REPORT;
  ws.modules.set('src/hash.js', {
    path: 'src/hash.js',
    bundleId: '3',
    isEntry: false,
    code: CRYPTO_MOD,
    tags: [],
  });
  ws.report['src/hash.js'] = EMPTY_REPORT;
  ws.interpreters.push({
    module: 'src/evil.js',
    line: 20,
    endLine: 40,
    dispatchKind: 'switch',
    handlerCount: 14,
    pc: 'pc',
    bytecode: 'bc',
  });
  return ws;
}

test('report categories come from the fixture report', async () => {
  const { call } = await connect(fixtureWorkspace());
  const endpoints = await call('wc_findings', { category: 'endpoints' });
  expect(endpoints).toContain('src/api.js:3');
  expect(endpoints).toContain('POST https://api.example.com/v1/login');

  const urls = await call('wc_findings', { category: 'urls' });
  expect(urls).toContain('src/api.js:3');
  expect(urls).toContain('`https://api.example.com/v1/login`');

  // The fixture URL is also reported as a generic-high-entropy secret.
  const secrets = await call('wc_findings', { category: 'secrets' });
  expect(secrets).toContain('src/api.js:3');
  expect(secrets).toContain('generic-high-entropy');

  const regexes = await call('wc_findings', { category: 'regexes' });
  expect(regexes).toContain('0 findings');
});

test('secrets are masked by default and revealed with reveal=true', async () => {
  const { call } = await connect(fixtureWorkspace());
  const masked = await call('wc_findings', { category: 'secrets' });
  expect(masked).toContain('`http…in`');
  expect(masked).not.toContain('https://api.example.com/v1/login');

  const revealed = await call('wc_findings', {
    category: 'secrets',
    reveal: true,
  });
  expect(revealed).toContain('`https://api.example.com/v1/login`');
});

test('sinks cover the spec list', async () => {
  const { call } = await connect(richWorkspace());
  const out = await call('wc_findings', {
    category: 'sinks',
    module: 'src/evil.js',
  });
  for (const title of [
    'eval()',
    'innerHTML assignment',
    'setTimeout() with string argument',
    'postMessage()',
    "addEventListener('message')",
    'location assignment',
    'document.write()',
    'Function()',
  ]) {
    expect(out).toContain(title);
  }
  expect(out).toContain('Next: wc_read src/evil.js:1');
});

test('storage and crypto on the fixture', async () => {
  const { call } = await connect(fixtureWorkspace());
  const storage = await call('wc_findings', { category: 'storage' });
  expect(storage).toContain('src/api.js:8');
  expect(storage).toContain('localStorage.setItem');

  const crypto = await call('wc_findings', { category: 'crypto' });
  expect(crypto).toContain('src/sign.js:2');
  expect(crypto).toContain('btoa()');
});

test('storage extras, crypto constants and dense bitwise ops', async () => {
  const { call } = await connect(richWorkspace());
  const storage = await call('wc_findings', {
    category: 'storage',
    module: 'src/evil.js',
  });
  expect(storage).toContain('sessionStorage.getItem');
  expect(storage).toContain('document.cookie');

  const crypto = await call('wc_findings', {
    category: 'crypto',
    module: 'src/hash.js',
  });
  expect(crypto).toContain('crypto constant: SHA-256 round constant');
  expect(crypto).toContain('crypto constant: AES S-box');
  expect(crypto).toContain('crypto constant: CRC32 polynomial');
  expect(crypto).toContain('crypto constant: MD5/SHA-1 init');
  expect(crypto).toContain('crypto.subtle.digest()');
  expect(crypto).toContain('dense bitwise ops');
});

test('crypto covers all crypto.* calls (union with tags)', () => {
  const ws = fixtureWorkspace();
  ws.modules.set('src/rand.js', {
    path: 'src/rand.js',
    bundleId: '2',
    isEntry: false,
    code: 'const r = crypto.getRandomValues(new Uint8Array(4));',
    tags: [],
  });
  ws.report['src/rand.js'] = EMPTY_REPORT;
  const titles = collectFindings(ws, 'crypto')
    .filter((f) => f.module === 'src/rand.js')
    .map((f) => f.title);
  expect(titles).toContain('crypto.getRandomValues()');
});

test('regexes, interesting and vm', async () => {
  const { call } = await connect(richWorkspace());
  const regexes = await call('wc_findings', { category: 'regexes' });
  expect(regexes).toContain('`/foo+/gi`');
  const interesting = await call('wc_findings', { category: 'interesting' });
  expect(interesting).toContain('email');
  expect(interesting).toContain('`a@b.com`');
  const vm = await call('wc_findings', { category: 'vm' });
  expect(vm).toContain('src/evil.js:20');
  expect(vm).toContain('VM interpreter (switch, 14 handlers)');
});

test('document.cookie chain reads are storage findings, once per line', () => {
  const ws = fixtureWorkspace();
  ws.modules.set('src/cookie.js', {
    path: 'src/cookie.js',
    bundleId: '2',
    isEntry: false,
    code: "const n = document.cookie.length;\nconst parts = document.cookie.split(';');",
    tags: [],
  });
  const findings = collectFindings(ws, 'storage').filter(
    (f) => f.module === 'src/cookie.js',
  );
  expect(findings.map((f) => f.line)).toEqual([1, 2]);
  expect(findings.every((f) => f.title === 'document.cookie')).toBe(true);
});

test('summary counts and top 5', async () => {
  const { call } = await connect(fixtureWorkspace());
  const out = await call('wc_findings', { category: 'summary' });
  expect(out).toContain('endpoints: 1');
  expect(out).toContain('urls: 1');
  expect(out).toContain('secrets: 1');
  expect(out).toContain('storage: 1');
  expect(out).toContain('crypto: 1');
  expect(out).toContain('vm: 0');
  expect(out).toContain('Next:');
});

test('module filter and pagination', async () => {
  const { call } = await connect(richWorkspace());
  const only = await call('wc_findings', {
    category: 'crypto',
    module: 'src/sign.js',
  });
  expect(only).toContain('btoa()');
  expect(only).not.toContain('src/hash.js');

  const page = await call('wc_findings', {
    category: 'sinks',
    module: 'src/evil.js',
    limit: 2,
    offset: 2,
  });
  expect(page).toContain('Showing 3-4 of 8. More: offset=4');

  await expect(
    call('wc_findings', { category: 'sinks', module: 'src/nope.js' }),
  ).rejects.toThrow('No modules match');
});

test('mutating module.code yields fresh findings (no stale AST)', () => {
  const ws = fixtureWorkspace();
  expect(ws.findings).toBeUndefined();
  ws.modules.set('main.js', {
    path: 'main.js',
    bundleId: '0',
    isEntry: true,
    code: 'a && b && c && console.log(1);\neval("x");',
    tags: [],
  });
  expect(
    collectFindings(ws, 'sinks').map((f) => `${f.module}:${f.line}`),
  ).toEqual(['main.js:2']);
  const mod = ws.modules.get('main.js');
  if (!mod) throw new Error('fixture is missing main.js');
  // Simulate `wc_deobfuscate apply` (unminify) pushing `eval` down: the
  // cached AST must not pin the finding to line 2.
  mod.code = '\n\na && b && c && console.log(1);\neval("x");';
  expect(
    collectFindings(ws, 'sinks').map((f) => `${f.module}:${f.line}`),
  ).toEqual(['main.js:4']);
});

test('precomputed ws.findings is used instead of parsing', () => {
  const ws = fixtureWorkspace();
  ws.findings = precomputeModuleFindings(ws.modules.values());
  const mod = ws.modules.get('src/sign.js');
  if (!mod) throw new Error('fixture is missing src/sign.js');
  const expected = collectFindings(ws, 'crypto', [mod]);
  expect(expected.map((f) => f.title)).toContain('btoa()');
  // Rewrite the code to something with entirely different findings: the
  // query must still serve the precomputed table (no reparse), so the new
  // `eval` stays invisible and the old `btoa` stays visible.
  mod.code = 'eval("x");';
  expect(collectFindings(ws, 'crypto', [mod])).toEqual(expected);
  expect(collectFindings(ws, 'sinks', [mod])).toEqual([]);
  expect(summarizeFindings(ws).counts.crypto).toBe(1);
});

test('a workspace without findings falls back to parsing', () => {
  const ws = fixtureWorkspace();
  expect(ws.findings).toBeUndefined();
  expect(collectFindings(ws, 'crypto').map((f) => f.title)).toContain('btoa()');
  expect(summarizeFindings(ws).counts).toMatchObject({ crypto: 1 });
});

test('pure logic: summarizeFindings top order', () => {
  const { counts, top } = summarizeFindings(fixtureWorkspace());
  expect(counts).toMatchObject({
    endpoints: 1,
    urls: 1,
    secrets: 1,
    regexes: 0,
    interesting: 0,
    sinks: 0,
    storage: 1,
    crypto: 1,
    vm: 0,
  });
  expect(top).toHaveLength(5);
  expect(top[0].category).toBe('secrets');
  expect(top[1].category).toBe('endpoints');
  // Raw values here: masking is the tool's job.
  expect(top[0].value).toBe('https://api.example.com/v1/login');
  expect(collectFindings(fixtureWorkspace(), 'vm')).toEqual([]);
});
