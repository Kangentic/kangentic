/**
 * What a turn end does for a task whose automations the user disabled
 * (src/main/automations/turn-end/turn-end-runner.ts, `runPass` and `runRows`).
 *
 * A disabled task runs none of the column's On agent turn end rows. The runner
 * decides that ahead of the Frequency records, the paint wait and the paid
 * Condition check, so a held task costs one read per turn end:
 *
 * - Each pending row is recorded as skipped with the reason, ONCE per visit, not
 *   at every turn end of a long chat. A task with no visit row has a null
 *   boundary, which counts all time, so it is still recorded only once.
 * - The pass never waits for the turn to settle and never makes the Condition
 *   check, which is a paid Automation agent call.
 * - A row that already ran this visit, or that the column cannot run, leaves no
 *   record, exactly as for an enabled task.
 * - The switch is checked before a spent Frequency, so the log gives the reason
 *   the user can act on.
 * - A switch thrown DURING the paint wait is caught by `runRows` before the paid
 *   check, from a fresh read of the task.
 *
 * Harness mirrors turn-end-runner-visit-guards.test.ts: driven through
 * `registerTurnEndAutomations` and the session manager's 'turn-ended' event,
 * with the run log and the visit boundary on REAL repositories over a real
 * SQLite database, and the transition engine a fake that writes its rows through
 * the real run repository. Every disabled-task test pairs with an enabled
 * control over the same rows, so the assertions that something did NOT happen
 * are shown to be able to fail.
 *
 * Unlike that file, the task here is an ordinary one (no workflow) and the
 * workflow step never applies. A workflow task carries a step the pass would
 * wait for whatever the rows say, which would make "never waits" untestable.
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
import { AUTOMATIONS_DISABLED_REASON } from '../../src/shared/automation-manifest';
import { openTestDatabase } from './helpers/test-database';

interface ExecuteOptions {
  onlyIds: ReadonlySet<string>;
  agentReply?: string | null;
  conditionAnswers: ReadonlyMap<string, RunConditionAnswer>;
}

const hoisted = vi.hoisted(() => ({
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
  executeTransition: vi.fn(),
  checkConditions: vi.fn(),
  conditionCheckInput: vi.fn(),
  conditionCheckCall: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  runWorkflowStep: vi.fn(),
  workflowStepApplies: vi.fn(),
  clearSpawnProgress: vi.fn(),
  findSession: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = hoisted.findSession;
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: hoisted.conditionCheckInput,
    conditionCheckCall: hoisted.conditionCheckCall,
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
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.retrievalCall } }));
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
const SPENT_REASON = 'Already ran once on this task, its limit.';

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('a turn end and a task with its automations disabled', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let laneId: string;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;

  afterEach(() => {
    for (const opened of openDatabases.splice(0)) opened.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    laneId = new SwimlaneRepository(database).list().find((lane) => lane.role === null)!.id;
    runs = new AutomationRunRepository(database);

    // The runner keeps one pass per task in a module-level map, so each test owns its task.
    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'A held task', '', laneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    // An ordinary task whose automations are disabled. Tests that want the
    // enabled control set the flag back.
    hoisted.task = {
      id: taskId,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: laneId,
      agent: 'claude',
      workflow_id: null,
      workflow_project_id: null,
      automations_disabled: true,
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
    hoisted.findSession.mockImplementation(() => null);
    hoisted.retrievalCall.mockImplementation(async () => null);
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    // Not a workflow task: with no step to run, a pass with no pending rows stops at the cheap gate.
    hoisted.workflowStepApplies.mockImplementation(() => false);
    hoisted.checkConditions.mockImplementation(async () => ({
      ok: true,
      answers: new Map([['row-ask-the-agent', { met: true, reason: 'Clean.' }]]),
    }));
    hoisted.conditionCheckInput.mockImplementation(() => ({}));
    hoisted.conditionCheckCall.mockImplementation(() => ({ projectId: PROJECT_ID, taskId, swimlaneId: laneId, job: 'condition_check' }));
    // The runner's own bookkeeping for the rows it is handed: a run for each.
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: ExecuteOptions) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        const started = { id: randomUUID(), automation: row, taskId: task.id };
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
      final_line: null,
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  /** Two pending rows, the second guarded by a Condition the Automation agent would be paid to check. */
  function twoRowsOneWithCondition(): ColumnAutomation[] {
    return [
      row(),
      row({ id: 'row-ask-the-agent', name: 'Ask the agent', position: 1, condition: 'The review is clean' }),
    ];
  }

  /** Record that the task entered the column at `at`, the boundary a visit counts from. */
  function enterColumnAt(at: string): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, laneId, 'renderer', null, at);
  }

  /** Fire a turn end and wait for its pass to finish (see turn-end-runner-visit-guards.test.ts). */
  async function endTurn(): Promise<void> {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: null,
      workSerial: WORK_SERIAL,
      transcriptAnchor: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
  const skippedRows = () => runs.listForTask(taskId).filter((run) => run.status === 'skipped');

  describe('the pass for a disabled task', () => {
    it('records each pending row as skipped with the reason, and runs nothing', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));

      await endTurn();

      const skipped = skippedRows();
      expect(skipped).toHaveLength(2);
      expect(skipped.map((run) => run.detail)).toEqual([AUTOMATIONS_DISABLED_REASON, AUTOMATIONS_DISABLED_REASON]);
      expect(skipped.map((run) => run.automation_id).sort()).toEqual(['row-ask-the-agent', 'row-on-to-testing']);
      expect(skipped.every((run) => run.trigger === 'turn_end' && run.swimlane_id === laneId)).toBe(true);
      expect(runs.listForTask(taskId)).toHaveLength(2);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
    });

    it('never waits for the turn to settle and never makes the paid Condition check', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.conditionCheckInput).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    });

    it('records each row once across several turn ends in the same visit', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();
      await endTurn();

      expect(skippedRows()).toHaveLength(2);
      expect(runs.listForTask(taskId)).toHaveLength(2);
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
    });

    it('records each row once across turn ends when the task has no visit row (a null boundary counts all time)', async () => {
      // A task placed in the column before moves were recorded has no task_moves
      // row for it: `currentVisit` is null and so is the visit boundary the
      // runner counts the skip from. `hasSkipSince` reads a null boundary as all
      // time, so the first turn end's skips are still found at the second.
      // Nothing seeds a visit here, and the precondition below keeps it so.
      hoisted.rows = twoRowsOneWithCondition();
      expect(new TaskMoveRepository(database).currentVisit(taskId, laneId)).toBeNull();

      await endTurn();

      expect(skippedRows().map((run) => run.detail)).toEqual([AUTOMATIONS_DISABLED_REASON, AUTOMATIONS_DISABLED_REASON]);

      await endTurn();

      // The skips were recorded, and the second turn end found them instead of writing more.
      expect(skippedRows()).toHaveLength(2);
      expect(skippedRows().map((run) => run.automation_id).sort()).toEqual(['row-ask-the-agent', 'row-on-to-testing']);
      expect(runs.listForTask(taskId)).toHaveLength(2);
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
    });

    it('records each row again in the next visit (the control for once per visit)', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));
      await endTurn();
      // Age the first visit's skips to before the second visit began.
      database.prepare('UPDATE automation_runs SET started_at = ?').run(secondsAgo(30));
      enterColumnAt(secondsAgo(10));

      await endTurn();

      expect(skippedRows()).toHaveLength(4);
      expect(skippedRows().filter((run) => run.automation_id === 'row-on-to-testing')).toHaveLength(2);
    });

    it('leaves no record for a row that already ran this visit', async () => {
      const ranRow = row();
      hoisted.rows = [ranRow, row({ id: 'row-later', name: 'Later row', position: 1 })];
      enterColumnAt(secondsAgo(60));
      const ranId = randomUUID();
      runs.start({ id: ranId, automation: ranRow, taskId });
      runs.finish(ranId, 'succeeded', 'Moved to Testing.');

      await endTurn();

      expect(skippedRows().map((run) => run.automation_id)).toEqual(['row-later']);
    });

    it('leaves no record when the column cannot run turn-end rows at all', async () => {
      // "Start an agent here" is off, so no agent ends a turn here: the row is
      // not pending for an enabled task either, and says nothing.
      hoisted.column = { id: laneId, name: 'Parked', role: null, auto_spawn: false };
      hoisted.rows = [row()];
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(runs.listForTask(taskId)).toEqual([]);
    });

    it('gives the disabled reason, not the spent Frequency, for a row whose limit is used up', async () => {
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      const earlierRunId = randomUUID();
      runs.start({ id: earlierRunId, automation: spentRow, taskId });
      runs.finish(earlierRunId, 'succeeded', 'Moved to Testing.');
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(secondsAgo(120), earlierRunId);
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();

      const skipped = skippedRows();
      expect(skipped.map((run) => run.detail)).toEqual([AUTOMATIONS_DISABLED_REASON]);
      expect(skipped.some((run) => run.detail === SPENT_REASON)).toBe(false);
    });
  });

  describe('the same rows for an enabled task (the controls)', () => {
    beforeEach(() => {
      hoisted.task = { ...hoisted.task, automations_disabled: false };
    });

    it('waits for the turn, makes the Condition check and runs the rows', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds].sort()).toEqual(['row-ask-the-agent', 'row-on-to-testing']);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
      expect(skippedRows().some((run) => run.detail === AUTOMATIONS_DISABLED_REASON)).toBe(false);
    });

    it('records the spent Frequency, not the disabled reason, for a row whose limit is used up', async () => {
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      const earlierRunId = randomUUID();
      runs.start({ id: earlierRunId, automation: spentRow, taskId });
      runs.finish(earlierRunId, 'succeeded', 'Moved to Testing.');
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(secondsAgo(120), earlierRunId);
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(skippedRows().map((run) => run.detail)).toEqual([SPENT_REASON]);
    });
  });

  describe('a switch thrown while the pass waits for the turn to settle', () => {
    /** The task as the user leaves it a moment later: same row, switch thrown. */
    function disableDuringTheWait(): void {
      hoisted.waitForTurnCompletion.mockImplementation(async () => {
        // A new object, as a fresh read of the row is: the pass still holds the old one.
        hoisted.task = { ...hoisted.task, automations_disabled: true };
        return 'completed';
      });
    }

    beforeEach(() => {
      hoisted.task = { ...hoisted.task, automations_disabled: false };
    });

    it('is caught before the paid Condition check, and records each row once', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));
      disableDuringTheWait();

      await endTurn();

      // The pass was already past the cheap gate, so it did wait.
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      const skipped = skippedRows();
      expect(skipped).toHaveLength(2);
      expect(skipped.map((run) => run.detail)).toEqual([AUTOMATIONS_DISABLED_REASON, AUTOMATIONS_DISABLED_REASON]);
    });

    it('does not record a second time at the next turn end', async () => {
      hoisted.rows = twoRowsOneWithCondition();
      enterColumnAt(secondsAgo(60));
      disableDuringTheWait();
      await endTurn();

      await endTurn();

      // The cheap gate saw the recorded skips from the first pass and wrote no more.
      expect(skippedRows()).toHaveLength(2);
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
    });
  });
});
