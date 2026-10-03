/**
 * Unit tests for runInitScript -- the cross-platform runner for the
 * git.initScript "Post-Worktree Script". Mirrors the hoisted node:child_process
 * spawn mock used by worktree-manager.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// spawn mock. Records calls and lets each test configure the child's outcome:
// a clean close(exitCode), captured stdout/stderr, or `hang` (never closes) so
// abort/timeout can be exercised. A shell command no longer gets Node's
// `signal` option: spawnWithAbort settles the abort itself and kills the
// child's whole tree (killChildTreeByPid, mocked below), so the abort tests
// drive the AbortController and, where it matters, emit the late `close` the
// killed shell produces by hand.
//
// `nullClose`: when set, fires close(null, null) - a Windows cmd.exe wrapper
// that exits without a numeric code or signal name.
//
// vi.hoisted() so these exist before vi.mock() runs.
const { mockSpawn, recordedSpawnCalls, spawnOverrides, mockKillChildTreeByPid } = vi.hoisted(() => {
  const recordedSpawnCalls: Array<{ command: string; options: { cwd?: string; shell?: boolean; windowsHide?: boolean; detached?: boolean; signal?: AbortSignal } }> = [];
  const spawnOverrides: Array<{
    match: (command: string) => boolean;
    behavior: { exitCode?: number; stderr?: string; stdout?: string; hang?: boolean; nullClose?: boolean };
  }> = [];

  const mockSpawn = vi.fn((command: string, options: { cwd?: string; shell?: boolean; windowsHide?: boolean; detached?: boolean; signal?: AbortSignal }) => {
    recordedSpawnCalls.push({ command, options });
    const override = spawnOverrides.find((entry) => entry.match(command));
    const behavior = override?.behavior ?? { exitCode: 0 };

    const EventEmitter = require('node:events').EventEmitter;
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });

    if (behavior.nullClose) {
      // Windows cmd.exe wrapper exit: code and signal are both null.
      queueMicrotask(() => { child.emit('close', null, null); });
    } else if (!behavior.hang) {
      // queueMicrotask (not setTimeout) so this still fires under fake timers.
      queueMicrotask(() => {
        if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout, 'utf8'));
        if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'));
        child.emit('close', behavior.exitCode ?? 0, null);
      });
    }

    return child;
  });

  return { mockSpawn, recordedSpawnCalls, spawnOverrides, mockKillChildTreeByPid: vi.fn() };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Never a real kill from a unit test: on POSIX the real helper signals the pid's
// process group, and 4242 could be anything on the machine running the suite.
vi.mock('../../src/main/shared/child-tree-stop', () => ({
  killChildTreeByPid: mockKillChildTreeByPid,
}));

import { runInitScript } from '../../src/main/git/run-init-script';

/** The fake child the most recent spawn returned. */
function lastChild(): { emit: (event: string, ...values: unknown[]) => boolean } {
  return mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
}

describe('runInitScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the script via a shell with the given cwd and resolves with captured output', async () => {
    spawnOverrides.push({ match: (cmd) => cmd === 'npm install', behavior: { exitCode: 0, stdout: 'added 1 package' } });

    const result = await runInitScript('npm install', '/worktree/path', { timeoutMs: 1000 });

    expect(result.stdout).toContain('added 1 package');
    expect(recordedSpawnCalls).toHaveLength(1);
    expect(recordedSpawnCalls[0].command).toBe('npm install');
    // Cross-platform: shell:true + a command string (Node picks cmd.exe / sh).
    expect(recordedSpawnCalls[0].options.shell).toBe(true);
    expect(recordedSpawnCalls[0].options.windowsHide).toBe(true);
    expect(recordedSpawnCalls[0].options.cwd).toBe('/worktree/path');
  });

  it('rejects with the captured stderr when the script exits non-zero', async () => {
    spawnOverrides.push({ match: (cmd) => cmd === 'bad-script', behavior: { exitCode: 1, stderr: 'boom: command failed' } });

    await expect(runInitScript('bad-script', '/worktree/path', { timeoutMs: 1000 }))
      .rejects.toThrow(/code 1.*boom: command failed/s);
  });

  it('rejects when the external signal aborts', async () => {
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(/external abort/);
  });

  it('rejects before spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runInitScript('npm install', '/worktree/path', { timeoutMs: 1000, signal: controller.signal }))
      .rejects.toThrow(/aborted before spawn/);
    expect(recordedSpawnCalls).toHaveLength(0);
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });

    const promise = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('settles exactly once with the abort reason when the killed shell closes afterwards (double-settle path)', async () => {
    // The tree kill makes the shell exit by signal a moment after the abort.
    // The Promise must keep the abort message, not switch to "killed by signal",
    // and must not throw an unhandled rejection from a second settle.
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    lastChild().emit('close', null, 'SIGKILL');

    await expect(promise).rejects.toThrow(/external abort/);
  });

  it('settles exactly once with the timeout reason when the killed shell closes afterwards', async () => {
    // Same double-event scenario driven by the internal wall-clock timeout.
    vi.useFakeTimers();
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });

    const promise = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    lastChild().emit('close', null, 'SIGKILL');
    await assertion;
  });

  it('kills the whole tree of the script on abort and on timeout, never through Node\'s own signal', async () => {
    // Node's `signal` option kills the shell only; whatever the script started
    // (an `npm install`) kept running in a worktree about to be removed.
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/external abort/);

    expect(mockKillChildTreeByPid).toHaveBeenCalledWith(4242);
    expect(recordedSpawnCalls[0].options.signal).toBeUndefined();
    // POSIX: the script leads its own process group so the group kill reaches
    // it all. Windows has no groups; `taskkill /T` walks the tree there.
    expect(recordedSpawnCalls[0].options.detached).toBe(process.platform !== 'win32');

    vi.useFakeTimers();
    mockKillChildTreeByPid.mockClear();
    const timedOut = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
    const assertion = expect(timedOut).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockKillChildTreeByPid).toHaveBeenCalledWith(4242);
  });

  it('rejects when close fires with code null and no signal (Windows cmd.exe wrapper exit)', async () => {
    // Node can deliver close(null, null) from a Windows cmd.exe wrapper that exits
    // without surfacing a numeric code (e.g. a DEP0190 no-args-array shell exit).
    // The 'close' handler checks: (a) signalName truthy? -> signal branch; (b)
    // code !== 0? -> non-zero branch. Since null !== 0 is true, this is treated
    // as a non-zero exit. Pinning the current behavior protects against any future
    // refactor that would silently resolve(null) instead of rejecting.
    spawnOverrides.push({ match: () => true, behavior: { nullClose: true } });

    await expect(runInitScript('npm install', '/worktree/path', { timeoutMs: 1000 }))
      .rejects.toThrow(/exited with code null/);
  });

  it('resolve wins when close(0) settles the Promise before a subsequent abort fires', async () => {
    // The Promise is first-settle-wins. When the child completes successfully
    // (close(0)) and the caller later aborts, resolve wins because the Promise
    // is already settled. A subsequent abort that fires into an already-settled
    // Promise must not crash or produce an unhandled rejection.
    //
    // Implementation note: close(0) is queued via queueMicrotask inside the mock
    // (to fire after the 'close' listener is registered), so to ensure close(0)
    // fires before the abort, we await one microtask flush before aborting. Pinning
    // this proves the implementation does not re-reject on a late abort, and that
    // cleanup() (removeEventListener + clearTimeout) is idempotent.
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    // Flush pending microtasks so the mock's queueMicrotask-scheduled close(0)
    // fires and settles the Promise before we abort.
    await Promise.resolve();

    // Abort after the Promise is already resolved. The externalAbortHandler was
    // removed by cleanup() inside the close(0) path, so controller.abort() does
    // not reach the internal AbortController, and the error handler never fires.
    controller.abort();

    await expect(promise).resolves.toEqual({ stdout: '', stderr: '' });
  });
});
