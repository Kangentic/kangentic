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
// child's whole tree (killChildTreeNow, mocked below), so the abort tests
// drive the AbortController and, where it matters, emit the late `close` the
// killed shell produces by hand.
//
// `nullClose`: when set, fires close(null, null) - a Windows cmd.exe wrapper
// that exits without a numeric code or signal name.
//
// `noPid`: when set, the child has `pid === undefined`, as a spawn that failed
// to start a process does. Every other behavior keeps pid 4242.
//
// vi.hoisted() so these exist before vi.mock() runs.
const { mockSpawn, recordedSpawnCalls, spawnOverrides, mockKillChildTreeNow } = vi.hoisted(() => {
  const recordedSpawnCalls: Array<{ command: string; options: { cwd?: string; shell?: boolean; windowsHide?: boolean; detached?: boolean; signal?: AbortSignal } }> = [];
  const spawnOverrides: Array<{
    match: (command: string) => boolean;
    behavior: { exitCode?: number; stderr?: string; stdout?: string; hang?: boolean; nullClose?: boolean; noPid?: boolean };
  }> = [];

  const mockSpawn = vi.fn((command: string, options: { cwd?: string; shell?: boolean; windowsHide?: boolean; detached?: boolean; signal?: AbortSignal }) => {
    recordedSpawnCalls.push({ command, options });
    const override = spawnOverrides.find((entry) => entry.match(command));
    const behavior = override?.behavior ?? { exitCode: 0 };

    const EventEmitter = require('node:events').EventEmitter;
    const child = Object.assign(new EventEmitter(), {
      pid: behavior.noPid ? undefined : 4242,
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

  // The tree kill closes the killed shell a moment later, as the real one does;
  // an aborted call settles on that close (or at TREE_EXIT_WAIT_MS without it).
  const mockKillChildTreeNow = vi.fn(() => {
    const killedChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value as
      { emit: (event: string, ...values: unknown[]) => boolean } | undefined;
    queueMicrotask(() => { killedChild?.emit('close', null, 'SIGKILL'); });
  });

  return { mockSpawn, recordedSpawnCalls, spawnOverrides, mockKillChildTreeNow };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Never a real kill from a unit test: on POSIX the real helper signals the pid's
// process group, and 4242 could be anything on the machine running the suite.
vi.mock('../../src/main/shared/child-tree-stop', () => ({
  killChildTreeNow: mockKillChildTreeNow,
}));

import { runInitScript, isAnyInitScriptRunning, whenNoInitScriptRuns } from '../../src/main/git/run-init-script';
import { TREE_EXIT_WAIT_MS } from '../../src/main/git/spawn-with-abort';

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

    expect(mockKillChildTreeNow).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }), { leadsGroup: true });
    expect(recordedSpawnCalls[0].options.signal).toBeUndefined();
    // POSIX: the script leads its own process group so the group kill reaches
    // it all. Windows has no groups; `taskkill /T` walks the tree there.
    expect(recordedSpawnCalls[0].options.detached).toBe(process.platform !== 'win32');

    vi.useFakeTimers();
    mockKillChildTreeNow.mockClear();
    const timedOut = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
    const assertion = expect(timedOut).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockKillChildTreeNow).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }), { leadsGroup: true });
  });

  it('settles an abort only once the killed tree has closed, so nothing it started is still running', async () => {
    // A settled creation is what lets a removal or a new creation at the same
    // worktree path go ahead, and `taskkill /T` takes a moment of its own.
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    mockKillChildTreeNow.mockImplementationOnce(() => undefined);
    const controller = new AbortController();
    let settled = false;

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    const outcome = promise.catch((error: unknown) => error).finally(() => { settled = true; });
    controller.abort();
    for (let flushCount = 0; flushCount < 10; flushCount++) await Promise.resolve();

    expect(mockKillChildTreeNow).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }), { leadsGroup: true });
    expect(settled).toBe(false);

    lastChild().emit('close', 1, null);
    expect(String(await outcome)).toMatch(/external abort/);
  });

  it('settles an abort at TREE_EXIT_WAIT_MS when the killed tree never closes', async () => {
    // A descendant that escaped the tree kill can hold the output pipes open
    // forever; the wait for the close is bounded.
    vi.useFakeTimers();
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    mockKillChildTreeNow.mockImplementationOnce(() => undefined);
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    const assertion = expect(promise).rejects.toThrow(/external abort/);
    controller.abort();
    await vi.advanceTimersByTimeAsync(TREE_EXIT_WAIT_MS - 1);
    let settled = false;
    void promise.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('rejects an abort at once when the child has no pid: no tree kill, nothing left on the clock', async () => {
    // A child that never started has no pid to kill and no close to wait for, so
    // the abort settles on the spot. Reverting the `child.pid === undefined`
    // branch in spawn-with-abort.ts would hand killChildTreeNow a child with no
    // pid and park the call behind the TREE_EXIT_WAIT_MS timer instead.
    vi.useFakeTimers();
    const baselineTimerCount = vi.getTimerCount();
    spawnOverrides.push({ match: () => true, behavior: { hang: true, noPid: true } });
    const controller = new AbortController();
    let outcome: unknown = 'pending';

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    void promise.catch((error: unknown) => { outcome = error; });
    // Only the wall-clock timeout is pending while the script hangs.
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    controller.abort();
    // Microtasks only, no timer advance: "at once" means the abort alone settles it.
    for (let flushCount = 0; flushCount < 10; flushCount++) await Promise.resolve();

    expect(String(outcome)).toMatch(/external abort/);
    expect(mockKillChildTreeNow).not.toHaveBeenCalled();
    // The wall-clock timer was cleared on settle and no tree-exit timer was armed.
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });

  it('clears the tree-exit bound once the killed shell closes, leaving no timer pending', async () => {
    // The TREE_EXIT_WAIT_MS timer is armed at the kill and must be cleared by the
    // close that settles the call. Reverting the clearTimeout(treeExitWait) in
    // the close handler leaves it pending (an unref'd 5 s timer per aborted
    // creation) even though the call already settled.
    vi.useFakeTimers();
    const baselineTimerCount = vi.getTimerCount();
    spawnOverrides.push({ match: () => true, behavior: { hang: true } });
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    const assertion = expect(promise).rejects.toThrow(/external abort/);
    controller.abort();
    // The default tree-kill mock emits the killed shell's close on a microtask.
    await assertion;

    expect(mockKillChildTreeNow).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }), { leadsGroup: true });
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
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

  // A Done move's deferred file delete waits on this count (removed-worktrees.ts),
  // so it must rise for the whole run and drop however the script settles.
  describe('the running-script count', () => {
    it('counts a script from the call until it succeeds, and wakes a waiter then', async () => {
      spawnOverrides.push({ match: () => true, behavior: { hang: true } });
      expect(isAnyInitScriptRunning()).toBe(false);

      const promise = runInitScript('pnpm install', '/worktree/path', { timeoutMs: 60_000 });
      expect(isAnyInitScriptRunning()).toBe(true);
      let idle = false;
      const waiter = whenNoInitScriptRuns().then(() => { idle = true; });
      for (let flushCount = 0; flushCount < 10; flushCount++) await Promise.resolve();
      expect(idle).toBe(false);

      lastChild().emit('close', 0, null);
      await promise;
      await waiter;
      expect(idle).toBe(true);
      expect(isAnyInitScriptRunning()).toBe(false);
    });

    it('stays up while either of two scripts runs', async () => {
      spawnOverrides.push({ match: () => true, behavior: { hang: true } });
      const first = runInitScript('pnpm install', '/worktree/one', { timeoutMs: 60_000 });
      const firstChild = lastChild();
      const second = runInitScript('pnpm install', '/worktree/two', { timeoutMs: 60_000 });
      const secondChild = lastChild();

      firstChild.emit('close', 0, null);
      await first;
      expect(isAnyInitScriptRunning()).toBe(true);
      secondChild.emit('close', 0, null);
      await second;
      expect(isAnyInitScriptRunning()).toBe(false);
    });

    it('drops after a failure, an abort and a timeout', async () => {
      spawnOverrides.push({ match: (cmd) => cmd === 'bad-script', behavior: { exitCode: 1 } });
      await expect(runInitScript('bad-script', '/worktree/path', { timeoutMs: 1000 })).rejects.toThrow();
      expect(isAnyInitScriptRunning()).toBe(false);

      spawnOverrides.push({ match: () => true, behavior: { hang: true } });
      const controller = new AbortController();
      const aborted = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
      expect(isAnyInitScriptRunning()).toBe(true);
      controller.abort();
      await expect(aborted).rejects.toThrow(/external abort/);
      expect(isAnyInitScriptRunning()).toBe(false);

      vi.useFakeTimers();
      const timedOut = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
      const assertion = expect(timedOut).rejects.toThrow(/timeout after 1000ms/);
      expect(isAnyInitScriptRunning()).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(isAnyInitScriptRunning()).toBe(false);
    });

    it('never counts a script that was aborted before it spawned', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(runInitScript('npm install', '/worktree/path', { timeoutMs: 1000, signal: controller.signal })).rejects.toThrow();
      expect(isAnyInitScriptRunning()).toBe(false);
      await expect(whenNoInitScriptRuns()).resolves.toBeUndefined();
    });
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
