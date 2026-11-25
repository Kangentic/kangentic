/**
 * What a user loses if these reports go quiet: the steps that keep a task's agent and its
 * numbers in line are caught and logged, so none of them reaches the IPC wrap or Sentry.
 * An agent that keeps running in a column whose auto-spawn was just turned off, or that
 * never starts in one turned on. A model change that suspends a session and never brings
 * it back. A phone that is never told its pause or resume was accepted. A task opened
 * after an idle pause that stays paused with no word. A task's cost, tokens, tool counts
 * and lines changed that never reach Stats. Each would look like a quiet day.
 *
 * Each case runs the real module, makes one dependency throw a code defect (a TypeError
 * whose message carries text a user could have written), and reads the call that reached
 * `reportHandledError`: its source, its `area` and `step` tags, the fixed message, and
 * that nothing sent (message, stack header, tags, contexts, fingerprint) holds the user's
 * text. Each case also pins what the user still gets: the answer, the fallback, the work
 * that carried on. Where a site reads from the retrieval worker, a second case pins that
 * a worker that is down sends nothing.
 *
 * Modules are imported per test (`vi.resetModules`) because each reporter latches a key
 * once per run, and each test installs only the mocks its module needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { reportedFailures, reportedText, type ReportedFailure } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

/** Text a user could have written, which must never leave with a report. */
const USER_TEXT = 'Fix Acme billing export';

function defect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
}

/** What the retrieval client rejects with while its worker is down: an expected class. */
function workerDown(): Error {
  return Object.assign(new Error('The retrieval worker exited'), { name: 'RetrievalUnavailableError' });
}

/** An abort, which every reporter skips. */
function aborted(): Error {
  return Object.assign(new Error(`Aborted ${USER_TEXT}`), { name: 'AbortError' });
}

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the test's teardown can unmock it. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

function stepReports(): ReportedFailure[] {
  return reportedFailures(reportHandledError).filter((call) => call.tags.source === 'handler_step');
}

/** Everything one report put in Sentry's hands, as one string. */
const everythingSent = (): string => reportedText(reportHandledError);

/** One `handler_step` report went out, under this area and step, carrying no user text. */
function expectOnlyStepReport(area: string, step: string, errorName = 'TypeError'): void {
  const calls = stepReports();
  expect(calls).toHaveLength(1);
  expect(calls[0].tags).toMatchObject({ source: 'handler_step', area, step, error_name: errorName });
  expect(calls[0].sent.message).toBe(`Handled handler_step failure: ${errorName}`);
  expect(everythingSent()).not.toMatch(/acme/i);
}

/** Let every promise continuation and zero-delay timer that is already queued run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// session_resume: pauseTaskSession, resumeTaskSession, resumeTaskOnOpen
// ---------------------------------------------------------------------------

describe('session_resume steps', () => {
  const TASK_ID = 'task-aaa00001';
  const PROJECT_ID = 'project-1';

  describe('caller_hook in pauseTaskSession', () => {
    function installPauseMocks(): { applySuspendDbWrites: ReturnType<typeof vi.fn> } {
      const applySuspendDbWrites = vi.fn();
      installMocks({
        '../../src/main/ipc/handlers/session-reconcile': () => ({
          reconcileTaskSessionRef: () => ({ task: { id: TASK_ID }, liveSession: { id: 'session-live', taskId: TASK_ID, status: 'running' } }),
          applySuspendDbWrites,
        }),
        '../../src/main/ipc/handlers/session-resume-controllers': () => ({ abortInFlightResume: vi.fn() }),
      });
      return { applySuspendDbWrites };
    }

    function pauseContext(): { currentProjectId: string; sessionManager: { suspend: ReturnType<typeof vi.fn> } } {
      return { currentProjectId: PROJECT_ID, sessionManager: { suspend: vi.fn(async () => undefined) } };
    }

    it('reports an onAccepted hook that throws and still stops the agent the record says is paused', async () => {
      const { applySuspendDbWrites } = installPauseMocks();
      const { pauseTaskSession } = await import('../../src/main/ipc/handlers/session-pause');
      const context = pauseContext();

      const outcome = await pauseTaskSession(context as never, TASK_ID, {
        onAccepted: () => { throw defect(); },
      });

      expect(outcome).toBe('paused');
      expect(applySuspendDbWrites).toHaveBeenCalledWith(context, PROJECT_ID, TASK_ID, 'user');
      expect(context.sessionManager.suspend).toHaveBeenCalledWith('session-live', { suspendedBy: 'user' });
      expectOnlyStepReport('session_resume', 'caller_hook');
    });

    it('sends nothing for a hook that was aborted', async () => {
      installPauseMocks();
      const { pauseTaskSession } = await import('../../src/main/ipc/handlers/session-pause');
      const context = pauseContext();

      const outcome = await pauseTaskSession(context as never, TASK_ID, {
        onAccepted: () => { throw aborted(); },
      });

      expect(outcome).toBe('paused');
      expect(context.sessionManager.suspend).toHaveBeenCalledTimes(1);
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('caller_hook in resumeTaskSession', () => {
    const lane = { id: 'lane-executing', role: null, auto_spawn: true };
    const task = { id: TASK_ID, title: USER_TEXT, swimlane_id: lane.id, session_id: null, archived_at: null };

    function installResumeMocks(ensureTaskWorktree: () => Promise<void>): void {
      const repos = {
        tasks: { getById: () => task },
        swimlanes: { getById: () => lane, list: () => [lane] },
        automations: {},
        automationRuns: {},
        attachments: {},
      };
      installMocks({
        '../../src/main/db/database': () => ({ getProjectDb: () => ({}) }),
        '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
        '../../src/main/db/repositories/task-move-repository': () => ({ TaskMoveRepository: class {} }),
        '../../src/main/ipc/helpers': () => ({
          getProjectRepos: () => repos,
          ensureTaskWorktree,
          createTransitionEngine: vi.fn(),
          resolveSpawnOverrides: vi.fn(),
          spawnAgent: vi.fn(),
        }),
        '../../src/main/ipc/helpers/agent-spawn': () => ({ resolveInjectionVerifier: vi.fn() }),
        '../../src/main/ipc/helpers/project-repos': () => ({
          resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: '/mock/project' }),
        }),
        '../../src/main/ipc/handlers/session-reconcile': () => ({
          reconcileTaskSessionRef: () => ({ task, liveSession: null }),
        }),
        '../../src/main/ipc/helpers/task-profile': () => ({ loadTaskProfile: () => null }),
        '../../src/main/transition-engine/column-strategy': () => ({ applyProfileToLane: (laneRow: unknown) => laneRow }),
        '../../src/main/transition-engine/resume-conversation-guard': () => ({ owedPromptOf: () => null, resolveResumeLineage: () => ({ lineage: [] }) }),
        '../../src/main/transition-engine/resume-prompt-delivery': () => ({ textLeftToType: () => null }),
        '../../src/main/transition-engine/spawn-progress': () => ({
          claimSpawnProgress: () => ({ onProgress: vi.fn(), release: vi.fn() }),
        }),
        '../../src/main/automations/turn-end/recap-turns': () => ({ forgetRecapSession: vi.fn() }),
        '../../src/main/held-messages/held-messages': () => ({
          claimHeldMessages: () => null,
          composeOpeningMessage: () => ({ prompt: undefined, heldAfterTurn: false }),
          deferHeldUntilTurnEnd: vi.fn(),
          deliverOpeningRemainder: vi.fn(),
        }),
        '../../src/main/pty/agent-launch-report': () => ({ reportPreflightFailure: vi.fn() }),
        '../../src/main/git/worktree-errors': () => ({ worktreeFailureCause: () => 'other' }),
      });
    }

    function resumeContext(): { currentProjectId: string; mainWindow: object; sessionManager: { findLiveSessionByTaskId: () => undefined } } {
      return { currentProjectId: PROJECT_ID, mainWindow: {}, sessionManager: { findLiveSessionByTaskId: () => undefined } };
    }

    it('reports an onFailed hook that throws and still rejects the resume with the worktree failure', async () => {
      installResumeMocks(async () => { throw new Error(`git failed in ${USER_TEXT}`); });
      const { resumeTaskSession } = await import('../../src/main/ipc/handlers/session-resume');
      const onFailed = vi.fn(() => { throw defect(); });

      await expect(resumeTaskSession(resumeContext() as never, TASK_ID, { projectId: PROJECT_ID, onFailed })).rejects.toThrow(/Worktree setup failed/);

      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onFailed).toHaveBeenCalledWith('worktree', expect.any(Error), task);
      expectOnlyStepReport('session_resume', 'caller_hook');
    });

    it('sends nothing for a hook that was aborted', async () => {
      installResumeMocks(async () => { throw new Error('git failed'); });
      const { resumeTaskSession } = await import('../../src/main/ipc/handlers/session-resume');

      await expect(resumeTaskSession(resumeContext() as never, TASK_ID, {
        projectId: PROJECT_ID,
        onFailed: () => { throw aborted(); },
      })).rejects.toThrow(/Worktree setup failed/);

      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('resumeTaskOnOpen', () => {
    const lane = { id: 'lane-executing', role: null };
    const task = { id: TASK_ID, title: USER_TEXT, swimlane_id: lane.id, session_id: null, archived_at: null };

    function installOpenMocks(resumeTaskSession: () => Promise<unknown>): void {
      installMocks({
        '../../src/main/db/database': () => ({ getProjectDb: () => ({}) }),
        '../../src/main/db/repositories/session-repository': () => ({
          SessionRepository: class {
            getLatestForTask() { return { id: 'record-paused', status: 'suspended', suspended_by: 'auto' }; }
          },
        }),
        '../../src/main/ipc/helpers': () => ({
          getProjectRepos: () => ({ tasks: { getById: () => task }, swimlanes: { getById: () => lane } }),
          notifySpawnBlocked: vi.fn(),
        }),
        '../../src/main/ipc/helpers/idle-pause-lift': () => ({ isLiftableIdlePause: () => true }),
        '../../src/main/ipc/handlers/session-resume': () => ({
          columnEnteredWhilePaused: () => null,
          resumeTaskSession,
        }),
        '../../src/main/ipc/handlers/session-resume-controllers': () => ({ isResumeInFlight: () => false }),
      });
    }

    const openContext = { currentProjectId: PROJECT_ID } as never;

    it('reports an onDecided hook that throws and still answers the open', async () => {
      installOpenMocks(async () => null);
      const { resumeTaskOnOpen } = await import('../../src/main/ipc/handlers/session-resume-on-open');

      const outcome = await resumeTaskOnOpen({ currentProjectId: null } as never, TASK_ID, null, {
        onDecided: () => { throw defect(); },
      });

      expect(outcome).toBe('not-eligible');
      expectOnlyStepReport('session_resume', 'on_decided_hook');
    });

    it('reports a resume that throws, and never rejects the open', async () => {
      const resumeTaskSession = vi.fn(async () => { throw defect(); });
      installOpenMocks(resumeTaskSession);
      const { resumeTaskOnOpen } = await import('../../src/main/ipc/handlers/session-resume-on-open');

      const outcome = await resumeTaskOnOpen(openContext, TASK_ID, PROJECT_ID);

      expect(resumeTaskSession).toHaveBeenCalledTimes(1);
      expect(outcome).toBe('not-eligible');
      expectOnlyStepReport('session_resume', 'resume_on_open');
    });

    it('sends nothing for a refusal the user already sees', async () => {
      const { RefusalError } = await import('../../src/shared/refusal');
      installOpenMocks(async () => { throw new RefusalError(`No room for ${USER_TEXT}`); });
      const { resumeTaskOnOpen } = await import('../../src/main/ipc/handlers/session-resume-on-open');

      const outcome = await resumeTaskOnOpen(openContext, TASK_ID, PROJECT_ID);

      expect(outcome).toBe('not-eligible');
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// session_reconcile: restartSessionForSettingsChange
// ---------------------------------------------------------------------------

describe('session_reconcile steps', () => {
  const TASK_ID = 'task-bbb00002';
  const PROJECT_ID = 'project-1';
  const lane = { id: 'lane-executing', permission_mode: null };
  const task = { id: TASK_ID, title: USER_TEXT, swimlane_id: lane.id, session_id: 'session-live', agent: null };

  interface RestartHarness {
    context: {
      mainWindow: object;
      projectRepo: { getById: () => { id: string; path: string } };
      sessionManager: {
        holdColumnSlot: () => () => void;
        suspend: ReturnType<typeof vi.fn>;
        markIdleAuthoritative: ReturnType<typeof vi.fn>;
      };
    };
    releaseColumnSlot: ReturnType<typeof vi.fn>;
    clearSpawnProgress: ReturnType<typeof vi.fn>;
    resumeSuspendedSession: ReturnType<typeof vi.fn>;
  }

  function installRestartMocks(options: { getTask?: () => unknown } = {}): RestartHarness {
    const releaseColumnSlot = vi.fn();
    const clearSpawnProgress = vi.fn();
    const resumeSuspendedSession = vi.fn(async () => ({}));
    const repos = {
      tasks: { getById: options.getTask ?? (() => task), update: vi.fn() },
      swimlanes: { getById: () => lane },
      automations: {},
      automationRuns: {},
      attachments: {},
    };
    installMocks({
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/db/repositories/session-own-record': () => ({ resolveOwnSessionRecord: () => null }),
      '../../src/main/db/repositories/usage-history-repository': () => ({ UsageHistoryRepository: class {} }),
      '../../src/main/db/database': () => ({ getProjectDb: () => ({}) }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: () => repos,
        createTransitionEngine: () => ({ resumeSuspendedSession }),
        resolveSpawnOverrides: () => ({}),
      }),
      '../../src/main/ipc/helpers/agent-spawn': () => ({ resolveInjectionVerifier: () => null }),
      '../../src/main/ipc/helpers/task-profile': () => ({ loadTaskProfile: () => null }),
      '../../src/main/automations/turn-end/agent-message-delivery': () => ({ deliverAgentMessageInBackground: vi.fn() }),
      '../../src/main/ipc/handlers/session-metrics': () => ({
        captureSessionMetrics: vi.fn(), refineTranscriptTokens: vi.fn(), refineTranscriptToolCounts: vi.fn(),
      }),
      '../../src/main/ipc/handlers/git-stats-capture': () => ({ captureGitChurn: vi.fn(), resolveDefaultBaseBranch: () => 'main' }),
      '../../src/main/transition-engine/session-lifecycle': () => ({ markRecordSuspended: vi.fn(), settleQueuedRecord: vi.fn() }),
      '../../src/main/transition-engine/column-strategy': () => ({ applyProfileToLane: (laneRow: unknown) => laneRow }),
      '../../src/main/transition-engine/resume-prompt-delivery': () => ({ textLeftToType: () => null }),
      '../../src/main/transition-engine/spawn-progress': () => ({ emitSpawnProgress: vi.fn(), clearSpawnProgress }),
      '../../src/main/pty/session-registry': () => ({ decideSuspendDbAction: () => 'none', isLiveSession: () => false }),
    });
    return {
      context: {
        mainWindow: {},
        projectRepo: { getById: () => ({ id: PROJECT_ID, path: '/mock/project' }) },
        sessionManager: {
          holdColumnSlot: () => releaseColumnSlot,
          suspend: vi.fn(async () => undefined),
          markIdleAuthoritative: vi.fn(),
        },
      },
      releaseColumnSlot,
      clearSpawnProgress,
      resumeSuspendedSession,
    };
  }

  async function restart(harness: RestartHarness): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { restartSessionForSettingsChange } = await import('../../src/main/ipc/handlers/session-reconcile');
    return restartSessionForSettingsChange(harness.context as never, PROJECT_ID, '/mock/project', TASK_ID, { phase: 'resuming' });
  }

  it('reports a suspend that fails, answers not ok, and frees the column slot', async () => {
    const harness = installRestartMocks();
    harness.context.sessionManager.suspend.mockRejectedValue(defect());

    const result = await restart(harness);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/^suspend failed/);
    expect(harness.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(harness.releaseColumnSlot).toHaveBeenCalledTimes(1);
    expect(harness.clearSpawnProgress).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('session_reconcile', 'settings_suspend');
  });

  it('reports a respawn that fails after the suspend and answers not ok', async () => {
    const harness = installRestartMocks();
    harness.resumeSuspendedSession.mockRejectedValue(defect());

    const result = await restart(harness);

    expect(harness.context.sessionManager.suspend).toHaveBeenCalledWith('session-live');
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/^respawn failed/);
    expect(harness.releaseColumnSlot).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('session_reconcile', 'settings_respawn');
  });

  it('sends nothing for a respawn that was aborted', async () => {
    const harness = installRestartMocks();
    harness.resumeSuspendedSession.mockRejectedValue(new DOMException(`Aborted ${USER_TEXT}`, 'AbortError'));

    const result = await restart(harness);

    expect(result).toEqual({ ok: false, reason: 'respawn aborted' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a read that throws before the restart began, and answers not ok instead of throwing', async () => {
    const harness = installRestartMocks({ getTask: () => { throw defect(); } });

    const result = await restart(harness);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/^restart failed/);
    expect(harness.context.sessionManager.suspend).not.toHaveBeenCalled();
    expectOnlyStepReport('session_reconcile', 'reconcile_read');
  });
});

// ---------------------------------------------------------------------------
// auto_spawn: reconcileAutoSpawnChange
// ---------------------------------------------------------------------------

describe('auto_spawn steps', () => {
  const PROJECT_ID = 'project-1';
  const LANE_ID = 'lane-executing';

  function change(taskId: string, autoSpawnAfter: boolean): unknown {
    return {
      task: { id: taskId, title: USER_TEXT, swimlane_id: LANE_ID, session_id: autoSpawnAfter ? null : `session-${taskId}` },
      before: { auto_spawn: !autoSpawnAfter, role: null },
      after: { auto_spawn: autoSpawnAfter, role: null },
      sourceName: USER_TEXT,
    };
  }

  function installAutoSpawnMocks(overrides: {
    autoSpawnForTask?: (...args: unknown[]) => Promise<void>;
    suspendError?: unknown;
  } = {}): { autoSpawnForTask: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; context: never } {
    const autoSpawnForTask = vi.fn(overrides.autoSpawnForTask ?? (async () => undefined));
    const send = vi.fn();
    installMocks({
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class {
          getHeldPausedTaskIds() { return new Set<string>(); }
        },
      }),
      '../../src/main/db/database': () => ({ getProjectDb: () => ({}) }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: () => ({ tasks: { getById: (taskId: string) => ({ id: taskId, swimlane_id: LANE_ID }) } }),
      }),
      '../../src/main/ipc/helpers/agent-spawn': () => ({ autoSpawnForTask }),
      '../../src/main/ipc/handlers/session-reconcile': () => ({
        reconcileTaskSessionRef: (_context: unknown, _projectId: string, taskId: string) => ({ task: { id: taskId }, liveSession: { id: `session-${taskId}` } }),
        applySuspendDbWrites: vi.fn(),
      }),
      '../../src/main/automations/turn-end/turn-end-passes': () => ({ supersedeMessageDeliveries: vi.fn() }),
    });
    const suspend = vi.fn(async () => {
      if (overrides.suspendError) throw overrides.suspendError;
    });
    const context = {
      terminalSubmitScheduler: { cancel: vi.fn() },
      sessionManager: { listSessions: () => [], suspend },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
    } as never;
    return { autoSpawnForTask, send, context };
  }

  async function waitForResync(send: ReturnType<typeof vi.fn>): Promise<void> {
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.TASK_SESSION_RESYNC, PROJECT_ID));
  }

  it('reports a suspend that fails and still tells the board to re-sync', async () => {
    const { send, context } = installAutoSpawnMocks({ suspendError: defect() });
    const { reconcileAutoSpawnChange } = await import('../../src/main/ipc/handlers/auto-spawn-reconcile');

    reconcileAutoSpawnChange(context, PROJECT_ID, 'COLUMN_UPDATE', [change('task-1', false)] as never);
    await waitForResync(send);

    expectOnlyStepReport('auto_spawn', 'toggle_suspend');
  });

  it('sends nothing for a suspend that was aborted', async () => {
    const { send, context } = installAutoSpawnMocks({ suspendError: aborted() });
    const { reconcileAutoSpawnChange } = await import('../../src/main/ipc/handlers/auto-spawn-reconcile');

    reconcileAutoSpawnChange(context, PROJECT_ID, 'COLUMN_UPDATE', [change('task-1', false)] as never);
    await waitForResync(send);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a spawn that fails, goes on to the next task, and tells the board to re-sync', async () => {
    const { autoSpawnForTask, send, context } = installAutoSpawnMocks({
      autoSpawnForTask: async (_context, _projectId, spawnedTask) => {
        if ((spawnedTask as { id: string }).id === 'task-1') throw defect();
      },
    });
    const { reconcileAutoSpawnChange } = await import('../../src/main/ipc/handlers/auto-spawn-reconcile');

    reconcileAutoSpawnChange(context, PROJECT_ID, 'COLUMN_UPDATE', [change('task-1', true), change('task-2', true)] as never);
    await waitForResync(send);

    expect(autoSpawnForTask).toHaveBeenCalledTimes(2);
    expect(autoSpawnForTask.mock.calls[1][2]).toMatchObject({ id: 'task-2' });
    expectOnlyStepReport('auto_spawn', 'toggle_spawn');
  });

  it('sends nothing more for a spawn failure the spawn chokepoint already reported', async () => {
    const { markReported } = await import('../../src/main/analytics/handled-report');
    const alreadyReported = defect();
    markReported(alreadyReported);
    const { send, context } = installAutoSpawnMocks({ autoSpawnForTask: async () => { throw alreadyReported; } });
    const { reconcileAutoSpawnChange } = await import('../../src/main/ipc/handlers/auto-spawn-reconcile');

    reconcileAutoSpawnChange(context, PROJECT_ID, 'COLUMN_UPDATE', [change('task-1', true)] as never);
    await waitForResync(send);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// git_stats: captureGitChurn
// ---------------------------------------------------------------------------

describe('git_stats steps', () => {
  const nonZeroChurn = { linesAdded: 12, linesRemoved: 3, filesChanged: 2 };

  function installChurnMocks(churn: { linesAdded: number; linesRemoved: number; filesChanged: number }): void {
    installMocks({
      '../../src/main/git/diff-service': () => ({
        DiffService: class {
          async getChurnSummary() { return churn; }
        },
      }),
      '../../src/main/git/git-read-queue': () => ({
        GitReadPriority: { BACKGROUND: 0 },
        viaGitRead: <Result>(read: () => Promise<Result>) => read(),
      }),
    });
  }

  function churnArguments(overrides: { setSession?: () => void; setUsage?: () => void; listRecords?: () => unknown[] } = {}) {
    const sessionRepo = {
      listForTaskNewestFirst: overrides.listRecords ?? (() => [{ id: 'record-1' }]),
      setTaskGitStats: vi.fn(overrides.setSession ?? (() => undefined)),
    };
    const usageHistoryRepo = { setTaskGitStats: vi.fn(overrides.setUsage ?? (() => undefined)) };
    const task = { id: 'task-ccc00003', title: USER_TEXT, worktree_path: '/mock/worktree', pr_state: null, archived_at: null, base_branch: null };
    return { sessionRepo, usageHistoryRepo, task };
  }

  it('reports a stats write that throws, off the finalization path', async () => {
    installChurnMocks(nonZeroChurn);
    const { captureGitChurn } = await import('../../src/main/ipc/handlers/git-stats-capture');
    const { sessionRepo, usageHistoryRepo, task } = churnArguments({ setSession: () => { throw defect(); } });

    expect(() => captureGitChurn(task as never, sessionRepo as never, usageHistoryRepo as never, 'record-1', '/mock/project', 'main')).not.toThrow();
    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));

    expectOnlyStepReport('git_stats', 'churn_write');
    // The usage ledger write sits behind the failed one, so a later capture still fills both.
    expect(usageHistoryRepo.setTaskGitStats).not.toHaveBeenCalled();
  });

  it('writes both rows and reports nothing for a capture that works', async () => {
    installChurnMocks(nonZeroChurn);
    const { captureGitChurn } = await import('../../src/main/ipc/handlers/git-stats-capture');
    const { sessionRepo, usageHistoryRepo, task } = churnArguments();

    captureGitChurn(task as never, sessionRepo as never, usageHistoryRepo as never, 'record-1', '/mock/project', 'main');
    await vi.waitFor(() => expect(usageHistoryRepo.setTaskGitStats).toHaveBeenCalledWith(['record-1'], 'record-1', nonZeroChurn));

    expect(sessionRepo.setTaskGitStats).toHaveBeenCalledWith(['record-1'], 'record-1', nonZeroChurn);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a capture that could not start and does not throw into the caller', async () => {
    installChurnMocks(nonZeroChurn);
    const { captureGitChurn } = await import('../../src/main/ipc/handlers/git-stats-capture');
    const { sessionRepo, usageHistoryRepo, task } = churnArguments({ listRecords: () => { throw defect(); } });

    expect(() => captureGitChurn(task as never, sessionRepo as never, usageHistoryRepo as never, 'record-1', '/mock/project', 'main')).not.toThrow();

    expectOnlyStepReport('git_stats', 'churn_capture');
    expect(sessionRepo.setTaskGitStats).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// session_metrics: capture, transcript refinements and the earlier-run fill
// ---------------------------------------------------------------------------

describe('session_metrics steps', () => {
  const SESSION_ID = 'session-ddd00004';
  const RECORD_ID = 'record-ddd00004';
  const START = '2026-11-20T10:00:00.000Z';
  const TOOL_ROWS = JSON.stringify([{ toolName: 'Read', callCount: 2, totalDurationMs: 40, interruptedCount: 0 }]);

  const call = vi.fn();

  /** An adapter that can read every transcript capability and scopes its reads by time. */
  const readingAdapter = {
    name: 'mock-agent',
    transcriptUsage: () => undefined,
    transcriptToolCounts: () => undefined,
    transcriptToolResultTokens: () => undefined,
    scopesTranscriptReadsByTime: true,
  };

  function installMetricsMocks(): void {
    call.mockReset();
    installMocks({
      '../../src/main/agent/agent-registry': () => ({
        agentRegistry: { get: () => readingAdapter, getBySessionType: () => readingAdapter },
      }),
      '../../src/main/retrieval/retrieval-client': () => ({ retrievalClient: { call } }),
      '../../src/main/workflows/workflow-agent-effort': () => ({ workflowAgentEffort: () => null }),
    });
  }

  interface ManagerOverrides {
    getUsageCache?: () => unknown;
    getSessionAgentName?: () => unknown;
    getSession?: () => unknown;
  }

  function makeManager(overrides: ManagerOverrides = {}) {
    return {
      getUsageCache: overrides.getUsageCache ?? (() => ({ [SESSION_ID]: { transcriptPath: '/mock/transcript.jsonl' } })),
      getToolCallCount: () => 0,
      getToolBreakdown: () => [],
      getCompactionCount: () => 0,
      getSessionAgentName: overrides.getSessionAgentName ?? (() => 'mock-agent'),
      getSession: overrides.getSession ?? (() => ({ id: SESSION_ID, taskId: 'task-1', isolatedSwimlaneId: null, startedAt: START, cwd: '/mock/worktree' })),
      remoteTranscriptSettled: () => undefined,
    };
  }

  const liveRecord = { id: RECORD_ID, agent_session_id: 'conversation-1', cwd: '/mock/worktree', cli_target: null, started_at: START };

  const earlierRecord = {
    id: 'record-earlier',
    session_type: 'mock',
    agent_session_id: 'conversation-1',
    cwd: '/mock/worktree',
    started_at: '2026-11-19T10:00:00.000Z',
    tool_call_count: 2,
    tool_breakdown: TOOL_ROWS,
    result_tokens_read_at: null,
    cli_target: null,
  };

  function makeRepo(overrides: Record<string, unknown> = {}) {
    return {
      updateMetrics: vi.fn(),
      findByAnyId: vi.fn(() => liveRecord),
      updateTranscriptTokens: vi.fn(),
      updateTranscriptToolCounts: vi.fn(),
      listEarlierRunRecords: vi.fn(() => [earlierRecord]),
      mergeTranscriptResultTokens: vi.fn(() => true),
      markResultTokensRead: vi.fn(),
      getEarlierRunToolTotals: vi.fn(() => ({ toolBreakdown: [] })),
      hasEarlierRecordOfConversation: vi.fn(() => false),
      ...overrides,
    };
  }

  function makeUsageRepo(overrides: Record<string, unknown> = {}) {
    return { recordSessionUsage: vi.fn(), ...overrides };
  }

  const USAGE = {
    cost: { totalCostUsd: 1.5, totalDurationMs: 1000 },
    contextWindow: { totalInputTokens: 10, totalOutputTokens: 5, contextWindowSize: 1000, usedTokens: 10, usedPercentage: 1 },
    model: { id: 'mock-model', displayName: 'Mock', effort: null },
    transcriptPath: '/mock/transcript.jsonl',
  };

  beforeEach(installMetricsMocks);

  describe('metrics_capture and workflow_usage_capture', () => {
    it('reports a metrics write that throws and does not throw into the suspend path', async () => {
      const { captureSessionMetrics } = await import('../../src/main/ipc/handlers/session-metrics');
      const repo = makeRepo({ updateMetrics: vi.fn(() => { throw defect(); }) });
      const usageRepo = makeUsageRepo();

      expect(() => captureSessionMetrics(makeManager() as never, repo as never, usageRepo as never, SESSION_ID, RECORD_ID, START, null)).not.toThrow();

      expectOnlyStepReport('session_metrics', 'metrics_capture');
    });

    it('reports a usage ledger write that throws, after the record was written', async () => {
      const { captureSessionMetrics } = await import('../../src/main/ipc/handlers/session-metrics');
      const repo = makeRepo();
      const usageRepo = makeUsageRepo({ recordSessionUsage: vi.fn(() => { throw defect(); }) });
      const manager = makeManager({ getUsageCache: () => ({ [SESSION_ID]: USAGE }) });

      expect(() => captureSessionMetrics(manager as never, repo as never, usageRepo as never, SESSION_ID, RECORD_ID, START, null)).not.toThrow();

      expect(repo.updateMetrics).toHaveBeenCalledTimes(1);
      expectOnlyStepReport('session_metrics', 'metrics_capture');
    });

    it('reports a workflow agent ledger write that throws and does not throw into the caller', async () => {
      const { captureWorkflowAgentUsage } = await import('../../src/main/ipc/handlers/session-metrics');
      const usageRepo = makeUsageRepo({ recordSessionUsage: vi.fn(() => { throw defect(); }) });
      const manager = makeManager({ getUsageCache: () => ({ [SESSION_ID]: USAGE }), getSessionAgentName: () => null });
      const session = { id: SESSION_ID, startedAt: START, agentSessionId: 'conversation-1' };

      expect(() => captureWorkflowAgentUsage(manager as never, usageRepo as never, session)).not.toThrow();

      expect(usageRepo.recordSessionUsage).toHaveBeenCalledTimes(1);
      expectOnlyStepReport('session_metrics', 'workflow_usage_capture');
    });
  });

  describe('transcript_tokens', () => {
    it('reports a transcript read that fails and leaves the snapshot tokens in place', async () => {
      const { refineTranscriptTokens, drainTranscriptReadQueueForTests } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(defect());
      const repo = makeRepo();

      refineTranscriptTokens(makeManager() as never, repo as never, SESSION_ID, RECORD_ID);
      await drainTranscriptReadQueueForTests();
      await vi.waitFor(() => expect(stepReports()).toHaveLength(1));

      expect(call).toHaveBeenCalledWith('transcript.usage', expect.objectContaining({ agentName: 'mock-agent' }), { timeoutMs: null });
      expect(repo.updateTranscriptTokens).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'transcript_tokens');
    });

    it('sends nothing for a worker that is down', async () => {
      const { refineTranscriptTokens, drainTranscriptReadQueueForTests } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(workerDown());
      const repo = makeRepo();

      refineTranscriptTokens(makeManager() as never, repo as never, SESSION_ID, RECORD_ID);
      await drainTranscriptReadQueueForTests();
      await settle();

      expect(call).toHaveBeenCalledTimes(1);
      expect(repo.updateTranscriptTokens).not.toHaveBeenCalled();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports a failure before the read starts and does not throw into the caller', async () => {
      const { refineTranscriptTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      const manager = makeManager({ getSessionAgentName: () => { throw defect(); } });

      expect(() => refineTranscriptTokens(manager as never, makeRepo() as never, SESSION_ID, RECORD_ID)).not.toThrow();

      expect(call).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'transcript_tokens');
    });
  });

  describe('transcript_tool_counts', () => {
    it('reports a transcript read that fails and leaves the live count in place', async () => {
      const { refineTranscriptToolCounts, drainTranscriptReadQueueForTests } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(defect());
      const repo = makeRepo();

      refineTranscriptToolCounts(makeManager() as never, repo as never, SESSION_ID, RECORD_ID);
      await drainTranscriptReadQueueForTests();
      await vi.waitFor(() => expect(stepReports()).toHaveLength(1));

      expect(call).toHaveBeenCalledWith('transcript.toolCounts', expect.objectContaining({ agentName: 'mock-agent' }), { timeoutMs: null });
      expect(repo.updateTranscriptToolCounts).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'transcript_tool_counts');
    });

    it('sends nothing for a worker that is down', async () => {
      const { refineTranscriptToolCounts, drainTranscriptReadQueueForTests } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(workerDown());

      refineTranscriptToolCounts(makeManager() as never, makeRepo() as never, SESSION_ID, RECORD_ID);
      await drainTranscriptReadQueueForTests();
      await settle();

      expect(call).toHaveBeenCalledTimes(1);
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports a failure before the read starts and does not throw into the caller', async () => {
      const { refineTranscriptToolCounts } = await import('../../src/main/ipc/handlers/session-metrics');
      const manager = makeManager({ getSessionAgentName: () => { throw defect(); } });

      expect(() => refineTranscriptToolCounts(manager as never, makeRepo() as never, SESSION_ID, RECORD_ID)).not.toThrow();

      expect(call).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'transcript_tool_counts');
    });
  });

  describe('live_result_tokens and earlier_result_tokens', () => {
    it('reports a live read that fails and answers null, so the popover keeps its rows', async () => {
      const { readTranscriptToolResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(defect());

      const result = await readTranscriptToolResultTokens(makeManager() as never, null, SESSION_ID);

      expect(result).toBeNull();
      expect(call).toHaveBeenCalledWith('transcript.toolResultTokens', expect.objectContaining({ agentName: 'mock-agent' }), { timeoutMs: null });
      expectOnlyStepReport('session_metrics', 'live_result_tokens');
    });

    it('sends nothing for a worker that is down', async () => {
      const { readTranscriptToolResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(workerDown());

      const result = await readTranscriptToolResultTokens(makeManager() as never, null, SESSION_ID);

      expect(result).toBeNull();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports an earlier-run read that throws and answers null', async () => {
      const { readTranscriptToolResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      const repo = makeRepo({
        listEarlierRunRecords: vi.fn(() => []),
        getEarlierRunToolTotals: vi.fn(() => { throw defect(); }),
      });
      // No agent name, so the live run reads nothing and only the earlier runs speak.
      const manager = makeManager({ getSessionAgentName: () => null });

      const result = await readTranscriptToolResultTokens(manager as never, repo as never, SESSION_ID);

      expect(result).toBeNull();
      expect(repo.getEarlierRunToolTotals).toHaveBeenCalledTimes(1);
      expectOnlyStepReport('session_metrics', 'earlier_result_tokens');
    });
  });

  describe('earlier_runs_fill', () => {
    it('reports a track that cannot be read and answers false', async () => {
      const { fillEarlierRunResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      const manager = makeManager({ getSession: () => { throw defect(); } });

      const changed = await fillEarlierRunResultTokens(manager as never, makeRepo() as never, SESSION_ID, { queued: false });

      expect(changed).toBe(false);
      expectOnlyStepReport('session_metrics', 'earlier_runs_fill');
    });

    it('reports earlier records that cannot be listed and answers false', async () => {
      const { fillEarlierRunResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      const repo = makeRepo({ listEarlierRunRecords: vi.fn(() => { throw defect(); }) });

      const changed = await fillEarlierRunResultTokens(makeManager() as never, repo as never, SESSION_ID, { queued: false });

      expect(changed).toBe(false);
      expect(call).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'earlier_runs_fill');
    });
  });

  describe('earlier_run_read and earlier_run_write', () => {
    it('reports a window read that fails and keeps the record as it was', async () => {
      const { fillEarlierRunResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(defect());
      const repo = makeRepo();

      const changed = await fillEarlierRunResultTokens(makeManager() as never, repo as never, SESSION_ID, { queued: false });

      expect(changed).toBe(false);
      expect(call).toHaveBeenCalledWith('transcript.toolResultTokens', expect.objectContaining({ agentSessionId: 'conversation-1' }), { timeoutMs: null });
      expect(repo.mergeTranscriptResultTokens).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'earlier_run_read');
    });

    it('sends nothing for a worker that is down', async () => {
      const { fillEarlierRunResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockRejectedValue(workerDown());
      const repo = makeRepo();

      const changed = await fillEarlierRunResultTokens(makeManager() as never, repo as never, SESSION_ID, { queued: false });

      expect(changed).toBe(false);
      expect(call).toHaveBeenCalledTimes(1);
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports estimates that were read and could not be written', async () => {
      const { fillEarlierRunResultTokens } = await import('../../src/main/ipc/handlers/session-metrics');
      call.mockResolvedValue({ Read: 40 });
      const repo = makeRepo({ mergeTranscriptResultTokens: vi.fn(() => { throw defect(); }) });

      const changed = await fillEarlierRunResultTokens(makeManager() as never, repo as never, SESSION_ID, { queued: false });

      expect(changed).toBe(false);
      expect(repo.mergeTranscriptResultTokens).toHaveBeenCalledWith('record-earlier', { Read: 40 });
      expect(repo.markResultTokensRead).not.toHaveBeenCalled();
      expectOnlyStepReport('session_metrics', 'earlier_run_write');
    });
  });
});
