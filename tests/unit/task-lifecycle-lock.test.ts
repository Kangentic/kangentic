import { describe, it, expect } from 'vitest';
import { withTaskLock, _taskLockCountForTesting } from '../../src/main/ipc/task-lifecycle-lock';

/**
 * Contract tests for withTaskLock - the per-task serialization primitive
 * used across all IPC handlers and helpers that touch per-task lifecycle
 * state. These tests lock in the four properties the rest of the codebase
 * depends on: same-task ordering, cross-task parallelism, error isolation,
 * and bounded Map growth.
 */
describe('withTaskLock', () => {
  it('serializes concurrent calls for the same taskId in submission order', async () => {
    const order: number[] = [];
    const delays = [30, 10, 20];

    // All three calls submitted synchronously (same microtask). Without the
    // lock they would interleave; with it, they must complete in submission
    // order regardless of their internal delays.
    const promises = delays.map((delay, index) =>
      withTaskLock('task-A', async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        order.push(index);
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2]);
  });

  it('runs calls for different taskIds in parallel', async () => {
    // Three different tasks, each with a 50ms hold. If they parallelize, the
    // total wall time is ~50ms. If they serialized incorrectly, it would be
    // ~150ms. The wall-time assertion alone proves parallelism; we use a
    // generous upper bound that tolerates scheduler jitter on slow CI.
    const ranTasks: string[] = [];
    const start = Date.now();

    await Promise.all([
      withTaskLock('task-A', async () => {
        ranTasks.push('A');
        await new Promise(resolve => setTimeout(resolve, 50));
      }),
      withTaskLock('task-B', async () => {
        ranTasks.push('B');
        await new Promise(resolve => setTimeout(resolve, 50));
      }),
      withTaskLock('task-C', async () => {
        ranTasks.push('C');
        await new Promise(resolve => setTimeout(resolve, 50));
      }),
    ]);

    const totalElapsed = Date.now() - start;
    // Serial execution would take ~150ms; parallel ~50ms. 120ms upper bound
    // proves parallelism with comfortable headroom for CI jitter.
    expect(totalElapsed).toBeLessThan(120);
    expect(ranTasks).toHaveLength(3);
  });

  it('a rejecting fn does not poison subsequent calls for the same task', async () => {
    // Record the order in which the fn bodies actually execute (not when
    // .catch handlers fire - those run as chained microtasks after the lock
    // has already released and the next holder has started).
    const bodyOrder: string[] = [];

    const failing = withTaskLock('task-X', async () => {
      bodyOrder.push('failing-body');
      throw new Error('boom');
    });

    const succeeding = withTaskLock('task-X', async () => {
      bodyOrder.push('succeeding-body');
    });

    // Caller still sees the original rejection
    await expect(failing).rejects.toThrow('boom');
    // Subsequent call still runs (chain not poisoned)
    await expect(succeeding).resolves.toBeUndefined();
    expect(bodyOrder).toEqual(['failing-body', 'succeeding-body']);
  });

  it('rejection from fn is delivered to the caller, not swallowed', async () => {
    await expect(
      withTaskLock('task-Y', async () => {
        throw new Error('caller should see this');
      }),
    ).rejects.toThrow('caller should see this');
  });

  it('does not produce unhandledRejection when fn rejects (cleanup branch is safe)', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    try {
      // Fire a rejecting call but DO NOT attach a .catch immediately. We
      // attach it on a later microtask to give any unhandled-rejection
      // tracking time to fire if the cleanup branch is broken.
      const promise = withTaskLock('task-Z', async () => {
        throw new Error('cleanup branch test');
      });
      // Drain microtasks so any unhandled rejection on the cleanup chain
      // would have surfaced by now.
      await new Promise(resolve => setTimeout(resolve, 0));
      // Now handle the actual caller-facing rejection.
      await promise.catch(() => {});

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('drains the lock Map after operations complete (no leak)', async () => {
    const before = _taskLockCountForTesting();

    await Promise.all([
      withTaskLock('drain-A', async () => {}),
      withTaskLock('drain-B', async () => {}),
      withTaskLock('drain-C', async () => {}),
    ]);

    // Allow the cleanup .finally to run
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(_taskLockCountForTesting()).toBe(before);
  });

  it('keeps the lock Map populated while a chain is still in flight', async () => {
    const before = _taskLockCountForTesting();
    let releaseFirst!: () => void;
    const firstHolder = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withTaskLock('inflight', async () => {
      await firstHolder;
    });

    // While the first call is held, a second call queues - the Map must
    // contain an entry for this task throughout.
    expect(_taskLockCountForTesting()).toBe(before + 1);

    const second = withTaskLock('inflight', async () => {});
    expect(_taskLockCountForTesting()).toBe(before + 1);

    releaseFirst();
    await Promise.all([first, second]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(_taskLockCountForTesting()).toBe(before);
  });

  it('returns the fn result to the caller', async () => {
    const result = await withTaskLock('task-result', async () => 42);
    expect(result).toBe(42);
  });
});
