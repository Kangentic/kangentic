/**
 * A row whose Condition Task lines the task does not match is not for that task
 * (src/main/automations/turn-end/turn-end-runner.ts, `runPass`, #872). The runner
 * drops it before every other guard, so it leaves no skip run row, joins no
 * Condition check, runs nothing and cannot stop the card. A person reading the
 * run log would otherwise see "already ran 1 time" or "automations are off" on a
 * row that was never about their task, and a card would wear the stopped mark for
 * a row that was never going to move it.
 *
 * Harness mirrors turn-end-runner-automations-disabled.test.ts: driven through
 * `registerTurnEndAutomations` and the session manager's 'turn-ended' event, with
 * the run log on a real SQLite database and the transition engine a fake. Each
 * case pairs the filtered row with an unfiltered sibling in the same column, so
 * the "no record" assertions are shown able to fail: the sibling's record proves
 * the guard in question was reached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { AutomationTaskFilter, ColumnAutomation } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { RunConditionAnswer } from '../../src/main/db/repositories/automation-run-repository';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { AUTOMATIONS_DISABLED_REASON as AUTOMATIONS_DISABLED_REASON_DESCRIPTOR } from '../../src/shared/automation-manifest';
import { englishText } from '../../src/shared/i18n/english';
import { openTestDatabase } from './helpers/test-database';

const AUTOMATIONS_DISABLED_REASON = englishText(AUTOMATIONS_DISABLED_REASON_DESCRIPTOR);

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
  heldMoveReason: vi.fn(() => null),
  runWorkflowStep: hoisted.runWorkflowStep,
  workflowStepApplies: hoisted.workflowStepApplies,
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

const {
  registerTurnEndAutomations,
  CARRIED_IN_TURN_REASON,
  AGENT_NOT_IDLE_REASON,
} = await import('../../src/main/automations/turn-end/turn-end-runner');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
const MAIN_WINDOW = { isDestroyed: () => false };
const WORK_SERIAL = 41;
const SPENT_REASON = 'Already ran once on this task, its limit.';
const OTHER_PRIORITY_ONLY: AutomationTaskFilter = { priorities: [4], labels: [] };
const TASK_PRIORITY = 1;

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('a turn end and a row whose Task lines the task does not match', () => {
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

    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'A task', '', laneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    hoisted.task = {
      id: taskId,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: laneId,
      agent: 'claude',
      workflow_id: null,
      workflow_project_id: null,
      automations_disabled: false,
      priority: TASK_PRIORITY,
      labels: [],
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
    hoisted.workflowStepApplies.mockImplementation(() => false);
    hoisted.checkConditions.mockImplementation(async () => ({
      ok: true,
      answers: new Map([['row-matching-condition', { met: true, reason: 'Clean.' }]]),
    }));
    hoisted.conditionCheckInput.mockImplementation(() => ({}));
    hoisted.conditionCheckCall.mockImplementation(() => ({ projectId: PROJECT_ID, taskId, swimlaneId: laneId, job: 'condition_check' }));
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
      setTaskStopped: vi.fn(),
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
      id: 'row-matching',
      swimlane_id: laneId,
      name: 'Matching row',
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

  /** A row for another priority than the task's: the Task lines do not match. */
  function filteredRow(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
    return row({ id: 'row-filtered', name: 'Filtered row', position: 1, filter: OTHER_PRIORITY_ONLY, ...overrides });
  }

  const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

  function enterColumnAt(at: string): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, laneId, 'renderer', null, at);
  }

  /** One earlier run before the visit began, so a `max_runs: 1` row reads as spent. */
  function spend(automation: ColumnAutomation): void {
    const runId = randomUUID();
    runs.start({ id: runId, automation, taskId });
    runs.finish(runId, 'succeeded', 'Moved.');
    database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(secondsAgo(120), runId);
  }

  async function endTurn(turnStartedAt: number | null = null): Promise<void> {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt,
      workSerial: WORK_SERIAL,
      transcriptAnchor: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Skip records of this pass, by row, as [id, reason]. */
  const skipPairs = (): Array<[string, string | null]> => runs.listForTask(taskId)
    .filter((run) => run.status === 'skipped' && run.type !== 'column_stopped')
    .map((run): [string, string | null] => [run.automation_id as string, run.detail])
    .sort((left, right) => left[0].localeCompare(right[0]));

  it('records no spent Frequency skip for it, while a matching spent row does', async () => {
    const matching = row({ max_runs: 1 });
    const filtered = filteredRow({ max_runs: 1 });
    hoisted.rows = [matching, filtered];
    spend(matching);
    spend(filtered);
    enterColumnAt(secondsAgo(60));

    await endTurn();

    expect(skipPairs()).toEqual([['row-matching', SPENT_REASON]]);
  });

  it('records a spent Frequency skip for the same row once the task matches its lines (the control)', async () => {
    hoisted.task = { ...hoisted.task, priority: 4 };
    const filtered = filteredRow({ max_runs: 1 });
    hoisted.rows = [filtered];
    spend(filtered);
    enterColumnAt(secondsAgo(60));

    await endTurn();

    expect(skipPairs()).toEqual([['row-filtered', SPENT_REASON]]);
  });

  it('records no automations-paused skip for it, while a matching row records its own', async () => {
    hoisted.task = { ...hoisted.task, automations_disabled: true };
    hoisted.rows = [row(), filteredRow()];
    enterColumnAt(secondsAgo(60));

    await endTurn();

    expect(skipPairs()).toEqual([['row-matching', AUTOMATIONS_DISABLED_REASON]]);
  });

  it('records no carried-in-turn skip for it, while a matching row records its own', async () => {
    hoisted.rows = [row(), filteredRow()];
    enterColumnAt(secondsAgo(60));

    // The turn began two minutes ago, before the task entered the column.
    await endTurn(Date.now() - 120_000);

    expect(skipPairs()).toEqual([['row-matching', CARRIED_IN_TURN_REASON]]);
  });

  it('records no agent-not-idle skip for it, while a matching row records its own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.rows = [row(), filteredRow()];
    enterColumnAt(secondsAgo(60));
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
    sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'working' });

    await endTurn();

    expect(skipPairs()).toEqual([['row-matching', AGENT_NOT_IDLE_REASON]]);
  });

  it('joins it to no Condition check and runs only the matching row', async () => {
    const matchingWithCondition = row({ id: 'row-matching-condition', condition: 'The review is clean' });
    const filteredWithCondition = filteredRow({ condition: 'The review is clean' });
    hoisted.rows = [matchingWithCondition, filteredWithCondition];
    enterColumnAt(secondsAgo(60));

    await endTurn();

    expect(hoisted.conditionCheckInput).toHaveBeenCalledTimes(1);
    const checkedRows = hoisted.conditionCheckInput.mock.calls[0][3] as ColumnAutomation[];
    expect(checkedRows.map((checked) => checked.id)).toEqual(['row-matching-condition']);
    expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
    const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
    expect([...options.onlyIds]).toEqual(['row-matching-condition']);
    expect(runs.countRuns('row-matching-condition', taskId)).toBe(1);
    expect(runs.countRuns('row-filtered', taskId)).toBe(0);
  });

  describe('the card stop', () => {
    const stop = () => runs.columnStop(taskId, laneId, null);

    it('is recorded for a spent move row the task matches (the control)', async () => {
      const spent = row({ max_runs: 1 });
      hoisted.rows = [spent];
      spend(spent);
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('is not recorded for a spent move row filtered out for the task', async () => {
      const spentFiltered = filteredRow({ max_runs: 1 });
      hoisted.rows = [spentFiltered];
      spend(spentFiltered);
      enterColumnAt(secondsAgo(60));

      await endTurn();

      // The pass did reach the stop judgement: it waited for the turn.
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
      expect(stop()).toBeNull();
    });
  });
});
