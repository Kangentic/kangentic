/**
 * Tests for the idle-timeout listener in registerSessionHandlers.
 *
 * A task's agent that sat idle past the timeout is paused through
 * `pauseTaskSession`, the Pause button's own path, recorded as Kangentic's
 * pause (`'auto'`). That pause is held: neither a restart nor a column move
 * starts the task again until the user resumes it. The record is written
 * BEFORE the PTY goes down. The sweep used to suspend the registry first and
 * write the row later from this listener, so a quit in that gap left the
 * record `running` and the next launch resumed the agent.
 * These tests verify:
 *
 *   #6 - When projectId is resolvable, the listener:
 *        - marks the record suspended with 'auto', then suspends the PTY
 *        - cancels the task's pending keystrokes
 *        - clears task.session_id
 *        - sends SESSION_IDLE_TIMEOUT to the renderer once the pause landed
 *        - declines, writing nothing, when the agent went back to work
 *        - declines, writing nothing, while text is typed into the prompt
 *          (whitespace alone does not hold the pause off)
 *        - queues ONE pause per session while a sweep fire waits on the task
 *          lock, and accepts a later fire once that pause settled
 *
 *   #7 - When projectId is missing (getSessionProjectId returns undefined):
 *        - renderer still receives SESSION_IDLE_TIMEOUT
 *        - withTaskLock is NOT entered (no DB writes, no cancel)
 *        - a task session is still suspended
 *        - a Command Terminal is dropped with no announce and no suspend,
 *          with or without a project: the sweep never times one out (a
 *          suspend would end it), so a late report must not mark it paused
 *
 * Mock strategy mirrors split-lock-cas.test.ts:
 *   - electron and ipcMain are mocked so registerSessionHandlers can be called
 *     without a real Electron process
 *   - sessionManager.on is mocked with a Map to capture event handlers
 *   - withTaskLock from task-lifecycle-lock.ts is the REAL implementation so
 *     the lock semantics are testable
 *   - DB helpers, repositories, and session-lifecycle functions are mocked
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, SessionRecord } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

const capturedIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedIpcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// SessionRepository mock: getLatestForTask is driven by mockGetLatestForTask
// which is set per-test in beforeEach. All other methods are stubs.
const mockGetLatestForTask = vi.fn(() => null as SessionRecord | null);
const mockMarkLaunchFailed = vi.fn();
const mockSetStartBlockedReason = vi.fn();

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    markLaunchFailed = mockMarkLaunchFailed;
    setStartBlockedReason = mockSetStartBlockedReason;
    // No own-record row, so applySuspendDbWrites falls back to getLatestForTask.
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

// TaskRepository.getById is what the startup-failure notice reads the task from.
// Null by default; the agent-never-started tests arrange a task.
const mockTaskRepositoryGetById = vi.fn((_taskId?: string) => null as { id: string; title: string } | null);

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskRepositoryGetById;
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
  settleQueuedRecord: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => {});
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

// getProjectRepos is configured per-test.
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
}));

const mockResumeTaskSession = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/handlers/session-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/session-resume')>()),
  resumeTaskSession: mockResumeTaskSession,
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { AgentCwdMissingError } from '../../src/main/pty/spawn/pty-spawn';
import { IPC } from '../../src/shared/ipc-channels';
import { markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';
import { notifySpawnBlocked } from '../../src/main/ipc/helpers';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import { abortInFlightResume, isResumeInFlight, registerResumeController, releaseResumeController } from '../../src/main/ipc/handlers/session-resume-controllers';
import { forgetWorkflowRecovery, resetWorkflowRecoveryForTests, setRecoveryEntry } from '../../src/main/workflows/workflow-recovery-state';

// Recovery state is module-level: an entry a failed test left behind, with its
// hour-long timer, must not reach the next test.
afterEach(() => {
  resetWorkflowRecoveryForTests();
});

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => [] as Session[]),
      getSession: vi.fn((_sessionId?: string) => null as Session | null),
      // Read by reconcileTaskSessionRef's heal-by-taskId fallback.
      findLiveSessionByTaskId: vi.fn(() => undefined),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null as string | null | undefined),
      // Read by the "Agent did not start" notice of a launch that never started.
      getSessionAgentName: vi.fn(() => null as string | null),
      getRawScrollback: vi.fn(async () => ''),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      // Called by the agent-never-started listener when its pause does not land.
      retireAgentlessSession: vi.fn(),
      // The agent-start-refused listener's two ends: why, or no pause to hold it.
      markStartBlocked: vi.fn(),
      retireRefusedStart: vi.fn(),
      // Read when a pause settles a queued record.
      isResuming: vi.fn(() => false),
      // Whether the launch gets its one retry. No, unless a test says so.
      mayRetryLaunch: vi.fn((_sessionId?: string) => false),
      // What the report found in the launch's output. Nothing, unless a test says so.
      launchOutputClass: vi.fn(async (_sessionId?: string) => undefined as string | undefined),
      noteAgentExitedAtStart: vi.fn(),
      getActivityCache: vi.fn((): Record<string, string> => ({})),
      // Read by the idle pause's eligibility re-check: typed text holds it off.
      getPendingDraft: vi.fn((_sessionId?: string) => null as string | null),
      getActivityCacheForProject: vi.fn(() => ({})),
      getUsageCache: vi.fn(() => ({})),
      getUsageCacheForProject: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      getEventsCacheForProject: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      setFocusedSessions: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
    },
    terminalSubmitScheduler: {
      scheduleKeystrokes: vi.fn(),
      cancel: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

/**
 * Drain the withTaskLock PQueue by polling until a condition is met or a
 * maximum number of microtask ticks have been consumed. PQueue uses microtasks
 * internally so repeated `await Promise.resolve()` yields to pending work.
 */
async function drainUntil(
  condition: () => boolean,
  maxTicks = 50,
): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (condition()) return;
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// A launch that never started pauses its task, so Resume is there to press
// ---------------------------------------------------------------------------

describe('agent-never-started listener', () => {
  const NEVER_STARTED_SESSION = {
    id: 'sess-never',
    taskId: 'task-never',
    transient: false,
    status: 'running',
    projectId: 'proj-1',
  } as Session;

  function registerWithLiveSession(liveSessionId: string): ReturnType<typeof createMockContext> {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    mockGetLatestForTask.mockReturnValue({
      id: 'record-never',
      task_id: 'task-never',
      agent_session_id: 'agent-never',
      status: 'running',
      suspended_by: null,
    } as SessionRecord);
    mockGetProjectRepos.mockReturnValue({
      tasks: {
        getById: vi.fn(() => ({ id: 'task-never', session_id: liveSessionId, swimlane_id: 'lane-doing' })),
        update: vi.fn(),
      },
      swimlanes: { getById: vi.fn(() => null) },
    });
    const context = createMockContext();
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    context.sessionManager.getSession.mockImplementation((sessionId?: string) => (
      sessionId === liveSessionId ? ({ ...NEVER_STARTED_SESSION, id: liveSessionId } as Session) : null
    ));
    mockTaskRepositoryGetById.mockReturnValue(null);
    registerSessionHandlers(context as never);
    return context;
  }

  const NEVER_STARTED_FALLBACK = 'The agent never reported that it started.';

  async function fireNeverStarted(): Promise<void> {
    capturedSessionEventHandlers.get('agent-never-started')?.('sess-never', NEVER_STARTED_SESSION);
    await withTaskLock('task-never', async () => {});
  }

  it('retries once on a fresh PTY after the pause, and holds the notice for its outcome', async () => {
    const context = registerWithLiveSession('sess-never');
    context.sessionManager.mayRetryLaunch.mockReturnValue(true);
    mockResumeTaskSession.mockResolvedValue(null);
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();

    await vi.waitFor(() => expect(mockResumeTaskSession).toHaveBeenCalledTimes(1));
    expect(mockResumeTaskSession).toHaveBeenCalledWith(context, 'task-never', { projectId: 'proj-1', startPath: 'retry', onFailed: expect.any(Function) });
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-never');
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('raises the notice when the retry could not start', async () => {
    const context = registerWithLiveSession('sess-never');
    context.sessionManager.mayRetryLaunch.mockReturnValue(true);
    // The real function reports a failed start through onFailed, then rejects.
    mockResumeTaskSession.mockImplementation(async (_context: unknown, _taskId: string, options: { onFailed?: () => void }) => {
      options.onFailed?.();
      throw new Error('Worktree setup failed');
    });
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
  });

  it('raises no notice when the retry is refused (rejects without onFailed)', async () => {
    const context = registerWithLiveSession('sess-never');
    context.sessionManager.mayRetryLaunch.mockReturnValue(true);
    // A task moved to To Do or Done is refused: the user's answer, not a failure.
    mockResumeTaskSession.mockRejectedValue(new Error('Task is in To Do'));
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fireNeverStarted();

    await vi.waitFor(() => expect(mockResumeTaskSession).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('does not retry, and raises the notice, when a Pause aborts the retry window', async () => {
    const context = registerWithLiveSession('sess-never');
    context.sessionManager.mayRetryLaunch.mockImplementation(async () => {
      abortInFlightResume('task-never');
      return true;
    });
    mockResumeTaskSession.mockResolvedValue(null);
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    expect(mockResumeTaskSession).not.toHaveBeenCalled();
  });

  it('neither retries nor raises the notice while another start is in flight', async () => {
    const context = registerWithLiveSession('sess-never');
    const otherStart = new AbortController();
    context.sessionManager.mayRetryLaunch.mockImplementation(async () => {
      registerResumeController('task-never', otherStart);
      return true;
    });
    mockResumeTaskSession.mockResolvedValue(null);
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    try {
      await fireNeverStarted();

      await vi.waitFor(() => expect(context.sessionManager.mayRetryLaunch).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
      expect(notifySpawnBlocked).not.toHaveBeenCalled();
      // The other start's controller is still its own.
      expect(isResumeInFlight('task-never')).toBe(true);
    } finally {
      releaseResumeController('task-never', otherStart);
    }
  });

  describe('the controller the listener registers is released', () => {
    async function fireAndExpectReleased(): Promise<void> {
      capturedSessionEventHandlers.get('agent-never-started')?.('sess-never', NEVER_STARTED_SESSION);
      // Registered synchronously by the listener, before the pause.
      expect(isResumeInFlight('task-never')).toBe(true);
      await withTaskLock('task-never', async () => {});
      await vi.waitFor(() => expect(isResumeInFlight('task-never')).toBe(false));
    }

    it('after a retry', async () => {
      const context = registerWithLiveSession('sess-never');
      context.sessionManager.mayRetryLaunch.mockReturnValue(true);
      mockResumeTaskSession.mockResolvedValue(null);

      await fireAndExpectReleased();
      expect(mockResumeTaskSession).toHaveBeenCalledTimes(1);
    });

    it('after a skipped retry', async () => {
      registerWithLiveSession('sess-never');
      mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

      await fireAndExpectReleased();
    });

    it('after a declined pause', async () => {
      // The task's live session is a newer one, so the pause is declined.
      const context = registerWithLiveSession('sess-newer');
      context.sessionManager.mayRetryLaunch.mockReturnValue(true);

      await fireAndExpectReleased();
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
    });

    it('after a pause that throws', async () => {
      const context = registerWithLiveSession('sess-never');
      context.sessionManager.mayRetryLaunch.mockReturnValue(true);
      context.sessionManager.suspend.mockRejectedValue(new Error('suspend failed'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await fireAndExpectReleased();
    });
  });

  it('does not retry a launch the manager says may not', async () => {
    registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    expect(mockResumeTaskSession).not.toHaveBeenCalled();
  });

  it('marks a fresh launch failed before its PTY goes down, so a Resume starts it fresh', async () => {
    const context = registerWithLiveSession('sess-never');
    let markedBeforeSuspend = false;
    context.sessionManager.suspend.mockImplementation(async () => {
      markedBeforeSuspend = mockMarkLaunchFailed.mock.calls.length === 1;
    });

    await fireNeverStarted();

    await vi.waitFor(() => expect(context.sessionManager.suspend).toHaveBeenCalled());
    expect(mockMarkLaunchFailed).toHaveBeenCalledWith('sess-never');
    expect(markedBeforeSuspend).toBe(true);
  });

  it('leaves a failed resume unmarked: its conversation is still there to resume', async () => {
    const context = registerWithLiveSession('sess-never');

    capturedSessionEventHandlers.get('agent-never-started')?.('sess-never', { ...NEVER_STARTED_SESSION, resuming: true });
    await withTaskLock('task-never', async () => {});

    await vi.waitFor(() => expect(context.sessionManager.suspend).toHaveBeenCalled());
    expect(mockMarkLaunchFailed).not.toHaveBeenCalled();
  });

  it('raises the fallback notice when a pause lands, and does not retire the session', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    const noticeError = vi.mocked(notifySpawnBlocked).mock.calls[0][3] as Error;
    expect(noticeError.message).toBe(NEVER_STARTED_FALLBACK);
    expect(context.sessionManager.noteAgentExitedAtStart).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-never');
    expect(context.sessionManager.retireAgentlessSession).not.toHaveBeenCalled();
  });

  it('prefers the adapter\'s named startup failure over the fallback text', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getRawScrollback.mockResolvedValue(
      'No conversation found with session ID: 12345678-aaaa-bbbb-cccc-1234567890ab',
    );

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    const noticeError = vi.mocked(notifySpawnBlocked).mock.calls[0][3] as Error;
    expect(noticeError.message).toContain('found no conversation to resume');
    expect(noticeError.message).not.toBe(NEVER_STARTED_FALLBACK);
    // What the CLI named is its own failure, so it reports as that stage.
    expect(context.sessionManager.noteAgentExitedAtStart).toHaveBeenCalledWith('sess-never');
  });

  it('shows the CLI\'s own line for a login failure, word for word, with no retry', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getRawScrollback.mockResolvedValue('$ claude\r\nNot logged in · Please run /login\r\n$ ');
    context.sessionManager.launchOutputClass.mockResolvedValue('login_required');

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    const noticeError = vi.mocked(notifySpawnBlocked).mock.calls[0][3] as Error;
    expect(noticeError.message).toBe('Not logged in · Please run /login');
    expect(mockResumeTaskSession).not.toHaveBeenCalled();
    // The report already counted it, as what it is.
    expect(context.sessionManager.noteAgentExitedAtStart).not.toHaveBeenCalled();
  });

  it('does not show a line the report did not find in this launch, such as a resume\'s old output', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getRawScrollback.mockResolvedValue('Not logged in · Please run /login\r\n');
    context.sessionManager.launchOutputClass.mockResolvedValue('not_read');

    await fireNeverStarted();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledTimes(1));
    expect((vi.mocked(notifySpawnBlocked).mock.calls[0][3] as Error).message).toBe(NEVER_STARTED_FALLBACK);
  });

  it('retires the session and raises no notice when the pause is declined for a newer session', async () => {
    const context = registerWithLiveSession('sess-newer');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();
    await drainUntil(() => false, 20);

    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledWith('sess-never');
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('retires the session and raises no notice when the task has no live session', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    context.sessionManager.getSession.mockReturnValue(null);

    await fireNeverStarted();
    await drainUntil(() => false, 20);

    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledWith('sess-never');
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('retires the session, with no unhandled rejection, when the pause rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const context = registerWithLiveSession('sess-never');
      mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
      context.sessionManager.suspend.mockRejectedValue(new Error('suspend failed'));

      await fireNeverStarted();

      await vi.waitFor(() => expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledWith('sess-never'));
      // Give a stray rejection a macrotask to surface.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledTimes(1);
      expect(notifySpawnBlocked).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });

  it('retires the session without pausing when its project cannot be resolved', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });
    context.sessionManager.getSessionProjectId.mockReturnValue(null);

    await fireNeverStarted();
    await drainUntil(() => false, 20);

    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.retireAgentlessSession).toHaveBeenCalledWith('sess-never');
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('records the pause as Kangentic\'s, which holds nothing, then suspends the PTY', async () => {
    const context = registerWithLiveSession('sess-never');

    capturedSessionEventHandlers.get('agent-never-started')?.('sess-never', NEVER_STARTED_SESSION);
    await withTaskLock('task-never', async () => {});
    await drainUntil(() => context.sessionManager.suspend.mock.calls.length > 0);

    expect(markRecordSuspended).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended).mock.calls[0]).toContain('system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-never');
  });

  it('leaves a newer session of the task alone', async () => {
    const context = registerWithLiveSession('sess-newer');

    capturedSessionEventHandlers.get('agent-never-started')?.('sess-never', NEVER_STARTED_SESSION);
    await withTaskLock('task-never', async () => {});
    await drainUntil(() => false, 20);

    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
  });

  it('puts the reason on the row and the record when the launch failed for good', async () => {
    const context = registerWithLiveSession('sess-never');
    mockTaskRepositoryGetById.mockReturnValue({ id: 'task-never', title: 'Never started' });

    await fireNeverStarted();

    await vi.waitFor(() => expect(context.sessionManager.markStartBlocked).toHaveBeenCalledWith('sess-never', 'never-started'));
    expect(mockSetStartBlockedReason).toHaveBeenCalledWith('sess-never', 'never-started');
  });
});

// ---------------------------------------------------------------------------
// A queued session whose folder went while it waited stops with a visible reason
// ---------------------------------------------------------------------------

describe('agent-start-refused listener', () => {
  const QUEUED_SESSION = {
    id: 'sess-queued',
    taskId: 'task-queued',
    transient: false,
    status: 'queued',
    resuming: false,
    projectId: 'proj-1',
  } as Session;
  const REFUSAL = new AgentCwdMissingError('/project/.kangentic/worktrees/1003');

  function registerWithQueuedSession(
    liveSessionId: string,
    task: { id: string; title: string; worktree_path: string | null } | null,
  ): ReturnType<typeof createMockContext> {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    mockGetLatestForTask.mockReturnValue({
      id: 'sess-queued',
      task_id: 'task-queued',
      agent_session_id: 'agent-queued',
      status: 'queued',
      suspended_by: null,
    } as SessionRecord);
    mockGetProjectRepos.mockReturnValue({
      tasks: {
        getById: vi.fn(() => ({ id: 'task-queued', session_id: liveSessionId, swimlane_id: 'lane-merge' })),
        update: vi.fn(),
      },
      swimlanes: { getById: vi.fn(() => null) },
    });
    const context = createMockContext();
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    context.sessionManager.getSession.mockImplementation((sessionId?: string) => (
      sessionId === liveSessionId ? ({ ...QUEUED_SESSION, id: liveSessionId } as Session) : null
    ));
    mockTaskRepositoryGetById.mockReturnValue(task as never);
    registerSessionHandlers(context as never);
    return context;
  }

  async function fireRefused(): Promise<void> {
    capturedSessionEventHandlers.get('agent-start-refused')?.('sess-queued', QUEUED_SESSION, REFUSAL);
    await withTaskLock('task-queued', async () => {});
  }

  it('pauses the task, marks the launch failed, and says why on the row and in the notice', async () => {
    const task = { id: 'task-queued', title: 'Merge', worktree_path: '/project/.kangentic/worktrees/1003' };
    const context = registerWithQueuedSession('sess-queued', task);

    await fireRefused();

    await vi.waitFor(() => expect(notifySpawnBlocked).toHaveBeenCalledWith(context, task, 'agent', REFUSAL, 'proj-1'));
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-queued');
    expect(mockMarkLaunchFailed).toHaveBeenCalledWith('sess-queued');
    expect(context.sessionManager.markStartBlocked).toHaveBeenCalledWith('sess-queued', 'worktree-missing');
    expect(mockSetStartBlockedReason).toHaveBeenCalledWith('sess-queued', 'worktree-missing');
  });

  it('names a plain folder for a cwd that is no worktree', async () => {
    const context = registerWithQueuedSession('sess-queued', { id: 'task-queued', title: 'Merge', worktree_path: null });

    capturedSessionEventHandlers.get('agent-start-refused')?.('sess-queued', QUEUED_SESSION, new AgentCwdMissingError('/project'));
    await withTaskLock('task-queued', async () => {});

    await vi.waitFor(() => expect(context.sessionManager.markStartBlocked).toHaveBeenCalledWith('sess-queued', 'folder-missing'));
  });

  it('retires the row when a newer session holds the task, so nothing stays queued', async () => {
    const context = registerWithQueuedSession('sess-newer', null);

    await fireRefused();

    await vi.waitFor(() => expect(context.sessionManager.retireRefusedStart).toHaveBeenCalledWith('sess-queued'));
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('retires the row of a session with no project', () => {
    const context = registerWithQueuedSession('sess-queued', null);
    context.sessionManager.getSessionProjectId.mockReturnValue(null);

    capturedSessionEventHandlers.get('agent-start-refused')?.('sess-queued', QUEUED_SESSION, REFUSAL);

    expect(context.sessionManager.retireRefusedStart).toHaveBeenCalledWith('sess-queued');
  });
});

// ---------------------------------------------------------------------------
// #6 - idle-timeout listener fires DB writes when projectId is present
// ---------------------------------------------------------------------------

describe('idle-timeout listener - DB side-effect when projectId is present', () => {
  let context: ReturnType<typeof createMockContext>;
  let taskUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    taskUpdate = vi.fn();

    // Task repo: getById returns a task with a live session_id.
    const taskRepo = {
      getById: vi.fn(() => ({
        id: 'task-idle',
        session_id: 'sess-idle',
        title: 'Idle task',
        swimlane_id: 'lane-doing',
        position: 0,
        worktree_path: null,
        session_type: null,
        branch_name: null,
        base_branch: null,
        agent: 'claude',
      })),
      update: taskUpdate,
    };

    // SessionRepository.getLatestForTask returns a running record with
    // agent_session_id set so decideSuspendDbAction returns 'suspend'.
    mockGetLatestForTask.mockReturnValue({
      id: 'record-idle',
      task_id: 'task-idle',
      session_type: 'agent',
      agent_session_id: 'agent-idle',
      command: 'claude',
      cwd: '/tmp',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: new Date().toISOString(),
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
      total_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      model_id: null,
      model_display_name: null,
      total_duration_ms: null,
    } as SessionRecord);

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    context = createMockContext();
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    // The task's live session, still idle when the pause takes the lock.
    context.sessionManager.getSession.mockImplementation((sessionId?: string) => (
      sessionId === 'sess-idle' ? { id: 'sess-idle', taskId: 'task-idle', status: 'running' } as Session : null
    ));
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-idle': 'idle' });
    registerSessionHandlers(context as never);
  });

  function fireIdleTimeout(): void {
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');
    idleTimeoutHandler('sess-idle', 'task-idle', 5);
  }

  it('records an auto pause, suspends the PTY, cancels keystrokes, clears session_id, then tells the renderer', async () => {
    fireIdleTimeout();
    // The renderer is told once the pause landed, the last step.
    await drainUntil(() => context.mainWindow.webContents.send.mock.calls.length > 0);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-idle',
      'task-idle',
      5,
      'proj-1',
    );
    expect(context.terminalSubmitScheduler.cancel).toHaveBeenCalledWith('task-idle');
    // Kangentic's own pause: held until the user resumes it.
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(
      expect.anything(), // SessionRepository instance
      'record-idle',
      'auto',
    );
    expect(taskUpdate).toHaveBeenCalledWith({ id: 'task-idle', session_id: null });
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-idle');
  });

  it('writes the paused record before it suspends the PTY, so a quit in between keeps it paused', async () => {
    fireIdleTimeout();
    await drainUntil(() => context.sessionManager.suspend.mock.calls.length > 0);

    const recordWrittenAt = vi.mocked(markRecordSuspended).mock.invocationCallOrder[0];
    const suspendedAt = context.sessionManager.suspend.mock.invocationCallOrder[0];
    expect(recordWrittenAt).toBeDefined();
    expect(suspendedAt).toBeDefined();
    expect(recordWrittenAt).toBeLessThan(suspendedAt);
  });

  it('declines, writing and stopping nothing, when the agent went back to work before the lock', async () => {
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-idle': 'thinking' });

    fireIdleTimeout();
    // Intentional fixed wait - we cannot poll for non-occurrence.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT, expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('declines, writing and stopping nothing, while the user has text typed into the prompt', async () => {
    context.sessionManager.getPendingDraft.mockReturnValue('half a thought');

    fireIdleTimeout();
    // The draft is read under the task lock, so wait for that read before
    // judging what the pause did with it.
    await drainUntil(() => context.sessionManager.getPendingDraft.mock.calls.length > 0);
    // Intentional fixed wait - we cannot poll for non-occurrence. Give the
    // rest of the pause time to run, were it to go ahead despite the draft.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT, expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    // The decline came from the draft check, not from an earlier exit.
    expect(context.sessionManager.getPendingDraft).toHaveBeenCalledWith('sess-idle');
  });

  it('still pauses when the prompt holds only whitespace, which is no draft', async () => {
    context.sessionManager.getPendingDraft.mockReturnValue('  \n  ');

    fireIdleTimeout();
    await drainUntil(() => context.mainWindow.webContents.send.mock.calls.length > 0);

    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'record-idle', 'auto');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-idle');
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-idle',
      'task-idle',
      5,
      'proj-1',
    );
    // The draft was read and judged empty, not skipped.
    expect(context.sessionManager.getPendingDraft).toHaveBeenCalledWith('sess-idle');
  });

  it('queues one pause when the sweep fires again while the first still waits on the task lock', async () => {
    // Hold the task's lock so the first pause cannot start, as it cannot while
    // another move or resume of the same task is running.
    let releaseLock: () => void = () => {};
    let lockHeld = false;
    const lockHolder = withTaskLock('task-idle', () => new Promise<void>((resolve) => {
      lockHeld = true;
      releaseLock = resolve;
    }));
    try {
      await drainUntil(() => lockHeld);
      expect(lockHeld).toBe(true);
      fireIdleTimeout();
      fireIdleTimeout();
    } finally {
      // Always release: the lock map is module-wide, so a held lock would hang
      // every later test that takes this task's lock.
      releaseLock();
    }
    await lockHolder;
    await drainUntil(() => context.sessionManager.suspend.mock.calls.length > 0);
    // Intentional fixed wait. A second pause, were one queued, runs after the
    // first and also succeeds against these static mocks, so asserting at the
    // first suspend would pass vacuously.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.suspend).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmitScheduler.cancel).toHaveBeenCalledTimes(1);
    const idleTimeoutSends = context.mainWindow.webContents.send.mock.calls.filter(
      (call) => call[0] === IPC.SESSION_IDLE_TIMEOUT,
    );
    expect(idleTimeoutSends).toHaveLength(1);
  });

  // A running workflow task under recovery waits on a timer, not on the user:
  // a pause would stop the nudge that moves it on (workflow-recovery.ts). Once
  // its recovery ends, it is an agent waiting on the user again.
  it('leaves a workflow task under recovery alone, and pauses it once recovery ends', async () => {
    const recoveryTimer = setTimeout(() => undefined, 60 * 60_000);
    setRecoveryEntry({
      projectId: 'proj-1', taskId: 'task-idle', workflowId: 'workflow-1', columnId: 'lane-doing', sessionId: 'sess-idle',
      attemptIndex: 0, countedNudges: 0, countedSinceNotice: 0, noticeSent: false, startedAt: Date.now(),
      workingWait: false, holdUntil: null, verdict: null, pendingNudge: null, lastTurnFromNudge: false, timer: recoveryTimer, inFlight: false,
    });
    try {
      fireIdleTimeout();
      // Intentional fixed wait - we cannot poll for non-occurrence.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
      expect(context.sessionManager.suspend).not.toHaveBeenCalled();
      expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
    } finally {
      forgetWorkflowRecovery('task-idle');
    }

    // Recovery ran out: the next sweep tick pauses it as it would any idle agent.
    fireIdleTimeout();
    await drainUntil(() => context.sessionManager.suspend.mock.calls.length > 0);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'record-idle', 'auto');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-idle');
  });

  it('does not pause a task whose recovery started while the pause waited on the task lock', async () => {
    let releaseLock: () => void = () => {};
    let lockHeld = false;
    const lockHolder = withTaskLock('task-idle', () => new Promise<void>((resolve) => {
      lockHeld = true;
      releaseLock = resolve;
    }));
    const recoveryTimer = setTimeout(() => undefined, 60 * 60_000);
    try {
      await drainUntil(() => lockHeld);
      fireIdleTimeout();
      // Recovery arms while the pause is queued behind the lock.
      setRecoveryEntry({
        projectId: 'proj-1', taskId: 'task-idle', workflowId: 'workflow-1', columnId: 'lane-doing', sessionId: 'sess-idle',
        attemptIndex: 0, countedNudges: 0, countedSinceNotice: 0, noticeSent: false, startedAt: Date.now(),
        workingWait: false, holdUntil: null, verdict: null, pendingNudge: null, lastTurnFromNudge: false, timer: recoveryTimer, inFlight: false,
      });
    } finally {
      releaseLock();
    }
    await lockHolder;
    // Intentional fixed wait - we cannot poll for non-occurrence.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    forgetWorkflowRecovery('task-idle');

    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
  });

  it('accepts a later fire once the first pause settled without pausing', async () => {
    // The agent is working when the first pause takes the lock, so it declines.
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-idle': 'thinking' });
    fireIdleTimeout();
    await drainUntil(() => context.sessionManager.getActivityCache.mock.calls.length > 0);
    // Intentional fixed wait - the in-flight set is cleared in a finally
    // handler that has no observable signal of its own.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();

    // The agent parked again; the next sweep fire must not be swallowed by the
    // first, long-settled pause.
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-idle': 'idle' });
    fireIdleTimeout();
    await drainUntil(() => context.mainWindow.webContents.send.mock.calls.length > 0);

    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'record-idle', 'auto');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-idle');
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-idle',
      'task-idle',
      5,
      'proj-1',
    );
  });
});

// ---------------------------------------------------------------------------
// #7 - idle-timeout listener skips DB writes when projectId is missing
// ---------------------------------------------------------------------------

describe('idle-timeout listener - early exit when projectId is missing', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    context = createMockContext();
    // getSessionProjectId returns undefined -> no projectId -> early return
    context.sessionManager.getSessionProjectId.mockReturnValue(undefined);
    registerSessionHandlers(context as never);
  });

  it('sends SESSION_IDLE_TIMEOUT to renderer but does NOT enter the lock or write the DB', async () => {
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-orphan', 'task-orphan', 10);

    // Intentional fixed wait - we cannot poll for non-occurrence. Give the
    // event loop enough time to process any inadvertently scheduled microtasks.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Renderer must still be notified (IPC send happens before the projectId
    // guard, so it fires unconditionally as long as the window is not destroyed).
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-orphan',
      'task-orphan',
      10,
      undefined,
    );

    // commandInjector.cancel is only called inside withTaskLock, which is
    // guarded by `if (!projectId) return;`. Must NOT have been called.
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();

    // markRecordSuspended must NOT have been called.
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();

    // getProjectRepos must NOT have been called (applySuspendDbWrites skipped).
    expect(mockGetProjectRepos).not.toHaveBeenCalled();

    // A task session that cannot be recorded is still stopped, as it always was.
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-orphan');
  });

  it('drops a Command Terminal: no announce, no suspend, no task record', async () => {
    context.sessionManager.getSession.mockReturnValue(
      { id: 'sess-command', taskId: 'task-command', transient: true } as Session,
    );
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-command', 'task-command', 10);

    // Intentional fixed wait - we cannot poll for non-occurrence.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // An announce would make the renderer mark the live terminal suspended.
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(mockGetProjectRepos).not.toHaveBeenCalled();
  });

  it('drops a Command Terminal in a resolved project the same way: never paused through a task record', async () => {
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    context.sessionManager.getSession.mockReturnValue(
      { id: 'sess-command', taskId: 'task-command', transient: true } as Session,
    );
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-command', 'task-command', 10);

    // Intentional fixed wait - we cannot poll for non-occurrence. Give the
    // queued task lock time to run its block, were the listener to enter it.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockGetProjectRepos).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #8 - idle-timeout listener leaves a workflow's own agent alone
// ---------------------------------------------------------------------------

describe('idle-timeout listener - a workflow\'s own agent session', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    context = createMockContext();
    // The project resolves, so only the workflow check can stop the listener.
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcasts nothing, takes no task lock and writes no task row: it has no task and no card', async () => {
    context.sessionManager.getSession.mockReturnValue({ id: 'sess-workflow', taskId: 'wf-1', workflowId: 'wf-1' } as never);
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-workflow', 'wf-1', 5);

    // Intentional fixed wait - we cannot poll for non-occurrence. Give the
    // queued task lock time to run its block, were the listener to enter it.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();
    expect(mockGetProjectRepos).not.toHaveBeenCalled();
  });

  it('still broadcasts and takes the task lock for a task\'s session (the control)', async () => {
    context.sessionManager.getSession.mockReturnValue({ id: 'sess-task', taskId: 'task-1', status: 'running' } as never);
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-task': 'idle' });
    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => ({ id: 'task-1', session_id: 'sess-task' })), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-task', 'task-1', 5);
    await drainUntil(() => context.mainWindow.webContents.send.mock.calls.length > 0);

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-task',
      'task-1',
      5,
      'proj-1',
    );
    expect(context.terminalSubmitScheduler.cancel).toHaveBeenCalledWith('task-1');
  });
});
