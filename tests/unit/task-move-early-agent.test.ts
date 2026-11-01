/**
 * A move into an agent column with a post-worktree script (#955): the move
 * hands `ensureTaskWorktree` a launcher, so the agent boots while the script
 * runs, and Phase 3's spawn adopts it. These tests drive the real
 * handleTaskMove with Phase 2 stubbed:
 *
 *   - the spawn (where the first prompt is typed) runs only once the script
 *     has exited, and receives the early agent to adopt;
 *   - a failed script still fails the move as before: rolled back to its
 *     source column, `Worktree setup failed: ...`, no spawn;
 *   - a Phase 3 check that skips the spawn discards the early agent;
 *   - a move that fails or aborts after Phase 2 returned the agent (the spawn
 *     rejects, the branch checkout throws, a Phase 3 read throws) discards it
 *     in the outer catch, before the rollback;
 *   - with `git.holdPromptForInitScript` off, the script runs in the
 *     background and the spawn carries the note that it is still running.
 *
 * Harness follows task-move-rollback.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('simple-git', () => ({ simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => true);
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({ markRecordExited: vi.fn(), markRecordSuspended: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({ resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })) }));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn();
const mockSpawnAgent = vi.fn(async () => {});
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => ({ failures: [] })) })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
  reportAutomationFailures: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { runWorktreeCreation } from '../../src/main/git/worktree-creation-registry';

const SOURCE_LANE_ID = 'lane-todo';
const TARGET_LANE_ID = 'lane-doing';
const WORKTREE = '/mock/project/.kangentic/worktrees/1';
const MOVE_INPUT = { taskId: 'task-aaa00001', targetSwimlaneId: TARGET_LANE_ID, targetPosition: 0 };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001', display_id: 1, title: 'My Task', description: '', swimlane_id: SOURCE_LANE_ID, position: 0,
    agent: null, session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
    base_branch: null, use_worktree: null, labels: [], priority: 0, attachment_count: 0, archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id, name: `Lane ${id}`, role: null, position: 0, color: '#888', icon: null, is_archived: false, is_ghost: false,
    permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null,
    model_override: null, effort_override: null, handoff_context: false, created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHandle(): EarlyAgentHandle & { discard: ReturnType<typeof vi.fn> } {
  return {
    sessionId: 'early-session', taskId: 'task-aaa00001', agentName: 'claude', agentSessionId: 'agent-session',
    command: 'claude', cwd: WORKTREE, launchKey: 'key',
    isSettled: () => false,
    markAdopted: () => true,
    discard: vi.fn(async () => {}),
  };
}

function setUp(options: { holdPrompt: boolean }) {
  const task = makeTask();
  const lanes = new Map([
    [SOURCE_LANE_ID, makeSwimlane(SOURCE_LANE_ID, { role: 'todo' })],
    [TARGET_LANE_ID, makeSwimlane(TARGET_LANE_ID)],
  ]);
  // The row as the moves leave it: Phase 3 and the rollback read it back.
  const row: Task = { ...task };
  const taskRepo = {
    getById: vi.fn(() => ({ ...row })),
    move: vi.fn((input: { targetSwimlaneId: string }) => { row.swimlane_id = input.targetSwimlaneId; }),
    update: vi.fn(),
    list: vi.fn(() => [{ ...row }]),
    archive: vi.fn(),
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: { getById: vi.fn((id: string) => lanes.get(id) ?? null), list: vi.fn(() => [...lanes.values()]) },
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      removeByTaskId: vi.fn(),
      killByTaskId: vi.fn(),
      listSessions: vi.fn(() => []),
      suspend: vi.fn(async () => {}),
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      findLiveSessionByTaskId: vi.fn(() => null),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'default' },
        git: { defaultBaseBranch: 'main', initScript: 'pnpm install --frozen-lockfile', holdPromptForInitScript: options.holdPrompt },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  return { context, taskRepo, task };
}

/** The forward move, then the revert to the source column that the outer catch's rollback makes. */
function expectRolledBackToSource(taskRepo: ReturnType<typeof setUp>['taskRepo']): void {
  expect(taskRepo.move).toHaveBeenCalledTimes(2);
  expect(taskRepo.move).toHaveBeenLastCalledWith(
    expect.objectContaining({ targetSwimlaneId: SOURCE_LANE_ID }),
    expect.objectContaining({ origin: 'rollback' }),
  );
}

/** The options handleTaskMove passed `ensureTaskWorktree` on its one call. */
function worktreeOptions(): { initScript?: { mode: string; launchAgent?: unknown } } {
  return mockEnsureTaskWorktree.mock.calls[0]?.[4] as { initScript?: { mode: string; launchAgent?: unknown } };
}

describe('handleTaskMove with a post-worktree script: the agent starts early', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands ensureTaskWorktree a launcher, and spawns (types the prompt) only once the script has exited', async () => {
    const { context } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    let finishScript: () => void = () => undefined;
    mockEnsureTaskWorktree.mockImplementationOnce(() => new Promise((resolve) => { finishScript = () => resolve(handle); }));

    const move = handleTaskMove(context as never, MOVE_INPUT, 'renderer');
    await vi.waitFor(() => expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1));

    expect(worktreeOptions().initScript?.mode).toBe('hold-prompt');
    expect(typeof worktreeOptions().initScript?.launchAgent).toBe('function');
    // The script is still running: nothing has sent the agent its prompt.
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    finishScript();
    await move;

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({ earlyAgent: handle, setupStillRunning: undefined }));
  });

  it('a failed script still fails the move: rolled back, "Worktree setup failed", no spawn', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    mockEnsureTaskWorktree.mockRejectedValueOnce(new Error('init script exited with code 1: ERR_PNPM_OUTDATED_LOCKFILE'));

    await expect(handleTaskMove(context as never, MOVE_INPUT, 'renderer')).rejects.toThrow(
      'Worktree setup failed: init script exited with code 1: ERR_PNPM_OUTDATED_LOCKFILE',
    );

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    // The forward move, then the revert to the source column.
    expect(taskRepo.move).toHaveBeenCalledTimes(2);
    expect(taskRepo.move).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetSwimlaneId: SOURCE_LANE_ID }),
      expect.objectContaining({ origin: 'rollback' }),
    );
  });

  it('discards the early agent when Phase 3 skips the spawn (the task moved on meanwhile)', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockImplementationOnce(async () => {
      // A newer placement landed while the script ran.
      taskRepo.move({ targetSwimlaneId: 'lane-review' });
      return handle;
    });

    await handleTaskMove(context as never, MOVE_INPUT, 'renderer');

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(handle.discard).toHaveBeenCalledTimes(1);
  });

  it('with the prompt not held, runs the script in the background and tells the agent it is still running', async () => {
    const { context, task } = setUp({ holdPrompt: false });
    let finishScript: () => void = () => undefined;
    let scriptHold: Promise<void> = Promise.resolve();
    mockEnsureTaskWorktree.mockImplementationOnce(async (_context: unknown, movingTask: Task) => {
      // The new worktree is recorded, and its script still holds the path.
      movingTask.worktree_path = WORKTREE;
      scriptHold = runWorktreeCreation(WORKTREE, undefined, () => new Promise<void>((resolve) => { finishScript = resolve; }));
      return null;
    });

    await handleTaskMove(context as never, { ...MOVE_INPUT, taskId: task.id }, 'renderer');
    finishScript();
    await scriptHold;

    expect(worktreeOptions().initScript?.mode).toBe('background');
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      setupStillRunning: expect.stringContaining('pnpm install --frozen-lockfile'),
    }));
  });

  it('with the prompt not held, sends no note when the script already finished', async () => {
    const { context, task } = setUp({ holdPrompt: false });
    mockEnsureTaskWorktree.mockImplementationOnce(async (_context: unknown, movingTask: Task) => {
      movingTask.worktree_path = WORKTREE;
      return null;
    });

    await handleTaskMove(context as never, { ...MOVE_INPUT, taskId: task.id }, 'renderer');

    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({ setupStillRunning: undefined }));
  });
});

/**
 * Phase 2 handed back an early agent and the move then fails. The outer catch
 * discards the handle before it rolls back. spawnAgent is mocked, so the real
 * one's own discard (its `finally`) never runs here, and a throw out of the
 * Phase 3 lock skips the discard after Phase 3. The catch block's discard is
 * therefore the only caller in each test: reverting it leaves the handle's
 * discard at zero calls and the agent running with no task.
 */
describe('handleTaskMove discards the early agent when the move fails after Phase 2 returned it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a Phase 3 spawn that rejects: discards the agent once, before the rollback, and rethrows the spawn error', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValueOnce(handle);
    mockSpawnAgent.mockRejectedValueOnce(new Error('spawn failed: agent binary not found'));

    // Phase 3 sits outside the worktree try, so the raw spawn error surfaces
    // (not wrapped as "Worktree setup failed").
    await expect(handleTaskMove(context as never, MOVE_INPUT, 'renderer')).rejects.toMatchObject({
      message: 'spawn failed: agent binary not found',
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(handle.discard).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(MOVE_INPUT.taskId);
    expectRolledBackToSource(taskRepo);
    // The agent goes before the rollback reverts the task's column.
    expect(handle.discard.mock.invocationCallOrder[0]).toBeLessThan(taskRepo.move.mock.invocationCallOrder[1]);
  });

  it('a Phase 3 spawn aborted by a newer move: discards the agent once, makes no revert, and resolves', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValueOnce(handle);
    mockSpawnAgent.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    // An abort is a superseded move, not a failure: the handler returns quietly.
    await handleTaskMove(context as never, MOVE_INPUT, 'renderer');

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(handle.discard).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(MOVE_INPUT.taskId);
    // Only the forward move: the newer move owns the task's column, so the abort path does not revert.
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
  });

  it('the branch checkout after Phase 2 throwing: discards the agent once, rolls back, and never spawns', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockResolvedValueOnce(handle);
    mockEnsureTaskBranchCheckout.mockRejectedValueOnce(new Error('checkout blocked: uncommitted changes'));

    // The checkout is deliberately unguarded: its error goes straight to the outer catch.
    await expect(handleTaskMove(context as never, MOVE_INPUT, 'renderer')).rejects.toMatchObject({
      message: 'checkout blocked: uncommitted changes',
    });

    expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(handle.discard).toHaveBeenCalledTimes(1);
    expectRolledBackToSource(taskRepo);
  });

  it('a Phase 3 gate read throwing before the spawn: discards the agent once, rolls back, and never spawns', async () => {
    const { context, taskRepo } = setUp({ holdPrompt: true });
    const handle = makeHandle();
    mockEnsureTaskWorktree.mockImplementationOnce(async () => {
      // The next task read is Phase 3's gate read (the worktree step is behind us, the checkout is a mock).
      taskRepo.getById.mockImplementationOnce(() => { throw new Error('database is locked'); });
      return handle;
    });

    // The exact message: had the read thrown inside the worktree try, it would arrive wrapped as "Worktree setup failed: ...".
    await expect(handleTaskMove(context as never, MOVE_INPUT, 'renderer')).rejects.toMatchObject({
      message: 'database is locked',
    });

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(handle.discard).toHaveBeenCalledTimes(1);
    expectRolledBackToSource(taskRepo);
  });
});
