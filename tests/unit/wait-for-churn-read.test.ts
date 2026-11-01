/**
 * `waitForChurnRead` (src/main/ipc/handlers/git-stats-capture.ts): a Done move
 * fires its churn capture into the worktree and then moves the worktree aside
 * at once. A read whose directory vanished mid-diff reports nothing, so the
 * removal first waits, bounded, for every read in flight in that directory,
 * queued or running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task } from '../../src/shared/types';

const { churnReads, queueGates } = vi.hoisted(() => ({
  /** One pending read per DiffService call, settled by the test. */
  churnReads: [] as Array<{ directory: string; settle: () => void }>,
  /** When non-empty, the next read waits here before it starts, as one queued behind others does. */
  queueGates: [] as Array<Promise<void>>,
}));

vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    constructor(private readonly directory: string) {}
    getChurnSummary(): Promise<{ linesAdded: number; linesRemoved: number; filesChanged: number }> {
      return new Promise((resolve) => {
        churnReads.push({ directory: this.directory, settle: () => resolve({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 }) });
      });
    }
  },
}));

vi.mock('../../src/main/git/git-read-queue', () => ({
  GitReadPriority: { USER: 0, BACKGROUND: 1 },
  viaGitRead: async <T,>(operation: () => Promise<T>): Promise<T> => {
    const gate = queueGates.shift();
    if (gate) await gate;
    return operation();
  },
}));

import { captureGitChurn, waitForChurnRead } from '../../src/main/ipc/handlers/git-stats-capture';

const WORKTREE = '/mock/project/.kangentic/worktrees/1';
const OTHER_WORKTREE = '/mock/project/.kangentic/worktrees/2';

function startCapture(worktreePath: string): void {
  const task = { id: `task-${worktreePath}`, worktree_path: worktreePath, pr_state: null, archived_at: null, base_branch: null } as unknown as Task;
  const sessionRepo = {
    listForTaskNewestFirst: () => [{ id: 'record-1', lines_added: 0, lines_removed: 0, files_changed: 0 }],
    setTaskGitStats: vi.fn(),
  };
  captureGitChurn(task, sessionRepo as never, { setTaskGitStats: vi.fn() } as never, 'record-1', '/mock/project', 'main');
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function track(promise: Promise<void>): { settled: () => boolean; promise: Promise<void> } {
  let isSettled = false;
  const tracked = promise.finally(() => { isSettled = true; });
  return { settled: () => isSettled, promise: tracked };
}

beforeEach(() => {
  churnReads.length = 0;
  queueGates.length = 0;
});

afterEach(async () => {
  // Settle whatever a test left, so no read stays in flight for the next one.
  for (const read of churnReads) read.settle();
  await flush();
  vi.useRealTimers();
});

describe('waitForChurnRead', () => {
  it('returns at once when no read is in flight', async () => {
    const waiting = track(waitForChurnRead(WORKTREE, 60_000));
    await flush();
    expect(waiting.settled()).toBe(true);
  });

  it('waits for a running read in that directory, and returns once it settles', async () => {
    startCapture(WORKTREE);
    await flush();
    expect(churnReads).toHaveLength(1);

    const waiting = track(waitForChurnRead(WORKTREE, 60_000));
    await flush();
    expect(waiting.settled()).toBe(false);

    churnReads[0].settle();
    await waiting.promise;
    expect(waiting.settled()).toBe(true);
  });

  it('waits for a read still queued behind others, which has not started its diff yet', async () => {
    let openQueue: () => void = () => undefined;
    queueGates.push(new Promise<void>((resolve) => { openQueue = resolve; }));
    startCapture(WORKTREE);
    await flush();
    expect(churnReads).toHaveLength(0);

    const waiting = track(waitForChurnRead(WORKTREE, 60_000));
    openQueue();
    await flush();
    expect(churnReads).toHaveLength(1);
    expect(waiting.settled()).toBe(false);

    churnReads[0].settle();
    await waiting.promise;
  });

  it('does not wait for a read in another directory', async () => {
    startCapture(OTHER_WORKTREE);
    await flush();

    const waiting = track(waitForChurnRead(WORKTREE, 60_000));
    await flush();
    expect(waiting.settled()).toBe(true);
  });

  it('returns at the bound when the read never settles', async () => {
    vi.useFakeTimers();
    startCapture(WORKTREE);
    await flush();

    const waiting = track(waitForChurnRead(WORKTREE, 1_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(waiting.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting.promise;
    expect(waiting.settled()).toBe(true);
  });
});
