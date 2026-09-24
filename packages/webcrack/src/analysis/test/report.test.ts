import { parse } from '@babel/parser';
import { describe, expect, test } from 'vitest';
import { extractReport, type Report } from '../report';

function reportOf(code: string) {
  return extractReport(parse(code));
}

describe('urls', () => {
  test('collects http/https/ws/wss literals and template quasis', () => {
    const report = reportOf(`
      const a = "https://example.com/api";
      const b = 'http://insecure.example/x';
      const c = "ws://socket.example/feed";
      const d = "wss://secure-socket.example/feed";
      const e = \`https://api.example.com/users/\${id}\`;
      const notUrl = "just a string";
      const relative = "/api/local";
    `);
    expect(report.urls.map((u) => u.value)).toEqual([
      'https://example.com/api',
      'http://insecure.example/x',
      'ws://socket.example/feed',
      'wss://secure-socket.example/feed',
      'https://api.example.com/users/',
    ]);
  });

  test('locations point at the literal', () => {
    const report = reportOf(`const a = "https://example.com/x";`);
    expect(report.urls).toHaveLength(1);
    expect(report.urls[0].line).toBe(1);
    expect(report.urls[0].column).toBe(10);
  });

  test('ftp and relative paths are not urls', () => {
    const report = reportOf(`
      const a = "ftp://files.example/x";
      const b = "/api/local";
      const c = "example.com/no-scheme";
    `);
    expect(report.urls).toEqual([]);
  });
});

describe('endpoints', () => {
  test('fetch, axios, xhr, $.ajax and sendBeacon', () => {
    const report = reportOf(`
      fetch("https://api.example.com/users");
      fetch("https://api.example.com/users", { method: "post" });
      axios.get("https://api.example.com/items");
      axios.post("https://api.example.com/items", {});
      axios({ method: "delete", url: "https://api.example.com/items/1" });
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/poll");
      $.ajax({ url: "/api/legacy", type: "POST" });
      navigator.sendBeacon("https://api.example.com/events", data);
    `);
    expect(report.endpoints).toEqual([
      {
        method: 'GET',
        url: 'https://api.example.com/users',
        line: 2,
        column: 6,
      },
      {
        method: 'POST',
        url: 'https://api.example.com/users',
        line: 3,
        column: 6,
      },
      {
        method: 'GET',
        url: 'https://api.example.com/items',
        line: 4,
        column: 6,
      },
      {
        method: 'POST',
        url: 'https://api.example.com/items',
        line: 5,
        column: 6,
      },
      {
        method: 'DELETE',
        url: 'https://api.example.com/items/1',
        line: 6,
        column: 6,
      },
      {
        method: 'GET',
        url: 'https://api.example.com/poll',
        line: 8,
        column: 6,
      },
      { method: 'POST', url: '/api/legacy', line: 9, column: 6 },
      {
        method: 'POST',
        url: 'https://api.example.com/events',
        line: 10,
        column: 6,
      },
    ]);
  });

  test('dynamic urls come back as null', () => {
    const report = reportOf(`
      fetch(base + "/users");
      axios.post(computedUrl, {});
    `);
    expect(report.endpoints).toEqual([
      { method: 'GET', url: null, line: 2, column: 6 },
      { method: 'POST', url: null, line: 3, column: 6 },
    ]);
  });

  test('present-but-dynamic method comes back as null, not GET', () => {
    const report = reportOf(`
      fetch("https://a.example/x", { method: getMethod() });
      fetch("https://a.example/y");
      $.ajax({ url: "/api/y", method: someVar });
      $.ajax({ url: "/api/z" });
    `);
    expect(report.endpoints).toEqual([
      { method: null, url: 'https://a.example/x', line: 2, column: 6 },
      { method: 'GET', url: 'https://a.example/y', line: 3, column: 6 },
      { method: null, url: '/api/y', line: 4, column: 6 },
      { method: 'GET', url: '/api/z', line: 5, column: 6 },
    ]);
  });

  test('window.open is not an endpoint', () => {
    const report = reportOf(`window.open("https://example.com/x", "_blank");`);
    expect(report.endpoints).toEqual([]);
  });

  test('only global fetch receivers are endpoints', () => {
    const report = reportOf(`
      db.fetch("users");
      window.fetch("https://w.example/x");
      globalThis.fetch("https://g.example/x");
      self.fetch("https://s.example/x");
      fetch("https://bare.example/x");
      fetch?.("https://optional.example/x");
    `);
    expect(report.endpoints.map((e) => e.url)).toEqual([
      'https://w.example/x',
      'https://g.example/x',
      'https://s.example/x',
      'https://bare.example/x',
      'https://optional.example/x',
    ]);
  });

  test('shadowed fetch and window are not endpoints', () => {
    const report = reportOf(`
      function fetch(u) { return u; }
      fetch("https://a.example/x");
    `);
    expect(report.endpoints).toEqual([]);

    const shadowedWindow = reportOf(`
      const window = { fetch(u) { return u; } };
      window.fetch("https://a.example/x");
    `);
    expect(shadowedWindow.endpoints).toEqual([]);

    const shadowedParam = reportOf(`
      function f(fetch) { return fetch("https://a.example/x"); }
    `);
    expect(shadowedParam.endpoints).toEqual([]);
  });
});

describe('secrets', () => {
  test('named rules', () => {
    const report = reportOf(`
      const aws = "AKIAIOSFODNN7EXAMPLE";
      const google = "AIzaSyA-abcdefghijklmnopqrstuvwxy123456";
      const stripe = "sk_test_4eC39HqLyjWDarjtT1zdp7dc";
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    `);
    expect(report.secrets).toEqual([
      {
        value: 'AKIAIOSFODNN7EXAMPLE',
        rule: 'aws-access-key',
        line: 2,
        column: 18,
      },
      {
        value: 'AIzaSyA-abcdefghijklmnopqrstuvwxy123456',
        rule: 'google-api-key',
        line: 3,
        column: 21,
      },
      {
        value: 'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
        rule: 'stripe-key',
        line: 4,
        column: 21,
      },
      {
        value:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        rule: 'jwt',
        line: 5,
        column: 18,
      },
    ]);
  });

  test('generic high-entropy strings', () => {
    const report = reportOf(`const token = "xK9#mQ2$vL7@nP4!wR8zT5yU";`);
    expect(report.secrets).toEqual([
      {
        value: 'xK9#mQ2$vL7@nP4!wR8zT5yU',
        rule: 'generic-high-entropy',
        line: 1,
        column: 14,
      },
    ]);
  });

  test('negatives are not flagged', () => {
    const report = reportOf(`
      const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA";
      const bareBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4z8AAAwMDEBMwiVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4z8AAAwMDEBMw";
      const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
      const integrity = "sha512-OHITJOlzJvw8dI8yT8y6R5J8yT8y6R5J8yT8y6R5J8yT8y6xx==";
      const uuid = "123e4567-e89b-12d3-a456-426614174000";
      const words = "correct horse battery staple words here";
      const short = "abc123";
    `);
    expect(report.secrets).toEqual([]);
  });
});

describe('regexes', () => {
  test('literals and static RegExp constructions', () => {
    const report = reportOf(`
      const a = /ab+c/gi;
      const b = new RegExp("a\\\\d+", "i");
      const c = RegExp("static-source");
      const dynamic = new RegExp(pattern);
    `);
    expect(report.regexes.map((r) => r.value)).toEqual([
      '/ab+c/gi',
      '/a\\d+/i',
      '/static-source/',
    ]);
  });

  test('optional RegExp call form', () => {
    const report = reportOf(`
      const a = RegExp?.("a+b");
      const b = RegExp?.("c+d", "gi");
    `);
    expect(report.regexes.map((r) => r.value)).toEqual(['/a+b/', '/c+d/gi']);
  });
});

describe('interesting', () => {
  test('emails, ips and api paths', () => {
    const report = reportOf(`
      const email = "contact admin@example.com for help";
      const ip = "connect to 192.168.1.10 now";
      const badIp = "version 999.999.999.999 here";
      const path = "POST /api/v1/users here";
      const full = "https://example.com/api/v2/items";
      const time = "at 12:34:56 today";
    `);
    expect(report.interesting).toEqual([
      { value: 'admin@example.com', kind: 'email', line: 2, column: 20 },
      { value: '192.168.1.10', kind: 'ip', line: 3, column: 17 },
      { value: '/api/v1/users', kind: 'path', line: 5, column: 19 },
      { value: '/api/v2/items', kind: 'path', line: 6, column: 19 },
    ]);
    expect(report.interesting.some((e) => e.value.includes('999'))).toBe(false);
    expect(report.interesting.some((e) => e.value.includes('12:34'))).toBe(
      false,
    );
  });
});

describe('dedup, ordering and serialization', () => {
  test('duplicates keep the first location and source order is stable', () => {
    const report = reportOf(`
      const b = "https://b.example/";
      const a = "https://a.example/";
      const b2 = "https://b.example/";
      const re = /dup/g;
      const re2 = /dup/g;
    `);
    expect(report.urls.map((u) => u.value)).toEqual([
      'https://b.example/',
      'https://a.example/',
    ]);
    expect(report.urls[0]).toMatchObject({ line: 2 });
    expect(report.regexes).toHaveLength(1);
    expect(report.regexes[0]).toMatchObject({ line: 5 });
  });

  test('report survives a JSON round-trip', () => {
    const report = reportOf(`
      fetch("https://api.example.com/users", { method: "POST" });
      const key = "AKIAIOSFODNN7EXAMPLE";
      const re = /x+/g;
      const mail = "a@b.com and 10.0.0.1 and /api/z";
    `);
    const roundTripped = JSON.parse(JSON.stringify(report)) as Report;
    expect(roundTripped).toEqual(report);
    expect(Object.keys(roundTripped).sort()).toEqual([
      'endpoints',
      'interesting',
      'regexes',
      'secrets',
      'urls',
    ]);
  });
});
