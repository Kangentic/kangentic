/**
 * Unit tests for SessionQueue -- the reentrancy-safe concurrency queue
 * that manages session spawning order and slot limits.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionQueue, type QueueGate } from '../../src/main/pty/session-queue';
import type { SpawnSessionInput } from '../../src/shared/types';

function makeQueueInput(taskId: string, id: string): SpawnSessionInput & { id: string } {
  return { id, taskId, command: 'mock-claude', cwd: '/tmp' };
}

describe('SessionQueue', () => {
  it('enqueue adds entries and length reflects them', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 0,
      maxConcurrent: 5,
    });
    queue.enqueue(makeQueueInput('t1', 'sess-1'));
    queue.enqueue(makeQueueInput('t2', 'sess-2'));
    expect(queue.length).toBe(2);
  });

  it('remove returns true when found, false when not', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 5, // at limit, so enqueue won't trigger processQueue
      maxConcurrent: 5,
    });
    queue.enqueue(makeQueueInput('t1', 'sess-1'));

    expect(queue.remove('sess-1')).toBe(true);
    expect(queue.length).toBe(0);
    expect(queue.remove('sess-nonexistent')).toBe(false);
  });

  it('shouldQueue returns true when active >= max', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 3,
      maxConcurrent: 3,
    });
    expect(queue.shouldQueue()).toBe(true);
  });

  it('shouldQueue returns false when active < max', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 2,
      maxConcurrent: 3,
    });
    expect(queue.shouldQueue()).toBe(false);
  });

  it('notifySlotFreed calls spawner for queued entry', async () => {
    const spawner = vi.fn().mockResolvedValue(undefined);
    let active = 1;
    const queue = new SessionQueue({
      spawner,
      getActiveCount: () => active,
      maxConcurrent: 2,
    });
    queue.enqueue(makeQueueInput('t1', 'sess-1'));
    queue.notifySlotFreed();

    // Give the async processQueue a tick to complete
    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
    expect(spawner).toHaveBeenCalledWith(makeQueueInput('t1', 'sess-1'));
    expect(queue.length).toBe(0);
  });

  it('notifySlotFreed respects concurrency limit', async () => {
    const spawner = vi.fn().mockResolvedValue(undefined);
    let active = 2;
    const queue = new SessionQueue({
      spawner,
      // After each spawn, active increases
      getActiveCount: () => active,
      maxConcurrent: 3,
    });
    spawner.mockImplementation(async () => { active++; });

    queue.enqueue(makeQueueInput('t1', 'sess-1'));
    queue.enqueue(makeQueueInput('t2', 'sess-2'));
    queue.enqueue(makeQueueInput('t3', 'sess-3'));
    queue.notifySlotFreed();

    // Only 1 slot open (active=2, max=3), so only 1 should spawn
    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
    // After spawning, active=3 -- remaining 2 stay queued
    expect(queue.length).toBe(2);
  });

  it('setMaxConcurrent triggers promotion', async () => {
    const spawner = vi.fn().mockResolvedValue(undefined);
    let active = 2;
    const queue = new SessionQueue({
      spawner,
      getActiveCount: () => active,
      maxConcurrent: 2,
    });
    queue.enqueue(makeQueueInput('t1', 'sess-1'));

    // Raise limit -- should trigger promotion
    queue.setMaxConcurrent(3);

    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
    expect(queue.length).toBe(0);
  });

  it('clear empties the queue', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 5,
      maxConcurrent: 5,
    });
    queue.enqueue(makeQueueInput('t1', 'sess-1'));
    queue.enqueue(makeQueueInput('t2', 'sess-2'));
    queue.enqueue(makeQueueInput('t3', 'sess-3'));

    queue.clear();
    expect(queue.length).toBe(0);
  });

  it('failed spawn does not stall queue -- next entry still processes', async () => {
    const spawner = vi.fn();
    const queue = new SessionQueue({
      spawner,
      getActiveCount: () => 0,
      maxConcurrent: 5,
    });

    spawner.mockRejectedValueOnce(new Error('spawn failed'));
    spawner.mockResolvedValueOnce(undefined);

    queue.enqueue(makeQueueInput('t-fail', 'sess-fail'));
    queue.enqueue(makeQueueInput('t-ok', 'sess-ok'));
    queue.notifySlotFreed();

    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(2));
    expect(spawner).toHaveBeenNthCalledWith(1, makeQueueInput('t-fail', 'sess-fail'));
    expect(spawner).toHaveBeenNthCalledWith(2, makeQueueInput('t-ok', 'sess-ok'));
    expect(queue.length).toBe(0);
  });

  it('reentrancy guard: concurrent notifySlotFreed does not over-spawn', async () => {
    const spawnOrder: string[] = [];
    let active = 0;
    let resolveFirst: (() => void) | null = null;

    const spawner = vi.fn().mockImplementation(async (input: SpawnSessionInput) => {
      active++;
      spawnOrder.push(input.taskId);
      if (input.taskId === 't1') {
        // First spawn blocks until we release it
        await new Promise<void>((resolve) => { resolveFirst = resolve; });
      }
    });

    const queue = new SessionQueue({
      spawner,
      getActiveCount: () => active,
      maxConcurrent: 2,
    });

    queue.enqueue(makeQueueInput('t1', 'sess-1'));
    queue.enqueue(makeQueueInput('t2', 'sess-2'));
    queue.enqueue(makeQueueInput('t3', 'sess-3'));

    // Fire two concurrent notifySlotFreed calls
    queue.notifySlotFreed();
    queue.notifySlotFreed(); // should set _dirty, not start a second loop

    // Wait for first spawn to start
    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
    expect(active).toBe(1);

    // Release the first spawn -- loop continues with _dirty re-check
    resolveFirst!();

    // Should spawn t2 (active=1 < max=2), then stop (active=2 >= max=2)
    await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(2));
    expect(active).toBe(2);
    expect(queue.length).toBe(1); // t3 still queued
    expect(spawnOrder).toEqual(['t1', 't2']);
  });

  it('maxConcurrentSessions getter reflects current limit', () => {
    const queue = new SessionQueue({
      spawner: vi.fn(),
      getActiveCount: () => 0,
      maxConcurrent: 7,
    });
    expect(queue.maxConcurrentSessions).toBe(7);
    queue.setMaxConcurrent(3);
    expect(queue.maxConcurrentSessions).toBe(3);
  });

  describe('with a gate', () => {
    const allow: QueueGate = { mustWait: () => false, pick: () => 0, countBlocked: () => 0 };

    it('a blocked head does not hold up the entries behind it', async () => {
      const spawner = vi.fn().mockResolvedValue(undefined);
      const queue = new SessionQueue({ spawner, getActiveCount: () => 0, maxConcurrent: 5 });
      queue.setGate({
        ...allow,
        pick: (queued) => queued.findIndex((input) => input.taskId !== 'blocked'),
      });
      queue.enqueue(makeQueueInput('blocked', 'sess-blocked'));
      queue.enqueue(makeQueueInput('free', 'sess-free'));

      queue.notifySlotFreed();

      await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
      expect(spawner).toHaveBeenCalledWith(makeQueueInput('free', 'sess-free'));
      expect(queue.entries.map((input) => input.taskId)).toEqual(['blocked']);
    });

    it('stops without spinning when nothing can start', async () => {
      const spawner = vi.fn().mockResolvedValue(undefined);
      const pick = vi.fn(() => -1);
      const queue = new SessionQueue({ spawner, getActiveCount: () => 0, maxConcurrent: 5 });
      queue.setGate({ ...allow, pick });
      queue.enqueue(makeQueueInput('t1', 'sess-1'));

      queue.notifySlotFreed();

      await vi.waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
      expect(spawner).not.toHaveBeenCalled();
      expect(queue.length).toBe(1);
    });

    it('a drain that lands during a spawn still re-checks the gate', async () => {
      let release: (() => void) | null = null;
      let columnOpen = false;
      const spawner = vi.fn().mockImplementation(async (input: SpawnSessionInput) => {
        if (input.taskId === 'first') await new Promise<void>((resolve) => { release = resolve; });
      });
      const queue = new SessionQueue({ spawner, getActiveCount: () => 0, maxConcurrent: 5 });
      queue.setGate({
        ...allow,
        pick: (queued) => queued.findIndex((input) => input.taskId === 'first' || columnOpen),
      });
      queue.enqueue(makeQueueInput('first', 'sess-first'));
      queue.enqueue(makeQueueInput('second', 'sess-second'));

      queue.notifySlotFreed();
      await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
      columnOpen = true;
      queue.notifySlotFreed();
      release!();

      await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(2));
      expect(queue.length).toBe(0);
    });

    it('a throwing pick falls back to the head', async () => {
      const spawner = vi.fn().mockResolvedValue(undefined);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const queue = new SessionQueue({ spawner, getActiveCount: () => 0, maxConcurrent: 5 });
      queue.setGate({ ...allow, pick: () => { throw new Error('database gone'); } });
      queue.enqueue(makeQueueInput('t1', 'sess-1'));

      queue.notifySlotFreed();

      await vi.waitFor(() => expect(spawner).toHaveBeenCalledTimes(1));
      errorLog.mockRestore();
    });

    it('shouldQueue asks the gate only with a global slot free, and a throw admits', () => {
      const mustWait = vi.fn(() => true);
      let active = 3;
      const queue = new SessionQueue({ spawner: vi.fn(), getActiveCount: () => active, maxConcurrent: 3 });
      queue.setGate({ ...allow, mustWait });
      const input = makeQueueInput('t1', 'sess-1');

      expect(queue.shouldQueue(input)).toBe(true);
      expect(mustWait).not.toHaveBeenCalled();

      active = 0;
      expect(queue.shouldQueue(input)).toBe(true);
      expect(mustWait).toHaveBeenCalledTimes(1);

      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      queue.setGate({ ...allow, mustWait: () => { throw new Error('database gone'); } });
      expect(queue.shouldQueue(input)).toBe(false);
      errorLog.mockRestore();
    });

    it('blockedCount reads the gate and costs nothing on an empty queue', () => {
      const countBlocked = vi.fn(() => 1);
      const queue = new SessionQueue({ spawner: vi.fn(), getActiveCount: () => 5, maxConcurrent: 5 });
      queue.setGate({ ...allow, countBlocked });

      expect(queue.blockedCount).toBe(0);
      expect(countBlocked).not.toHaveBeenCalled();

      queue.enqueue(makeQueueInput('t1', 'sess-1'));
      expect(queue.blockedCount).toBe(1);
    });
  });
});
