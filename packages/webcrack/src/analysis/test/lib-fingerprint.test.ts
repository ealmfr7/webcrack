import { parse } from '@babel/parser';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  fingerprint,
  matchModules,
  toMappings,
  type LibrarySignature,
} from '../lib-fingerprint';
import { SIGNATURES } from '../signatures/index';
import { Bundle } from '../../unpack/bundle';
import { Module } from '../../unpack/module';

function hashOf(code: string): string {
  return fingerprint(parse(code));
}

function seed(path: string): LibrarySignature {
  const signature = SIGNATURES.find((s) => s.path === path);
  if (!signature) throw new Error(`seed missing: ${path}`);
  return signature;
}

function bundleOf(
  entries: Array<{ id: string; code: string; entry?: boolean }>,
): Bundle {
  const modules = new Map(
    entries.map(({ id, code, entry }) => [
      id,
      new Module(id, parse(code), entry ?? false),
    ]),
  );
  const entryId = entries.find((e) => e.entry)?.id ?? entries[0].id;
  return new Bundle('webpack', entryId, modules);
}

describe('fingerprint', () => {
  test('same function with different identifier names hashes the same', () => {
    expect(hashOf('function add(a, b) { return a + b; }')).toBe(
      hashOf('function sum(x, y) { return x + y; }'),
    );
  });

  test('minified spelling hashes the same', () => {
    expect(hashOf('function add(a, b) { return a + b; }')).toBe(
      hashOf('function s(t,e){return t+e}'),
    );
  });

  test('comments and formatting are ignored', () => {
    expect(hashOf('function add(a, b) { return a + b; }')).toBe(
      hashOf('// adds two numbers\nfunction add(a, b) {\n  return a + b; // sum\n}'),
    );
  });

  test('hex and decimal spellings of the same number agree', () => {
    expect(hashOf('function f() { return 0x10; }')).toBe(
      hashOf('function f() { return 16; }'),
    );
  });

  test('long strings are normalized, short strings are kept', () => {
    const longA = `function f() { return '${'a'.repeat(100)}'; }`;
    const longB = `function f() { return '${'b'.repeat(100)}'; }`;
    const longerB = `function f() { return '${'b'.repeat(101)}'; }`;
    expect(hashOf(longA)).toBe(hashOf(longB));
    expect(hashOf(longB)).not.toBe(hashOf(longerB));
    expect(hashOf(`function f() { return 'a'; }`)).not.toBe(
      hashOf(`function f() { return 'b'; }`),
    );
  });

  test('File and Program forms of the same code agree', () => {
    const file = parse('function add(a, b) { return a + b; }');
    expect(fingerprint(file)).toBe(fingerprint(file.program));
  });

  test('semantically different functions hash differently', () => {
    expect(hashOf('function f(a, b) { return a + b; }')).not.toBe(
      hashOf('function f(a, b) { return a - b; }'),
    );
    expect(hashOf('function f(x) { console.log(x); }')).not.toBe(
      hashOf('function f(x) { console.warn(x); }'),
    );
    expect(hashOf('function f() { return 1; }')).not.toBe(
      hashOf('function f() { return 2; }'),
    );
    expect(hashOf('function f(a) { if (a) { return 1; } return 0; }')).not.toBe(
      hashOf('function f(a) { return a ? 1 : 0; }'),
    );
  });
});

describe('seed signatures', () => {
  const signaturesDir = fileURLToPath(new URL('../signatures/', import.meta.url));
  const generatedPath = join(signaturesDir, 'generated.ts');

  function signatureFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.JSON')) files.push(full);
      }
    };
    walk(signaturesDir);
    return files;
  }

  function isSignature(value: unknown): value is LibrarySignature {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record.library === 'string' &&
      (record.version === undefined || typeof record.version === 'string') &&
      typeof record.path === 'string' &&
      typeof record.hash === 'string' &&
      typeof record.source === 'string'
    );
  }

  function readSignature(file: string): LibrarySignature {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isSignature(data)) throw new Error(`Invalid signature file: ${file}`);
    return data;
  }

  function canonical(signature: LibrarySignature): LibrarySignature {
    return {
      library: signature.library,
      ...(signature.version === undefined
        ? {}
        : { version: signature.version }),
      path: signature.path,
      hash: signature.hash,
      source: signature.source,
    };
  }

  function compareSignatures(
    a: LibrarySignature,
    b: LibrarySignature,
  ): number {
    const ka = JSON.stringify([a.library, a.path]);
    const kb = JSON.stringify([b.library, b.path]);
    return ka < kb ? -1 : 1;
  }

  function serializeSignatures(signatures: LibrarySignature[]): string {
    const header = [
      '// DO NOT EDIT: generated from the *.JSON files in this directory.',
      '// Regenerate with:',
      '//   UPDATE_SIGNATURES=1 ../../node_modules/.bin/vitest run --no-isolate src/analysis/test/lib-fingerprint.test.ts',
      '// (run from packages/webcrack).',
      "import type { LibrarySignature } from '../lib-fingerprint';",
    ].join('\n');
    const entries = signatures
      .map((signature) =>
        JSON.stringify(signature, null, 2)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      )
      .join(',\n');
    return `${header}\n\nexport const SIGNATURES: LibrarySignature[] = [\n${entries}\n];\n`;
  }

  test('seed database is fresh (UPDATE_SIGNATURES=1 regenerates)', () => {
    const files = signatureFiles();
    expect(files.length).toBeGreaterThan(0);
    const stale: string[] = [];
    const fresh = files.map((file) => {
      const signature = readSignature(file);
      expect(signature.hash).toMatch(/^[0-9a-f]{64}$/);
      const hash = fingerprint(parse(signature.source));
      if (hash !== signature.hash) stale.push(file);
      return canonical({ ...signature, hash });
    });
    fresh.sort(compareSignatures);
    if (process.env.UPDATE_SIGNATURES === '1') {
      const byKey = new Map(
        fresh.map((s) => [JSON.stringify([s.library, s.path]), s]),
      );
      for (const file of files) {
        const signature = readSignature(file);
        const updated = byKey.get(
          JSON.stringify([signature.library, signature.path]),
        );
        if (!updated) throw new Error(`Unregistered signature file: ${file}`);
        writeFileSync(file, `${JSON.stringify(updated)}\n`);
      }
      writeFileSync(generatedPath, serializeSignatures(fresh));
      return;
    }
    expect(stale).toEqual([]);
    // The checked-in generated index matches the JSON files exactly.
    expect([...SIGNATURES].sort(compareSignatures)).toEqual(fresh);
    expect(readFileSync(generatedPath, 'utf8')).toBe(
      serializeSignatures(fresh),
    );
  });
});

describe('matchModules', () => {
  const appCode = `
    function renderList(items) {
      const el = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item.name;
        el.appendChild(li);
      }
      return el;
    }
    module.exports = renderList;
  `;

  // Hand-renamed ("minified") copy of the fnv1a seed.
  const minifiedFnv1a = `
    function f(s) {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    }
    module.exports = f;
  `;

  test('matches a seeded library module in a bundle', () => {
    const crc32 = seed('tiny-hash/crc32.js');
    const bundle = bundleOf([
      { id: 'entry', code: 'console.log("app");', entry: true },
      { id: '1', code: crc32.source },
    ]);
    expect(matchModules(bundle)).toEqual([
      {
        moduleId: '1',
        library: 'tiny-hash',
        version: '1.0.0',
        path: 'tiny-hash/crc32.js',
        confidence: 1,
      },
    ]);
  });

  test('matches the minified copy of a seed', () => {
    const bundle = bundleOf([{ id: '9', code: minifiedFnv1a }]);
    expect(matchModules(bundle)).toEqual([
      {
        moduleId: '9',
        library: 'tiny-hash',
        version: '1.0.0',
        path: 'tiny-hash/fnv1a.js',
        confidence: 1,
      },
    ]);
  });

  test('every seed matches only its own library', () => {
    const entries = SIGNATURES.map((s, index) => ({
      id: String(index),
      code: s.source,
    }));
    const matches = matchModules(bundleOf(entries));
    expect(matches).toHaveLength(SIGNATURES.length);
    for (const [index, signature] of SIGNATURES.entries()) {
      expect(matches[index]).toMatchObject({
        moduleId: String(index),
        library: signature.library,
        path: signature.path,
      });
    }
  });

  test('no false matches on unrelated modules', () => {
    const bundle = bundleOf([
      { id: 'entry', code: 'console.log("app");', entry: true },
      { id: '1', code: appCode },
      { id: '2', code: 'function f(a, b) { return a + b; }' },
    ]);
    expect(matchModules(bundle)).toEqual([]);
  });

  test('matches feed Bundle.applyMappings via toMappings', () => {
    const crc32 = seed('tiny-hash/crc32.js');
    const bundle = bundleOf([
      { id: 'entry', code: 'console.log("app");', entry: true },
      { id: '7', code: crc32.source },
    ]);
    const matches = matchModules(bundle);
    expect(matches).toHaveLength(1);
    bundle.applyMappings(toMappings(matches));
    expect(bundle.modules.get('7')?.path).toBe('node_modules/tiny-hash/crc32.js');
    expect(bundle.modules.get('entry')?.path).toBe('./index.js');
  });
});
