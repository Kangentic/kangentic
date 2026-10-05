/**
 * `handleTaskMove` (src/main/ipc/handlers/task-move.ts) Priority 2 (target is
 * Done) and Priority 2.5 (target column has auto_spawn=false) must write the
 * moving session's OWN record, not the task's newest record.
 *
 * A task can hold two session tracks at once: a main session and an isolated
 * (column) session. `getLatestForTask` returns the newest record across BOTH
 * tracks, so when the other track's record is the newer one, a capture written
 * there counts this run twice in that track's merged tool totals. Both sites
 * therefore resolve `findByAnyId(task.session_id) ?? getLatestForTask(task.id)`:
 * the session's own record first, the newest only as the fallback for a spawn
 * whose record is not inserted yet.
 *
 * Fallback coverage:
 *   - Priority 2.5: already pinned by the `rec-noswap` case in
 *     task-move-git-churn-wiring.test.ts (findByAnyId answers undefined and the
 *     getLatestForTask record lands on captureGitChurn).
 *   - Priority 2: NOT pinned elsewhere (the existing Done case there moves a
 *     task with no session_id, which takes the no-PTY else branch), so the
 *     Done fallback is pinned here.
 *
 * Red-green, reasoned from the code: reverting the `record` lookup at either
 * site to `sessionRepo.getLatestForTask(task.id)` alone makes `record` the
 * other track's row. Each own-record case then sees `rec-other-track` where it
 * expects `rec-own` (captureSessionMetrics arg 5, both refines arg 4,
 * markRecordSuspended arg 2, and at Priority 2.5 captureGitChurn arg 4), and
 * its findByAnyId assertion fails because the session id is never looked up.
 * The Done fallback case is the guard in the other direction: dropping the
 * `?? getLatestForTask` half makes `record` undefined and nothing is captured.
 *
 * Priority 2's trailing churn capture (the block after reapTaskLeftovers) is
 * attributed the same way, to the session that just ended, so both Done cases
 * pin captureGitChurn's record id too. Red-green: reverting it to
 * `getLatestForTask(task.id)` alone sends `rec-other-track` there.
 *
 * Harness copied from task-move-git-churn-wiring.test.ts. The findByAnyId mock
 * keys on the exact session id, so passing the wrong argument (the task id,
 * say) also falls back to the other record and fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';
import { makeSessionRecord } from './helpers/session-record-fixture';

const hoisted = vi.hoisted(() => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'mocked-default-branch'),
  findByAnyId: vi.fn<(sessionId: string) => unknown>(),
  getLatestForTask: vi.fn<(taskId: string) => unknown>(),
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
    findByAnyId = hoisted.findByAnyId;
    getLatestForTask = hoisted.getLatestForTask;
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
const mockSpawnAgent = vi.fn(async () => {});

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  // The exit and enter automation groups run their (empty) column lists
  // through the engine and report failures; an inert engine keeps those
  // groups from logging a caught TypeError into every test's output.
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [] })),
  })),
  reportAutomationFailures: vi.fn(),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { markRecordExited, markRecordSuspended } from '../../src/main/transition-engine/session-lifecycle';
import {
  captureSessionMetrics,
  refineTranscriptTokens,
  refineTranscriptToolCounts,
} from '../../src/main/ipc/handlers/session-metrics';

const TASK_ID = 'task-aaa00001';
const SESSION_ID = 'active-session-1';
const PROJECT_PATH = '/mock/project';
const RESOLVED_BRANCH = 'mocked-default-branch';
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
    session_id: SESSION_ID,
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

/** The moving session's own record: the main track, started first. */
function makeOwnRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord({
    id: 'rec-own',
    task_id: TASK_ID,
    agent_session_id: 'agent-own',
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

/**
 * The task's NEWEST record, which belongs to the other track (an isolated
 * column session). It passes the same eligibility gate as the own record
 * (running, with an agent session id), so a site that picks it captures into
 * it instead of silently no-oping.
 */
function makeOtherTrackRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord({
    id: 'rec-other-track',
    task_id: TASK_ID,
    agent_session_id: 'agent-other',
    session_type: 'codex_agent',
    isolated_swimlane_id: 'lane-review-isolated',
    started_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });
}

function makeContext(taskRepo: unknown, swimlaneRepo: unknown) {
  const sessionManager = {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
    // Phase 1 reconciles task.session_id against the registry before the
    // Priority ladder; a live row for the pointed-at id keeps these fixtures
    // on the live-session branches they exercise.
    getSession: vi.fn((id: string) => ({ id, status: 'running' })),
    findLiveSessionByTaskId: vi.fn(() => null),
    getUsageCache: vi.fn((): Record<string, unknown> => ({})),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: PROJECT_PATH,
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
    automations: { listForColumn: vi.fn(() => []), getForTrigger: vi.fn(() => []) },
    automationRuns: { start: vi.fn(), finish: vi.fn(), recordSkipped: vi.fn() },
    attachments: { deleteByTaskId: vi.fn() },
  });
  return context;
}

/** An exec lane plus a Done lane, with a task row that holds a live session. */
function makeDoneMoveFixture() {
  const execLane = makeSwimlane(EXEC_LANE_ID);
  const doneLane = makeSwimlane('lane-done', { role: 'done' });
  const swimlaneRepo = {
    getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-done' ? doneLane : null)),
    list: vi.fn(() => [execLane, doneLane]),
  };
  const taskRepo = {
    getById: vi.fn(() => makeTask()),
    move: vi.fn(),
    update: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
    archive: vi.fn(),
    list: vi.fn(() => [makeTask()]),
  };
  return { taskRepo, context: makeContext(taskRepo, swimlaneRepo) };
}

/** An exec lane plus an auto_spawn=false lane, with a task row that holds a live session. */
function makeNoSpawnMoveFixture() {
  const execLane = makeSwimlane(EXEC_LANE_ID);
  const noSpawnLane = makeSwimlane('lane-no-spawn', { auto_spawn: false });
  const swimlaneRepo = {
    getById: vi.fn((id: string) => (id === EXEC_LANE_ID ? execLane : id === 'lane-no-spawn' ? noSpawnLane : null)),
    list: vi.fn(() => [execLane, noSpawnLane]),
  };
  const taskRepo = {
    getById: vi.fn(() => makeTask()),
    move: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    list: vi.fn(() => [makeTask()]),
  };
  return { taskRepo, context: makeContext(taskRepo, swimlaneRepo) };
}

describe('handleTaskMove captures the moving session\'s own record, not the task\'s newest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveDefaultBaseBranch.mockReturnValue(RESOLVED_BRANCH);
    hoisted.findByAnyId.mockReset();
    hoisted.getLatestForTask.mockReset();
    mockResolveTargetAgent.mockReturnValue({ agent: 'claude', isHandoff: false });
    mockPrepareInjectionPlan.mockReturnValue(null);
    mockSpawnAgent.mockResolvedValue(undefined);
  });

  it('Priority 2 (move to Done): capture, refines, and markRecordSuspended use the own record id when the task\'s newest record is the other track\'s', async () => {
    const { context } = makeDoneMoveFixture();
    const ownRecord = makeOwnRecord();
    hoisted.findByAnyId.mockImplementation((sessionId) => (sessionId === SESSION_ID ? ownRecord : undefined));
    hoisted.getLatestForTask.mockReturnValue(makeOtherTrackRecord());

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-done', targetPosition: 0,
    }, 'renderer');

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(SESSION_ID);

    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      expect.anything(),
      SESSION_ID,
      'rec-own',
      ownRecord.started_at,
      'claude_agent',
    );
    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'rec-own', 'system');
    expect(vi.mocked(markRecordExited)).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    // The trailing churn capture is attributed to the session that just ended.
    expect(hoisted.captureGitChurn).toHaveBeenCalledTimes(1);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-own',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
  });

  it('Priority 2 (move to Done) fallback: with no own record yet, the task\'s newest record is captured and suspended', async () => {
    const { context } = makeDoneMoveFixture();
    const latestRecord = makeSessionRecord({ id: 'rec-latest', task_id: TASK_ID, agent_session_id: 'agent-latest' });
    hoisted.findByAnyId.mockReturnValue(undefined);
    hoisted.getLatestForTask.mockReturnValue(latestRecord);

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-done', targetPosition: 0,
    }, 'renderer');

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(SESSION_ID);
    expect(hoisted.getLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      expect.anything(),
      SESSION_ID,
      'rec-latest',
      latestRecord.started_at,
      'claude_agent',
    );
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'rec-latest', 'system');
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-latest',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
  });

  it('Priority 2.5 (auto_spawn=false target): capture, refines, churn, and markRecordSuspended use the own record id when the task\'s newest record is the other track\'s', async () => {
    const { context } = makeNoSpawnMoveFixture();
    const ownRecord = makeOwnRecord();
    hoisted.findByAnyId.mockImplementation((sessionId) => (sessionId === SESSION_ID ? ownRecord : undefined));
    hoisted.getLatestForTask.mockReturnValue(makeOtherTrackRecord());

    await handleTaskMove(context as never, {
      taskId: TASK_ID, targetSwimlaneId: 'lane-no-spawn', targetPosition: 0,
    }, 'renderer');

    expect(hoisted.findByAnyId).toHaveBeenCalledWith(SESSION_ID);

    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSessionMetrics)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      expect.anything(),
      SESSION_ID,
      'rec-own',
      ownRecord.started_at,
      'claude_agent',
    );
    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptTokens)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refineTranscriptToolCounts)).toHaveBeenCalledWith(
      context.sessionManager,
      expect.anything(),
      SESSION_ID,
      'rec-own',
    );
    // Unlike the Done branch, this site's only churn capture is the one that
    // keys on the resolved record, so it is pinned here too.
    expect(hoisted.captureGitChurn).toHaveBeenCalledTimes(1);
    expect(hoisted.captureGitChurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.anything(),
      'rec-own',
      PROJECT_PATH,
      RESOLVED_BRANCH,
    );
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(expect.anything(), 'rec-own', 'system');
    expect(vi.mocked(markRecordExited)).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
