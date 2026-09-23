// DO NOT EDIT: generated from the *.JSON files in this directory.
// Regenerate with:
//   UPDATE_SIGNATURES=1 ../../node_modules/.bin/vitest run --no-isolate src/analysis/test/lib-fingerprint.test.ts
// (run from packages/webcrack).
import type { LibrarySignature } from '../lib-fingerprint';

export const SIGNATURES: LibrarySignature[] = [
  {
    "library": "tiny-b64",
    "version": "2.1.0",
    "path": "tiny-b64/base64.js",
    "hash": "c0315bfacb5cef654479c0df56ce7721c1f13193a416fe449290841937f002c4",
    "source": "const chars =\n  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\nfunction encode(input) {\n  let output = '';\n  for (let i = 0; i < input.length; i += 3) {\n    const a = input.charCodeAt(i);\n    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;\n    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : 0;\n    const triple = (a << 16) | (b << 8) | c;\n    output += chars[(triple >> 18) & 63] + chars[(triple >> 12) & 63];\n    output += i + 1 < input.length ? chars[(triple >> 6) & 63] : '=';\n    output += i + 2 < input.length ? chars[triple & 63] : '=';\n  }\n  return output;\n}\nmodule.exports = { encode };\n"
  },
  {
    "library": "tiny-hash",
    "version": "1.0.0",
    "path": "tiny-hash/crc32.js",
    "hash": "93d70f2632c448ec4aa823cbf8e0ed332f8f051ff3b716d8cdceb7f9b128d725",
    "source": "const table = new Array(256);\nfor (let n = 0; n < 256; n++) {\n  let c = n;\n  for (let k = 0; k < 8; k++) {\n    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;\n  }\n  table[n] = c;\n}\nfunction crc32(str) {\n  let crc = 0 ^ -1;\n  for (let i = 0; i < str.length; i++) {\n    crc = (crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xff];\n  }\n  return (crc ^ -1) >>> 0;\n}\nmodule.exports = crc32;\n"
  },
  {
    "library": "tiny-hash",
    "version": "1.0.0",
    "path": "tiny-hash/fnv1a.js",
    "hash": "405ca3a0c16e31e4fe1f8c989056d6ee3f7d54458bece4f4f8a038ce5bad0929",
    "source": "function fnv1a(str) {\n  let hash = 0x811c9dc5;\n  for (let i = 0; i < str.length; i++) {\n    hash ^= str.charCodeAt(i);\n    hash = Math.imul(hash, 0x01000193);\n  }\n  return hash >>> 0;\n}\nmodule.exports = fnv1a;\n"
  },
  {
    "library": "tiny-timers",
    "version": "1.2.0",
    "path": "tiny-timers/debounce.js",
    "hash": "4cc5ee129a5571c55d71b6fa23105e8abe24fa0a040c9b7967f3c4622c35e331",
    "source": "function debounce(fn, wait) {\n  let timeout = null;\n  function debounced(...args) {\n    if (timeout !== null) {\n      clearTimeout(timeout);\n    }\n    timeout = setTimeout(() => {\n      timeout = null;\n      fn.apply(this, args);\n    }, wait);\n  }\n  debounced.cancel = function () {\n    if (timeout !== null) {\n      clearTimeout(timeout);\n      timeout = null;\n    }\n  };\n  return debounced;\n}\nmodule.exports = debounce;\n"
  }
];
