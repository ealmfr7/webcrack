import type IsolatedVM from 'isolated-vm-shared';
import { expect, test, vi } from 'vitest';
import { createNodeSandbox } from '../vm';

// Observe disposal by wrapping the real Isolate and counting dispose() calls.
// The wrapper delegates everything, so behavior is identical.
const mocks = vi.hoisted(() => ({ disposeCount: 0 }));
vi.mock('isolated-vm-6', async (importOriginal) => {
  const actual = await importOriginal<{
    Isolate: typeof IsolatedVM.Isolate;
    default: typeof IsolatedVM;
  }>();
  class CountingIsolate extends actual.Isolate {
    override dispose(): void {
      mocks.disposeCount++;
      super.dispose();
    }
  }
  return {
    ...actual,
    Isolate: CountingIsolate,
    default: { ...actual.default, Isolate: CountingIsolate },
  };
});

test('evaluates code with default limits', async () => {
  const sandbox = createNodeSandbox();
  await expect(sandbox('1 + 2')).resolves.toBe(3);
  await expect(sandbox('({ a: [1, 2] })')).resolves.toEqual({ a: [1, 2] });
});

test('rejects infinite loops within the configured timeout', async () => {
  const sandbox = createNodeSandbox({ timeout: 200 });
  const start = Date.now();
  await expect(sandbox('while (true) {}')).rejects.toThrow(/timed out/);
  // Well below the 10s default: proves the per-evaluation timeout applies.
  expect(Date.now() - start).toBeLessThan(10_000);
});

test('rejects allocations beyond memoryLimit', async () => {
  const sandbox = createNodeSandbox({ memoryLimit: 8 });
  await expect(sandbox('new ArrayBuffer(64 * 1024 * 1024)')).rejects.toThrow(
    /Array buffer allocation failed/,
  );
});

test('survives heap exhaustion that disposes the isolate', async () => {
  const sandbox = createNodeSandbox({ memoryLimit: 8 });
  await expect(
    sandbox(
      'let a = []; for (let i = 0; i < 50; i++) { a.push(new Array(1e6).fill(0)); }',
    ),
  ).rejects.toThrow(/memory limit/);
  // Cleanup must not touch the already-disposed isolate; next call works.
  await expect(sandbox('1 + 2')).resolves.toBe(3);
});

test('disposes the isolate after each call', async () => {
  const sandbox = createNodeSandbox({ timeout: 200 });
  mocks.disposeCount = 0;
  await sandbox('1 + 2');
  await sandbox('3 + 4');
  expect(mocks.disposeCount).toBe(2);

  // Failures dispose too, and the sandbox stays usable afterwards.
  await expect(sandbox('while (true) {}')).rejects.toThrow(/timed out/);
  expect(mocks.disposeCount).toBe(3);
  await expect(sandbox('1 + 2')).resolves.toBe(3);
  expect(mocks.disposeCount).toBe(4);
});

test('repeated calls do not leak isolates', async () => {
  const sandbox = createNodeSandbox({ memoryLimit: 16 });
  for (let i = 0; i < 25; i++) {
    await expect(sandbox(`new Array(1e6).fill(0); ${i}`)).resolves.toBe(i);
  }
});
