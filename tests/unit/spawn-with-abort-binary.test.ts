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

const { spawnMock, killChildTreeNowMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  killChildTreeNowMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/main/shared/child-tree-stop', () => ({ killChildTreeNow: killChildTreeNowMock }));
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
    killChildTreeNowMock.mockReset();
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
    expect(killChildTreeNowMock).not.toHaveBeenCalled();
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
    expect(killChildTreeNowMock).not.toHaveBeenCalled();
  });

  it('carries the signal and timedOut: true when the timeout kill closes the binary before its abort error', async () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    const caught = pending.catch((error: unknown) => error);
    vi.advanceTimersByTime(1_000);
    child.emit('close', null, 'SIGTERM');

    const error = await caught as Error & { signal?: string; timedOut?: boolean };
    expect(error.message).toMatch(/git fetch --all killed by signal SIGTERM after 1000ms timeout/);
    expect(error.signal).toBe('SIGTERM');
    expect(error.timedOut).toBe(true);
  });

  it('blames the timeout when the caller aborts after it and the binary then closes by signal before its abort error', async () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);
    const external = new AbortController();

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000, signal: external.signal });
    const caught = pending.catch((error: unknown) => error);
    // The timeout fires first, then the caller's abort lands while the child is still dying.
    vi.advanceTimersByTime(1_000);
    external.abort();
    child.emit('close', null, 'SIGTERM');

    const error = await caught as Error & { signal?: string; timedOut?: boolean };
    expect(error.message).toMatch(/git fetch --all killed by signal SIGTERM after 1000ms timeout/);
    expect(error.message).not.toMatch(/external abort/);
    expect(error.signal).toBe('SIGTERM');
    expect(error.timedOut).toBe(true);
  });

  it('carries the exit code and timedOut: false for a binary that exits non-zero', async () => {
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    const caught = pending.catch((error: unknown) => error);
    child.stderr.emit('data', Buffer.from('fatal: nope'));
    child.emit('close', 128, null);

    const error = await caught as Error & { exitCode?: number; timedOut?: boolean };
    expect(error.message).toMatch(/exited with code 128: fatal: nope/);
    expect(error.exitCode).toBe(128);
    expect(error.timedOut).toBe(false);
  });

  describe('how much of stdout is kept', () => {
    // Eight chunks of 250,000 characters: twice the default cap.
    const chunk = Buffer.from('x'.repeat(250_000));

    function emitTwoMillionCharacters(child: FakeChild): void {
      for (let index = 0; index < 8; index += 1) child.stdout.emit('data', chunk);
    }

    it('stops at 1,000,000 characters by default, so a verbose child cannot fill memory or an error', async () => {
      const child = fakeChild(4242);
      spawnMock.mockReturnValue(child);

      const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
      emitTwoMillionCharacters(child);
      child.emit('close', 0, null);

      expect((await pending).stdout).toHaveLength(1_000_000);
    });

    it('keeps all of it for a caller that raises the cap to parse a whole listing', async () => {
      // A listing cut at the default parses as a shorter listing: the git work
      // state counted 32,367 changed files where the checkout held 150,000.
      const child = fakeChild(4242);
      spawnMock.mockReturnValue(child);

      const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000, maxOutputChars: 4_000_000 });
      emitTwoMillionCharacters(child);
      child.emit('close', 0, null);

      expect((await pending).stdout).toHaveLength(2_000_000);
    });

    describe('when the end of the output is kept', () => {
      // The tail branch keeps everything until the text passes TWICE the cap, then
      // cuts to the last `cap` characters. So it is not "at most cap" at every moment.
      it('still applies the default cap, and keeps the end, so a hook that fails shows why', async () => {
        const child = fakeChild(4242);
        spawnMock.mockReturnValue(child);

        const pending = spawnWithAbort(BINARY_TARGET,{ timeoutMs: 1_000, keepOutput: 'tail' });
        // Eight chunks reach exactly twice the cap, which is not past it. The ninth is
        // distinguishable and pushes it over, so the cut keeps it.
        emitTwoMillionCharacters(child);
        child.stdout.emit('data', Buffer.from('y'.repeat(250_000)));
        child.emit('close', 0, null);

        const { stdout } = await pending;
        expect(stdout).toHaveLength(1_000_000);
        expect(stdout.endsWith('y'.repeat(250_000))).toBe(true);
        expect(stdout.startsWith('x')).toBe(true);
      });

      it('keeps output the default cap would have cut when the caller raises the cap', async () => {
        const child = fakeChild(4242);
        spawnMock.mockReturnValue(child);

        const pending = spawnWithAbort(BINARY_TARGET,{ timeoutMs: 1_000, keepOutput: 'tail', maxOutputChars: 4_000_000 });
        emitTwoMillionCharacters(child);
        child.stdout.emit('data', Buffer.from('y'.repeat(250_000)));
        child.emit('close', 0, null);

        expect((await pending).stdout).toHaveLength(2_250_000);
      });

      it('cuts to the end of the output once it passes twice a small cap', async () => {
        const child = fakeChild(4242);
        spawnMock.mockReturnValue(child);

        const pending = spawnWithAbort(BINARY_TARGET,{ timeoutMs: 1_000, keepOutput: 'tail', maxOutputChars: 10 });
        // 8 and 16 characters are not past 20. The third makes 24, so the last 10 stay.
        child.stdout.emit('data', Buffer.from('a'.repeat(8)));
        child.stdout.emit('data', Buffer.from('b'.repeat(8)));
        child.stdout.emit('data', Buffer.from('c'.repeat(8)));
        child.emit('close', 0, null);

        expect((await pending).stdout).toBe('bbcccccccc');
      });
    });
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
    expect(killChildTreeNowMock).toHaveBeenCalledTimes(1);
    expect(killChildTreeNowMock).toHaveBeenCalledWith(child, { leadsGroup: true });
    // The killed shell closes (taskkill leaves exit code 1 on Windows); the
    // abort's wording stands rather than "exited with code 1".
    child.emit('close', 1, null);
    await outcome;
  });
});
