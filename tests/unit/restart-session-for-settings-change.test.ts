/**
 * Unit tests for `restartSessionForSettingsChange` from
 * src/main/ipc/handlers/session-reconcile.ts.
 *
 * This is the shared helper that both task-runtime-override.ts (manual
 * ContextBar model pick) and board.ts (SWIMLANE_UPDATE) delegate to when a
 * model change requires suspend + respawn. It:
 *
 *   1. Returns { ok: true } immediately when the task has no live session
 *      (benign no-op; the persisted override is picked up on the next spawn).
 *   2. Calls applySuspendDbWrites (same module) -> sessionManager.suspend.
 *   3. Re-reads the task + swimlane (in case they changed during the unlocked
 *      suspend), builds a TransitionEngine, and calls resumeSuspendedSession
 *      with skipPromptTemplate=true so the session resumes idle.
 *   4. Returns { ok: false, reason: 'suspend failed: ...' } when suspend rejects.
 *   5. Returns { ok: false, reason: 'respawn failed: ...' } when
 *      resumeSuspendedSession rejects with a normal Error.
 *   6. Returns { ok: false, reason: 'respawn aborted' } when
 *      resumeSuspendedSession rejects with a DOMException named 'AbortError'.
 *
 * Mock strategy: we cannot mock `applySuspendDbWrites` in isolation (same module),
 * so we let it run through its mocked deps: getProjectRepos (for task read +
 * update), SessionRepository (for getLatestForTask), decideSuspendDbAction,
 * captureSessionMetrics, and markRecordSuspended. We then assert on those mocks
 * to confirm the suspend DB writes actually executed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BoardProfile } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  markRecordSuspended: vi.fn(),
  markRecordExited: vi.fn(),
  captureSessionMetrics: vi.fn(),
  decideSuspendDbAction: vi.fn(() => 'suspend' as 'suspend' | 'exit-queued' | 'noop'),
  // Returns the same record object for both applySuspendDbWrites' read and
  // restartSessionForSettingsChange's re-read via SessionRepository. Override
  // per test to control the suspend action.
  sessionRecord: {
    id: 'rec-1',
    task_id: 'task-restart-1',
    agent_session_id: 'agent-X',
    status: 'running' as const,
    started_at: '2026-01-01T00:00:00Z',
    session_type: 'claude_agent',
    permission_mode: 'plan',
    applied_model: null,
    applied_effort: null,
    isolated_swimlane_id: null,
  },
}));

// ---------------------------------------------------------------------------
// Module mocks (must be declared before imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.sessionRecord);
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: (...args: unknown[]) => hoisted.markRecordSuspended(...args),
  markRecordExited: (...args: unknown[]) => hoisted.markRecordExited(...args),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: (...args: unknown[]) => hoisted.captureSessionMetrics(...args),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/pty/session-registry', () => ({
  decideSuspendDbAction: (...args: unknown[]) => hoisted.decideSuspendDbAction(...(args as [never])),
  isLiveSession: vi.fn(() => true),
}));

// resolveSpawnOverrides is the key output of this path; we verify it was called
// with the re-read task and lane.
const mockResolveSpawnOverrides = vi.fn((
  task: { model_override?: string | null; effort_override?: string | null } | undefined,
  lane: { model_override?: string | null; effort_override?: string | null } | null | undefined,
) => ({
  model: task?.model_override ?? lane?.model_override ?? undefined,
  effort: task?.effort_override ?? lane?.effort_override ?? undefined,
}));

const mockCreateTransitionEngine = vi.fn();
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  resolveSpawnOverrides: (...args: unknown[]) =>
    mockResolveSpawnOverrides(...(args as [never, never])),
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import { restartSessionForSettingsChange } from '../../src/main/ipc/handlers/session-reconcile';

// ---------------------------------------------------------------------------
// Shared test scaffolding
// ---------------------------------------------------------------------------

const TASK_ID = 'task-restart-1';
const SESSION_ID = 'live-session-abc';
// The session id the CLI resumes onto after resumeSuspendedSession succeeds.
// Deliberately distinct from both SESSION_ID (the pre-suspend id) and null
// (the value used for the line-116 re-read), so an assertion against this
// value proves markIdleAuthoritative read the post-respawn row, not a stale one.
const RESUMED_SESSION_ID = 'resumed-session-def';
const PROJECT_ID = 'proj-restart';
const PROJECT_PATH = '/mock/restart-project';

function makeTask(sessionId: string | null = SESSION_ID) {
  return {
    id: TASK_ID,
    session_id: sessionId,
    swimlane_id: 'lane-executing',
    agent: 'claude',
    model_override: null,
    effort_override: null,
  };
}

function makeLane() {
  return {
    id: 'lane-executing',
    permission_mode: 'auto',
    model_override: null,
    effort_override: null,
  };
}

function makeEngine() {
  return {
    resumeSuspendedSession: vi.fn(async () => {}),
  };
}

/**
 * Build a minimal IpcContext. The sessionManager's `suspend` is the key
 * async gate that determines success vs failure.
 */
function makeContext(sessionSuspend: ReturnType<typeof vi.fn> = vi.fn(async () => {})) {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    sessionManager: {
      suspend: sessionSuspend,
      getSession: vi.fn(() => null),
      // The post-respawn idle-authoritative pin (session-reconcile.ts:155).
      // Asserted directly by the happy-path and no-session-id tests below.
      markIdleAuthoritative: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    // applySuspendDbWrites resolves the churn-capture base branch via
    // resolveDefaultBaseBranch(context, projectPath), which reads
    // boardConfigManager before falling back to configManager's git default.
    // getBoardProfiles backs loadTaskProfile's Board Profile lookup; defaults
    // to no profiles, overridden per-test via .mockReturnValue(...).
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => [] as BoardProfile[]),
    },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, default_agent: 'claude', default_model: null, default_effort: null })) },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('restartSessionForSettingsChange', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.markRecordSuspended.mockReset();
    hoisted.markRecordExited.mockReset();
    hoisted.captureSessionMetrics.mockReset();
    hoisted.decideSuspendDbAction.mockReturnValue('suspend');

    engine = makeEngine();
    mockCreateTransitionEngine.mockReturnValue(engine);
  });

  // =========================================================================
  // No live session: benign no-op
  // =========================================================================

  it('returns { ok: true } immediately when the task has no live session', async () => {
    const taskWithNoSession = makeTask(null);
    const taskRepo = {
      getById: vi.fn(() => taskWithNoSession),
      update: vi.fn(),
    };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => makeLane()) },
      actions: {},
      attachments: {},
    });
    const context = makeContext();

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result).toEqual({ ok: true });
    // No suspend and no respawn when there is no live session to act on.
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(hoisted.markRecordSuspended).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Happy path: full suspend + re-read + resumeSuspendedSession
  // =========================================================================

  it('suspends the session, re-reads task and lane, and calls resumeSuspendedSession idle', async () => {
    // First getById call (inside applySuspendDbWrites) returns task with session.
    // Second getById call (re-read after applySuspendDbWrites) returns task without
    // session_id (cleared by applySuspendDbWrites's tasks.update). Third getById
    // call (post-respawn read) returns a task pointed at the newly-resumed
    // session id, distinct from both SESSION_ID and null.
    const liveTask = makeTask(SESSION_ID);
    const updatedTask = makeTask(null);
    const resumedTask = makeTask(RESUMED_SESSION_ID);
    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(liveTask)    // restartSessionForSettingsChange: initial read (line 98)
        .mockReturnValueOnce(liveTask)    // applySuspendDbWrites: internal read (line 33)
        .mockReturnValueOnce(updatedTask) // restartSessionForSettingsChange: re-read after suspend (line 116)
        .mockReturnValueOnce(resumedTask) // restartSessionForSettingsChange: post-respawn read (line 154)
        ,
      update: vi.fn(),
    };
    const laneRepo = { getById: vi.fn(() => makeLane()) };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: laneRepo,
      actions: {},
      attachments: {},
    });
    const context = makeContext();

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result).toEqual({ ok: true });

    // PTY suspend was called with the original session id.
    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);

    // DB side of suspend: session record was marked suspended.
    expect(hoisted.markRecordSuspended).toHaveBeenCalledWith(
      expect.anything(),
      'rec-1',
      'system',
    );

    // session_id was cleared on the task.
    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });

    // Engine was built and resumeSuspendedSession was called.
    expect(mockCreateTransitionEngine).toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);

    // Key contract: skipPromptTemplate=true (resume idle, no re-send of original prompt).
    const [
      passedTask,
      passedPermissionMode,
      skipPromptTemplate,
      resumePrompt,
      signal,
      targetAgent,
      handoffPromptPrefix,
    ] = engine.resumeSuspendedSession.mock.calls[0] as unknown[];
    expect(passedTask).toBe(updatedTask);
    expect(passedPermissionMode).toBe('auto'); // from lane.permission_mode
    expect(skipPromptTemplate).toBe(true);
    expect(resumePrompt).toBeUndefined();
    expect(signal).toBeUndefined();
    expect(targetAgent).toBeUndefined();
    expect(handoffPromptPrefix).toBeUndefined();

    // resolveSpawnOverrides was called to build spawn overrides from task + lane + project.
    expect(mockResolveSpawnOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.objectContaining({ id: 'lane-executing' }),
      expect.objectContaining({ id: PROJECT_ID }),
    );

    // Post-respawn idle-authoritative pin: a successful resume must re-read the
    // task and mark the RESUMED session id idle-authoritative, so the status
    // heartbeat does not force-think the resume-picker's hookless context reload.
    expect(context.sessionManager.markIdleAuthoritative).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.markIdleAuthoritative).toHaveBeenCalledWith(RESUMED_SESSION_ID);
  });

  it('does not call markIdleAuthoritative when the post-respawn read has no session_id, and still returns ok: true', async () => {
    // Same read sequence as the happy path, except the post-respawn read (the
    // 4th getById call) yields a task whose session_id is null - e.g. the
    // session was suspended again before this read landed. The guard on
    // `if (resumedSessionId)` must skip the pin without failing the restart.
    const liveTask = makeTask(SESSION_ID);
    const updatedTask = makeTask(null);
    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(liveTask)    // restartSessionForSettingsChange: initial read (line 98)
        .mockReturnValueOnce(liveTask)    // applySuspendDbWrites: internal read (line 33)
        .mockReturnValueOnce(updatedTask) // restartSessionForSettingsChange: re-read after suspend (line 116)
        .mockReturnValueOnce(updatedTask) // restartSessionForSettingsChange: post-respawn read (line 154), no session_id
        ,
      update: vi.fn(),
    };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => makeLane()) },
      actions: {},
      attachments: {},
    });
    const context = makeContext();

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result).toEqual({ ok: true });
    expect(context.sessionManager.markIdleAuthoritative).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Board Profile fold (pins the bug: the re-read lane must be profile-folded)
  //
  // A task riding a Board Profile carries model_override / effort_override /
  // permission_mode all null (the profile-vs-pins exclusivity invariant), so
  // resolveSpawnOverrides falls through to whatever LANE object it is handed.
  // restartSessionForSettingsChange must fold the task's Board Profile over
  // the re-read lane (applyProfileToLane + loadTaskProfile) before calling
  // resolveSpawnOverrides and before reading permission_mode for
  // resumeSuspendedSession. Reading the lane raw (swimlanes.getById alone)
  // silently demotes the task back to the column's BASE rung on every
  // settings-change restart, even though the delta was correctly detected
  // upstream in propagateBoardProfileChange.
  // =========================================================================

  const PROFILE_ID = 'profile-heavy';
  const PROFILE_LANE_ID = 'lane-profile-executing';

  const heavyProfile: BoardProfile = {
    id: PROFILE_ID,
    name: 'Heavy',
    columns: {
      [PROFILE_LANE_ID]: {
        modelOverride: 'opus',
        permissionMode: 'plan',
      },
    },
  };

  function makeProfileTask(sessionId: string | null) {
    return {
      id: TASK_ID,
      session_id: sessionId,
      swimlane_id: PROFILE_LANE_ID,
      agent: 'claude',
      profile_id: PROFILE_ID,
      // Profile-vs-pins exclusivity invariant: a task riding a profile has
      // null Advanced-override pins.
      model_override: null,
      effort_override: null,
    };
  }

  function makeProfileBaseLane() {
    return {
      id: PROFILE_LANE_ID,
      agent_override: null,
      // Column BASE model - must NOT reach the respawn once a profile applies.
      model_override: 'sonnet',
      effort_override: null,
      permission_mode: 'auto' as const,
      auto_command: null,
      auto_spawn: false,
      handoff_context: false,
      session_target: 'main' as const,
      session_spawn_strategy: 'create_or_resume' as const,
      plan_exit_target_id: null,
    };
  }

  /**
   * Shared arrange + act for the Board Profile fold tests below. Returns the
   * result plus the raw args `resumeSuspendedSession` was called with, so
   * each test can assert its own seam independently - a revert of the fold
   * must fail BOTH seams, not just whichever assertion happens to run first.
   */
  async function runProfileRestart() {
    const liveTask = makeProfileTask(SESSION_ID);
    const updatedTask = makeProfileTask(null);
    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(liveTask)    // restartSessionForSettingsChange: initial read
        .mockReturnValueOnce(liveTask)    // applySuspendDbWrites: internal read
        .mockReturnValueOnce(updatedTask), // restartSessionForSettingsChange: re-read after suspend
      update: vi.fn(),
    };
    const laneRepo = { getById: vi.fn(() => makeProfileBaseLane()) };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: laneRepo,
      actions: {},
      attachments: {},
    });
    const context = makeContext();
    context.boardConfigManager.getBoardProfiles.mockReturnValue([heavyProfile]);

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);
    const callArgs = engine.resumeSuspendedSession.mock.calls[0] as unknown[];
    return { result, callArgs };
  }

  it('passes the profile\'s permission_mode to resumeSuspendedSession, not the column base', async () => {
    const { result, callArgs } = await runProfileRestart();

    expect(result).toEqual({ ok: true });

    // The profile's permission_mode ('plan') must reach resumeSuspendedSession,
    // not the column's base ('auto'). Reverting the fold back to
    // `swimlanes.getById(...)` alone makes this 'auto' and fails the test.
    const passedPermissionMode = callArgs[1];
    expect(passedPermissionMode).toBe('plan');
  });

  it('resolves spawn overrides from the profile-folded lane, not the column base model', async () => {
    const { result, callArgs } = await runProfileRestart();

    expect(result).toEqual({ ok: true });

    // resolveSpawnOverrides must receive a profile-folded lane (model 'opus'),
    // never the column's raw base model ('sonnet'). Reverting the fold back to
    // `swimlanes.getById(...)` alone makes this 'sonnet' and fails the test.
    const passedSpawnOverrides = callArgs[7];
    expect(passedSpawnOverrides).toEqual({ model: 'opus', effort: undefined });

    // Directly confirm the LANE object handed to resolveSpawnOverrides was
    // profile-folded, not the raw column lane.
    expect(mockResolveSpawnOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.objectContaining({ id: PROFILE_LANE_ID, model_override: 'opus', permission_mode: 'plan' }),
      expect.objectContaining({ id: PROJECT_ID }),
    );
  });

  // =========================================================================
  // Suspend failure
  // =========================================================================

  it('returns { ok: false, reason matching /^suspend failed:/ } when suspend rejects', async () => {
    const liveTask = makeTask(SESSION_ID);
    const taskRepo = {
      getById: vi.fn(() => liveTask),
      update: vi.fn(),
    };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => makeLane()) },
      actions: {},
      attachments: {},
    });
    const suspendMock = vi.fn(async () => {
      throw new Error('PTY already exited');
    });
    const context = makeContext(suspendMock);

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^suspend failed:/);
      expect(result.reason).toContain('PTY already exited');
    }
    // resumeSuspendedSession must NOT have been called after a suspend failure.
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Respawn failures
  // =========================================================================

  it('returns { ok: false, reason matching /^respawn failed:/ } when resumeSuspendedSession rejects', async () => {
    const liveTask = makeTask(SESSION_ID);
    const updatedTask = makeTask(null);
    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(liveTask)
        .mockReturnValueOnce(liveTask)
        .mockReturnValueOnce(updatedTask),
      update: vi.fn(),
    };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => makeLane()) },
      actions: {},
      attachments: {},
    });
    engine.resumeSuspendedSession.mockRejectedValue(new Error('CLI exited'));
    mockCreateTransitionEngine.mockReturnValue(engine);
    const context = makeContext();

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^respawn failed:/);
      expect(result.reason).toContain('CLI exited');
    }
  });

  it('returns { ok: false, reason: "respawn aborted" } when resumeSuspendedSession rejects with an AbortError', async () => {
    // isAbortError checks: error instanceof DOMException && error.name === 'AbortError'.
    const liveTask = makeTask(SESSION_ID);
    const updatedTask = makeTask(null);
    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(liveTask)
        .mockReturnValueOnce(liveTask)
        .mockReturnValueOnce(updatedTask),
      update: vi.fn(),
    };
    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => makeLane()) },
      actions: {},
      attachments: {},
    });
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    engine.resumeSuspendedSession.mockRejectedValue(abortError);
    mockCreateTransitionEngine.mockReturnValue(engine);
    const context = makeContext();

    const result = await restartSessionForSettingsChange(context as never, PROJECT_ID, PROJECT_PATH, TASK_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('respawn aborted');
    }
  });
});
