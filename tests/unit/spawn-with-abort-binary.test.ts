/**
 * Unit coverage for which kill mechanism `spawnWithAbort` gives each spawn shape
 * (src/main/git/spawn-with-abort.ts).
 *
 * A SHELL command (no `args`, the Post-Worktree Script) leads its own process
 * group on POSIX and loses its whole tree on abort or timeout, because Node's
 * `signal` option kills only the shell and left an `npm install` running in a
 * worktree about to be removed. A BINARY command (`args` given, git) keeps Node's
 * own `signal` kill and is neither detached nor tree-killed: git's children are
 * its own business, and detaching it would take git out of the app's process
 * group for no reason. A change that widened the tree-kill branch to every spawn
 * would break git's abort path while every shell-command test stayed green, so
 * the binary shape is pinned here. The shell shape is pinned alongside it as the
 * contrast, which also keeps the "no `detached` key" assertion from passing
 * vacuously. The real-process behavior of the shell branch is run-init-script-tree-kill.test.ts.
 *
 * `node:child_process` is mocked with a fake child, so no process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock, killChildTreeByPidMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  killChildTreeByPidMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/main/shared/child-tree-stop', () => ({ killChildTreeByPid: killChildTreeByPidMock }));
// No macOS spawn-helper, whatever platform this runs on (see spawn-with-abort.test.ts).
vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: (): string[] => [],
}));

import { spawnWithAbort } from '../../src/main/git/spawn-with-abort';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number };

function fakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  return child;
}

const BINARY_TARGET = {
  command: 'git',
  args: ['fetch', '--all'],
  cwd: '/mock/repo',
  label: 'git fetch --all',
  signalKillAssertsTimeout: true,
};

const SHELL_TARGET = {
  command: 'npm install',
  cwd: '/mock/repo',
  label: 'init script',
  signalKillAssertsTimeout: false,
};

/** The options object handed to spawn, whichever positional shape was used. */
function spawnOptions(): Record<string, unknown> {
  const call = spawnMock.mock.calls[0];
  return call[call.length - 1] as Record<string, unknown>;
}

/** What Node does to a child whose `signal` option aborts: an `error` event named AbortError. */
function emitNodeAbortError(child: FakeChild): void {
  child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
}

describe('spawnWithAbort kill mechanism per spawn shape', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    killChildTreeByPidMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns a binary command with Node\'s `signal` and without `detached`', async () => {
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    child.emit('close', 0, null);
    await pending;

    const options = spawnOptions();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect((options.signal as AbortSignal).aborted).toBe(false);
    // No `detached` key at all: git stays in the app's process group. Not merely
    // `detached: false`, which would hide a branch that sets the key on Windows.
    expect(options).not.toHaveProperty('detached');
  });

  it('aborts a binary command through that signal on an external abort, without a tree kill', async () => {
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);
    const external = new AbortController();

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 60_000, signal: external.signal });
    const outcome = expect(pending).rejects.toThrow(/git fetch --all aborted \(external abort\)/);
    external.abort();

    // The external abort reaches the child's own `signal`, which is what makes Node kill it.
    expect((spawnOptions().signal as AbortSignal).aborted).toBe(true);
    emitNodeAbortError(child);
    await outcome;
    expect(killChildTreeByPidMock).not.toHaveBeenCalled();
  });

  it('aborts a binary command through that signal on its timeout, without a tree kill', async () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    const outcome = expect(pending).rejects.toThrow(/git fetch --all aborted \(timeout after 1000ms\)/);
    vi.advanceTimersByTime(1_000);

    expect((spawnOptions().signal as AbortSignal).aborted).toBe(true);
    emitNodeAbortError(child);
    await outcome;
    expect(killChildTreeByPidMock).not.toHaveBeenCalled();
  });

  it('contrast: a shell command gets no `signal`, leads its own group on POSIX, and loses its tree on abort', async () => {
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);
    const external = new AbortController();

    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 60_000, signal: external.signal });
    const outcome = expect(pending).rejects.toThrow(/init script aborted \(external abort\) \(child process killed\)/);

    const options = spawnOptions();
    expect(options).not.toHaveProperty('signal');
    expect(options.detached).toBe(process.platform !== 'win32');

    external.abort();
    await outcome;
    expect(killChildTreeByPidMock).toHaveBeenCalledTimes(1);
    expect(killChildTreeByPidMock).toHaveBeenCalledWith(4242);
  });
});
