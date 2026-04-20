/**
 * Unit tests for `removeWithRetry`.
 *
 * The function is a thin retry loop around `fs.promises.rm({ recursive:
 * true, force: true })`, so tests cover the retry surface only - the tree
 * walk itself is Node's responsibility and is exercised by the real-fs
 * integration points (worktree-manager, node-modules-link).
 *
 *   - ENOENT is absorbed by `force: true` so a missing path resolves
 *   - Happy path: one `fs.rm` call, resolves
 *   - Transient failure then success: retries honored
 *   - Exhaustion: last error is rethrown after the full 0/100/500ms schedule
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFsRm } = vi.hoisted(() => ({
  mockFsRm: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    promises: {
      rm: (path: string, options: unknown) => mockFsRm(path, options),
    },
  },
}));

import { removeWithRetry } from '../../src/main/git/rm-with-retry';

function eperm(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EPERM' }) as NodeJS.ErrnoException;
}

describe('removeWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on the first attempt when fs.rm succeeds', async () => {
    mockFsRm.mockResolvedValue(undefined);

    await expect(removeWithRetry('/tmp/target')).resolves.toBeUndefined();

    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(mockFsRm).toHaveBeenCalledWith(
      '/tmp/target',
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('retries on transient errors and succeeds within the retry budget', async () => {
    vi.useFakeTimers();
    mockFsRm
      .mockRejectedValueOnce(eperm('transient lock 1'))
      .mockRejectedValueOnce(eperm('transient lock 2'))
      .mockResolvedValueOnce(undefined);

    const resultPromise = removeWithRetry('/tmp/flaky');

    // Attempt 1 fires immediately (0ms), attempt 2 after 100ms, attempt 3 after 500ms.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toBeUndefined();
    expect(mockFsRm).toHaveBeenCalledTimes(3);
  });

  it('resolves without retrying when the path is already gone (ENOENT absorbed by force:true)', async () => {
    // `fs.promises.rm({ force: true })` silences ENOENT internally - the mock
    // simulates this by resolving immediately, which is the behaviour Node
    // produces for a missing path with `force: true`. This test documents the
    // claim made in the file header and guards against accidentally removing
    // `force: true` from the options object.
    mockFsRm.mockResolvedValue(undefined);

    await expect(removeWithRetry('/does/not/exist')).resolves.toBeUndefined();

    // Resolved on the first attempt - no retries needed for a missing path.
    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(mockFsRm).toHaveBeenCalledWith(
      '/does/not/exist',
      expect.objectContaining({ force: true }),
    );
  });

  it('rethrows the last error after exhausting all retry attempts', async () => {
    vi.useFakeTimers();
    mockFsRm.mockRejectedValue(eperm('persistent lock'));

    const resultPromise = removeWithRetry('/tmp/locked');
    // Silence unhandled-rejection warnings while we drive timers.
    resultPromise.catch(() => {});

    // Drive the full 0 + 100 + 500 = 600 ms schedule.
    await vi.advanceTimersByTimeAsync(600);

    await expect(resultPromise).rejects.toThrow(/persistent lock/);
    expect(mockFsRm).toHaveBeenCalledTimes(3);
  });
});
