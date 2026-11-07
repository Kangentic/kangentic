/**
 * The copy worker's lifecycle. A real worktree copy runs in a utilityProcess,
 * which vitest has no Electron to fork, so the fork returns a controllable
 * child. What a user loses here: an abort that returns while the worker still
 * writes lets a removal land under it, and a worker that cannot run must not
 * fail a task's start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockFork, mockCopyEntries } = vi.hoisted(() => ({ mockFork: vi.fn(), mockCopyEntries: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: mockFork },
}));

vi.mock('../../src/main/git/worktree-copy/copy-entries', () => ({ copyEntries: mockCopyEntries }));

import { WorktreeCopyClient } from '../../src/main/git/worktree-copy/worktree-copy-client';
import { WorktreeCopyLimitError } from '../../src/main/git/worktree-errors';
import { UtilityRestartPolicy } from '../../src/main/utility-process/restart-policy';

interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

const REQUEST = { projectPath: '/project', worktreePath: '/worktree', entries: ['data'], linkedFolders: [] };
const RESULT = { copied: 3, unchanged: 1, skippedLinks: 0 };
const INLINE_RESULT = { copied: 9, unchanged: 0, skippedLinks: 0 };

let child: FakeChild;

function makeChild(): FakeChild {
  const fake = new EventEmitter() as FakeChild;
  fake.postMessage = vi.fn();
  fake.kill = vi.fn();
  return fake;
}

function newClient(): WorktreeCopyClient {
  return new WorktreeCopyClient(new UtilityRestartPolicy({ service: 'test-copy', maxCrashes: 3 }));
}

describe('WorktreeCopyClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    child = makeChild();
    mockFork.mockImplementation(() => child);
    mockCopyEntries.mockResolvedValue(INLINE_RESULT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the copy in a worker of its own and ends it on the answer', async () => {
    const copying = newClient().copy(REQUEST);

    expect(mockFork).toHaveBeenCalledWith(
      expect.stringContaining('worktree-copy-worker.js'),
      [],
      expect.objectContaining({ serviceName: 'kangentic-worktree-copy' }),
    );
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'copy', request: REQUEST });
    child.emit('message', { type: 'result', result: RESULT });

    await expect(copying).resolves.toEqual(RESULT);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('does not read the exit after an answer as a crash, so copies keep running in a worker', async () => {
    const client = newClient();
    for (let copyNumber = 0; copyNumber < 5; copyNumber += 1) {
      child = makeChild();
      const copying = client.copy(REQUEST);
      child.emit('message', { type: copyNumber % 2 === 0 ? 'result' : 'failed', result: RESULT, message: 'failed', overLimit: false });
      child.emit('exit', 0);
      await copying.catch(() => undefined);
    }
    expect(mockFork).toHaveBeenCalledTimes(5);
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('forks one worker per copy, so an abort reaches only its own', async () => {
    const client = newClient();
    const firstChild = child;
    const first = client.copy(REQUEST);
    const secondChild = makeChild();
    mockFork.mockImplementation(() => secondChild);
    const controller = new AbortController();
    const second = client.copy(REQUEST, controller.signal);

    controller.abort();
    expect(secondChild.kill).toHaveBeenCalledTimes(1);
    expect(firstChild.kill).not.toHaveBeenCalled();

    secondChild.emit('exit', 0);
    await expect(second).rejects.toThrow();
    firstChild.emit('message', { type: 'result', result: RESULT });
    await expect(first).resolves.toEqual(RESULT);
  });

  it('turns an over-limit answer back into the typed error, with no retry on main', async () => {
    const copying = newClient().copy(REQUEST);
    child.emit('message', { type: 'failed', message: 'data has over 20,000 files', overLimit: true });
    await expect(copying).rejects.toBeInstanceOf(WorktreeCopyLimitError);
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('rejects with the copy\'s own failure, with no retry on main', async () => {
    const copying = newClient().copy(REQUEST);
    child.emit('message', { type: 'failed', message: 'EBUSY: locked', overLimit: false });
    await expect(copying).rejects.toThrow('EBUSY: locked');
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('settles an abort only once the killed worker has exited', async () => {
    const controller = new AbortController();
    let settled = false;
    const copying = newClient().copy(REQUEST, controller.signal);
    const watched = copying.catch(() => undefined).finally(() => { settled = true; });

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    child.emit('exit', 0);
    await expect(copying).rejects.toThrow();
    await watched;
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('settles an abort after a bound when the worker never exits', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const copying = newClient().copy(REQUEST, controller.signal);
    const outcome = expect(copying).rejects.toThrow();
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
  });

  it('kills a worker on a hung disk and rejects', async () => {
    vi.useFakeTimers();
    const copying = newClient().copy(REQUEST);
    const outcome = expect(copying).rejects.toThrow('The worktree copy timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 0);
    await outcome;
  });

  it('never starts a worker for a copy already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(newClient().copy(REQUEST, controller.signal)).rejects.toThrow();
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('copies on main when the worker cannot start', async () => {
    mockFork.mockImplementation(() => { throw new Error('no fork'); });
    await expect(newClient().copy(REQUEST)).resolves.toEqual(INLINE_RESULT);
    expect(mockCopyEntries).toHaveBeenCalledWith(REQUEST, undefined);
  });

  it('copies on main when the worker dies with no answer', async () => {
    const copying = newClient().copy(REQUEST);
    child.emit('exit', 1);
    await expect(copying).resolves.toEqual(INLINE_RESULT);
  });

  it('stops forking a worker that keeps dying, and still copies', async () => {
    const client = newClient();
    for (let crash = 0; crash < 3; crash += 1) {
      child = makeChild();
      const copying = client.copy(REQUEST);
      child.emit('exit', 1);
      await copying;
      vi.setSystemTime(Date.now() + 60_000);
    }
    mockFork.mockClear();
    await expect(client.copy(REQUEST)).resolves.toEqual(INLINE_RESULT);
    expect(mockFork).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('refuses a copy after dispose: nothing forks, and nothing runs on main where a quit could not stop it', async () => {
    const client = newClient();
    client.dispose();
    await expect(client.copy(REQUEST)).rejects.toThrow('The worktree copy stopped for the quit');
    expect(mockFork).not.toHaveBeenCalled();
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('kills a worker whose copy is aborted during the fork, and never posts the copy', async () => {
    const controller = new AbortController();
    // Not aborted when copy() starts, so the entry check passes; aborted by the time the fork returns.
    mockFork.mockImplementation(() => {
      controller.abort();
      return child;
    });
    const copying = newClient().copy(REQUEST, controller.signal);
    const outcome = expect(copying).rejects.toThrow();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.postMessage).not.toHaveBeenCalled();
    child.emit('exit', 0);
    await outcome;
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('rejects, and does not copy on main, when a worker exits with no answer and the copy was aborted', async () => {
    const controller = new AbortController();
    const copying = newClient().copy(REQUEST, controller.signal);
    const outcome = expect(copying).rejects.toThrow();

    // The exit settles the run with no answer and drops the abort listener, so the
    // abort that follows in the same turn is seen only by the check after the run.
    child.emit('exit', 1);
    controller.abort();

    await outcome;
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });

  it('kills a live worker on dispose, and that copy rejects rather than running on main during the quit', async () => {
    const client = newClient();
    const copying = client.copy(REQUEST);
    client.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 0);
    await expect(copying).rejects.toThrow();
    expect(mockCopyEntries).not.toHaveBeenCalled();
  });
});
