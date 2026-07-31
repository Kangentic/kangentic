/**
 * Wiring tests for `captureGitChurn` / `resolveDefaultBaseBranch` calls inside
 * `handleTaskMove` (src/main/ipc/handlers/task-move.ts).
 *
 * Bug #1 of the usage-dashboard fix: git churn (lines/files) was always 0
 * because the only capture site was the move-to-Done branch, which in the PR
 * flow runs AFTER the branch is merged (nothing left to diff). The fix adds
 * `captureGitChurn` calls at every session-finalization site inside
 * handleTaskMove, not just Done. `capture-git-stats-history.test.ts` already
 * unit-tests `captureGitChurn` itself (the no-clobber guard, one-row
 * consolidation, base-branch fallback) in isolation; NONE of the existing
 * task-move-*.test.ts files assert that handleTaskMove actually CALLS it at
 * each site with the right record id / project path / resolved branch. That
 * wiring is exactly the kind of regression a lower-tier pure-function test
 * cannot catch (the function could be perfect and a site could still forget
 * to call it, or pass the wrong record id) - see the 10-second-rule "wiring
 * between layers" criterion.
 *
 * `git-stats-capture` is mocked wholesale (captureGitChurn + resolveDefaultBaseBranch
 * as bare vi.fn()s) so these tests assert the CALL, not the git diff itself.
 * `resolveDefaultBaseBranch` is mocked to return a distinctive sentinel value
 * ('mocked-default-branch') so we can also confirm it is resolved ONCE per
 * move and threaded unchanged into every capture call (per the comment at
 * task-move.ts's `effectiveDefaultBranch` declaration).
 *
 * Harness modeled on task-move-isolation-switch.test.ts (closest existing
 * pattern for driving handleTaskMove's Priority 2 / 2.5 / 3 branches).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  activeRecord: null as Record<string, unknown> | null,
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'mocked-default-branch'),
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: hoisted.captureGitChurn,
  resolveDefaultBaseBranch: hoisted.resolveDefaultBaseBranch,
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.activeRecord);
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

const mockResolveTargetAgent = vi.fn(() => ({ agent: 'claude', isHandoff: false }));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: (...args: unknown[]) => mockResolveTargetAgent(...args),
}));

const mockPrepareInjectionPlan = vi.fn(() => null as { needsRestartForModel: boolean } | null);
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
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

const TASK_ID = 'task-aaa00001';
const PROJECT_PATH = '/mock/project';
const RESOLVED_BRANCH = 'mocked-default-branch';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-exec',
    position: 0,
    agent: 'claude',
    session_id: null,
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
    // Read by resolveLiveEffort; empty means the agent reports no effort.
    getUsageCache: vi.fn((): Record<string, unknown> => ({})),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: PROJECT_PATH,
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
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

const EXEC_LANE_ID = 'lane-exec';

describe('handleTaskMove git-churn capture wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    hoisted.resolveDefaultBaseBranch.mockReturnValue(RESOLVED_BRANCH);
    mockResolveTargetAgent.mockReturnValue({ agent: 'claude', isHandoff: false });
    mockPrepareInjectionPlan.mockReturnValue(null);
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
  });

  it('Priority 2 (move to Done): captures git churn for the latest session record using the resolved default branch', async () => {
    const doingLane = makeSwimlane(EXEC_LANE_ID, { role: null });
    const doneLane = makeSwimlane('lane-done', { role: 'done' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? doingLane : id === 'lane-done' ? doneLane : null)),
      list: vi.fn(() => [doingLane, doneLane]),
    };

    // No active PTY; the latest record is a preserved exited session that
    // moving to Done should still capture churn for.
    hoisted.activeRecord = {
      id: 'rec-done', task_id: TASK_ID, agent_session_id: 'agent-A',
      status: 'exited', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn(() => makeTask({ swimlane_id: EXEC_LANE_ID, session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(() => [makeTask()]),
    };
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-done', targetPosition: 0,
    });

    expect(hoisted.resolveDefaultBaseBranch).toHaveBeenCalledWith(context, PROJECT_PATH);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-done',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
  });

  it('Priority 2.5 (auto_spawn=false target): suspends the live session and captures git churn', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const noSpawnLane = makeSwimlane('lane-no-spawn', { auto_spawn: false });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-no-spawn' ? noSpawnLane : null)),
      list: vi.fn(() => [execLane, noSpawnLane]),
    };

    hoisted.activeRecord = {
      id: 'rec-noswap', task_id: TASK_ID, agent_session_id: 'agent-B',
      status: 'running', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn(() => makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' })),
      move: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(() => [makeTask()]),
    };
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-no-spawn', targetPosition: 0,
    });

    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-noswap',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('Priority 3 session switch (isolation ENTER): captures git churn for the suspended live record', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main' });
    const isolatedLane = makeSwimlane('lane-review-isolated', { session_target: 'isolated', auto_command: '/code-review' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-review-isolated' ? isolatedLane : null)),
      list: vi.fn(() => [execLane, isolatedLane]),
    };

    hoisted.activeRecord = {
      id: 'rec-main', task_id: TASK_ID, isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' }))
        .mockReturnValue(makeTask({ swimlane_id: 'lane-review-isolated', session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(() => [makeTask()]),
    };
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-review-isolated', targetPosition: 0,
    });

    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-main',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('Priority 3a (agent handoff): captures git churn for the suspended record before the new agent spawns', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const codexLane = makeSwimlane('lane-codex', { agent_override: 'codex' });
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-codex' ? codexLane : null)),
      list: vi.fn(() => [execLane, codexLane]),
    };

    hoisted.activeRecord = {
      id: 'rec-handoff', task_id: TASK_ID, isolated_swimlane_id: null,
      agent_session_id: 'agent-claude', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };
    mockResolveTargetAgent.mockReturnValue({ agent: 'codex', isHandoff: true });

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1', agent: 'claude' }))
        .mockReturnValue(makeTask({ swimlane_id: 'lane-codex', session_id: null, agent: 'claude' })),
      move: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(() => [makeTask()]),
    };
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-codex', targetPosition: 0,
    });

    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-handoff',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('suspendLiveSessionForRespawn (model-change respawn): captures git churn for the suspended record before respawn', async () => {
    const execLane = makeSwimlane(EXEC_LANE_ID);
    const targetLane = makeSwimlane('lane-target');
    const swimlaneRepo = {
      getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-target' ? targetLane : null)),
      list: vi.fn(() => [execLane, targetLane]),
    };

    hoisted.activeRecord = {
      id: 'rec-model-restart', task_id: TASK_ID, isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    };
    // Forces the suspendLiveSessionForRespawn branch (step 1: model change).
    mockPrepareInjectionPlan.mockReturnValue({ needsRestartForModel: true });

    const taskRepo = {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask({ swimlane_id: EXEC_LANE_ID, session_id: 'active-session-1' }))
        .mockReturnValue(makeTask({ swimlane_id: 'lane-target', session_id: null })),
      move: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(() => [makeTask()]),
    };
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-target', targetPosition: 0,
    });

    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-model-restart',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });
});
