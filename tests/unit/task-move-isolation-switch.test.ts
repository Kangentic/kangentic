/**
 * Unit tests for the session switch branch in handleTaskMove
 * (src/main/ipc/handlers/task-move.ts).
 *
 * The session switch fires inside Priority 3 (task has a live session) when the
 * live session's isolation (isolated_swimlane_id) differs from what the target
 * column wants. It must:
 *   1. Suspend the live session (capture metrics + markRecordSuspended +
 *      sessionManager.suspend) and clear task.session_id.
 *   2. Return a MoveSpawnPlan so Phase 3 resumes-or-spawns the TARGET session via
 *      spawnAgent(toLane) - the isolation is derived from the column strategy.
 *
 * Two transitions exercise it:
 *   - ENTER an isolated column from a live main session.
 *   - LEAVE an isolated column back to a normal column (must NOT keep the
 *     reviewer alive in the normal column - the latent keep-alive bug this
 *     guards).
 *
 * A third test pins the regression guard: a normal -> normal move of a main
 * session must NOT take the line-switch branch.
 *
 * Harness modeled on task-move-rollback.test.ts; the SessionRepository mock
 * returns a configurable active record so Priority 3 is reachable.
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

vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
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

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-exec',
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
    // Read by resolveLiveEffort; empty means the agent reports no effort.
    getUsageCache: vi.fn((): Record<string, unknown> => ({})),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
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
    attachments: { deleteByTaskId: vi.fn() },
  });
  return context;
}

const EXEC_LANE_ID = 'lane-exec';
const REVIEW_ISOLATED_LANE_ID = 'lane-review-isolated';

describe('handleTaskMove session switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
  });

  it('ENTER isolated: suspends the live main session and spawns the isolated column', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main' });
    const isolatedLane = makeSwimlane(REVIEW_ISOLATED_LANE_ID, { session_target: 'isolated', auto_command: '/code-review' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === REVIEW_ISOLATED_LANE_ID ? isolatedLane : null)),
      list: vi.fn(() => [execLane, isolatedLane]),
    };

    // Live main session on the exec lane.
    hoisted.activeRecord = {
      id: 'rec-main', task_id: 'task-aaa00001', isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' }))
        .mockReturnValue(makeTask({ swimlane_id: REVIEW_ISOLATED_LANE_ID, session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => [makeTask()]),
      archive: vi.fn(),
    };

    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: REVIEW_ISOLATED_LANE_ID, targetPosition: 0,
    });

    // Suspended the live (main) line.
    expect(markRecordSuspended).toHaveBeenCalledWith(expect.anything(), 'rec-main', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-aaa00001', session_id: null });

    // Phase 3 spawned with the isolated column as the destination (line derived there).
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { toLane: Swimlane };
    expect(spawnArg.toLane.id).toBe(REVIEW_ISOLATED_LANE_ID);
    expect(spawnArg.toLane.session_target).toBe('isolated');
  });

  it('LEAVE isolated: suspends the isolated line and spawns the normal column (no keep-alive strand)', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main' });
    const isolatedLane = makeSwimlane(REVIEW_ISOLATED_LANE_ID, { session_target: 'isolated' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === REVIEW_ISOLATED_LANE_ID ? isolatedLane : null)),
      list: vi.fn(() => [execLane, isolatedLane]),
    };

    // Live ISOLATED session (line = the review lane id).
    hoisted.activeRecord = {
      id: 'rec-isolated', task_id: 'task-aaa00001', isolated_swimlane_id: REVIEW_ISOLATED_LANE_ID,
      agent_session_id: 'agent-B', status: 'running',
      started_at: '2026-01-02T00:00:00Z', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: REVIEW_ISOLATED_LANE_ID, session_id: 'active-session-1' }))
        .mockReturnValue(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => [makeTask()]),
      archive: vi.fn(),
    };

    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXEC_LANE_ID, targetPosition: 0,
    });

    // Suspended the live isolated line (not kept alive).
    expect(markRecordSuspended).toHaveBeenCalledWith(expect.anything(), 'rec-isolated', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');

    // Phase 3 spawned with the NORMAL column (which resumes main).
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { toLane: Swimlane };
    expect(spawnArg.toLane.id).toBe(EXEC_LANE_ID);
    expect(spawnArg.toLane.session_target).toBe('main');
  });

  it('regression: normal -> normal move of a main session does NOT line-switch', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main' });
    const otherLane = makeSwimlane('lane-other', { session_target: 'main' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-other' ? otherLane : null)),
      list: vi.fn(() => [execLane, otherLane]),
    };

    // Live main session; target is another normal column, no auto_command.
    hoisted.activeRecord = {
      id: 'rec-main', task_id: 'task-aaa00001', isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn(() => makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' })),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => [makeTask()]),
      archive: vi.fn(),
    };

    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: 'lane-other', targetPosition: 0,
    });

    // No line switch: the live main session is kept alive (no suspend, no respawn).
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('FORCE-FRESH (reset-main): a main + always_spawn_new column suspends the live main session and respawns fresh', async () => {
    // Same track on both sides (main -> main), so the isolation inequality does
    // NOT fire. But the target column forces a fresh session each entry
    // (always_spawn_new), so it must still suspend + route to Phase 3 (which
    // spawns fresh via forceFresh) rather than fall through to Priority 3d
    // keep-alive. This is the reset-main cell of the matrix, and the only case
    // the targetForceFresh predicate clause exists for.
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', session_spawn_strategy: 'create_or_resume' });
    const resetLane = makeSwimlane('lane-reset', { session_target: 'main', session_spawn_strategy: 'always_spawn_new' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-reset' ? resetLane : null)),
      list: vi.fn(() => [execLane, resetLane]),
    };

    // Live MAIN session (isolation null on both the active record and the target).
    hoisted.activeRecord = {
      id: 'rec-main', task_id: 'task-aaa00001', isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' }))
        .mockReturnValue(makeTask({ swimlane_id: 'lane-reset', session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => [makeTask()]),
      archive: vi.fn(),
    };

    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: 'lane-reset', targetPosition: 0,
    });

    // Suspended the live main session and routed to Phase 3 to spawn fresh.
    expect(markRecordSuspended).toHaveBeenCalledWith(expect.anything(), 'rec-main', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { toLane: Swimlane };
    expect(spawnArg.toLane.id).toBe('lane-reset');
    expect(spawnArg.toLane.session_spawn_strategy).toBe('always_spawn_new');
  });
});
