/**
 * Unit tests for `removeWithRetry`.
 *
 * The function is a two-layer retry around `fs.promises.rm({ recursive:
 * true, force: true })`. Tests cover the outer retry loop and the options
 * forwarded to `fs.rm` (Node's inner per-file retry is its own
 * responsibility). The tree walk itself is exercised by the real-fs
 * integration points (worktree-manager, node-modules-link).
 *
 * Locks in the retry budget that stabilizes
 * tests/e2e/bulk-delete-worktrees.spec.ts on Windows. The E2E test cannot
 * deterministically reproduce the race; this unit test does.
 *
 *   - Happy path: one `fs.rm` call, resolves, options forwarded
 *   - Transient failure then success: retries honored
 *   - ENOENT absorbed by `force: true`
 *   - Exhaustion: last error is rethrown after the full
 *     0/200/500/1000/2000ms schedule (5 outer attempts)
 *
 * The second half covers BUDGETED mode (`budgetMs`), where one wall clock owns
 * the call: Node's per-path retry is off and this loop drives every retry until
 * the deadline. The unbudgeted cases above are also the guard that adding the
 * mode changed nothing for callers that do not pass a budget.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFsRm } = vi.hoisted(() => ({
  mockFsRm: vi.fn(),
}));

// Mock the helper's `original-fs` boundary directly. Mocking `node:fs`
// would only work transitively (original-fs.ts falls back to node:fs in
// vitest where the Electron `original-fs` package is absent), and that
// indirection breaks if the fallback ever changes.
vi.mock('../../src/main/git/original-fs', () => ({
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

  it('resolves on the first attempt and forwards inner-retry options to fs.rm', async () => {
    mockFsRm.mockResolvedValue(undefined);

    await expect(removeWithRetry('/tmp/target')).resolves.toBeUndefined();

    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(mockFsRm).toHaveBeenCalledWith(
      '/tmp/target',
      expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    );
  });

  it('retries on transient errors and succeeds within the retry budget', async () => {
    vi.useFakeTimers();
    mockFsRm
      .mockRejectedValueOnce(eperm('transient lock 1'))
      .mockRejectedValueOnce(eperm('transient lock 2'))
      .mockRejectedValueOnce(eperm('transient lock 3'))
      .mockResolvedValueOnce(undefined);

    const resultPromise = removeWithRetry('/tmp/flaky');

    // Schedule: 0 / 200 / 500 / 1000 / 2000 ms between attempts.
    // Drain the queue so each scheduled retry fires.
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBeUndefined();
    expect(mockFsRm).toHaveBeenCalledTimes(4);
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

  it('fast mode (delays:[0], innerMaxRetries:0) attempts exactly once with no inner retries', async () => {
    mockFsRm.mockRejectedValue(eperm('locked'));

    const resultPromise = removeWithRetry('/tmp/locked', { delays: [0], innerMaxRetries: 0 });
    resultPromise.catch(() => {});

    await expect(resultPromise).rejects.toThrow(/locked/);
    // Single outer attempt, and inner per-file retries disabled.
    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(mockFsRm).toHaveBeenCalledWith(
      '/tmp/locked',
      expect.objectContaining({ recursive: true, force: true, maxRetries: 0 }),
    );
  });

  it('rethrows the last error after exhausting all retry attempts', async () => {
    vi.useFakeTimers();
    mockFsRm.mockRejectedValue(eperm('persistent lock'));

    const resultPromise = removeWithRetry('/tmp/locked');
    // Silence unhandled-rejection warnings while we drive timers.
    resultPromise.catch(() => {});

    // Drive the full schedule: 0 + 200 + 500 + 1000 + 2000 = 3700 ms.
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(/persistent lock/);
    // Five outer attempts in [0, 200, 500, 1000, 2000].
    expect(mockFsRm).toHaveBeenCalledTimes(5);
  });
});

/**
 * Budgeted mode. The bug this closes: without a clock the ceiling scales with
 * the TREE, because Node applies `{ maxRetries, retryDelay }` per locked path.
 * One observed worktree removal ground for 402716ms while it held the
 * per-project git queue.
 */
describe('removeWithRetry - budgeted mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables Node per-file retry so this loop owns the whole clock', async () => {
    mockFsRm.mockResolvedValue(undefined);

    await expect(removeWithRetry('/tmp/target', { budgetMs: 30_000 })).resolves.toBeUndefined();

    // Exact match, not objectContaining: `retryDelay` must be ABSENT. A
    // surviving inner ladder is what makes the bound soft, since a single
    // `fs.rm` pass could then outlive the deadline by seconds per locked path.
    expect(mockFsRm).toHaveBeenCalledWith('/tmp/target', {
      recursive: true,
      force: true,
      maxRetries: 0,
    });
  });

  it('gives up at the deadline with a typed timeout carrying the last errno error', async () => {
    vi.useFakeTimers();
    mockFsRm.mockRejectedValue(eperm('persistent lock'));

    const resultPromise = removeWithRetry('/tmp/locked', { budgetMs: 5_000 });
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(20_000);

    const error = await resultPromise.catch((thrown: unknown) => thrown) as Error & {
      budgetMs: number;
      cause: NodeJS.ErrnoException;
    };
    expect(error.name).toBe('WorktreeRemovalTimeoutError');
    expect(error.message).toMatch(/gave up on \/tmp\/locked/);
    expect(error.budgetMs).toBe(5_000);
    // The cause is the diagnostic the caller logs; the timeout itself only
    // says that we stopped.
    expect(error.cause.code).toBe('EPERM');
  });

  it('keeps retrying past the five-entry ladder, saturating at its last delay', async () => {
    vi.useFakeTimers();
    mockFsRm.mockRejectedValue(eperm('persistent lock'));

    const resultPromise = removeWithRetry('/tmp/locked', { budgetMs: 30_000 });
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(40_000);

    await expect(resultPromise).rejects.toMatchObject({ name: 'WorktreeRemovalTimeoutError' });
    // Unbudgeted mode stops at five. A 30s budget with the ladder saturating at
    // 2000ms is many more passes than that, which is what replaces the per-path
    // retry coverage the mode gives up.
    expect(mockFsRm.mock.calls.length).toBeGreaterThan(5);
  });

  it('does not sleep past the deadline', async () => {
    vi.useFakeTimers();
    mockFsRm.mockRejectedValue(eperm('locked'));

    // Budget 100ms. The first attempt runs immediately; the next ladder delay
    // is 200ms, which would overrun, so it is skipped rather than waited out.
    const resultPromise = removeWithRetry('/tmp/locked', { budgetMs: 100 });
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5_000);

    const error = await resultPromise.catch((thrown: unknown) => thrown) as Error & {
      elapsedMs: number;
    };
    expect(error.name).toBe('WorktreeRemovalTimeoutError');
    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(error.elapsedMs).toBeLessThan(200);
  });

  it('attempts once even when the budget is already spent', async () => {
    mockFsRm.mockResolvedValue(undefined);

    await expect(removeWithRetry('/tmp/target', { budgetMs: 0 })).resolves.toBeUndefined();

    expect(mockFsRm).toHaveBeenCalledTimes(1);
  });
});
