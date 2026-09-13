/**
 * Unit tests for the spawn-progress label emitted during a suspend-for-respawn
 * in handleTaskMove (src/main/ipc/handlers/task-move.ts).
 *
 * Before this fix, a model change / cross-agent handoff / effort-only respawn /
 * session-track switch suspended the live session in Phase 1 and emitted NO
 * label until Phase 3's `emitSpawnProgress('starting-agent')`. For the whole
 * unlocked Phase 2 gap between them, the renderer read the suspended record as
 * a genuine park: the big "Resume session" Play button and the board card's
 * "Paused" chip flashed over a task that was mid-handoff, not parked. See the
 * task description for the measured 1.78s window on kangentic-mobile #74.
 *
 * The fix routes all four respawn branches through `suspendLiveSessionForRespawn`,
 * which emits a phase-specific label as its FIRST statement - before the record
 * is even marked suspended. These tests pin that ordering (the label must be
 * emitted before `sessionManager.suspend` is called, not merely "at some point"),
 * and pin the negative case: a genuine park (Done, auto_spawn=false) emits no
 * respawn phase and calls `clearSpawnProgress` explicitly instead of relying on
 * the renderer's suspended-row carve-out (session-store.ts's `upsertSession`) to
 * retire a label that was never emitted.
 *
 * Harness modeled on task-move-git-churn-wiring.test.ts (closest existing
 * pattern already covering both the agent-handoff and model-change respawn
 * branches with an overridable resolveTargetAgent / prepareInjectionPlan, and
 * the Priority 2 Done branch's captureSessionLeftovers / reapSessionLeftovers
 * mocks) and task-move-isolation-switch.test.ts (the session-switch branch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  activeRecord: null as Record<string, unknown> | null,
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
    // Read by Priority 2's completion-analytics tracking (move to Done).
    getSummaryForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
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

// Named references (not bare `vi.fn()` inline) so the ordering test below can
// read `invocationCallOrder` off them directly. Variables prefixed `mock` are
// hoisted by Vitest alongside the `vi.mock` call itself.
const mockMarkRecordSuspended = vi.fn();
const mockMarkRecordExited = vi.fn();
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: (...args: unknown[]) => mockMarkRecordExited(...args),
  markRecordSuspended: (...args: unknown[]) => mockMarkRecordSuspended(...args),
}));

// Controllable via `mockIsShuttingDown.value` so a test can simulate shutdown
// starting mid-move without touching the real shutdown-state module.
const mockIsShuttingDown = { value: false };
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => mockIsShuttingDown.value,
}));

const mockEmitSpawnProgress = vi.fn();
const mockClearSpawnProgress = vi.fn();
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: (...args: unknown[]) => mockEmitSpawnProgress(...args),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: (...args: unknown[]) => mockClearSpawnProgress(...args),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

const mockResolveTargetAgent = vi.fn(() => ({ agent: 'claude', isHandoff: false }));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: (...args: unknown[]) => mockResolveTargetAgent(...args),
}));

const mockPrepareInjectionPlan = vi.fn(() => null as { needsRestartForModel: boolean; sequence: unknown[]; verifier: null } | null);
vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: (...args: unknown[]) => mockPrepareInjectionPlan(...args),
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

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
  // The Done branch snapshots the session's process tree before suspending and
  // reaps it before the worktree delete. Inert here (no background shells in
  // these fixtures); covered for real by session-tree-reap.test.ts.
  captureSessionLeftovers: vi.fn(() => null),
  reapSessionLeftovers: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

const TASK_ID = 'task-aaa00001';
const EXEC_LANE_ID = 'lane-exec';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: EXEC_LANE_ID,
    position: 0,
    agent: 'claude',
    session_id: 'active-session-1',
    worktree_path: null,
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
    // Read by resolveLiveEffort; empty means the agent reports no effort, so
    // the effort-delta test sources from the session record as intended.
    getUsageCache: vi.fn((): Record<string, unknown> => ({})),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null), getBoardProfiles: vi.fn(() => []) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn(), getPathsForTask: vi.fn(() => []) },
  });
  return context;
}

/** Live main session record. Phase 1 reads it via getLatestForTask. */
function setActiveRecord(overrides: Record<string, unknown> = {}) {
  hoisted.activeRecord = {
    id: 'rec-main',
    task_id: TASK_ID,
    isolated_swimlane_id: null,
    agent_session_id: 'agent-A',
    status: 'running',
    started_at: '2026-01-01T00:00:00Z',
    session_type: 'claude_agent',
    applied_model: null,
    applied_effort: null,
    ...overrides,
  };
}

/** Phase 1 sees the task with a live session; Phase 3 re-reads it moved with no session. */
function makeTaskRepo(fromLaneId: string, toLaneId: string, extra: Partial<Task> = {}) {
  return {
    getById: vi.fn()
      .mockReturnValueOnce(makeTask({ swimlane_id: fromLaneId, session_id: 'active-session-1', ...extra }))
      .mockReturnValue(makeTask({ swimlane_id: toLaneId, session_id: null, ...extra })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
  };
}

describe('handleTaskMove respawn branches emit a spawn-progress label before suspending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    mockIsShuttingDown.value = false;
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockPrepareInjectionPlan.mockReturnValue(null);
    mockResolveTargetAgent.mockReturnValue({ agent: 'claude', isHandoff: false });
  });

  /**
   * Asserts emitSpawnProgress(mainWindow, taskId, phase) fired strictly before
   * sessionManager.suspend AND strictly before whichever of markRecordSuspended
   * / markRecordExited the branch takes. The docblock's claim is "before the
   * record is even marked suspended" - anchoring only against `suspend` would
   * stay green even if the emit moved down past the metrics capture and the
   * markRecordSuspended/markRecordExited call, since those already run earlier
   * than `suspend` in suspendLiveSessionForRespawn.
   */
  function expectLabelEmittedBeforeSuspend(context: ReturnType<typeof makeContext>, phase: string) {
    expect(mockEmitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, phase);
    const emitOrder = mockEmitSpawnProgress.mock.invocationCallOrder[0];
    const suspendOrder = context.sessionManager.suspend.mock.invocationCallOrder[0];
    expect(emitOrder).toBeLessThan(suspendOrder);

    const markSuspendedOrder = mockMarkRecordSuspended.mock.invocationCallOrder[0] as number | undefined;
    const markExitedOrder = mockMarkRecordExited.mock.invocationCallOrder[0] as number | undefined;
    const markOrder = markSuspendedOrder ?? markExitedOrder;
    expect(markOrder).toBeDefined();
    expect(emitOrder).toBeLessThan(markOrder as number);
  }

  it('model change: emits "switching-model" before suspending', async () => {
    const planningLane = makeSwimlane('lane-planning', { permission_mode: 'plan' });
    const execLane = makeSwimlane(EXEC_LANE_ID, { permission_mode: 'auto' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === 'lane-planning' ? planningLane : id === EXEC_LANE_ID ? execLane : null)),
      list: vi.fn(() => [planningLane, execLane]),
    };
    setActiveRecord();
    mockPrepareInjectionPlan.mockReturnValue({ sequence: [], verifier: null, needsRestartForModel: true });
    const taskRepo = makeTaskRepo('lane-planning', EXEC_LANE_ID);
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: EXEC_LANE_ID, targetPosition: 0 }, 'renderer');

    expectLabelEmittedBeforeSuspend(context, 'switching-model');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('effort-only respawn (no live swap): emits "applying-settings" before suspending', async () => {
    const fromLane = makeSwimlane('lane-from');
    const toLane = makeSwimlane(EXEC_LANE_ID, { effort_override: 'xhigh' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === 'lane-from' ? fromLane : id === EXEC_LANE_ID ? toLane : null)),
      list: vi.fn(() => [fromLane, toLane]),
    };
    // Session already running at 'low'; destination wants 'xhigh'. No adapter
    // live-swap plan (mockPrepareInjectionPlan returns null), so this is the
    // no-live-swap CLI-flag respawn (Priority 3d step 2b), not a live inject.
    setActiveRecord({ applied_effort: 'low' });
    const taskRepo = makeTaskRepo('lane-from', EXEC_LANE_ID);
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: EXEC_LANE_ID, targetPosition: 0 }, 'renderer');

    expectLabelEmittedBeforeSuspend(context, 'applying-settings');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('session-track switch (enter isolated column): emits "new-session" before suspending', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main' });
    const isolatedLane = makeSwimlane('lane-review-isolated', { session_target: 'isolated', auto_command: '/code-review' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-review-isolated' ? isolatedLane : null)),
      list: vi.fn(() => [execLane, isolatedLane]),
    };
    setActiveRecord({ isolated_swimlane_id: null });
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-review-isolated');
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-review-isolated', targetPosition: 0 }, 'renderer');

    expectLabelEmittedBeforeSuspend(context, 'new-session');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('session-track switch (always_spawn_new, same track): emits "new-session" before suspending', async () => {
    // Sibling trigger of the branch above: same track on both sides (main ->
    // main), so the isolation inequality does NOT fire, but the target column
    // forces a fresh session each entry. Same suspendLiveSessionForRespawn
    // call, different boolean getting there - see
    // task-move-isolation-switch.test.ts's FORCE-FRESH case for the branch
    // itself; this pins that it labels the window too.
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', session_spawn_strategy: 'create_or_resume' });
    const resetLane = makeSwimlane('lane-reset', { session_target: 'main', session_spawn_strategy: 'always_spawn_new' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-reset' ? resetLane : null)),
      list: vi.fn(() => [execLane, resetLane]),
    };
    setActiveRecord({ isolated_swimlane_id: null });
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-reset');
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-reset', targetPosition: 0 }, 'renderer');

    expectLabelEmittedBeforeSuspend(context, 'new-session');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('cross-agent handoff: emits "switching-agent" before suspending', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const codexLane = makeSwimlane('lane-codex', { agent_override: 'codex' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-codex' ? codexLane : null)),
      list: vi.fn(() => [execLane, codexLane]),
    };
    setActiveRecord();
    mockResolveTargetAgent.mockReturnValue({ agent: 'codex', isHandoff: true });
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-codex', { agent: 'claude' });
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-codex', targetPosition: 0 }, 'renderer');

    expectLabelEmittedBeforeSuspend(context, 'switching-agent');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('cross-agent handoff without a locked agent_override: nulls model_override and effort_override on suspend', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const codexLane = makeSwimlane('lane-codex', { agent_override: 'codex' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-codex' ? codexLane : null)),
      list: vi.fn(() => [execLane, codexLane]),
    };
    setActiveRecord();
    mockResolveTargetAgent.mockReturnValue({ agent: 'codex', isHandoff: true });
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-codex', { agent: 'claude', agent_override: null });
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-codex', targetPosition: 0 }, 'renderer');

    expect(taskRepo.update).toHaveBeenCalledWith({
      id: TASK_ID,
      session_id: null,
      model_override: null,
      effort_override: null,
    });
  });

  it('cross-agent handoff WITH a locked agent_override: keeps model_override and effort_override on suspend', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const codexLane = makeSwimlane('lane-codex', { agent_override: 'codex' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-codex' ? codexLane : null)),
      list: vi.fn(() => [execLane, codexLane]),
    };
    setActiveRecord();
    // isHandoff true is what the mocked resolver returns here regardless of
    // agent_override (see the defensive-guard comment at the call site); the
    // behavior under test is the additionalTaskUpdates ternary, not resolution.
    mockResolveTargetAgent.mockReturnValue({ agent: 'codex', isHandoff: true });
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-codex', { agent: 'claude', agent_override: 'claude' });
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-codex', targetPosition: 0 }, 'renderer');

    expect(taskRepo.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
    expect(taskRepo.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ model_override: null }),
    );
  });
});

describe('handleTaskMove respawn branches during shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    mockIsShuttingDown.value = false;
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockPrepareInjectionPlan.mockReturnValue(null);
    mockResolveTargetAgent.mockReturnValue({ agent: 'claude', isHandoff: false });
  });

  /** Builds the same model-change respawn scenario the ordering test above uses. */
  function makeModelChangeScenario() {
    const planningLane = makeSwimlane('lane-planning', { permission_mode: 'plan' });
    const execLane = makeSwimlane(EXEC_LANE_ID, { permission_mode: 'auto' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === 'lane-planning' ? planningLane : id === EXEC_LANE_ID ? execLane : null)),
      list: vi.fn(() => [planningLane, execLane]),
    };
    setActiveRecord();
    mockPrepareInjectionPlan.mockReturnValue({ sequence: [], verifier: null, needsRestartForModel: true });
    const taskRepo = makeTaskRepo('lane-planning', EXEC_LANE_ID);
    const context = makeContext(taskRepo, swimlaneRepo);
    return { swimlaneRepo, taskRepo, context };
  }

  it('shutdown already in progress after Phase 1: clears spawn progress and never reaches Phase 2/3', async () => {
    mockIsShuttingDown.value = true;
    const { context } = makeModelChangeScenario();

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: EXEC_LANE_ID, targetPosition: 0 }, 'renderer');

    // The respawn branch still labels the window before suspending (Phase 1
    // work), but the isShuttingDown() gate right after Phase 1 returns must
    // stop it there.
    expect(mockEmitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, 'switching-model');
    expect(mockClearSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID);
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('shutdown starts during Phase 2: the failure-path clearSpawnProgress still fires ahead of the shutdown bail', async () => {
    const { context } = makeModelChangeScenario();
    // Simulate shutdown beginning while the Phase 2 worktree await is in
    // flight: the flag flips true right as this call throws, so Phase 1's own
    // isShuttingDown() gate (checked before this call) sees false and lets
    // Phase 2 start, matching "shutdown started while a Phase 2 await was in
    // flight" from the source comment on the outer catch.
    mockEnsureTaskWorktree.mockImplementation(async () => {
      mockIsShuttingDown.value = true;
      throw new Error('worktree setup blew up');
    });

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: EXEC_LANE_ID, targetPosition: 0 }, 'renderer');

    expect(mockClearSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe('handleTaskMove genuine parks clear the label instead of emitting a respawn phase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    mockIsShuttingDown.value = false;
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockPrepareInjectionPlan.mockReturnValue(null);
    mockResolveTargetAgent.mockReturnValue({ agent: 'claude', isHandoff: false });
  });

  it('Done: clears spawn progress and never emits a respawn phase', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const doneLane = makeSwimlane('lane-done', { role: 'done' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-done' ? doneLane : null)),
      list: vi.fn(() => [execLane, doneLane]),
    };
    setActiveRecord();
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-done');
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-done', targetPosition: 0 }, 'renderer');

    // A genuine park: suspends (Priority 2's own bookkeeping) but never routes
    // through suspendLiveSessionForRespawn, so no respawn phase is emitted -
    // the explicit clear is what retires any label a prior in-flight spawn
    // left behind (Priority 1's clear, mirrored here).
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockEmitSpawnProgress).not.toHaveBeenCalled();
    expect(mockClearSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('auto_spawn=false: clears spawn progress and never emits a respawn phase', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const parkedLane = makeSwimlane('lane-parked', { auto_spawn: false });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-parked' ? parkedLane : null)),
      list: vi.fn(() => [execLane, parkedLane]),
    };
    setActiveRecord();
    const taskRepo = makeTaskRepo(EXEC_LANE_ID, 'lane-parked');
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: 'lane-parked', targetPosition: 0 }, 'renderer');

    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockEmitSpawnProgress).not.toHaveBeenCalled();
    expect(mockClearSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
