/**
 * A move made by the task's own agent session that ends that session
 * (src/main/ipc/handlers/task-move.ts with own-call-turn-wait.ts).
 *
 * #916's agent moved itself Testing -> Code Review twice, and each time the
 * session-switch suspend landed 3 ms after the commit. The console close is
 * Claude's graceful exit, and Claude left without writing the move's tool call
 * or its result to its transcript, so the next resume made the move again.
 * #915's Merge -> Done move was lost the same way.
 *
 * So the move commits at once and ends the session only once the caller's
 * turn ends (idle, then a quiet PTY), up to OWN_CALL_TURN_WAIT_MS. Pinned here:
 *   - each session-ending branch (session switch, Done, a column with no
 *     agent) waits, and the commit came first;
 *   - the bound, and an abort from a newer move, end the wait;
 *   - a move by anyone else, or with a session id that is not the task's live
 *     one, ends the session at once, as before;
 *   - a move that keeps the session never waits;
 *   - the session is marked from the commit until Phase 1 settles, so the exit
 *     group already sees it and the enter group no longer does.
 *
 * Harness modeled on task-move-isolation-switch.test.ts, with a session
 * manager that is a real EventEmitter so the real `waitForTurnCompletion`
 * hears its activity. Fake timers cover setTimeout and Date only, so the task
 * lock's promise chain and `setImmediate` stay real.
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
import { abortInFlightMove } from '../../src/main/ipc/handlers/task-move-controllers';
import { isSessionInOwnCall, OWN_CALL_TURN_WAIT_MS } from '../../src/main/ipc/handlers/own-call-turn-wait';

const TASK_ID = 'task-own-move-1';
const SESSION_ID = 'active-session-1';
const TESTING_LANE_ID = 'lane-testing';
const REVIEW_LANE_ID = 'lane-review-isolated';
const DONE_LANE_ID = 'lane-done';
const PARKED_LANE_ID = 'lane-no-agent';
const MERGE_LANE_ID = 'lane-merge';
/** `waitForTurnCompletion`'s default quiet window. */
const QUIET_MS = 1_500;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 916,
    title: 'Extract the dialogs',
    description: '',
    swimlane_id: TESTING_LANE_ID,
    position: 0,
    agent: 'claude',
    session_id: SESSION_ID,
    worktree_path: null,
    branch_name: 'extract-dialogs',
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
  makeSwimlane(PARKED_LANE_ID, { name: 'Parked', auto_spawn: false }),
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
    getSession: vi.fn((id: string) => ({ id, status: 'running' })),
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

/** Let the move run up to its next timer. `setImmediate` is not faked. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function moveAsOwnAgent(context: ReturnType<typeof makeContext>['context'], targetSwimlaneId: string, moverSessionId = SESSION_ID): Promise<void> {
  return handleTaskMove(
    context as never,
    { taskId: TASK_ID, targetSwimlaneId, targetPosition: 0 },
    'agent',
    undefined,
    undefined,
    { moverIsTaskAgent: true, moverSessionId },
  );
}

describe('a move by the task\'s own agent that ends its session', () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['the session switch into an isolated column', REVIEW_LANE_ID],
    ['a move to Done', DONE_LANE_ID],
    ['a move to a column with no agent', PARKED_LANE_ID],
  ])('%s commits at once and suspends only once the turn has ended and the terminal gone quiet', async (_label, targetSwimlaneId) => {
    const { context, sessionManager, taskRepo } = makeContext();

    const moving = moveAsOwnAgent(context, targetSwimlaneId);
    await settle();

    expect(taskRepo.move).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, targetSwimlaneId }),
      expect.objectContaining({ origin: 'agent' }),
    );
    expect(sessionManager.suspend).not.toHaveBeenCalled();
    expect(isSessionInOwnCall(SESSION_ID)).toBe(true);

    sessionManager.emit('activity', SESSION_ID, 'idle');
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(sessionManager.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await moving;

    expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, session_id: null }));
    expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
  });

  it('ends the session at the bound when the turn never ends', async () => {
    const { context, sessionManager } = makeContext();

    const moving = moveAsOwnAgent(context, REVIEW_LANE_ID);
    await settle();
    await vi.advanceTimersByTimeAsync(OWN_CALL_TURN_WAIT_MS - 1);
    expect(sessionManager.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await moving;

    expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
  });

  it('ends the wait when a newer move aborts this one, and still suspends', async () => {
    const { context, sessionManager } = makeContext();

    const moving = moveAsOwnAgent(context, DONE_LANE_ID);
    await settle();
    expect(sessionManager.suspend).not.toHaveBeenCalled();

    abortInFlightMove(TASK_ID);
    await moving;

    expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
  });

  it('suspends at once for a move that names no mover session, as before', async () => {
    const { context, sessionManager } = makeContext();

    await handleTaskMove(
      context as never,
      { taskId: TASK_ID, targetSwimlaneId: REVIEW_LANE_ID, targetPosition: 0 },
      'agent',
      undefined,
      undefined,
      { moverIsTaskAgent: true },
    );

    expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
  });

  it('suspends at once when the mover session is not the task\'s live one', async () => {
    const { context, sessionManager } = makeContext();

    await moveAsOwnAgent(context, DONE_LANE_ID, 'some-other-session');

    expect(sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
  });

  it('never waits on a move that keeps the session', async () => {
    const { context, sessionManager } = makeContext();

    await moveAsOwnAgent(context, MERGE_LANE_ID);

    expect(sessionManager.suspend).not.toHaveBeenCalled();
    expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
  });

  describe('the mark, from the commit until Phase 1 settles', () => {
    /** Whether the session read as in its own move when each group ran. */
    function recordMarkPerTrigger(): Map<string, boolean> {
      const seen = new Map<string, boolean>();
      mockExecuteTransition.mockImplementation(async (_task: unknown, _lane: unknown, trigger: string) => {
        seen.set(trigger, isSessionInOwnCall(SESSION_ID));
        return { failures: [] };
      });
      return seen;
    }

    it('is already set while the exit group runs on a move that ends the session', async () => {
      const seen = recordMarkPerTrigger();
      const { context, sessionManager } = makeContext();

      const moving = moveAsOwnAgent(context, REVIEW_LANE_ID);
      await settle();
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await vi.advanceTimersByTimeAsync(QUIET_MS);
      await moving;

      expect(seen.get('exit')).toBe(true);
      expect(isSessionInOwnCall(SESSION_ID)).toBe(false);
    });

    it('covers the exit group of a move that keeps the session, and is gone by its enter group', async () => {
      const seen = recordMarkPerTrigger();
      const { context } = makeContext();

      await moveAsOwnAgent(context, MERGE_LANE_ID);

      expect(seen.get('exit')).toBe(true);
      expect(seen.get('enter')).toBe(false);
    });

    it('is never set for a move by anyone else', async () => {
      const seen = recordMarkPerTrigger();
      const { context } = makeContext();

      await handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: MERGE_LANE_ID, targetPosition: 0 },
        'renderer',
      );

      expect(seen.get('exit')).toBe(false);
    });
  });
});
