/**
 * What stops a turn end from running a column's On agent turn end rows when it
 * should not (src/main/automations/turn-end/turn-end-runner.ts):
 *
 * - **The visit gate.** A turn that began before the task entered the column did
 *   the last column's work, and `{{agentReply}}` would carry the wrong reply, so
 *   it runs no row.
 * - **Once per visit.** A row that already ran since the task entered the column
 *   is not run again at the next turn end. Only a run counts: a skip does not.
 * - **A "not set up" skip is written once per visit.** A column whose Condition
 *   cannot be checked (no Automation agent chosen) would otherwise write the same
 *   skipped row at every turn end of a long chat and bury the log.
 *
 * Driven through `registerTurnEndAutomations` and the session manager's
 * 'turn-ended' event, the way the app drives it. The run log and the visit
 * boundary are the REAL repositories on a real SQLite database, so "has it run
 * since the visit began" is answered by the query production uses. The transition
 * engine is a fake that writes its rows through the real run repository the way
 * the runner does: a run for a row that executes, a skip for a Condition nobody
 * answered.
 *
 * The pass starts on a `setImmediate` and everything the mocks do after that is a
 * microtask, which drains before the next immediate. So awaiting one immediate
 * after the emit is a barrier that the pass has finished, including a pass that
 * returns at the gate before it reaches the `finally` that clears the spawn
 * progress (which is why that is not used as the barrier here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { RunConditionAnswer } from '../../src/main/db/repositories/automation-run-repository';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { supersedeTurnEndWork } from '../../src/main/automations/turn-end/turn-end-passes';
import { openTestDatabase } from './helpers/test-database';

interface ExecuteOptions {
  onlyIds: ReadonlySet<string>;
  conditionAnswers: ReadonlyMap<string, RunConditionAnswer>;
  conditionUnavailableReason?: string;
}

const hoisted = vi.hoisted(() => ({
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
  executeTransition: vi.fn(),
  checkConditions: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  runWorkflowStep: vi.fn(),
  workflowStepApplies: vi.fn(),
  clearSpawnProgress: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => null);
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: vi.fn(() => ({})),
    checkConditions: hoisted.checkConditions,
  })),
  resolveInjectionVerifier: vi.fn(() => undefined),
}));
vi.mock('../../src/main/ipc/helpers/automation-failures', () => ({ reportAutomationFailures: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: hoisted.clearSpawnProgress,
}));
vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: hoisted.waitForTurnCompletion,
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: vi.fn() } }));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(), list: vi.fn(() => []) } }));
vi.mock('../../src/main/automations/automation-registry', () => ({ automationRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/automations/move-target', () => ({ resolveMoveTarget: vi.fn(), routeOf: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-step', () => ({
  runWorkflowStep: hoisted.runWorkflowStep,
  workflowStepApplies: hoisted.workflowStepApplies,
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
const MAIN_WINDOW = { isDestroyed: () => false };
const WORK_SERIAL = 41;
const SETUP_REASON = 'Set up an Automation agent in Settings > Workflows to check this condition.';
const MODEL_REASON = 'Choose a model for the Automation agent in Settings > Workflows to check this condition.';

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('a turn end and the rows it may run', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let laneId: string;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;

  afterEach(() => {
    for (const opened of openDatabases.splice(0)) opened.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database);
    laneId = lanes.list().find((lane) => lane.role === null)!.id;
    runs = new AutomationRunRepository(database);

    // The runner keeps one pass per task in a module-level map, so each test owns its task.
    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'A task in review', '', laneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    hoisted.task = {
      id: taskId,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: laneId,
      agent: 'claude',
      workflow_id: 'workflow-1',
      workflow_project_id: null,
    };
    hoisted.column = { id: laneId, name: 'Code Review', role: null, auto_spawn: true };
    hoisted.rows = [];
    hoisted.repos = {
      tasks: { getById: () => hoisted.task, list: () => [] },
      swimlanes: { getById: () => hoisted.column, list: () => [] },
      automations: { getForTrigger: () => hoisted.rows },
      automationRuns: runs,
      taskMoves: new TaskMoveRepository(database),
      attachments: {},
    };

    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    // A workflow task, so a pass always reaches its `finally` unless the visit gate stops it.
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.checkConditions.mockImplementation(async () => ({ ok: true, answers: new Map() }));
    // The runner's own bookkeeping for the rows it is handed: a run for a row
    // that executes, a skip for a Condition nobody answered or that answered no.
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: ExecuteOptions) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        const started = { id: randomUUID(), automation: row, taskId: task.id };
        if (row.condition) {
          const answer = options.conditionAnswers.get(row.id);
          if (!answer) {
            runs.recordSkipped(started, options.conditionUnavailableReason ?? 'The condition was not checked.');
            continue;
          }
          if (!answer.met) {
            runs.recordSkipped(started, 'Condition not met.');
            continue;
          }
        }
        runs.start(started);
        runs.finish(started.id, 'succeeded', 'Done.');
      }
      return { results: [] };
    });

    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => ({ [SESSION_ID]: 'idle' }),
      isLatestTurn: (sessionId: string, workSerial: number) => sessionId === SESSION_ID && workSerial === WORK_SERIAL,
    });
    registerTurnEndAutomations({
      sessionManager,
      mainWindow: MAIN_WINDOW,
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext);
  });

  function row(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
    return {
      id: 'row-on-to-testing',
      swimlane_id: laneId,
      name: 'On to Testing',
      type: 'move_to_column',
      trigger: 'turn_end',
      position: 0,
      enabled: true,
      config: { targetColumn: 'Testing' },
      condition: null,
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  /** Record that the task entered the column at `at`, the boundary a visit counts from. */
  function enterColumnAt(at: string): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, laneId, 'user', null, at);
  }

  /** Fire a turn end and wait for its pass to finish (see the file header). */
  async function endTurn(turnStartedAt: number | null = null): Promise<void> {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt,
      workSerial: WORK_SERIAL,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
  const skippedRows = () => runs.listForTask(taskId).filter((run) => run.status === 'skipped');

  describe('the visit gate', () => {
    it('runs no row for a turn that began before the task entered the column', async () => {
      hoisted.rows = [row()];
      const enteredAt = secondsAgo(10);
      enterColumnAt(enteredAt);

      await endTurn(Date.parse(enteredAt) - 1_000);

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
    });

    it('runs the row for a turn that began after the task entered the column (the control)', async () => {
      hoisted.rows = [row()];
      const enteredAt = secondsAgo(10);
      enterColumnAt(enteredAt);

      await endTurn(Date.parse(enteredAt) + 1_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
    });
  });

  describe('once per visit', () => {
    it('does not run a row again at the next turn end once it has run this visit', async () => {
      hoisted.rows = [row()];
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();

      // The second turn end got as far as waiting for the turn to settle, and
      // still handed the engine nothing: the row had run this visit.
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(2);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
    });

    it('runs the row again once the task has left the column and come back (the control)', async () => {
      hoisted.rows = [row()];
      enterColumnAt(secondsAgo(60));
      await endTurn();
      // Age the first visit's run to before the second visit began.
      database.prepare('UPDATE automation_runs SET started_at = ?').run(secondsAgo(30));
      enterColumnAt(secondsAgo(10));

      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(2);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(2);
    });

    it('counts a skip as no run, so a Condition that answered no is asked again', async () => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      hoisted.checkConditions.mockImplementation(async () => ({
        ok: true,
        answers: new Map([['row-on-to-testing', { met: false, reason: 'Two findings are open.' }]]),
      }));
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(2);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(0);
    });
  });

  describe('a skip because the Automation agent is not set up', () => {
    beforeEach(() => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      hoisted.checkConditions.mockImplementation(async () => ({ ok: false, reason: SETUP_REASON }));
    });

    it('is written once per visit, not at every turn end', async () => {
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();
      await endTurn();

      // Every turn end got past the gate and asked for the check.
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(3);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(skippedRows().map((run) => run.detail)).toEqual([SETUP_REASON]);
    });

    it('is written again when the reason changes, since the user fixed one thing and not the other', async () => {
      enterColumnAt(secondsAgo(60));
      await endTurn();
      hoisted.checkConditions.mockImplementation(async () => ({ ok: false, reason: MODEL_REASON }));

      await endTurn();

      expect(skippedRows().map((run) => run.detail).sort()).toEqual([MODEL_REASON, SETUP_REASON].sort());
    });

    it('is written again in the next visit (the control)', async () => {
      enterColumnAt(secondsAgo(60));
      await endTurn();
      // Age the first visit's skip to before the second visit began.
      database.prepare('UPDATE automation_runs SET started_at = ?').run(secondsAgo(30));
      enterColumnAt(secondsAgo(10));

      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(2);
      expect(skippedRows()).toHaveLength(2);
    });
  });

  // A turn end holds no task lock, so its check has no time limit, but it is
  // bound to the pass: a move that supersedes the pass must stop the check, or
  // the check keeps running (and holding one of the two check slots) for a
  // pass that will act on nothing.
  describe('the Condition check a pass makes', () => {
    beforeEach(() => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      enterColumnAt(secondsAgo(60));
    });

    it('is handed an abort signal that is live while the pass runs', async () => {
      let signalSeen: AbortSignal | undefined;
      let abortedWhenAsked: boolean | undefined;
      hoisted.checkConditions.mockImplementationOnce(async (_input: unknown, limits?: { signal?: AbortSignal }) => {
        signalSeen = limits?.signal;
        abortedWhenAsked = limits?.signal?.aborted;
        return { ok: true, answers: new Map() };
      });

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(signalSeen).toBeInstanceOf(AbortSignal);
      expect(abortedWhenAsked).toBe(false);
    });

    it('is stopped when a move supersedes the pass, and the pass runs no row after it', async () => {
      let signalSeen: AbortSignal | undefined;
      let finishCheck!: () => void;
      hoisted.checkConditions.mockImplementationOnce((_input: unknown, limits?: { signal?: AbortSignal }) => new Promise((resolve) => {
        signalSeen = limits?.signal;
        finishCheck = () => resolve({ ok: true, answers: new Map([['row-on-to-testing', { met: true, reason: 'Clean.' }]]) });
      }));

      // The pass is out on its check when this returns (see the file header).
      await endTurn();
      expect(signalSeen).toBeInstanceOf(AbortSignal);
      expect(signalSeen!.aborted).toBe(false);

      // The task is moved: what the move path calls to stop the column's turn-end work.
      supersedeTurnEndWork(taskId);

      expect(signalSeen!.aborted).toBe(true);
      // The check answers anyway, as a CLI run that was already out does; the pass has stopped caring.
      finishCheck();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(0);
    });
  });
});
