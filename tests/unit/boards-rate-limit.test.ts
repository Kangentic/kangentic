/**
 * Unit tests for src/main/boards/shared/rate-limit.ts
 *
 * Uses vi.useFakeTimers() so the test suite never actually sleeps.
 *
 * Pattern: use Promise.all([resultPromise, vi.runAllTimersAsync()]) so that
 * timer advancement runs concurrently with the promise chain. This prevents
 * unhandled rejection warnings that occur when timers fire and work() throws
 * before withBackoff's try-catch has a chance to consume the rejection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withBackoff } from '../../src/main/boards/shared/rate-limit';

/**
 * Helper that runs a withBackoff call to completion while simultaneously
 * advancing fake timers. Returns the settled result (value or thrown error).
 */
async function runWithFakeTimers<T>(
  resultPromise: Promise<T>,
): Promise<{ success: true; value: T } | { success: false; error: unknown }> {
  const [settled] = await Promise.all([
    resultPromise.then(
      (value) => ({ success: true as const, value }),
      (error: unknown) => ({ success: false as const, error }),
    ),
    vi.runAllTimersAsync(),
  ]);
  return settled;
}

describe('withBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result immediately on first-try success', async () => {
    const work = vi.fn().mockResolvedValue('ok');
    const settled = await runWithFakeTimers(withBackoff(work));
    expect(settled.success).toBe(true);
    if (settled.success) expect(settled.value).toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and returns second-try result', async () => {
    let callCount = 0;
    const work = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('transient');
      return 'recovered';
    });

    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 3, initialDelayMs: 100 }),
    );
    expect(settled.success).toBe(true);
    if (settled.success) expect(settled.value).toBe('recovered');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting maxAttempts', async () => {
    const work = vi.fn().mockImplementation(async () => {
      throw new Error('always fails');
    });

    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 3, initialDelayMs: 100 }),
    );
    expect(settled.success).toBe(false);
    if (!settled.success) expect((settled.error as Error).message).toBe('always fails');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('throws immediately when shouldRetry returns false', async () => {
    const work = vi.fn().mockImplementation(async () => {
      throw new Error('fatal');
    });
    const shouldRetry = vi.fn().mockReturnValue(false);

    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 5, shouldRetry }),
    );
    expect(settled.success).toBe(false);
    if (!settled.success) expect((settled.error as Error).message).toBe('fatal');
    // Called once; shouldRetry was consulted but returned false so no retry occurred.
    expect(work).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('respects shouldRetry selectively (retries once then stops)', async () => {
    const errorMessages = ['retry-me', 'stop-here'];
    let callIndex = 0;
    const work = vi.fn().mockImplementation(async () => {
      throw new Error(errorMessages[callIndex++]);
    });
    // Only retry the first error; stop on the second.
    const shouldRetry = vi.fn().mockImplementation((_error: unknown, attempt: number) => attempt < 2);

    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 5, initialDelayMs: 50, shouldRetry }),
    );
    expect(settled.success).toBe(false);
    if (!settled.success) expect((settled.error as Error).message).toBe('stop-here');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('caps delay at maxDelayMs (all timers resolve without hanging)', async () => {
    // Runs 5 attempts with maxDelayMs=600. Exponential growth without the cap
    // would reach 500*2^4 = 8000ms on the last retry. With the cap, all delays
    // are <=600ms and fake timers advance them cleanly.
    const work = vi.fn().mockImplementation(async () => {
      throw new Error('always');
    });
    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 5, initialDelayMs: 500, maxDelayMs: 600 }),
    );
    expect(settled.success).toBe(false);
    if (!settled.success) expect((settled.error as Error).message).toBe('always');
    expect(work).toHaveBeenCalledTimes(5);
  });

  it('uses default options when none are provided (maxAttempts=3)', async () => {
    const work = vi.fn().mockImplementation(async () => {
      throw new Error('default');
    });
    const settled = await runWithFakeTimers(withBackoff(work));
    expect(settled.success).toBe(false);
    expect(work).toHaveBeenCalledTimes(3);
  });

  describe('retryAfterMs', () => {
    /** Run a withBackoff call that fails once then succeeds, recording each sleep's duration. */
    async function sleptDurations(options: Parameters<typeof withBackoff>[1]): Promise<number[]> {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      let callCount = 0;
      const work = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('rate limited');
        return 'ok';
      });
      const settled = await runWithFakeTimers(withBackoff(work, options));
      expect(settled.success).toBe(true);
      const durations = timeoutSpy.mock.calls.map((call) => call[1] as number);
      timeoutSpy.mockRestore();
      return durations;
    }

    it('clamps the server-requested wait to maxDelayMs', async () => {
      const durations = await sleptDurations({
        initialDelayMs: 100,
        maxDelayMs: 500,
        retryAfterMs: () => 60_000,
      });
      expect(durations).toEqual([500]);
    });

    it('uses the server-requested wait when it is under maxDelayMs', async () => {
      const durations = await sleptDurations({
        initialDelayMs: 100,
        maxDelayMs: 5_000,
        retryAfterMs: () => 1_234,
      });
      expect(durations).toEqual([1_234]);
    });

    it('falls back to the exponential delay when retryAfterMs returns undefined', async () => {
      const durations = await sleptDurations({
        initialDelayMs: 100,
        maxDelayMs: 5_000,
        retryAfterMs: () => undefined,
      });
      // First retry is attempt 1: initialDelayMs * 2^0.
      expect(durations).toEqual([100]);
    });

    it('doubles the fallback delay on each later attempt', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const work = vi.fn().mockImplementation(async () => {
        throw new Error('always');
      });
      const settled = await runWithFakeTimers(
        withBackoff(work, { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 5_000, retryAfterMs: () => undefined }),
      );
      expect(settled.success).toBe(false);
      expect(timeoutSpy.mock.calls.map((call) => call[1])).toEqual([100, 200]);
      timeoutSpy.mockRestore();
    });

    it('consults retryAfterMs with the thrown error', async () => {
      const thrown = new Error('429');
      const retryAfterMs = vi.fn().mockReturnValue(10);
      let callCount = 0;
      const work = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) throw thrown;
        return 'ok';
      });
      const settled = await runWithFakeTimers(withBackoff(work, { retryAfterMs }));
      expect(settled.success).toBe(true);
      expect(retryAfterMs).toHaveBeenCalledTimes(1);
      expect(retryAfterMs).toHaveBeenCalledWith(thrown);
    });
  });

  it('passes the attempt number to shouldRetry', async () => {
    const capturedAttempts: number[] = [];
    const work = vi.fn().mockImplementation(async () => {
      throw new Error('fail');
    });
    const shouldRetry = vi.fn().mockImplementation((_error: unknown, attempt: number) => {
      capturedAttempts.push(attempt);
      return attempt < 3;
    });

    const settled = await runWithFakeTimers(
      withBackoff(work, { maxAttempts: 5, initialDelayMs: 10, shouldRetry }),
    );
    expect(settled.success).toBe(false);
    // Attempts 1 and 2 were retried; attempt 3 triggered shouldRetry=false.
    expect(capturedAttempts).toEqual([1, 2, 3]);
  });
});
