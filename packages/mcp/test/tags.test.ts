import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { tagModule } from '../src/workspace/tags';
import type {
  CallSite,
  ModuleEntry,
  ModuleIndex,
  StringLiteralEntry,
} from '../src/workspace/types';
import { fixtureWorkspace } from './helpers';

function entry(path: string, code = ''): ModuleEntry {
  return { path, bundleId: '0', isEntry: false, code, tags: [] };
}

function call(module: string, callee: string, line = 1): CallSite {
  return { module, line, callee };
}

function str(module: string, value: string, line = 1): StringLiteralEntry {
  return { module, line, value };
}

function slice(
  module: string,
  parts: {
    calls?: CallSite[];
    strings?: StringLiteralEntry[];
  } = {},
): ModuleIndex {
  return {
    symbols: [],
    calls: parts.calls ?? [],
    strings: parts.strings ?? [],
    refs: [],
    imports: [],
    reexports: [],
  };
}

/** Corpus file text (the real indexer in M1.2 is still a stub, so the index
 * slices below are built by hand to mirror what it would emit). */
function corpus(name: string): string {
  return readFileSync(
    new URL(`../../webcrack/test/corpus/${name}`, import.meta.url),
    'utf8',
  );
}

describe('tagModule', () => {
  test('network from calls and https strings', () => {
    for (const callee of [
      'fetch',
      'XMLHttpRequest',
      'axios.post',
      'xhr.open',
      '*.open',
      'ws.send',
      '*.send',
      'WebSocket',
    ]) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('network');
    }
    expect(
      tagModule(
        entry('a.js'),
        slice('a.js', { strings: [str('a.js', 'https://x.example/y')] }),
      ),
    ).toContain('network');
    expect(
      tagModule(
        entry('a.js'),
        slice('a.js', { strings: [str('a.js', 'http://x.example/y')] }),
      ),
    ).toContain('network');
  });

  test('network ignores non-network callees and strings', () => {
    expect(
      tagModule(
        entry('a.js'),
        slice('a.js', {
          calls: [call('a.js', 'JSON.stringify'), call('a.js', '*.json')],
          strings: [str('a.js', 'POST')],
        }),
      ),
    ).not.toContain('network');
  });

  test('auth from keyword strings', () => {
    for (const value of [
      'Authorization',
      'bearer abc',
      'token',
      '/v1/login',
      'password',
      'jwt',
      'PASSWORD', // case-insensitive
    ]) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { strings: [str('a.js', value)] }),
        ),
        value,
      ).toContain('auth');
    }
    expect(
      tagModule(
        entry('a.js'),
        slice('a.js', {
          strings: [str('a.js', './sign.js'), str('a.js', 's3cr3t')],
        }),
      ),
    ).not.toContain('auth');
  });

  test('crypto from btoa/atob and crypto.* calls', () => {
    for (const callee of [
      'btoa',
      'atob',
      'crypto.subtle.digest',
      'crypto.getRandomValues',
    ]) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('crypto');
    }
  });

  test('storage from storage calls and document.cookie reads', () => {
    for (const callee of [
      'localStorage.setItem',
      'localStorage.getItem',
      'sessionStorage.getItem',
    ]) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('storage');
    }
    expect(
      tagModule(entry('a.js', 'document.cookie = "x=1";'), slice('a.js')),
    ).toContain('storage');
  });

  test('dom from document/window calls, listeners and html sinks', () => {
    for (const callee of [
      'document.createElement',
      'document.getElementById',
      'window.location',
      'addEventListener',
      'document.addEventListener',
      'el.innerHTML',
      '*.innerHTML',
      '*.createElement',
      '*.getElementById',
      '*.appendChild',
      '*.querySelector',
    ]) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('dom');
    }
  });

  test('union with findings tables: bare roots, cookie calls, postMessage', () => {
    // Bare storage/crypto roots (findings matches `name === root`).
    for (const [callee, tag] of [
      ['localStorage', 'storage'],
      ['sessionStorage', 'storage'],
      ['indexedDB', 'storage'],
      ['crypto', 'crypto'],
    ] as const) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain(tag);
    }
    // `document.cookie*` callees flag storage even when the code has no
    // cookie property read for COOKIE_RE to see.
    for (const callee of ['document.cookie', 'document.cookie.split']) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('storage');
    }
    // `.postMessage` is a canonical sink suffix (findings) that also
    // implies dom. Bare `postMessage` matches neither table (both require
    // the dotted suffix).
    for (const callee of ['worker.postMessage', '*.postMessage']) {
      expect(
        tagModule(
          entry('a.js'),
          slice('a.js', { calls: [call('a.js', callee)] }),
        ),
        callee,
      ).toContain('dom');
    }
    expect(
      tagModule(
        entry('a.js'),
        slice('a.js', { calls: [call('a.js', 'postMessage')] }),
      ),
    ).not.toContain('dom');
  });

  test('vendor from path and from code banners/signatures', () => {
    for (const path of [
      'node_modules/react/index.js',
      'src/vendor/app.js',
      'lib/jquery.js',
      'lib/jquery.min.js',
      'dist/react-dom.js',
    ]) {
      expect(tagModule(entry(path), slice(path)), path).toContain('vendor');
    }
    expect(
      tagModule(
        entry('bundle/1.js', '/*! @license MIT */\nvar x = 1;'),
        slice('bundle/1.js'),
      ),
    ).toContain('vendor');
    expect(
      tagModule(
        entry('bundle/2.js', '/* jQuery JavaScript Library v3.7 */'),
        slice('bundle/2.js'),
      ),
    ).toContain('vendor');
    expect(
      tagModule(entry('src/app.js', 'var x = 1;'), slice('src/app.js')),
    ).toEqual([]);
    // `reaction.js` merely starts with a library name: not vendor.
    expect(
      tagModule(entry('src/reaction.js'), slice('src/reaction.js')),
    ).toEqual([]);
  });

  test('never returns vm (the store owns it)', () => {
    expect(
      tagModule(
        entry('vm.js', 'while (true) { switch (opcode) { case 1: break; } }'),
        slice('vm.js', { calls: [call('vm.js', 'fetch')] }),
      ),
    ).toEqual(['network']);
  });

  test('ignores index entries from other modules', () => {
    expect(
      tagModule(entry('a.js'), {
        ...slice('a.js'),
        calls: [call('b.js', 'fetch')],
        strings: [str('b.js', 'https://x.example')],
      }),
    ).toEqual([]);
  });

  test('fixture: src/api.js is network/auth/storage, src/sign.js is crypto', () => {
    const ws = fixtureWorkspace();
    const api = ws.modules.get('src/api.js');
    const sign = ws.modules.get('src/sign.js');
    expect(api).toBeDefined();
    expect(sign).toBeDefined();
    if (api === undefined || sign === undefined) return;
    const apiIndex: ModuleIndex = {
      symbols: [],
      calls: ws.index.calls.filter((c) => c.module === api.path),
      strings: ws.index.strings.filter((s) => s.module === api.path),
      refs: [],
      imports: [],
      reexports: [],
    };
    const signIndex: ModuleIndex = {
      symbols: [],
      calls: ws.index.calls.filter((c) => c.module === sign.path),
      strings: ws.index.strings.filter((s) => s.module === sign.path),
      refs: [],
      imports: [],
      reexports: [],
    };
    expect(tagModule(api, apiIndex)).toEqual(['network', 'auth', 'storage']);
    expect(tagModule(sign, signIndex)).toEqual(['crypto']);
  });

  test('corpus: minified-iife.js is network + dom', () => {
    const code = corpus('minified-iife.js');
    expect(code).toContain('fetch');
    const mod = entry('main.js', code);
    const index = slice('main.js', {
      calls: [
        call('main.js', 'fetch'),
        call('main.js', '*.json'),
        call('main.js', 'document.addEventListener'),
      ],
      strings: [str('main.js', 'https://example.com/api/items?')],
    });
    expect(tagModule(mod, index)).toEqual(['network', 'dom']);
  });

  test('corpus: bookmarklet.js is dom', () => {
    const code = corpus('bookmarklet.js');
    expect(code).toContain('document');
    // `var d = document` makes every DOM access a `*.` root for the indexer.
    const mod = entry('main.js', code);
    const index = slice('main.js', {
      calls: [
        call('main.js', '*.createElement'),
        call('main.js', '*.getElementsByTagName'),
        call('main.js', '*.appendChild'),
      ],
    });
    expect(tagModule(mod, index)).toEqual(['dom']);
  });

  test('corpus: browserify.js is dom', () => {
    const code = corpus('browserify.js');
    expect(code).toContain('document.getElementById');
    const mod = entry('1.js', code);
    const index = slice('1.js', {
      calls: [call('1.js', 'document.getElementById')],
    });
    expect(tagModule(mod, index)).toEqual(['dom']);
  });
});
