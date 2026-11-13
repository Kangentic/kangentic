/**
 * Behavior tests for three handled-error reports that used to be pinned only by
 * source text in error-reporting-feature-gaps.test.ts.
 *
 * What a user loses if these reports go quiet:
 *   - A worktree that cannot be removed stays on disk and is retried at every
 *     startup, indefinitely, and nobody learns that removals are failing.
 *   - A session whose agent session id was never captured cannot be resumed, and
 *     nothing says the capture paths all missed.
 *   - A preload that threw, or a push callback the preload guard caught, leaves a
 *     window broken in a way the renderer's own SDK cannot see.
 *
 * Each test imports the real module, drives the site, and asserts what reached
 * `reportHandledError` (mocked) or the callback. The pure report function for the
 * session id case is covered in agent-launch-report.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrashRecord } from '../../src/shared/types';
import type { AgentParser } from '../../src/shared/types';

type SpawnBehavior = { exitCode: number; stderr?: string };

const hoisted = vi.hoisted(() => ({
  reportHandledError: vi.fn(),
  removeWithRetry: vi.fn(async (_target: string, _options?: unknown): Promise<void> => {}),
  describeWorktreeHolders: vi.fn(
    async (): Promise<Array<{ pid: number; image: string; commandLine: string }>> => [],
  ),
  spawnBehavior: { current: { exitCode: 0 } as SpawnBehavior },
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  appListeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: hoisted.reportHandledError,
}));

// Worktree removal: real git is replaced by a spawn that fails the `worktree remove`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockSpawn = vi.fn((_command: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const isRemove = args[0] === 'worktree' && args[1] === 'remove';
    const behavior: SpawnBehavior = isRemove ? hoisted.spawnBehavior.current : { exitCode: 0 };
    queueMicrotask(() => {
      if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'));
      child.emit('close', behavior.exitCode, null);
    });
    return child;
  });
  return { ...actual, default: { ...actual, spawn: mockSpawn }, spawn: mockSpawn };
});

vi.mock('../../src/main/git/git-client', () => ({
  gitAt: vi.fn(() => ({ raw: vi.fn(async () => '') })),
}));
vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => true),
  isInsideWorktree: vi.fn(() => false),
}));
vi.mock('../../src/main/git/node-modules-link', () => ({
  linkNodeModules: vi.fn(),
  removeNodeModulesPath: vi.fn(),
}));
vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: (target: string, options?: unknown) => hoisted.removeWithRetry(target, options),
  isRemovalTimeoutError: (error: unknown) =>
    error instanceof Error && error.name === 'WorktreeRemovalTimeoutError',
}));
vi.mock('../../src/main/git/zombie-reaper', () => ({
  reapProcessesForWorktree: vi.fn(async () => []),
  describeWorktreeHolders: () => hoisted.describeWorktreeHolders(),
  describeHolder: (holder: { pid: number; image: string }) => `${holder.image} (pid ${holder.pid})`,
}));

// Crash capture: Electron's app and ipcMain are fakes that record what registers.
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    getGPUFeatureStatus: vi.fn(() => ({})),
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      hoisted.appListeners.set(eventName, handler);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      hoisted.ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));
vi.mock('../../src/main/diagnostics/gpu-health', () => ({
  isGpuFaultDeath: vi.fn(() => false),
  recordGpuProcessGone: vi.fn(),
  recordGpuModeObservation: vi.fn(),
}));
vi.mock('../../src/main/diagnostics/linux-gpu-zygote', () => ({
  createLinuxGpuZygoteProbe: vi.fn(() => ({ discover: vi.fn(), snapshot: vi.fn() })),
}));

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'report-behavior-'));
  hoisted.reportHandledError.mockClear();
  hoisted.removeWithRetry.mockReset();
  hoisted.describeWorktreeHolders.mockReset();
  hoisted.describeWorktreeHolders.mockResolvedValue([]);
  hoisted.ipcHandlers.clear();
  hoisted.appListeners.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('worktree removal failure report', () => {
  async function removeFailingWorktree(
    removalProfile: 'fast' | 'moderate' | 'thorough',
    manualRemovalError: Error,
  ): Promise<boolean> {
    const worktreePath = path.join(tempDirectory, '.kangentic', 'worktrees', `task-${removalProfile}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    hoisted.spawnBehavior.current = { exitCode: 1, stderr: 'fatal: unable to remove worktree' };
    hoisted.removeWithRetry.mockRejectedValue(manualRemovalError);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');
    return new WorktreeManager(tempDirectory).removeWorktree(worktreePath, { removalProfile });
  }

  it('reports a removal that fails, tagged with profile, timeout, holders, refusal and platform', async () => {
    const eperm = Object.assign(new TypeError('EPERM: operation not permitted'), { code: 'EPERM' });

    const removed = await removeFailingWorktree('moderate', eperm);

    expect(removed).toBe(false);
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags] = hoisted.reportHandledError.mock.calls[0];
    expect((sent as Error).name).toBe('WorktreeRemovalFailedError');
    expect(tags).toMatchObject({
      source: 'worktree_removal',
      profile: 'moderate',
      timed_out: 'false',
      holders: 'none',
      refused: 'false',
      platform: process.platform,
    });
  });

  it('tags a removal that ran out of budget as timed out', async () => {
    const timeout = new Error('ran out of time');
    timeout.name = 'WorktreeRemovalTimeoutError';

    const removed = await removeFailingWorktree('fast', timeout);

    expect(removed).toBe(false);
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    expect(hoisted.reportHandledError.mock.calls[0][1]).toMatchObject({
      profile: 'fast',
      timed_out: 'true',
    });
  });

  it('tags a removal as held when a process was seen holding the folder', async () => {
    // The reap and the holder scan are skipped under NODE_ENV=test, so run as production.
    vi.stubEnv('NODE_ENV', 'production');
    hoisted.describeWorktreeHolders.mockResolvedValue([{ pid: 4242, image: 'node', commandLine: 'node x' }]);

    await removeFailingWorktree('thorough', new TypeError('EBUSY'));

    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    expect(hoisted.reportHandledError.mock.calls[0][1]).toMatchObject({
      profile: 'thorough',
      holders: 'some',
    });
  });

  it('reports nothing when the removal succeeds', async () => {
    const worktreePath = path.join(tempDirectory, '.kangentic', 'worktrees', 'task-ok');
    fs.mkdirSync(worktreePath, { recursive: true });
    hoisted.spawnBehavior.current = { exitCode: 0 };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');

    const removed = await new WorktreeManager(tempDirectory).removeWorktree(worktreePath);

    expect(removed).toBe(true);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
  });
});

describe('session id not captured', () => {
  function adapterWithCapturePaths(): AgentParser {
    return {
      runtime: { sessionId: { fromOutput: () => null } },
    } as unknown as AgentParser;
  }

  async function armManager(options: { sessionExists: boolean; captured: boolean }) {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSessionIdNotCaptured = vi.fn();
    const { SessionIdManager } = await import('../../src/main/pty/lifecycle/session-id-manager');
    const manager = new SessionIdManager({
      hasAgentSessionId: () => options.captured,
      notifyAgentSessionId: vi.fn(),
      sessionExists: () => options.sessionExists,
      agentSessionIdOf: () => null,
      onSessionIdNotCaptured,
    });
    manager.init('session-1', adapterWithCapturePaths(), tempDirectory, 'claude');
    vi.advanceTimersByTime(30_000);
    return onSessionIdNotCaptured;
  }

  it('calls the callback when no capture path found an id within the window', async () => {
    const callback = await armManager({ sessionExists: true, captured: false });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('session-1');
  });

  it('stays quiet when an id was captured', async () => {
    const callback = await armManager({ sessionExists: true, captured: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it('stays quiet for a session that was removed meanwhile', async () => {
    const callback = await armManager({ sessionExists: false, captured: false });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('crash capture reports', () => {
  function fakeWebContents(type: string): EventEmitter & { getType(): string; getURL(): string } {
    return Object.assign(new EventEmitter(), { getType: () => type, getURL: () => 'about:blank' });
  }

  async function startCapture(): Promise<void> {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    startCrashCapture({
      getProjectRoot: () => tempDirectory,
      gpuHealthFilePath: path.join(tempDirectory, 'gpu-health.json'),
    });
  }

  function attach(webContents: EventEmitter): void {
    const onCreated = hoisted.appListeners.get('web-contents-created');
    expect(onCreated).toBeDefined();
    onCreated!({}, webContents);
  }

  const pushCallbackRecord: CrashRecord = {
    ts: '2026-05-06T12:34:56.789Z',
    kind: 'renderer-window-error',
    source: 'preload',
    message: 'secret text a user wrote',
    stack: 'TypeError\n    at guard (preload.js:1:1)',
    origin: null,
    context: { pushCallback: 'config.onChanged', errorName: 'TypeError' },
    versions: { kangentic: '1.2.3', electron: '1', node: '1', chrome: '1' },
  };

  it('reports a preload error from one of our own windows', async () => {
    await startCapture();
    const windowContents = fakeWebContents('window');
    attach(windowContents);

    windowContents.emit('preload-error', {}, 'preload.js', new TypeError('boom'));

    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags] = hoisted.reportHandledError.mock.calls[0];
    expect((sent as Error).message).toBe('Handled preload failure: TypeError');
    expect(tags).toMatchObject({ kind: 'preload_error', source: 'preload', error_name: 'TypeError' });
  });

  it('does not report a preload error from a webview guest', async () => {
    await startCapture();
    const guestContents = fakeWebContents('webview');
    attach(guestContents);

    guestContents.emit('preload-error', {}, 'preload.js', new TypeError('boom'));

    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a push callback record forwarded by one of our own windows', async () => {
    await startCapture();
    const { IPC } = await import('../../src/shared/ipc-channels');
    const handler = hoisted.ipcHandlers.get(IPC.CRASH_REPORT);
    expect(handler).toBeDefined();

    handler!({ sender: fakeWebContents('window') }, pushCallbackRecord);

    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags, , fingerprint] = hoisted.reportHandledError.mock.calls[0];
    expect((sent as Error).message).not.toContain('secret');
    expect(tags).toMatchObject({ source: 'preload_callback', method: 'config.onChanged' });
    expect(fingerprint).toEqual(['preload-callback', 'config.onChanged']);
  });

  it('does not report a push callback record that came from a webview guest', async () => {
    await startCapture();
    const { IPC } = await import('../../src/shared/ipc-channels');
    const handler = hoisted.ipcHandlers.get(IPC.CRASH_REPORT);

    handler!({ sender: fakeWebContents('webview') }, pushCallbackRecord);

    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
  });
});
