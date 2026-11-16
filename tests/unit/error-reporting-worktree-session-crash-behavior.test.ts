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
import type { AgentParser, CrashRecord, SessionIdStoreEvidence } from '../../src/shared/types';

type SpawnBehavior = { exitCode: number; stderr?: string };

const hoisted = vi.hoisted(() => ({
  reportHandledError: vi.fn(),
  removeWithRetry: vi.fn(async (_target: string, _options?: unknown): Promise<void> => {}),
  describeWorktreeHolders: vi.fn(
    async (): Promise<Array<{ pid: number; image: string; commandLine: string }>> => [],
  ),
  spawnBehavior: { current: { exitCode: 0 } as SpawnBehavior },
  ipcHandlers: new Map<string, (event: unknown, ...handlerArguments: unknown[]) => unknown>(),
  appListeners: new Map<string, (...listenerArguments: unknown[]) => unknown>(),
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: hoisted.reportHandledError,
}));

// Worktree removal: real git is replaced by a spawn that fails the `worktree remove`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockSpawn = vi.fn((_command: string, commandArguments: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const isRemove = commandArguments[0] === 'worktree' && commandArguments[1] === 'remove';
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
    on: vi.fn((eventName: string, handler: (...listenerArguments: unknown[]) => unknown) => {
      hoisted.appListeners.set(eventName, handler);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...handlerArguments: unknown[]) => unknown) => {
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
  fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  // Sentry DESKTOP-36 and DESKTOP-3A reported at the 30 s window whether or not
  // an id arrived after it. These drive the real SessionIdManager into the real
  // reports, wired as SessionManager wires them, and read what was sent.
  function adapterWithCapturePaths(storeEvidence?: () => Promise<SessionIdStoreEvidence>): AgentParser {
    return {
      runtime: { sessionId: { fromOutput: () => null, ...(storeEvidence ? { storeEvidence } : {}) } },
    } as unknown as AgentParser;
  }

  async function armManager(options: { sessionExists?: boolean; storeEvidence?: () => Promise<SessionIdStoreEvidence> } = {}) {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { SessionIdManager } = await import('../../src/main/pty/lifecycle/session-id-manager');
    const report = await import('../../src/main/pty/agent-launch-report');
    report.resetLaunchReports();
    const agentParser = adapterWithCapturePaths(options.storeEvidence);
    const session = {
      id: 'session-1',
      agentName: 'codex',
      agentCliVersion: '0.169.0 (Codex CLI)',
      startPath: 'board',
      openingPrompt: 'none',
      shell: '/bin/zsh',
      commandCwd: tempDirectory,
      status: 'running',
      agentParser,
    } as unknown as import('../../src/main/pty/session-registry').ManagedSession;
    const state = { agentSessionId: null as string | null, exists: options.sessionExists ?? true };
    const manager = new SessionIdManager({
      hasAgentSessionId: () => state.agentSessionId !== null,
      notifyAgentSessionId: vi.fn(),
      sessionExists: () => state.exists,
      agentSessionIdOf: () => state.agentSessionId,
      onCaptureWindowPassed: () => {
        const storeEvidence = agentParser.runtime?.sessionId?.storeEvidence;
        report.noteSessionIdCaptureWindowPassed(session, storeEvidence ? () => storeEvidence({ cwd: tempDirectory }) : null);
      },
      onCaptureOutcome: (id, outcome) => report.reportSessionIdCaptureOutcome(id, outcome, state.exists ? 'running' : null),
    });
    manager.init('session-1', agentParser, tempDirectory, 'codex');
    /** An id arriving, as SessionManager's `onAgentSessionId` takes it. */
    const capture = (id: string): void => {
      state.agentSessionId = id;
      manager.noteCaptured('session-1');
    };
    const sent = async (): Promise<Array<[Error, Record<string, string>]>> => {
      await vi.advanceTimersByTimeAsync(0);
      return hoisted.reportHandledError.mock.calls.map((call) => [call[0] as Error, call[1] as Record<string, string>]);
    };
    return { manager, state, capture, sent };
  }

  beforeEach(() => {
    hoisted.reportHandledError.mockClear();
  });

  it('reports nothing at the window, since an id can still arrive', async () => {
    const { sent } = await armManager();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await sent()).toEqual([]);
  });

  it('reads an id captured at 35 s as late, never as not captured', async () => {
    const { capture, manager, sent } = await armManager();
    await vi.advanceTimersByTimeAsync(35_000);
    capture('0199a0b2-1111-2222-3333-444455556666');
    manager.removeSession('session-1');
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][0].name).toBe('AgentSessionIdCapturedLateError');
    expect(reports[0][1]).toMatchObject({ agent: 'codex', captured_after_s: '30-60', start_path: 'board', opening_prompt: 'none' });
  });

  it('reports a session removed with no id as not captured, with the facts that say why', async () => {
    const { manager, sent } = await armManager({ storeEvidence: async () => 'absent' });
    await vi.advanceTimersByTimeAsync(31_000);
    manager.removeSession('session-1');

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][0].name).toBe('AgentSessionIdNotCapturedError');
    expect(reports[0][1]).toEqual({
      source: 'agent_session_id',
      agent: 'codex',
      agent_cli_version: '0.169.0',
      start_path: 'board',
      shell: 'zsh',
      opening_prompt: 'none',
      hook_seen: 'no',
      agent_started: 'no',
      first_output: 'no',
      settled_by: 'removed',
      session_status: 'running',
      fs_scan: 'none',
      id_store: 'absent',
    });
  });

  it('reports a session still without an id at the ceiling, though its PTY exited and its row stayed', async () => {
    const { manager, sent } = await armManager();
    await vi.advanceTimersByTimeAsync(31_000);
    manager.clearDiagnostic('session-1');
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ settled_by: 'ceiling', id_store: 'unknown' });
  });

  it('stays quiet when an id arrived within the window, or the session was removed before it', async () => {
    const captured = await armManager();
    captured.capture('0199a0b2-1111-2222-3333-444455556666');
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(await captured.sent()).toEqual([]);

    const removed = await armManager({ sessionExists: false });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(await removed.sent()).toEqual([]);
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
