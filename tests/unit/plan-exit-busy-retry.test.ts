/**
 * A plan-exit auto-move that found the project database busy (Sentry
 * DESKTOP-5V, #967). Another connection held the write lock for the whole 5 s
 * busy wait, the listener reported and gave up, and the card stayed in its
 * plan column while the agent carried on with the approved plan.
 *
 * What a user loses if these go: the card is left behind again, or a retry
 * moves a task the user had already dragged elsewhere. The listener now
 * retries once, later, off the first attempt's stack (an inline retry would
 * hold main's thread in a second synchronous busy wait), and reports only when
 * the retry fails too.
 *
 * Mock strategy mirrors plan-exit-continuation-prompt.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportedFailures } from './helpers/reported-failures';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

const { reportHandledError, openDatabase } = vi.hoisted(() => ({
  reportHandledError: vi.fn(() => true),
  openDatabase: { value: {} as unknown },
}));
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getOpenProjectDb: vi.fn(() => openDatabase.value),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: vi.fn((lane: unknown) => lane),
}));

vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: vi.fn(() => null),
}));

// Loaded fresh per case: the session handlers' reporter latches each key once per run.
let PLAN_EXIT_BUSY_RETRY_MS: typeof import('../../src/main/ipc/handlers/sessions').PLAN_EXIT_BUSY_RETRY_MS;
let registerSessionHandlers: typeof import('../../src/main/ipc/handlers/sessions').registerSessionHandlers;
let handleTaskMove: typeof import('../../src/main/ipc/handlers/task-move').handleTaskMove;
let getProjectRepos: typeof import('../../src/main/ipc/helpers').getProjectRepos;

const PLANNING_LANE_ID = 'lane-planning';
const TARGET_LANE_ID = 'lane-target';
const ELSEWHERE_LANE_ID = 'lane-elsewhere';

const lanes = [
  { id: PLANNING_LANE_ID, name: 'Planning', plan_exit_target_id: TARGET_LANE_ID },
  { id: TARGET_LANE_ID, name: 'Executing', plan_exit_target_id: null },
  { id: ELSEWHERE_LANE_ID, name: 'Review', plan_exit_target_id: null },
];

/** The task row, which a case moves to stand in for a move made between the attempts. */
const taskRow = { id: 'task-1', title: 'My Task', swimlane_id: PLANNING_LANE_ID, session_id: 'sess-1' as string | null };

function installBoard(): void {
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
  vi.mocked(getProjectRepos).mockReturnValue({
    tasks: {
      getBySessionId: vi.fn((sessionId: string) => (taskRow.session_id === sessionId ? { ...taskRow } : null)),
      getById: vi.fn((taskId: string) => (taskId === taskRow.id ? { ...taskRow } : null)),
      list: vi.fn(() => []),
    },
    swimlanes: {
      getById: vi.fn((id: string) => lanesById.get(id)),
      list: vi.fn(() => lanes),
    },
  } as never);
}

const getSession = vi.fn(() => ({ transient: false }));

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      getSession,
      getSessionTaskId: vi.fn(() => 'task-1'),
      getSessionProjectId: vi.fn(() => 'proj-1'),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    projectRepo: { getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })) },
  };
}

/** What better-sqlite3 throws when BEGIN IMMEDIATE waited out busy_timeout. */
function busyError(): Error {
  const error = new Error('database is locked');
  error.name = 'SqliteError';
  return Object.assign(error, { code: 'SQLITE_BUSY' });
}

async function firePlanExit(sessionId: string): Promise<void> {
  const handler = capturedSessionEventHandlers.get('plan-exit');
  if (!handler) throw new Error('plan-exit handler was not registered');
  await handler(sessionId);
}

/** The options bag is handleTaskMove's 6th positional argument. */
function moveOptions(callIndex: number): { expectedFromSwimlaneId?: string; continuationPrompt?: string } | undefined {
  return vi.mocked(handleTaskMove).mock.calls[callIndex]?.[5] as { expectedFromSwimlaneId?: string } | undefined;
}

function planExitReports() {
  return reportedFailures(reportHandledError).filter((report) => report.tags.stage === 'plan_exit_move');
}

describe('plan-exit auto-move that finds the database busy', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ PLAN_EXIT_BUSY_RETRY_MS, registerSessionHandlers } = await import('../../src/main/ipc/handlers/sessions'));
    ({ handleTaskMove } = await import('../../src/main/ipc/handlers/task-move'));
    ({ getProjectRepos } = await import('../../src/main/ipc/helpers'));
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(handleTaskMove).mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    capturedSessionEventHandlers.clear();
    taskRow.swimlane_id = PLANNING_LANE_ID;
    taskRow.session_id = 'sess-1';
    openDatabase.value = {};
    getSession.mockImplementation(() => ({ transient: false }));
    installBoard();
    registerSessionHandlers(createMockContext() as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves the task on one deferred retry, off the first call stack, and reports nothing', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError()).mockResolvedValueOnce(undefined);

    await firePlanExit('sess-1');
    // The first attempt failed and its listener returned: no retry ran on its stack.
    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PLAN_EXIT_BUSY_RETRY_MS - 1);
    expect(handleTaskMove).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(handleTaskMove).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handleTaskMove).mock.calls[1][1]).toMatchObject({ taskId: 'task-1', targetSwimlaneId: TARGET_LANE_ID });
    // The move re-checks the source column under its own task lock.
    expect(moveOptions(1)?.expectedFromSwimlaneId).toBe(PLANNING_LANE_ID);
    expect(moveOptions(1)?.continuationPrompt).toBe(moveOptions(0)?.continuationPrompt);
    expect(moveOptions(0)?.expectedFromSwimlaneId).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports once when the retry finds the database busy again, and tries no third time', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError()).mockRejectedValueOnce(busyError());

    await firePlanExit('sess-1');
    await vi.runAllTimersAsync();

    expect(handleTaskMove).toHaveBeenCalledTimes(2);
    const reports = planExitReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'plan_exit_move', errno: 'SQLITE_BUSY', plan_exit_retry: 'failed' });
  });

  it('does not retry or report when the task left its plan column before the retry', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError());

    await firePlanExit('sess-1');
    taskRow.swimlane_id = ELSEWHERE_LANE_ID;
    await vi.runAllTimersAsync();

    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('does not retry or report when the session that left plan mode is gone', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError());

    await firePlanExit('sess-1');
    getSession.mockImplementation(() => undefined as never);
    await vi.runAllTimersAsync();

    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('does not retry when the project closed before the retry', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError());

    await firePlanExit('sess-1');
    openDatabase.value = null;
    await vi.runAllTimersAsync();

    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports the first failure, without moving again, when its write had landed before a later step failed', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(busyError());

    await firePlanExit('sess-1');
    taskRow.swimlane_id = TARGET_LANE_ID;
    await vi.runAllTimersAsync();

    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    const reports = planExitReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ stage: 'plan_exit_move', errno: 'SQLITE_BUSY', plan_exit_retry: 'landed' });
  });

  it('reports any other failure at once and never retries it', async () => {
    vi.mocked(handleTaskMove).mockRejectedValueOnce(new TypeError('boom'));

    await firePlanExit('sess-1');

    const reports = planExitReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ stage: 'plan_exit_move', error_name: 'TypeError' });
    expect(reports[0].tags.plan_exit_retry).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(handleTaskMove).toHaveBeenCalledTimes(1);
  });
});
