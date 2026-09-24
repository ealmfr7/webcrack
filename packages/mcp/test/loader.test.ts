import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Config } from '../src/config';
import { WcError } from '../src/format/errors';
import { loadSource } from '../src/workspace/loader';

// The test server only ever binds 127.0.0.1, but runtimes with
// NODE_USE_ENV_PROXY=1 route global fetch through an egress proxy unless
// loopback is exempted. Keep that traffic direct (additive, loopback-only).
for (const name of ['no_proxy', 'NO_PROXY'] as const) {
  const hosts = (process.env[name] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!hosts.includes(host)) hosts.push(host);
  }
  process.env[name] = hosts.join(',');
}

const CODE = 'console.log("hello");\n';

function configFor(root: string, over: Partial<Config> = {}): Config {
  return {
    roots: [root],
    cacheDir: join(root, 'cache'),
    maxInputBytes: 1024 * 1024,
    timeoutMs: 5000,
    outputBudget: 20_000,
    ...over,
  };
}

const tempDirs: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wc-loader-'));
  tempDirs.push(dir);
  return dir;
}

const servers: Server[] = [];
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('test server did not bind');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Run loadSource expecting a WcError; return its message. */
async function loadError(source: string, config: Config): Promise<string> {
  const error = await loadSource(source, config).then(
    () => {
      throw new Error(`expected loadSource to throw for ${source}`);
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(WcError);
  return (error as Error).message;
}

describe('path sources', () => {
  test('loads a file inside roots with a root-relative label', async () => {
    const root = await makeRoot();
    const file = join(root, 'sub', 'bundle.js');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(file, CODE, 'utf8');

    const loaded = await loadSource(file, configFor(root));

    expect(loaded.kind).toBe('path');
    expect(loaded.label).toBe(join('sub', 'bundle.js'));
    expect(loaded.code).toBe(CODE);
    expect(loaded.bytes).toBe(Buffer.byteLength(CODE));
  });

  test('rejects .. escapes outside roots and names WEBCRACK_MCP_ROOTS', async () => {
    const root = await makeRoot();
    const escape = join(root, 'sub', '..', '..', 'evil.js');
    await writeFile(resolve(escape), CODE, 'utf8');
    try {
      const message = await loadError(escape, configFor(root));

      expect(message).toContain('outside the allowed roots');
      expect(message).toContain('WEBCRACK_MCP_ROOTS');
      expect(message).toContain(root);
    } finally {
      await rm(resolve(escape), { force: true });
    }
  });

  test('rejects symlinks pointing outside roots', async () => {
    const root = await makeRoot();
    const outsideDir = await makeRoot();
    const target = join(outsideDir, 'real.js');
    await writeFile(target, CODE, 'utf8');
    const link = join(root, 'link.js');
    await symlink(target, link);

    const message = await loadError(link, configFor(root));

    expect(message).toContain('outside the allowed roots');
    expect(message).toContain('WEBCRACK_MCP_ROOTS');
  });

  test('rejects files larger than maxInputBytes', async () => {
    const root = await makeRoot();
    const file = join(root, 'big.js');
    await writeFile(file, 'x'.repeat(100), 'utf8');

    const message = await loadError(
      file,
      configFor(root, { maxInputBytes: 10 }),
    );

    expect(message).toContain('100 bytes');
    expect(message).toContain('10-byte limit');
    expect(message).toContain('WEBCRACK_MCP_MAX_INPUT');
  });

  test('rejects directories', async () => {
    const root = await makeRoot();

    const message = await loadError(root, configFor(root));

    expect(message).toContain('is a directory');
  });

  test('missing lookalike paths fail instead of being treated as code', async () => {
    const root = await makeRoot();

    const message = await loadError(join(root, 'missing.js'), configFor(root));

    expect(message).toContain('File not found');
  });
});

describe('url sources', () => {
  test('loads an http url', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(CODE);
    });

    const loaded = await loadSource(
      `${base}/bundle.js`,
      configFor(await makeRoot()),
    );

    expect(loaded.kind).toBe('url');
    expect(loaded.label).toBe(`${base}/bundle.js`);
    expect(loaded.code).toBe(CODE);
    expect(loaded.bytes).toBe(Buffer.byteLength(CODE));
  });

  test('non-2xx responses fail with the status', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });

    const message = await loadError(
      `${base}/bundle.js`,
      configFor(await makeRoot()),
    );

    expect(message).toContain('404');
  });

  test('follows relative redirects to http(s)', async () => {
    const base = await startServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/bundle.js' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(CODE);
      }
    });

    const loaded = await loadSource(
      `${base}/redir`,
      configFor(await makeRoot()),
    );

    expect(loaded.kind).toBe('url');
    expect(loaded.label).toBe(`${base}/bundle.js`);
    expect(loaded.code).toBe(CODE);
  });

  test.each(['file:///etc/passwd', 'data:text/plain,hi'])(
    'refuses redirects to %s',
    async (target) => {
      const base = await startServer((_req, res) => {
        res.writeHead(302, { location: target });
        res.end();
      });

      const message = await loadError(
        `${base}/redir`,
        configFor(await makeRoot()),
      );

      expect(message).toContain('Refused to follow a redirect');
      expect(message).toContain('only http(s)');
    },
  );

  test('rejects bodies larger than maxInputBytes', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('x'.repeat(200));
    });

    const message = await loadError(
      `${base}/big.js`,
      configFor(await makeRoot(), { maxInputBytes: 64 }),
    );

    expect(message).toContain('64-byte limit');
    expect(message).toContain('WEBCRACK_MCP_MAX_INPUT');
  });

  test('rejects chunked bodies larger than maxInputBytes', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.write('x'.repeat(40));
      res.write('y'.repeat(40));
      res.end('z'.repeat(40));
    });

    const message = await loadError(
      `${base}/big.js`,
      configFor(await makeRoot(), { maxInputBytes: 64 }),
    );

    expect(message).toContain('64-byte limit');
  });

  test('slow servers hit the configured timeout', async () => {
    const base = await startServer((_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.end(CODE);
      }, 300);
    });

    const message = await loadError(
      `${base}/slow.js`,
      configFor(await makeRoot(), { timeoutMs: 50 }),
    );

    expect(message).toContain('timed out');
    expect(message).toContain('WEBCRACK_MCP_TIMEOUT_MS');
  });

  test('credentials are stripped from the label', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(CODE);
    });
    const withCreds = base.replace('://', '://secret-user:s3cret@');

    const loaded = await loadSource(withCreds, configFor(await makeRoot()));

    expect(loaded.kind).toBe('url');
    expect(loaded.label).toBe(`${base}/`);
    expect(loaded.label).not.toContain('secret-user');
    expect(loaded.label).not.toContain('s3cret');
    expect(loaded.code).toBe(CODE);
  });
});

describe('code and scheme detection', () => {
  test('other input is treated as literal code', async () => {
    const code = 'const x = 1;\nconsole.log(x);\n';

    const loaded = await loadSource(code, configFor(await makeRoot()));

    expect(loaded.kind).toBe('code');
    expect(loaded.label).toBe('<code>');
    expect(loaded.code).toBe(code);
    expect(loaded.bytes).toBe(Buffer.byteLength(code));
  });

  test('js-looking strings without a separator stay code', async () => {
    const root = await makeRoot();

    const loaded = await loadSource('bundle.js', configFor(root));

    expect(loaded.kind).toBe('code');
    expect(loaded.code).toBe('bundle.js');
  });

  test('multiline js-looking strings stay code', async () => {
    const root = await makeRoot();
    const code = 'const a = 1;\n// bundle.js\n';

    const loaded = await loadSource(code, configFor(root));

    expect(loaded.kind).toBe('code');
  });

  test.each([
    'data:text/plain,hello',
    'file:///tmp/bundle.js',
    'ftp://example.com/bundle.js',
  ])('unsupported scheme fails: %s', async (source) => {
    const message = await loadError(source, configFor(await makeRoot()));

    expect(message).toContain('Unsupported URL scheme');
    expect(message).toContain('http(s)');
  });
});
