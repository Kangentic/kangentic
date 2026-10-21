/**
 * The project search's git call ends its tree with `taskkill /T` on Windows
 * when it runs past its 20 s budget (src/main/ipc/helpers/project-entry-search.ts).
 * taskkill opens the pid it is given, and Node pins a child's pid only until it
 * has handled the child's exit. git can exit while something it started still
 * holds its output open, so `close` comes later, and the timeout can land in
 * between. These pin that the tree kill runs only while the child has not
 * exited (src/main/shared/child-tree-stop.ts).
 *
 * On POSIX the same call is SIGTERM to the git process, then SIGKILL after
 * `TREE_STOP_GRACE_MS` if it has not exited. git is not started detached, so it
 * leads no process group and the signal never goes to one.
 *
 * `node:child_process` is mocked, so no process is spawned or killed, and the
 * POSIX cases also stub `process.kill`: a group signal to a made-up pid could
 * name anything on the machine running the suite.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { clearProjectEntrySearchCache, searchProjectEntries } from '../../src/main/ipc/helpers/project-entry-search';
import { TREE_STOP_GRACE_MS } from '../../src/main/shared/child-tree-stop';

const GIT_BUDGET_MS = 20_000;

interface FakeGit extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: EventEmitter;
  stdin: { write: () => void; end: () => void };
  kill: ReturnType<typeof vi.fn>;
}

function fakeGit(pid: number): FakeGit {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stdin: { write: () => undefined, end: () => undefined },
    kill: vi.fn(),
  });
}

/** Every git call gets `git`; a taskkill gets a child that never exits, as `child-tree-stop.ts` needs. */
function spawnReturning(git: FakeGit): void {
  spawnMock.mockImplementation((command: string) => (
    command === 'taskkill' ? Object.assign(new EventEmitter(), { unref: vi.fn() }) : git
  ));
}

function taskkillCalls(): unknown[][] {
  return spawnMock.mock.calls.filter(([command]) => command === 'taskkill');
}

describe('project entry search: the tree kill of a git call past its budget', () => {
  const originalPlatform = process.platform;
  let cwd = '';

  function startSearch(): Promise<unknown> {
    return searchProjectEntries({ cwd, query: '', limit: 10 });
  }

  /** Runs a started search to its end: every git call it makes times out, and the file walk uses real I/O. */
  async function runToEnd(started: Promise<unknown>): Promise<void> {
    let settled = false;
    const search = started.finally(() => { settled = true; });
    for (let round = 0; round < 20 && !settled; round += 1) {
      await vi.advanceTimersByTimeAsync(GIT_BUDGET_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await search;
  }

  async function searchToEnd(): Promise<void> {
    await runToEnd(startSearch());
  }

  beforeEach(() => {
    // Timeouts only: the file walk's real I/O must still run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    spawnMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-search-tree-kill-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '', 'utf8');
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    clearProjectEntrySearchCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('takes the tree of a git call that is still running, without blocking the loop', async () => {
    const git = fakeGit(4321);
    spawnReturning(git);
    await searchToEnd();
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], expect.objectContaining({ windowsHide: true }));
  });

  it('starts no taskkill for a git call that has exited, though its output is still open', async () => {
    const git = fakeGit(4321);
    // Node has handled the exit; whatever git started still holds stdout.
    git.exitCode = 0;
    spawnReturning(git);
    await searchToEnd();
    // Positive control: the search did reach git, and its budget ran out.
    expect(spawnMock).toHaveBeenCalledWith('git', expect.any(Array), expect.objectContaining({ cwd }));
    expect(taskkillCalls()).toEqual([]);
    expect(git.kill).not.toHaveBeenCalled();
  });

  describe('on POSIX', () => {
    // Every git call is its own fake, so a call's signals are read apart from the
    // calls the search makes after it. The first is what these cases drive.
    let gitCalls: FakeGit[] = [];
    let processKillSpy: MockInstance<typeof process.kill>;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      // git is not detached, so no group may be signalled. A stub, because a
      // revert to a group signal would otherwise reach the made-up pids below.
      processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      gitCalls = [];
      spawnMock.mockImplementation(() => {
        const git = fakeGit(4321 + gitCalls.length);
        gitCalls.push(git);
        return git;
      });
    });

    afterEach(() => {
      processKillSpy.mockRestore();
    });

    it('terminates a git call past its budget, then kills it a second later when it has not exited', async () => {
      const search = startSearch();
      try {
        // The search spawns its first git call before it yields.
        expect(gitCalls).toHaveLength(1);
        const [git] = gitCalls;

        await vi.advanceTimersByTimeAsync(GIT_BUDGET_MS - 1);
        expect(git.kill).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        // The git process itself, never a group: it was not started as a leader of one.
        expect(processKillSpy).not.toHaveBeenCalled();
        expect(git.kill.mock.calls).toEqual([['SIGTERM']]);

        await vi.advanceTimersByTimeAsync(TREE_STOP_GRACE_MS - 1);
        expect(git.kill.mock.calls).toEqual([['SIGTERM']]);

        await vi.advanceTimersByTimeAsync(1);
        expect(git.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
        expect(processKillSpy).not.toHaveBeenCalled();
      } finally {
        await runToEnd(search);
      }
    });

    it('sends no SIGKILL to a git call that exits within the second after its SIGTERM', async () => {
      const search = startSearch();
      try {
        const [git] = gitCalls;
        await vi.advanceTimersByTimeAsync(GIT_BUDGET_MS);
        expect(git.kill.mock.calls).toEqual([['SIGTERM']]);

        // The SIGTERM ended it: by the time the grace is up Node has handled the exit.
        git.signalCode = 'SIGTERM';
        git.emit('close', null, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(TREE_STOP_GRACE_MS);

        expect(git.kill.mock.calls).toEqual([['SIGTERM']]);
        expect(processKillSpy).not.toHaveBeenCalled();
      } finally {
        await runToEnd(search);
      }
    });

    it('signals nothing for a git call that has already exited, though its output is still open', async () => {
      const search = startSearch();
      try {
        const [git] = gitCalls;
        // Node has handled the exit; whatever git started still holds stdout.
        git.exitCode = 0;

        // Its budget, then the grace a SIGTERM would have started.
        await vi.advanceTimersByTimeAsync(GIT_BUDGET_MS + TREE_STOP_GRACE_MS);

        // Positive control: its budget ran out and the search went on to a second
        // git call, which is still running, so that call's budget (it began when
        // the first one's ran out) ends it with a SIGTERM.
        expect(gitCalls.length).toBeGreaterThan(1);
        await vi.advanceTimersByTimeAsync(GIT_BUDGET_MS - TREE_STOP_GRACE_MS);
        expect(gitCalls[1].kill.mock.calls).toEqual([['SIGTERM']]);

        expect(git.kill).not.toHaveBeenCalled();
        expect(processKillSpy).not.toHaveBeenCalled();
      } finally {
        await runToEnd(search);
      }
    });
  });
});
