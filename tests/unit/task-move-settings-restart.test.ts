/**
 * Unit tests for the model/effort-change restart and live-injection branches
 * in handleTaskMove (src/main/ipc/handlers/task-move.ts).
 *
 * These branches fire inside Priority 3 (task has a live session, same agent,
 * same track). The decision tree as of the current behavior:
 *
 *   1. MODEL change (`prepareInjectionPlan` returns `needsRestartForModel: true`)
 *      -> suspend + respawn via Phase 3. The resumed spawn re-applies the new
 *      model + effort + any auto_command as CLI flags. A live `/model` swap is
 *      deliberately NOT used (it left the agent paused after a Planning ->
 *      Executing handoff).
 *
 *   2. Effort-only change with a live-swap plan (`prepareInjectionPlan` returns a
 *      non-null plan with `needsRestartForModel: false`) -> live injection:
 *      `scheduleKeystrokes` fires, `updateAppliedSettings` persists the new value,
 *      and the session stays alive.
 *
 *   3. PERMISSION delta alone (or no delta at all) -> keep the live session alive.
 *      A permission change NEVER restarts: in the canonical Planning -> Executing
 *      flow the user already approved the plan in-session, so the spawn-time
 *      permission mode is a stale signal that must not churn the PTY.
 *
 *   4. No live-swap plan + effort delta to a concrete target (adapter has no slash)
 *      -> suspend + respawn so the new effort reaches the CLI as a spawn flag.
 *      The two regression-guard tests pin this path's source-vs-destination diff
 *      against `activeRecord.applied_effort` (NOT the leaving column's config).
 *
 * Also covers continuationPrompt and suppressAutoCommand threading through to
 * spawnAgent, which is exercised on the model-change restart path.
 *
 * Harness modeled on the former task-move-permission-respawn.test.ts; the
 * permission-mode columns (`permission_mode: 'plan'` / `'auto'`) remain in the
 * fixtures but are exercised only to confirm they do NOT restart anymore.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  activeRecord: null as Record<string, unknown> | null,
  updateAppliedSettings: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.activeRecord);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => hoisted.activeRecord);
    updateGitStats = vi.fn();
    updateAppliedSettings = hoisted.updateAppliedSettings;
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/injection-plan', () => ({
  prepareInjectionPlan: vi.fn(() => null),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn(), refineTranscriptTokens: vi.fn(), refineTranscriptToolCounts: vi.fn() }));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({}));
const mockBuildAutoCommandVars = vi.fn(() => ({}));

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  buildAutoCommandVars: (...args: unknown[]) => mockBuildAutoCommandVars(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';
import { prepareInjectionPlan } from '../../src/main/transition-engine/injection-plan';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-planning',
    position: 0,
    agent: 'claude',
    session_id: 'active-session-1',
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeContext(taskRepo: unknown, swimlaneRepo: unknown) {
  const sessionManager = {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        git: { defaultBaseBranch: 'main' },
        agent: { permissionMode: 'acceptEdits' },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });
  return context;
}

const PLANNING_LANE_ID = 'lane-planning';
const EXECUTING_LANE_ID = 'lane-executing';
const DONE_LANE_ID = 'lane-done';

function makeLanes(executingOverrides: Partial<Swimlane> = {}) {
  const planningLane = makeSwimlane(PLANNING_LANE_ID, { permission_mode: 'plan' });
  const executingLane = makeSwimlane(EXECUTING_LANE_ID, {
    permission_mode: 'auto',
    ...executingOverrides,
  });
  const swimlaneRepo = {
    getById: vi.fn((id: string) =>
      id === PLANNING_LANE_ID ? planningLane
      : id === EXECUTING_LANE_ID ? executingLane
      : null,
    ),
    list: vi.fn(() => [planningLane, executingLane]),
  };
  return { planningLane, executingLane, swimlaneRepo };
}

/** Live main session record. Phase 1 reads it via getLatestForTask. */
function setActiveRecord(
  permissionMode: string | null,
  appliedModel: string | null = null,
  appliedEffort: string | null = null,
) {
  hoisted.activeRecord = {
    id: 'rec-main',
    task_id: 'task-aaa00001',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-A',
    status: 'running',
    started_at: '2026-01-01T00:00:00Z',
    session_type: 'claude_agent',
    permission_mode: permissionMode,
    applied_model: appliedModel,
    applied_effort: appliedEffort,
  };
}

/** Phase 1 sees the task with a live session; Phase 3 re-reads it moved with no session. */
function makeTaskRepo() {
  return {
    getById: vi.fn()
      .mockReturnValueOnce(makeTask({ swimlane_id: PLANNING_LANE_ID, session_id: 'active-session-1' }))
      .mockReturnValue(makeTask({ swimlane_id: EXECUTING_LANE_ID, session_id: null })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
  };
}

/**
 * A non-archived task sitting in a Done-role lane (MCP move_task / legacy row)
 * dragged to an active lane. The Done move suspended the session, so Phase 1
 * sees session_id=null and the move reaches Priority 4 -> Phase 3 spawnAgent.
 * The target lane carries an auto_command to prove it is suppressed on the
 * recovery move.
 */
function makeDoneOutSetup() {
  const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
  const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/merge-back' });
  const swimlaneRepo = {
    getById: vi.fn((id: string) =>
      id === DONE_LANE_ID ? doneLane
      : id === EXECUTING_LANE_ID ? executingLane
      : null,
    ),
    list: vi.fn(() => [doneLane, executingLane]),
  };
  const taskRepo = {
    getById: vi.fn()
      .mockReturnValueOnce(makeTask({ swimlane_id: DONE_LANE_ID, session_id: null }))
      .mockReturnValue(makeTask({ swimlane_id: EXECUTING_LANE_ID, session_id: null })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
  };
  return { swimlaneRepo, taskRepo };
}

describe('handleTaskMove model/effort restart and live-injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    hoisted.updateAppliedSettings.mockReset();
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);
  });

  // =========================================================================
  // Headline behavior change: permission-only delta no longer restarts
  // =========================================================================

  it('permission delta alone keeps the live session alive (no respawn)', async () => {
    // The canonical Planning (plan mode) -> Executing (auto mode) move must NOT
    // restart the session anymore. The user approved the plan in-session and Claude
    // already left plan mode, so the spawn-time permission_mode is a stale signal.
    const { swimlaneRepo } = makeLanes(); // planning=plan, executing=auto
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    // prepareInjectionPlan returns null (no model/effort delta).
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    // Permission-only delta: keep alive.
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Model change -> suspend + respawn via Phase 3
  // =========================================================================

  it('model change suspends and respawns via Phase 3', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    // prepareInjectionPlan signals a model change via needsRestartForModel.
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(markRecordSuspended).toHaveBeenCalledWith(expect.anything(), 'rec-main', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-aaa00001', session_id: null });
    // Phase 3 spawns into the executing lane.
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { toLane: Swimlane };
    expect(spawnArg.toLane.id).toBe(EXECUTING_LANE_ID);
    // Live slash injection must NOT fire alongside a restart.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Effort-only live injection (needsRestartForModel: false, non-empty sequence)
  // =========================================================================

  it('effort-only live injection keeps the session alive', async () => {
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      needsRestartForModel: false,
      appliedSettings: { effort: 'xhigh' },
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    // Live injection: slash fires, no suspend, no spawn.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(hoisted.updateAppliedSettings).toHaveBeenCalledWith('active-session-1', { effort: 'xhigh' });
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // settingsSourceLane threading (fromLane, not toLane, reaches spawnAgent)
  //
  // freezeAdvancedOverridesOnFirstSpawn resolves still-inherited Advanced
  // fields against the lane the task left, never the destination the New
  // Task / Edit dialog never showed the user. task-move.ts must thread the
  // SOURCE lane (captured once at Phase 1 as `fromLane`) through every
  // MoveSpawnPlan return site to the eventual spawnAgent call as
  // `settingsSourceLane`. Red-green: reverting task-move.ts's
  // `settingsSourceLane: fromLane ?? null` to omit the field (or pass toLane)
  // makes this test fail; restoring it makes it pass.
  // =========================================================================

  it('threads the SOURCE lane (Planning), not the destination (Executing), to spawnAgent as settingsSourceLane', async () => {
    const { planningLane, swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as {
      settingsSourceLane?: Swimlane | null;
      toLane: Swimlane;
    };
    expect(spawnArg.settingsSourceLane?.id).toBe(PLANNING_LANE_ID);
    expect(spawnArg.settingsSourceLane?.id).toBe(planningLane.id);
    expect(spawnArg.settingsSourceLane?.id).not.toBe(spawnArg.toLane.id);
  });

  // =========================================================================
  // continuationPrompt threading (model-change restart path)
  // =========================================================================

  it('threads options.continuationPrompt through to spawnAgent on a model-change restart', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    const continuation = 'Proceed with implementing the approved plan.';
    await handleTaskMove(
      context as never,
      { taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0 },
      undefined,
      undefined,
      { continuationPrompt: continuation },
    );

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { continuationPrompt?: string };
    expect(spawnArg.continuationPrompt).toBe(continuation);
  });

  it('omits continuationPrompt when the caller passes no options (user drag)', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { continuationPrompt?: string };
    expect(spawnArg.continuationPrompt).toBeUndefined();
  });

  // =========================================================================
  // suppressAutoCommand threading
  // =========================================================================

  it('suppresses auto_command on the first move OUT of Done (recovery move)', async () => {
    const { swimlaneRepo, taskRepo } = makeDoneOutSetup();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { suppressAutoCommand?: boolean };
    expect(spawnArg.suppressAutoCommand).toBe(true);
  });

  it('does NOT suppress auto_command on a normal move with a model-change restart', async () => {
    // A move from a normal active lane with a model change restarts via Phase 3;
    // suppression must be false so the destination column's auto_command injects.
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { suppressAutoCommand?: boolean };
    expect(spawnArg.suppressAutoCommand).toBe(false);
  });

  // =========================================================================
  // Priority 3c persistence - updateAppliedSettings called after live injection
  // =========================================================================

  it('live injection with appliedSettings calls updateAppliedSettings on the session repo', async () => {
    // The plan mock returns appliedSettings so the handler must persist the new
    // running value. Without this, the NEXT move diffs against the old applied
    // value and injects again redundantly.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      needsRestartForModel: false,
      appliedSettings: { effort: 'xhigh' },
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(hoisted.updateAppliedSettings).toHaveBeenCalledWith('active-session-1', { effort: 'xhigh' });
  });

  it('live injection with no appliedSettings (auto_command only) does NOT call updateAppliedSettings', async () => {
    // A plan that only carries an auto_command has no appliedSettings (no model/effort
    // field changed). The handler must NOT call updateAppliedSettings with undefined/empty.
    const { swimlaneRepo } = makeLanes({ permission_mode: null });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['implement the task'],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: false,
      // appliedSettings absent - auto_command only
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(hoisted.updateAppliedSettings).not.toHaveBeenCalled();
  });

  // =========================================================================
  // No-live-swap effort regression-guard (source uses activeRecord.applied_*)
  // =========================================================================

  it('no-live-swap: does NOT respawn when the session already runs at the destination effort (regression guard)', async () => {
    // THE KEY REGRESSION: old code diffed fromLane vs toLane. When both columns
    // had effort_override='xhigh' but the leaving column was null (e.g. a To Do
    // lane with no override), the diff was null vs xhigh and a spurious respawn
    // fired. New code diffs activeRecord.applied_effort vs toLane, so a session
    // already at xhigh (recorded in applied_effort) entering another xhigh column
    // produces no delta and no respawn.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    // Session is already running at xhigh - the fix reads this from the record.
    setActiveRecord('acceptEdits', null, 'xhigh');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    // prepareInjectionPlan returns null (adapter has no live slash - codex-style).
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    // applied_effort='xhigh' == destination effort_override='xhigh' -> no delta -> no respawn.
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('no-live-swap: DOES respawn when the session runs at a different effort than the destination', async () => {
    // session applied_effort='low', destination effort='xhigh'.
    // The delta is real, so a no-live-swap respawn must fire.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    setActiveRecord('acceptEdits', null, 'low');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    // Delta exists: applied='low', target='xhigh' -> respawn.
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // No-live-swap effort regression-guard (project-level default_effort tier)
  // =========================================================================

  it('no-live-swap: DOES respawn when the session runs at a different effort than the project default (no lane override)', async () => {
    // Lane carries no effort_override (null), so the target falls through to
    // project.default_effort. Session applied_effort='low' differs from the
    // project default 'xhigh' -> a real delta -> respawn must fire.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: null });
    setActiveRecord('acceptEdits', null, 'low');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    context.projectRepo.getById = vi.fn(() => ({ id: 'proj-test', default_agent: 'claude', default_effort: 'xhigh' }));
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('no-live-swap: does NOT respawn when the session already runs at the project default_effort (no lane override)', async () => {
    // Session is already at 'xhigh', which matches the project default; the
    // lane has no override so target = project default = 'xhigh' -> no delta.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: null });
    setActiveRecord('acceptEdits', null, 'xhigh');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    context.projectRepo.getById = vi.fn(() => ({ id: 'proj-test', default_agent: 'claude', default_effort: 'xhigh' }));
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001',
      targetSwimlaneId: EXECUTING_LANE_ID,
      targetPosition: 0,
    });

    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
