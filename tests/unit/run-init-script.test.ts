/**
 * Unit tests for runInitScript -- the cross-platform runner for the
 * git.initScript "Post-Worktree Script". Mirrors the hoisted node:child_process
 * spawn mock used by worktree-manager.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// spawn mock. Records calls and lets each test configure the child's outcome:
// a clean close(exitCode), captured stdout/stderr, or `hang` (never closes) so
// abort/timeout can be exercised by aborting the signal passed to spawn.
// vi.hoisted() so these exist before vi.mock() runs.
const { mockSpawn, recordedSpawnCalls, spawnOverrides } = vi.hoisted(() => {
  const recordedSpawnCalls: Array<{ command: string; options: { cwd?: string; shell?: boolean; windowsHide?: boolean } }> = [];
  const spawnOverrides: Array<{
    match: (command: string) => boolean;
    behavior: { exitCode?: number; stderr?: string; stdout?: string; hang?: boolean };
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
      });
    }

    if (!behavior.hang) {
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
});
