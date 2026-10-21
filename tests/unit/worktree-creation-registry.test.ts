/**
 * Unit tests for the worktree creation registry: the in-memory map that keeps a
 * removal, a sweep, or a second creation off a worktree path whose setup (copy,
 * link, Post-Worktree Script) is still running after the git queue was released.
 *
 * The module holds one shared map, so every test uses its own path and ends with
 * nothing in flight. No fake timers: a flush is a trip through setImmediate,
 * which runs after every pending microtask.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  runWorktreeCreation,
  isWorktreeCreationInFlight,
  waitForWorktreeCreation,
} from '../../src/main/git/worktree-creation-registry';

/** A promise the test settles by hand, to hold a creation open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Let every pending microtask (and so every queued waiter) run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A worktree path under the temp dir that no other test in this file uses. Never written to. */
function uniqueWorktreePath(testName: string, folderName = '7'): string {
  return path.join(os.tmpdir(), 'kangentic-creation-registry-test', testName, '.kangentic', 'worktrees', folderName);
}

describe('worktree creation registry', () => {
  it('runs creations on one path one at a time in start order, and tells each waiter it waited', async () => {
    const worktreePath = uniqueWorktreePath('serial');
    const started: string[] = [];
    const waitedFlags: Record<string, boolean> = {};
    const holdA = deferred();
    const holdB = deferred();
    const holdC = deferred();

    const creationA = runWorktreeCreation(worktreePath, undefined, async (waited) => {
      started.push('A');
      waitedFlags.A = waited;
      await holdA.promise;
      return 'result-a';
    });
    const creationB = runWorktreeCreation(worktreePath, undefined, async (waited) => {
      started.push('B');
      waitedFlags.B = waited;
      await holdB.promise;
      return 'result-b';
    });
    const creationC = runWorktreeCreation(worktreePath, undefined, async (waited) => {
      started.push('C');
      waitedFlags.C = waited;
      await holdC.promise;
      return 'result-c';
    });

    // Only A runs while it holds the path.
    await flush();
    expect(started).toEqual(['A']);
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);

    // Releasing A lets exactly one waiter in. B and C both woke on A's release,
    // but B re-checked first and claimed the path; C must see that claim and wait
    // again. Reverting the `while` re-check to an `if` lets C run alongside B.
    holdA.resolve();
    await flush();
    expect(started).toEqual(['A', 'B']);

    holdB.resolve();
    await flush();
    expect(started).toEqual(['A', 'B', 'C']);

    holdC.resolve();
    expect(await Promise.all([creationA, creationB, creationC])).toEqual(['result-a', 'result-b', 'result-c']);
    expect(waitedFlags).toEqual({ A: false, B: true, C: true });
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
  });

  it('keeps creations on different paths independent', async () => {
    const firstPath = uniqueWorktreePath('independent', '7');
    const secondPath = uniqueWorktreePath('independent', '8');
    const holdFirst = deferred();
    let secondWaited: boolean | undefined;

    const firstCreation = runWorktreeCreation(firstPath, undefined, async () => { await holdFirst.promise; });
    const secondCreation = runWorktreeCreation(secondPath, undefined, async (waited) => { secondWaited = waited; });

    await secondCreation;
    expect(secondWaited).toBe(false);
    expect(isWorktreeCreationInFlight(firstPath)).toBe(true);
    expect(isWorktreeCreationInFlight(secondPath)).toBe(false);

    holdFirst.resolve();
    await firstCreation;
    expect(isWorktreeCreationInFlight(firstPath)).toBe(false);
  });

  it('releases the path when a creation rejects: the rejection reaches its caller and the next waiter runs', async () => {
    // Reverting the `finally` (release only on success) would strand every later
    // creation and removal at this path behind a claim nothing resolves.
    const worktreePath = uniqueWorktreePath('rejects');
    const failure = new Error('git phase failed');
    const holdFirst = deferred();
    const waiterWaitedFlags: boolean[] = [];

    const firstCreation = runWorktreeCreation(worktreePath, undefined, async () => {
      await holdFirst.promise;
      throw failure;
    });
    // Attached before the creation can fail, so the rejection is never unhandled.
    const firstOutcome = expect(firstCreation).rejects.toBe(failure);
    const nextCreation = runWorktreeCreation(worktreePath, undefined, async (waited) => {
      waiterWaitedFlags.push(waited);
      return 'next-result';
    });

    await flush();
    expect(waiterWaitedFlags).toEqual([]);
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);

    holdFirst.resolve();
    await firstOutcome;
    expect(await nextCreation).toBe('next-result');
    expect(waiterWaitedFlags).toEqual([true]);
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
  });

  it('releases the path when a creation throws before its first await', async () => {
    const worktreePath = uniqueWorktreePath('sync-throw');
    const failure = new Error('threw synchronously');

    await expect(runWorktreeCreation(worktreePath, undefined, () => { throw failure; })).rejects.toBe(failure);

    expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    expect(await waitForWorktreeCreation(worktreePath)).toBe(false);
  });

  describe('path keys', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    function stubPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: platform });
    }

    afterEach(() => {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    });

    it('treats paths that differ only in letter case as one key on win32', async () => {
      // The key is computed when each call is entered, so the stub is active before
      // either creation starts. Reverting the win32 lower-casing in creationKey
      // would let a second creation (or a removal) for the other-cased spelling of
      // a live worktree through.
      const lowerCasePath = path.join(os.tmpdir(), 'kangentic-creation-registry-test', 'win32-case', '.kangentic', 'worktrees', 'task-7');
      const upperCasePath = path.join(os.tmpdir(), 'KANGENTIC-Creation-Registry-Test', 'WIN32-Case', '.Kangentic', 'Worktrees', 'TASK-7');
      stubPlatform('win32');
      const holdFirst = deferred();
      const secondStarted = vi.fn();

      const firstCreation = runWorktreeCreation(lowerCasePath, undefined, async () => { await holdFirst.promise; });
      expect(isWorktreeCreationInFlight(upperCasePath)).toBe(true);

      const secondCreation = runWorktreeCreation(upperCasePath, undefined, async (waited) => {
        secondStarted(waited);
      });
      await flush();
      expect(secondStarted).not.toHaveBeenCalled();

      holdFirst.resolve();
      await Promise.all([firstCreation, secondCreation]);
      expect(secondStarted).toHaveBeenCalledWith(true);
      expect(isWorktreeCreationInFlight(upperCasePath)).toBe(false);
      expect(isWorktreeCreationInFlight(lowerCasePath)).toBe(false);
    });

    it('keeps paths that differ only in letter case apart off win32', async () => {
      // The lower-casing is win32-only: POSIX file systems are case-sensitive, so
      // two spellings are two different directories. Reverting it to unconditional
      // would make a creation of `Task-7` wait on an unrelated `task-7`.
      const lowerCasePath = path.join(os.tmpdir(), 'kangentic-creation-registry-test', 'posix-case', '.kangentic', 'worktrees', 'task-7');
      const upperCasePath = path.join(os.tmpdir(), 'kangentic-creation-registry-test', 'posix-case', '.kangentic', 'worktrees', 'TASK-7');
      stubPlatform('linux');
      const holdFirst = deferred();
      let secondWaited: boolean | undefined;

      const firstCreation = runWorktreeCreation(lowerCasePath, undefined, async () => { await holdFirst.promise; });
      expect(isWorktreeCreationInFlight(upperCasePath)).toBe(false);

      await runWorktreeCreation(upperCasePath, undefined, async (waited) => { secondWaited = waited; });
      expect(secondWaited).toBe(false);
      expect(isWorktreeCreationInFlight(lowerCasePath)).toBe(true);

      holdFirst.resolve();
      await firstCreation;
      expect(isWorktreeCreationInFlight(lowerCasePath)).toBe(false);
    });
  });

  describe('waitForWorktreeCreation', () => {
    it('resolves false at once when nothing is in flight', async () => {
      const worktreePath = uniqueWorktreePath('wait-idle');

      expect(await waitForWorktreeCreation(worktreePath)).toBe(false);

      await runWorktreeCreation(worktreePath, undefined, async () => undefined);
      expect(await waitForWorktreeCreation(worktreePath)).toBe(false);
    });

    it('resolves true only after the running creation and the one queued behind it have both ended', async () => {
      // B is queued behind A before the waiter arrives, so when A releases B claims
      // the path first and the waiter must keep waiting. Reverting the `while` in
      // waitForWorktreeCreation to a single await resolves it after A alone, and a
      // removal would then run against B's half-made worktree.
      const worktreePath = uniqueWorktreePath('wait-chain');
      const holdA = deferred();
      const holdB = deferred();
      const startedCreations: string[] = [];

      const creationA = runWorktreeCreation(worktreePath, undefined, async () => {
        startedCreations.push('A');
        await holdA.promise;
      });
      const creationB = runWorktreeCreation(worktreePath, undefined, async () => {
        startedCreations.push('B');
        await holdB.promise;
      });
      await flush();

      let waiterResult: boolean | undefined;
      const waiter = waitForWorktreeCreation(worktreePath).then((waited) => { waiterResult = waited; });
      await flush();
      expect(waiterResult).toBeUndefined();

      holdA.resolve();
      await creationA;
      await flush();
      // B has taken over the path; the waiter is still pending.
      expect(startedCreations).toEqual(['A', 'B']);
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);
      expect(waiterResult).toBeUndefined();

      holdB.resolve();
      await creationB;
      await waiter;
      expect(waiterResult).toBe(true);
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    });
  });

  describe('abort while waiting', () => {
    it('rejects with the signal\'s reason, never runs the creation, and leaves the running one alone', async () => {
      // Reverting the abort check around the wait would run the superseded
      // creation once the first one released the path.
      const worktreePath = uniqueWorktreePath('abort-waiter');
      const holdFirst = deferred();
      const abortReason = new Error('superseded by a newer move');
      const controller = new AbortController();
      const waiterCreation = vi.fn(async () => 'waiter-result');

      const firstCreation = runWorktreeCreation(worktreePath, undefined, async () => {
        await holdFirst.promise;
        return 'first-result';
      });
      const waiterOutcome = expect(runWorktreeCreation(worktreePath, controller.signal, waiterCreation)).rejects.toBe(abortReason);
      await flush();

      controller.abort(abortReason);
      await waiterOutcome;

      expect(waiterCreation).not.toHaveBeenCalled();
      // The first creation still owns the path, and the aborted waiter claimed nothing.
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);

      holdFirst.resolve();
      expect(await firstCreation).toBe('first-result');
      expect(waiterCreation).not.toHaveBeenCalled();
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);

      // The path is free for a later creation, which did not have to wait.
      let laterWaited: boolean | undefined;
      await runWorktreeCreation(worktreePath, undefined, async (waited) => { laterWaited = waited; });
      expect(laterWaited).toBe(false);
    });

    it('does not run a waiter whose signal aborts in the turn the path is released', async () => {
      // The release resolves the waiter's wait, and the abort lands before the
      // waiter resumes, so the path already reads free when it does. The abort
      // check that follows the wait is all that stops the creation. Reverting it
      // runs the superseded creation on a path the newer move is about to take.
      const worktreePath = uniqueWorktreePath('abort-at-release');
      const holdFirst = deferred();
      const abortReason = new Error('superseded as the path freed');
      const controller = new AbortController();
      const waiterCreation = vi.fn(async () => 'waiter-result');

      const firstCreation = runWorktreeCreation(worktreePath, undefined, async () => { await holdFirst.promise; });
      // Waits on the first creation's release ahead of the waiter, so the order
      // of the release's wake-ups is: this aborter, then the waiter's wait ends,
      // then the aborter's abort, then the waiter resumes.
      const aborter = waitForWorktreeCreation(worktreePath).then(() => controller.abort(abortReason));
      const waiterOutcome = expect(runWorktreeCreation(worktreePath, controller.signal, waiterCreation)).rejects.toBe(abortReason);
      await flush();

      holdFirst.resolve();
      await firstCreation;
      await aborter;
      await waiterOutcome;

      expect(waiterCreation).not.toHaveBeenCalled();
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    });

    it('rejects at once, without listening, when the signal is already aborted and the path is held', async () => {
      const worktreePath = uniqueWorktreePath('abort-before-wait');
      const holdFirst = deferred();
      const abortReason = new Error('already superseded');
      const controller = new AbortController();
      controller.abort(abortReason);
      const addListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
      const waiterCreation = vi.fn(async () => 'waiter-result');

      const firstCreation = runWorktreeCreation(worktreePath, undefined, async () => { await holdFirst.promise; });
      let waiterSettled = false;
      const waiterOutcome = runWorktreeCreation(worktreePath, controller.signal, waiterCreation)
        .then(() => undefined, (error: unknown) => error)
        .finally(() => { waiterSettled = true; });
      // Settled while the first creation still holds the path: the pre-aborted
      // signal ended the wait before it began. Reverting the throwIfAborted() at
      // the top of the wait loop would park the waiter behind the first creation.
      await flush();
      expect(waiterSettled).toBe(true);
      expect(await waiterOutcome).toBe(abortReason);

      expect(waiterCreation).not.toHaveBeenCalled();
      expect(addListenerSpy).not.toHaveBeenCalled();
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);

      holdFirst.resolve();
      await firstCreation;
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    });

    it('removes the waiter\'s abort listener when the held creation settles without an abort', async () => {
      // Reverting the removeEventListener in the settle callback would leave one
      // listener per waited-on creation on a long-lived signal.
      const worktreePath = uniqueWorktreePath('listener-removed');
      const holdFirst = deferred();
      const controller = new AbortController();
      const addListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const waiterCreation = vi.fn(async () => 'waiter-result');

      const firstCreation = runWorktreeCreation(worktreePath, undefined, async () => { await holdFirst.promise; });
      const waiterOutcome = runWorktreeCreation(worktreePath, controller.signal, waiterCreation);
      await flush();

      expect(addListenerSpy).toHaveBeenCalledTimes(1);
      expect(addListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(removeListenerSpy).not.toHaveBeenCalled();
      const addedListener = addListenerSpy.mock.calls[0][1];

      holdFirst.resolve();
      await firstCreation;
      expect(await waiterOutcome).toBe('waiter-result');

      // The very listener that was added is the one taken off.
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', addedListener);
      expect(waiterCreation).toHaveBeenCalledWith(true);
      expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    });
  });
});
