/**
 * The branches of a move by the task's own agent session that
 * task-move-own-agent-turn.test.ts leaves open
 * (src/main/ipc/handlers/task-move.ts with own-call-turn-wait.ts).
 *
 * That file pins the session switch into an isolated column, Done, a column with
 * no agent, the bound, the abort and the mark's timing. This one pins the rest of
 * the same mechanism:
 *   - the agent handoff and the model or effort restart call sites of
 *     `suspendLiveSessionForRespawn` each wait for the turn before the suspend,
 *     and suspend at once for a mover that is not the live session;
 *   - a move to To Do by the own agent never waits;
 *   - Phase 1 throwing after the commit still releases the mark;
 *   - a same-column move never marks the session;
 *   - a caller whose session is no longer running at the wait suspends at once
 *     instead of holding the move for OWN_CALL_TURN_WAIT_MS.
 *
 * Harness copied from task-move-own-agent-turn.test.ts: a session manager that
 * is a real EventEmitter so the real `waitForTurnCompletion` hears its activity,
 * and fake timers over setTimeout and Date only so the task lock's promise chain
 * and `setImmediate` stay real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  activeRecord: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.activeRecord);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => hoisted.activeRecord);
    findByAnyId = vi.fn(() => hoisted.activeRecord);
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
vi.mock('../../src/main/analytics/usage', () => ({ trackMilestone: vi.fn() }));

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
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({ closeTaskWindows: vi.fn() }));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockSpawnAgent = vi.fn(async () => {});
const mockExecuteTransition = vi.fn();

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: vi.fn(() => ({ executeTransition: (...args: unknown[]) => mockExecuteTransition(...args) })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => {}),
  reportAutomationFailures: vi.fn(),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { isSessionInOwnCall } from '../../src/main/ipc/handlers/own-call-turn-wait';
import { cleanupTaskResources } from '../../src/main/ipc/helpers/index';
import { emitSpawnProgress } from '../../src/main/transition-engine/spawn-progress';
import { resolveTargetAgent } from '../../src/main/transition-engine/agent-resolver';
import { prepareInjectionPlan } from '../../src/main/transition-engine/injection-plan';

const TASK_ID = 'task-own-branches-1';
const SESSION_ID = 'active-session-1';
const TESTING_LANE_ID = 'lane-testing';
const REVIEW_LANE_ID = 'lane-review-isolated';
const DONE_LANE_ID = 'lane-done';
const TODO_LANE_ID = 'lane-todo';
const MERGE_LANE_ID = 'lane-merge';
/** `waitForTurnCompletion`'s default quiet window. */
const QUIET_MS = 1_500;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 928,
    title: 'Wait for the turn',
    description: '',
    swimlane_id: TESTING_LANE_ID,
    position: 0,
    agent: 'claude',
    session_id: SESSION_ID,
    worktree_path: null,
    branch_name: 'wait-for-the-turn',
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

const LANES: Swimlane[] = [
  makeSwimlane(TESTING_LANE_ID, { name: 'Testing' }),
  makeSwimlane(REVIEW_LANE_ID, { name: 'Code Review', session_target: 'isolated' }),
  makeSwimlane(DONE_LANE_ID, { name: 'Done', role: 'done' }),
  makeSwimlane(TODO_LANE_ID, { name: 'To Do', role: 'todo' }),
  makeSwimlane(MERGE_LANE_ID, { name: 'Merge' }),
];

/** A session manager the real `waitForTurnCompletion` can listen to. */
function makeSessionManager() {
  const activity: Record<string, string> = { [SESSION_ID]: 'thinking' };
  return Object.assign(new EventEmitter(), {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
    // A live row, so Phase 1's reconcile keeps the pointer.
    getSession: vi.fn((id: string): { id: string; status: string } | undefined => ({ id, status: 'running' })),
    findLiveSessionByTaskId: vi.fn(() => null),
    getUsageCache: vi.fn((): Record<string, unknown> => ({})),
    getFirstReportedEffort: vi.fn((): string | null => null),
    getActivityCache: vi.fn(() => activity),
  });
}

function makeContext() {
  const sessionManager = makeSessionManager();
  const taskRepo = {
    getById: vi.fn(() => makeTask()),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
    clearArchived: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
  };
  const swimlaneRepo = {
    getById: vi.fn((id: string) => LANES.find((lane) => lane.id === id) ?? null),
    list: vi.fn(() => LANES),
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
    automations: { listForColumn: vi.fn(() => []), getForTrigger: vi.fn(() => []) },
    automationRuns: { start: vi.fn(), finish: vi.fn(), recordSkipped: vi.fn() },
    attachments: { deleteByTaskId: vi.fn(), getPathsForTask: vi.fn(() => []) },
    taskMoves: { currentVisit: vi.fn(() => null) },
  });
  return { context, sessionManager, taskRepo };
}

type TestContext = ReturnType<typeof makeContext>;

/** Let the move run up to its next timer. `setImmediate` is not faked. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Start a move as the task's own agent session. Returns what the test needs to
 * watch it without ever leaving a rejection unhandled: whether it has settled,
 * and `outcome`, which resolves to null on success or to the error it threw.
 */
function startMove(
  context: TestContext['context'],
  targetSwimlaneId: string,
  extra: { moverSessionId?: string; onCommitted?: () => void } = {},
) {
  const state = { settled: false };
  const outcome = handleTaskMove(
    context as never,
    { taskId: TASK_ID, targetSwimlaneId, targetPosition: 0 },
    'agent',
    undefined,
    undefined,
    { moverIsTaskAgent: true, moverSessionId: SESSION_ID, ...extra },
  ).then(
    () => {
      state.settled = true;
      return null;
    },
    (error: unknown) => {
      state.settled = true;
      return error;
    },
  );
  return { state, outcome };
}

/** The turn ends: the engine commits idle, and the PTY then stays quiet for the window. */
async function endTurn(sessionManager: TestContext['sessionManager']): Promise<void> {
  sessionManager.emit('activity', SESSION_ID, 'idle');
  await vi.advanceTimersByTimeAsync(QUIET_MS);
}

describe('a move by the task\'s own agent: the branches beyond the session switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.activeRecord = {
      id: SESSION_ID, task_id: TASK_ID, isolated_swimlane_id: null,
      agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-10-27T23:18:31.385Z', session_type: 'claude_agent',
    };
    mockExecuteTransition.mockImplementation(async () => ({ failures: [] }));
    // Set again every test: clearAllMocks keeps a mockReturnValue, so a handoff or
    // restart set up by one test would otherwise reach the next.
    vi.mocked(resolveTargetAgent).mockImplementation(() => ({ agent: 'claude', isHandoff: false }));
    vi.mocked(prepareInjectionPlan).mockImplementation(() => null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('an agent handoff (the switching-agent suspend)', () => {
    beforeEach(() => {
      vi.mocked(resolveTargetAgent).mockImplementation(() => ({ agent: 'codex', isHandoff: true }));
    });

    it('waits for the turn before it suspends, and names the handoff only once it ends', async () => {
      const { context, sessionManager, taskRepo } = makeContext();

      const move = startMove(context, MERGE_LANE_ID);
      await settle();

      expect(taskRepo.move).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID, targetSwimlaneId: MERGE_LANE_ID }),
        expect.objectContaining({ origin: 'agent' }),
      );
      expect(sessionManager.suspend).not.toHaveBeenCalled();
      expect(emitSpawnProgress).not.toHaveBeenCalledWith(context.mainWindow, TASK_ID, 'switching-agent');
      expect(isSessionInOwnCall(SESSION_ID)).toBe(true);

      await endTurn(sessionManager);
      expect(await move.outcome).toBeNull();

      expect(emitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, 'switching-agent');
      expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
      expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, session_id: null }));
      expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
    });

    it('suspends at once when the mover session is not the task\'s live one', async () => {
      const { context, sessionManager } = makeContext();

      const move = startMove(context, MERGE_LANE_ID, { moverSessionId: 'some-other-session' });
      await settle();

      expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
      expect(emitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, 'switching-agent');
      expect(await move.outcome).toBeNull();
    });
  });

  describe('a model or effort restart', () => {
    it.each([
      ['model', 'switching-model'],
      ['effort', 'applying-settings'],
    ] as const)('when the %s changes it waits for the turn before it suspends, and shows %s only once it ends', async (restartReason, expectedPhase) => {
      vi.mocked(prepareInjectionPlan).mockImplementation(() => ({ sequence: [], verifier: null, restartReason }));
      const { context, sessionManager, taskRepo } = makeContext();

      const move = startMove(context, MERGE_LANE_ID);
      await settle();

      expect(taskRepo.move).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID, targetSwimlaneId: MERGE_LANE_ID }),
        expect.objectContaining({ origin: 'agent' }),
      );
      expect(sessionManager.suspend).not.toHaveBeenCalled();
      expect(emitSpawnProgress).not.toHaveBeenCalledWith(context.mainWindow, TASK_ID, expectedPhase);
      expect(isSessionInOwnCall(SESSION_ID)).toBe(true);

      await endTurn(sessionManager);
      expect(await move.outcome).toBeNull();

      expect(emitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, expectedPhase);
      expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
      expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, session_id: null }));
      expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
    });

    it('suspends at once when the mover session is not the task\'s live one', async () => {
      vi.mocked(prepareInjectionPlan).mockImplementation(() => ({ sequence: [], verifier: null, restartReason: 'model' }));
      const { context, sessionManager } = makeContext();

      const move = startMove(context, MERGE_LANE_ID, { moverSessionId: 'some-other-session' });
      await settle();

      expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
      expect(emitSpawnProgress).toHaveBeenCalledWith(context.mainWindow, TASK_ID, 'switching-model');
      expect(await move.outcome).toBeNull();
    });
  });

  it('a move to To Do tears the session down without waiting for the turn', async () => {
    const { context, sessionManager } = makeContext();

    // No idle is emitted and no timer advances: a wait anywhere in the branch
    // would leave one of the three checks below short.
    const move = startMove(context, TODO_LANE_ID);
    await settle();

    expect(sessionManager.killByTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(cleanupTaskResources).toHaveBeenCalled();
    expect(move.state.settled).toBe(true);
    expect(await move.outcome).toBeNull();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[OWN_CALL]'));
    expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
  });

  it('releases the mark and settles with the error when Phase 1 throws after the commit', async () => {
    const { context, sessionManager, taskRepo } = makeContext();
    sessionManager.suspend.mockRejectedValueOnce(new Error('suspend refused'));

    // The rejection lands inside the timer advance below, so the handler on
    // `outcome` is already attached by then.
    const move = startMove(context, DONE_LANE_ID);
    await settle();
    expect(taskRepo.move).toHaveBeenCalled();
    expect(isSessionInOwnCall(SESSION_ID)).toBe(true);

    await endTurn(sessionManager);
    const error = await move.outcome;

    expect(sessionManager.suspend).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('suspend refused');
    expect(move.state.settled).toBe(true);
    expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
  });

  // The mark is read WHILE the move runs, from `onCommitted`, which fires after
  // the commit-time mark: reading it after the move proves nothing, since the
  // release runs either way. The second row is the probe's control.
  it.each([
    ['never marks the session on a same-column move', TESTING_LANE_ID, false],
    ['marks the session at the commit on a move to another column', MERGE_LANE_ID, true],
  ])('%s', async (_label, targetSwimlaneId, expectedMarkedAtCommit) => {
    const { context, sessionManager } = makeContext();
    const markedAtCommit: boolean[] = [];

    const move = startMove(context, targetSwimlaneId, {
      onCommitted: () => markedAtCommit.push(isSessionInOwnCall(SESSION_ID)),
    });
    await settle();

    expect(await move.outcome).toBeNull();
    expect(markedAtCommit).toEqual([expectedMarkedAtCommit]);
    expect(sessionManager.suspend).not.toHaveBeenCalled();
    expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
  });

  describe('when the caller\'s session is no longer running at the wait', () => {
    /**
     * The registry reads the session as running until the exit group has run, so
     * Phase 1's reconcile keeps the pointer and the move is the live session's
     * own. From then on the row is `finalRow`: the session exited while the
     * source column's exit rows ran.
     */
    function endSessionDuringExitGroup(sessionManager: TestContext['sessionManager'], finalRow: { status: string } | undefined): void {
      mockExecuteTransition.mockImplementation(async (_task: unknown, _lane: unknown, trigger: string) => {
        if (trigger === 'exit') {
          sessionManager.getSession.mockImplementation((id: string) => (finalRow ? { id, ...finalRow } : undefined));
        }
        return { failures: [] };
      });
    }

    it.each([
      ['a move to Done', 'the registry row reads exited', DONE_LANE_ID, { status: 'exited' }],
      ['a move to Done', 'the registry has no row for it', DONE_LANE_ID, undefined],
      ['the session switch into an isolated column', 'the registry row reads exited', REVIEW_LANE_ID, { status: 'exited' }],
      ['the session switch into an isolated column', 'the registry has no row for it', REVIEW_LANE_ID, undefined],
    ])('%s suspends at once, with no hold for the turn, when %s', async (_label, _registryState, targetSwimlaneId, finalRow) => {
      const { context, sessionManager, taskRepo } = makeContext();
      endSessionDuringExitGroup(sessionManager, finalRow);

      // No idle is emitted and no timer advances: the session is still 'thinking'
      // in the activity cache, so a wait would hold the move to the 30 s bound.
      const move = startMove(context, targetSwimlaneId);
      await settle();

      expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
      expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, session_id: null }));
      expect(move.state.settled).toBe(true);
      expect(await move.outcome).toBeNull();
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[OWN_CALL]'));
      expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('[OWN_CALL]'));
      expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
    });
  });
});
