/**
 * Unit tests for the `tasks.clearArchived(...)` branch in handleTaskMove
 * (src/main/ipc/handlers/task-move.ts), the inverse of the auto-archive-into-Done
 * bookkeeping.
 *
 * tests/unit/done-move-bookkeeping.test.ts already pins this wiring with a
 * STATIC source-text scan (the call site exists, the conditional expression's
 * literal text is `Boolean(task.archived_at) && toLane?.role !== 'done'`, and
 * the repository's SQL string is correct). That is airtight for "the call site
 * exists with this exact text" but cannot catch an INTEGRATION bug: the
 * conditional reachable but never actually invoked (an earlier return sits
 * above it), `toLane` resolved from the wrong swimlane, or the condition
 * silently inverted while still matching some other regex. This file drives
 * the REAL handler (mirrors task-move-complete-analytics.test.ts's harness)
 * with a mocked TaskRepository exposing `clearArchived: vi.fn()`, so it
 * observes what the handler actually DOES, not what its source text says.
 *
 * Every scenario targets a lane with `auto_spawn: false` (Priority 2.5 in
 * task-move.ts) or a same-lane reorder, both of which return early with no
 * worktree/spawnAgent work - the clearArchived branch runs unconditionally
 * before any of those branches, so this keeps the harness to the same minimal
 * mock surface task-move-complete-analytics.test.ts uses.
 *
 * Covers the four branches of `Boolean(task.archived_at) && toLane?.role !== 'done'`:
 *   1. archived task, Done -> non-Done lane: clearArchived called
 *   2. archived task, reorder WITHIN Done (toLane.role stays 'done'): not called
 *   3. non-archived task, Done -> non-Done lane: not called (nothing to clear)
 *   4. archived task OUTSIDE Done moved to another non-Done lane (legacy row):
 *      still called - keyed on the task's own flag, not the source lane
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

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
    getLatestForTask = vi.fn(() => null);
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-clear-archived-001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-done',
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

function makeTaskRepo(task: Task) {
  return {
    getById: vi.fn(() => ({ ...task })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [{ ...task }]),
    archive: vi.fn(),
    clearArchived: vi.fn(),
  };
}

function makeSwimlaneRepo(lanes: Swimlane[]) {
  const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
  return {
    getById: vi.fn((id: string) => laneMap.get(id) ?? null),
    list: vi.fn(() => Array.from(laneMap.values())),
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
    boardEvents: { emitBoardChanged: vi.fn() },
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

const DONE_LANE_ID = 'lane-done';
const AUTO_SPAWN_OFF_LANE_ID = 'lane-no-spawn';
const CUSTOM_LANE_ID = 'lane-custom';

async function move(task: Task, targetSwimlaneId: string, lanes: Swimlane[]) {
  const swimlaneRepo = makeSwimlaneRepo(lanes);
  const taskRepo = makeTaskRepo(task);
  const context = makeContext(taskRepo, swimlaneRepo);

  await handleTaskMove(context as never, {
    taskId: task.id,
    targetSwimlaneId,
    targetPosition: 0,
  }, 'renderer');

  return { taskRepo };
}

describe('handleTaskMove clears archived_at on a move out of Done', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears archived_at when an archived task moves from Done to a non-Done lane', async () => {
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
    const noSpawnLane = makeSwimlane(AUTO_SPAWN_OFF_LANE_ID, { role: null, auto_spawn: false });
    const task = makeTask({ swimlane_id: DONE_LANE_ID, archived_at: '2025-06-01T00:00:00.000Z' });

    const { taskRepo } = await move(task, AUTO_SPAWN_OFF_LANE_ID, [doneLane, noSpawnLane]);

    expect(taskRepo.clearArchived).toHaveBeenCalledTimes(1);
    expect(taskRepo.clearArchived).toHaveBeenCalledWith(task.id);
  });

  it('does NOT clear archived_at when the move is a reorder WITHIN Done', async () => {
    // Red: inverting the handler's `!== 'done'` to `=== 'done'` makes this
    // assertion fail (clearArchived would be called once).
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
    const task = makeTask({ swimlane_id: DONE_LANE_ID, archived_at: '2025-06-01T00:00:00.000Z' });

    const { taskRepo } = await move(task, DONE_LANE_ID, [doneLane]);

    expect(taskRepo.clearArchived).not.toHaveBeenCalled();
  });

  it('does NOT clear anything for a non-archived task moving out of Done', async () => {
    const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
    const noSpawnLane = makeSwimlane(AUTO_SPAWN_OFF_LANE_ID, { role: null, auto_spawn: false });
    const task = makeTask({ swimlane_id: DONE_LANE_ID, archived_at: null });

    const { taskRepo } = await move(task, AUTO_SPAWN_OFF_LANE_ID, [doneLane, noSpawnLane]);

    expect(taskRepo.clearArchived).not.toHaveBeenCalled();
  });

  it('still clears a legacy archived task parked OUTSIDE Done (keyed on the flag, not the source lane)', async () => {
    const customLane = makeSwimlane(CUSTOM_LANE_ID, { role: null, auto_spawn: false });
    const otherLane = makeSwimlane(AUTO_SPAWN_OFF_LANE_ID, { role: null, auto_spawn: false });
    // A legacy row: archived_at set but sitting in a non-Done lane (e.g. its
    // Done-role lane was deleted, or an older code path archived it there).
    const task = makeTask({ swimlane_id: CUSTOM_LANE_ID, archived_at: '2025-06-01T00:00:00.000Z' });

    const { taskRepo } = await move(task, AUTO_SPAWN_OFF_LANE_ID, [customLane, otherLane]);

    expect(taskRepo.clearArchived).toHaveBeenCalledTimes(1);
    expect(taskRepo.clearArchived).toHaveBeenCalledWith(task.id);
  });
});
