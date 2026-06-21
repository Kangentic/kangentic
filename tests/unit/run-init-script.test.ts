/**
 * Unit tests for runInitScript -- the cross-platform runner for the
 * git.initScript "Post-Worktree Script". Mirrors the hoisted node:child_process
 * spawn mock used by worktree-manager.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// spawn mock. Records calls and lets each test configure the child's outcome:
// a clean close(exitCode), captured stdout/stderr, or `hang` (never closes) so
// abort/timeout can be exercised by aborting the signal passed to spawn.
//
// `closeAfterAbort`: when set, the mock also fires a subsequent 'close' event
// after the AbortError 'error' event, with { code: null, signal: 'SIGTERM' }.
// This exercises the real Node behaviour where both events fire on abort/kill.
//
// `nullClose`: when set, fires close(null, null) - a Windows cmd.exe wrapper
// that exits without a numeric code or signal name.
//
// vi.hoisted() so these exist before vi.mock() runs.
const { mockSpawn, recordedSpawnCalls, spawnOverrides } = vi.hoisted(() => {
  const recordedSpawnCalls: Array<{ command: string; options: { cwd?: string; shell?: boolean; windowsHide?: boolean } }> = [];
  const spawnOverrides: Array<{
    match: (command: string) => boolean;
    behavior: { exitCode?: number; stderr?: string; stdout?: string; hang?: boolean; closeAfterAbort?: boolean; nullClose?: boolean };
  }> = [];

  const mockSpawn = vi.fn((command: string, options: { cwd?: string; shell?: boolean; windowsHide?: boolean; signal?: AbortSignal }) => {
    recordedSpawnCalls.push({ command, options });
    const override = spawnOverrides.find((entry) => entry.match(command));
    const behavior = override?.behavior ?? { exitCode: 0 };

    const EventEmitter = require('node:events').EventEmitter;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });

    // Simulate Node's spawn: aborting the signal kills the child with an
    // AbortError 'error' event (this is what runInitScript's timeout and
    // external-cancellation paths rely on).
    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        child.emit('error', abortError);
        // Real Node also fires 'close' after 'error' when a kill-by-signal
        // terminates the child. closeAfterAbort tests that the Promise settles
        // exactly once (with the abort reason, not the 'killed by signal' branch)
        // when both events fire in the same microtask.
        if (behavior.closeAfterAbort) {
          child.emit('close', null, 'SIGTERM');
        }
      });
    }

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

  return { mockSpawn, recordedSpawnCalls, spawnOverrides };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { runInitScript } from '../../src/main/git/run-init-script';

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

  it('settles exactly once with the abort reason when both error and close fire (double-settle path)', async () => {
    // Real Node fires 'error' (AbortError) then 'close' (null, 'SIGTERM') when
    // the internal AbortController kills the child. The Promise must settle with
    // the abort/timeout message (from 'error'), not the "killed by signal SIGTERM"
    // message (from 'close'), and must not throw an unhandled rejection.
    // closeAfterAbort=true makes the mock emit 'close' immediately after 'error'.
    spawnOverrides.push({ match: () => true, behavior: { hang: true, closeAfterAbort: true } });
    const controller = new AbortController();

    const promise = runInitScript('npm install', '/worktree/path', { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();

    // The abort reason must win, not "killed by signal SIGTERM".
    await expect(promise).rejects.toThrow(/external abort/);
    // The 'close' branch's competing rejection (if it fired) would produce a
    // different message; asserting the abort message is present confirms the
    // first-settler wins and no crash from a double-reject occurred.
  });

  it('settles exactly once with the timeout reason when both error and close fire on timeout', async () => {
    // Same double-event scenario but driven by the internal timeout (not external
    // signal): after the wall-clock fires, the internal AbortController kills the
    // child, which emits AbortError then close(null, SIGTERM). The Promise must
    // settle with the "timeout after Nms" message, not "killed by signal SIGTERM".
    vi.useFakeTimers();
    spawnOverrides.push({ match: () => true, behavior: { hang: true, closeAfterAbort: true } });

    const promise = runInitScript('slow-script', '/worktree/path', { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
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
