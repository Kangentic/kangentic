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
  trackEvent: vi.fn(),
  removeWithRetry: vi.fn(async (_target: string, _options?: unknown): Promise<void> => {}),
  /** Whether the node_modules link was left in place, which refuses the removal. */
  removeNodeModulesPath: vi.fn(async (_target: string, _options?: unknown): Promise<boolean> => false),
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

// The Aptabase count a removal sends in place of a report.
vi.mock('../../src/main/analytics/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/analytics')>()),
  trackEvent: hoisted.trackEvent,
}));

// The session-id report asks whether `node` is on PATH; answer at once, as a machine with node would.
vi.mock('which', () => ({ default: Object.assign(async () => '/usr/local/bin/node', { sync: () => '/usr/local/bin/node' }) }));

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
  removeNodeModulesPath: (target: string, options?: unknown) => hoisted.removeNodeModulesPath(target, options),
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
  hoisted.trackEvent.mockClear();
  hoisted.removeWithRetry.mockReset();
  hoisted.removeNodeModulesPath.mockReset();
  hoisted.removeNodeModulesPath.mockResolvedValue(false);
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
  function worktreePathFor(removalProfile: string): string {
    return path.join(tempDirectory, '.kangentic', 'worktrees', `task-${removalProfile}`);
  }

  async function removeFailingWorktree(
    removalProfile: 'fast' | 'moderate' | 'thorough',
    manualRemovalError: Error,
    options: Omit<import('../../src/main/git/worktree-manager').WorktreeRemovalOptions, 'removalProfile'> = {},
  ): Promise<boolean> {
    const worktreePath = worktreePathFor(removalProfile);
    fs.mkdirSync(worktreePath, { recursive: true });
    hoisted.spawnBehavior.current = { exitCode: 1, stderr: 'fatal: unable to remove worktree' };
    hoisted.removeWithRetry.mockRejectedValue(manualRemovalError);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');
    return new WorktreeManager(tempDirectory).removeWorktree(worktreePath, { removalProfile, ...options });
  }

  /** An EBUSY as Node's fs raises it, with the syscall and the path it failed on. */
  function busyError(syscall: string, failedPath: string): Error {
    return Object.assign(new Error(`EBUSY: resource busy or locked, ${syscall} '${failedPath}'`), { code: 'EBUSY', syscall, path: failedPath });
  }

  // Sentry DESKTOP-3P: 15 events, every one EBUSY on Windows, from folders the
  // task's own reap had left a process working in.
  it('counts a removal the task\'s reap left a process in, and reports nothing', async () => {
    const removed = await removeFailingWorktree('moderate', busyError('rmdir', worktreePathFor('moderate')), {
      caller: 'done_fallback',
      reapLeftRunning: true,
    });

    expect(removed).toBe(false);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(hoisted.trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'worktree_removal',
      reason: 'reap_left_running',
      caller: 'done_fallback',
      profile: 'moderate',
      errno: 'EBUSY',
    }));
  });

  it('still reports a failure with nothing left there, with its caller, the part of the folder and the syscall', async () => {
    const lockedFile = path.join(worktreePathFor('moderate'), 'node_modules', '.bin', 'vite');

    await removeFailingWorktree('moderate', busyError('unlink', lockedFile), { caller: 'cleanup', reapLeftRunning: false });

    expect(hoisted.trackEvent).not.toHaveBeenCalledWith('app_error', expect.objectContaining({ source: 'worktree_removal' }));
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    const tags = hoisted.reportHandledError.mock.calls[0][1] as Record<string, string>;
    expect(tags).toMatchObject({ caller: 'cleanup', path_class: 'node_modules', syscall: 'unlink' });
    // The path never leaves: it holds the task's folder name.
    expect(JSON.stringify(tags)).not.toContain('task-moderate');
  });

  it('names the folder itself and its .git apart from the rest', async () => {
    const { removalPathClassOf, removalSyscallOf } = await import('../../src/main/git/worktree-manager');
    const worktreePath = worktreePathFor('classes');

    expect(removalPathClassOf(worktreePath, worktreePath)).toBe('root');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, '.git', 'index.lock'))).toBe('.git');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, 'packages', 'web', 'node_modules', 'x'))).toBe('node_modules');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, 'src', 'index.ts'))).toBe('other');
    expect(removalPathClassOf(worktreePath, path.join(tempDirectory, 'elsewhere'))).toBe('other');
    expect(removalPathClassOf(worktreePath, undefined)).toBe('none');
    expect(removalSyscallOf('rmdir')).toBe('rmdir');
    expect(removalSyscallOf('something we never call')).toBe('other');
    expect(removalSyscallOf(undefined)).toBe('none');
  });

  it('reads the syscall and part of the folder off the error a timeout wraps', async () => {
    // A timed-out manual removal rejects with the timeout error, and the failure
    // that was in flight (an EBUSY on a locked file) rides on its cause.
    const lockedFile = path.join(worktreePathFor('fast'), 'node_modules', '.bin', 'vite');
    const timeout = new Error('ran out of time', { cause: busyError('unlink', lockedFile) });
    timeout.name = 'WorktreeRemovalTimeoutError';

    await removeFailingWorktree('fast', timeout, { caller: 'cleanup' });

    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    expect(hoisted.reportHandledError.mock.calls[0][1]).toMatchObject({
      timed_out: 'true',
      syscall: 'unlink',
      path_class: 'node_modules',
    });
  });

  it('counts a child folder whose name starts with two dots as inside the worktree', async () => {
    const { removalPathClassOf } = await import('../../src/main/git/worktree-manager');
    const worktreePath = worktreePathFor('dots');

    expect(removalPathClassOf(worktreePath, path.join(worktreePath, '..cache', 'node_modules', 'x'))).toBe('node_modules');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, '..cache', 'x'))).toBe('other');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, '..', 'sibling'))).toBe('other');
    expect(removalPathClassOf(worktreePath, path.join(worktreePath, '..', 'sibling', 'node_modules', 'x'))).toBe('other');
  });

  it('tags a removal with no caller named as other', async () => {
    await removeFailingWorktree('moderate', busyError('rmdir', worktreePathFor('moderate')));

    expect(hoisted.reportHandledError.mock.calls[0][1]).toMatchObject({ caller: 'other', path_class: 'root', syscall: 'rmdir' });
  });

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

  // Sentry DESKTOP-3P on 0.63.0: a Done move's own removal and its delayed retry, 18 s
  // apart, both EBUSY on the folder's own rmdir with no holder seen, no timeout, no
  // refusal, and nothing the reap left there. No probe can say who held it, so another
  // event of that shape cannot point at anything new. Every neighbor still reports.
  describe('a Done removal no probe can explain', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

    function stubPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
    });

    /** The `worktree_removal` counts sent to Aptabase in place of a report. */
    function removalCounts(): unknown[] {
      return hoisted.trackEvent.mock.calls
        .filter((call) => call[0] === 'app_error' && (call[1] as Record<string, string>).source === 'worktree_removal')
        .map((call) => call[1]);
    }

    /** The folder's own rmdir refused while something holds it, as on Windows. */
    function rootBusy(): Error {
      return busyError('rmdir', worktreePathFor('moderate'));
    }

    it.each(['done_fallback', 'done_retry_delayed'] as const)('counts %s and reports nothing', async (caller) => {
      stubPlatform('win32');

      const removed = await removeFailingWorktree('moderate', rootBusy(), { caller, reapLeftRunning: false });

      expect(removed).toBe(false);
      expect(hoisted.reportHandledError).not.toHaveBeenCalled();
      expect(removalCounts()).toEqual([expect.objectContaining({
        reason: 'no_holder_seen',
        caller,
        profile: 'moderate',
        errno: 'EBUSY',
        platform: 'win32',
      })]);
    });

    // The reap-left-running count is checked first. Stubbing win32 makes the shape also
    // match the no-holder count, so swapping the two branches would change the reason.
    it.each(['done_fallback', 'done_retry_delayed'] as const)('counts %s as a reap leftover, not as an unexplained hold', async (caller) => {
      stubPlatform('win32');

      const removed = await removeFailingWorktree('moderate', rootBusy(), { caller, reapLeftRunning: true });

      expect(removed).toBe(false);
      expect(hoisted.reportHandledError).not.toHaveBeenCalled();
      expect(removalCounts()).toEqual([expect.objectContaining({ reason: 'reap_left_running', caller })]);
    });

    type Neighbor = {
      name: string;
      platform?: NodeJS.Platform;
      caller?: import('../../src/main/git/worktree-manager').WorktreeRemovalCaller;
      error?: () => Error;
      arrange?: () => void;
      /** The report's tag that shows this neighbor's one condition really differed. */
      tags?: Record<string, string>;
    };

    const neighbors: Neighbor[] = [
      {
        name: 'another errno',
        error: () => Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'rmdir', path: worktreePathFor('moderate') }),
        tags: { errno: 'EPERM', path_class: 'root' },
      },
      {
        name: 'a holder seen',
        arrange: () => {
          // The holder scan is skipped under NODE_ENV=test, so run as production.
          vi.stubEnv('NODE_ENV', 'production');
          hoisted.describeWorktreeHolders.mockResolvedValue([{ pid: 4242, image: 'node', commandLine: 'node x' }]);
        },
        tags: { holders: 'some' },
      },
      {
        name: 'a timeout',
        error: () => Object.assign(new Error('ran out of time', { cause: rootBusy() }), { name: 'WorktreeRemovalTimeoutError' }),
        tags: { timed_out: 'true', errno: 'EBUSY', path_class: 'root' },
      },
      {
        name: 'the .git path class',
        error: () => busyError('unlink', path.join(worktreePathFor('moderate'), '.git', 'index.lock')),
        tags: { path_class: '.git' },
      },
      {
        name: 'the node_modules path class',
        error: () => busyError('unlink', path.join(worktreePathFor('moderate'), 'node_modules', '.bin', 'vite')),
        tags: { path_class: 'node_modules' },
      },
      {
        // Only the folder's own rmdir is counted: a held file elsewhere in it names a part to look at.
        name: 'another file in the folder',
        error: () => busyError('unlink', path.join(worktreePathFor('moderate'), 'src', 'index.ts')),
        tags: { path_class: 'other' },
      },
      {
        name: 'an EBUSY that names no path',
        error: () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
        tags: { errno: 'EBUSY', path_class: 'none' },
      },
      { name: 'the startup retry', caller: 'startup_retry' },
      { name: 'a cleanup', caller: 'cleanup' },
      { name: 'no caller named', caller: 'other' },
      { name: 'a retry after a Stop', caller: 'done_retry_stop' },
      { name: 'a retry after a recheck', caller: 'done_retry_recheck' },
      { name: 'a retry after a late reap', caller: 'done_retry_late_reap' },
      { name: 'macOS', platform: 'darwin', tags: { platform: 'darwin' } },
      { name: 'Linux', platform: 'linux', tags: { platform: 'linux' } },
      {
        // A refused attempt never reaches the delete, so it carries no errno either.
        name: 'a refusal (which has no errno)',
        arrange: () => hoisted.removeNodeModulesPath.mockResolvedValue(true),
        tags: { refused: 'true' },
      },
    ];

    it.each(neighbors)('still reports $name', async ({ platform = 'win32', caller = 'done_fallback', error = rootBusy, arrange, tags = {} }) => {
      stubPlatform(platform);
      arrange?.();

      const removed = await removeFailingWorktree('moderate', error(), { caller, reapLeftRunning: false });

      expect(removed).toBe(false);
      expect(removalCounts()).toEqual([]);
      expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
      expect(hoisted.reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'worktree_removal', caller, ...tags });
    });
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
      manager.noteCaptured('session-1', 'hook');
    };
    /** The agent's first Prompt event, as SessionManager's `onEvent` stamps it on the row. */
    const prompt = (): void => {
      session.promptObservedAt ??= Date.now();
    };
    const sent = async (): Promise<Array<[Error, Record<string, string>]>> => {
      await vi.advanceTimersByTimeAsync(0);
      return hoisted.reportHandledError.mock.calls.map((call) => [call[0] as Error, call[1] as Record<string, string>]);
    };
    return { manager, state, capture, prompt, sent };
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

  // Sentry DESKTOP-36 on 0.62.0: a terminal no one typed into made no conversation, so it
  // had no id to miss. Its store reads absent for this session, and nothing is sent.
  it('reports nothing for a session no prompt reached and whose store holds no conversation of its own', async () => {
    const { manager, sent } = await armManager({ storeEvidence: async () => 'absent' });
    await vi.advanceTimersByTimeAsync(31_000);
    manager.removeSession('session-1');

    expect(await sent()).toEqual([]);
  });

  it('still reports a session a prompt reached that gave no id, though its store reads absent', async () => {
    const { manager, prompt, sent } = await armManager({ storeEvidence: async () => 'absent' });
    await vi.advanceTimersByTimeAsync(31_000);
    prompt();
    manager.removeSession('session-1');

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ prompt_seen: 'yes', id_store: 'absent' });
  });

  it('reports a session removed with no id as not captured, with the facts that say why', async () => {
    const { manager, sent } = await armManager({ storeEvidence: async () => 'present' });
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
      create_chat: 'unknown',
      prompt_seen: 'no',
      hook_seen: 'no',
      agent_started: 'no',
      first_output: 'no',
      settled_by: 'removed',
      session_status: 'running',
      agent_ran_for_s: 'not_run',
      fs_scan: 'none',
      id_store: 'present',
      login: 'unknown',
      node_on_path: 'yes',
      hook_load: 'unknown',
    });
  });

  // Sentry DESKTOP-4C: a terminal started with no prompt, whose first prompt
  // came minutes in with the id right behind it, was counted late against its
  // spawn. Main reads a batch's ids ahead of its events, so the id lands first.
  it('sends nothing for a session with no opening prompt whose id came with its first prompt, minutes in', async () => {
    const { capture, prompt, sent } = await armManager();
    await vi.advanceTimersByTimeAsync(180_000);
    capture('0199a0b2-1111-2222-3333-444455556666');
    prompt();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(await sent()).toEqual([]);
  });

  it('still reports that capture as late when no prompt came with it', async () => {
    const { capture, sent } = await armManager();
    await vi.advanceTimersByTimeAsync(180_000);
    capture('0199a0b2-1111-2222-3333-444455556666');
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][0].name).toBe('AgentSessionIdCapturedLateError');
    expect(reports[0][1]).toMatchObject({ opening_prompt: 'none', captured_after_s: '60-300', prompt_seen: 'no', after_prompt_s: 'none' });
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

  // Sentry DESKTOP-45 and DESKTOP-3A: both runs had no opening prompt and
  // reached the ceiling, and the report could not say whether anyone ever sent
  // the agent a prompt. With none, the agent may never have made a conversation,
  // so there is nothing to resume.
  it('says no prompt was seen for a session with no opening prompt that never took one', async () => {
    const { sent } = await armManager();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ opening_prompt: 'none', settled_by: 'ceiling', prompt_seen: 'no' });
  });

  it('says a prompt was seen when one arrived after the window, before the ceiling', async () => {
    const { prompt, sent } = await armManager();
    await vi.advanceTimersByTimeAsync(60_000);
    prompt();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const reports = await sent();
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ opening_prompt: 'none', settled_by: 'ceiling', prompt_seen: 'yes' });
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
