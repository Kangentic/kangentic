/**
 * What stops a turn end from running a column's On agent turn end rows when it
 * should not (src/main/automations/turn-end/turn-end-runner.ts):
 *
 * - **The visit gate.** A turn that began before the task entered the column did
 *   the last column's work, and `{{agentReply}}` would carry the wrong reply, so
 *   it runs no row. The skip writes no run record, so it logs one line. A plan
 *   approval is the exception: its move (`auto-move`) lands mid-turn and the
 *   agent implements in that same turn, so the turn is the new column's work
 *   and its rows run.
 * - **Once per visit.** A row that already ran since the task entered the column
 *   is not run again at the next turn end. Only a run counts: a skip does not.
 * - **A "not set up" skip is written once per visit.** A column whose Condition
 *   cannot be checked (no Automation agent chosen) would otherwise write the same
 *   skipped row at every turn end of a long chat and bury the log.
 * - **A spent Frequency is written once per visit.** A row that has run its
 *   limit is never checked or run, but says why, and a task that came back
 *   from Done counts its Frequency from there.
 * - **A turn that never settles.** When the wait for idle and a quiet terminal
 *   runs out, no row runs and nothing is recorded, so the pass warns once.
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
import type { ColumnAutomation, TaskMoveRecordOrigin } from '../../src/shared/types';
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
  conditionUnavailableCallId?: string | null;
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
const SETUP_REASON = 'Set up an Automation agent in Settings > Workflows to check this condition.';
const MODEL_REASON = 'Choose a model for the Automation agent in Settings > Workflows to check this condition.';
const TIMED_OUT_REASON = 'The Automation agent did not answer in time.';

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
  /** What the engine describes a check's call as: whose ledger, which task and column. */
  let checkCall: { projectId: string; taskId: string; swimlaneId: string; job: 'condition_check' };

  afterEach(() => {
    for (const opened of openDatabases.splice(0)) opened.close();
    // A console spy a failed assertion left in place.
    vi.restoreAllMocks();
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
    // No session record, so no reply is read, unless a test sets one up.
    hoisted.findSession.mockImplementation(() => null);
    hoisted.retrievalCall.mockImplementation(async () => null);
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    // A workflow task, so a pass always reaches its `finally` unless the visit gate stops it.
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.checkConditions.mockImplementation(async () => ({ ok: true, answers: new Map() }));
    hoisted.conditionCheckInput.mockImplementation(() => ({}));
    checkCall = { projectId: PROJECT_ID, taskId, swimlaneId: laneId, job: 'condition_check' };
    hoisted.conditionCheckCall.mockImplementation(() => checkCall);
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
      final_line: null,
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  /** Record that the task entered the column at `at`, the boundary a visit counts from. */
  function enterColumnAt(at: string, origin: TaskMoveRecordOrigin = 'renderer'): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, laneId, origin, null, at);
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
    // Every mover but a plan approval: a drag, the agent moving its own task, a
    // phone, a Move to column row, a workflow step. Each of those turns did the
    // last column's work.
    it.each(['renderer', 'agent', 'mobile', 'automation', 'workflow'] as const)(
      'runs no row for a turn that began before a %s move into the column, and logs the skip',
      async (origin) => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        hoisted.rows = [row()];
        const enteredAt = secondsAgo(10);
        enterColumnAt(enteredAt, origin);

        await endTurn(Date.parse(enteredAt) - 1_000);

        expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
        expect(hoisted.checkConditions).not.toHaveBeenCalled();
        expect(hoisted.executeTransition).not.toHaveBeenCalled();
        expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
        expect(runs.listForTask(taskId)).toEqual([]);
        // The skip writes no run record, so the log is the only trace of it.
        const skipLines = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Skipped a carried-in turn'));
        expect(skipLines).toHaveLength(1);
        expect(skipLines[0]).toContain(`before the ${origin} move at ${enteredAt}`);
        logSpy.mockRestore();
      },
    );

    it('runs the row for a turn whose start falls inside the visit, as after a plan approved following a drag in', async () => {
      // The runner's half of the plan-approval case. Dragged in while the agent
      // was still planning, the engine starts the turn again at the approval
      // (activity-engine-turn-ended.test.ts pins that), so the start the turn
      // end carries falls inside the visit. This pins only that the guard
      // trusts the stamp the payload carries, whichever event wrote it.
      hoisted.rows = [row()];
      const draggedAt = secondsAgo(40 * 60);
      enterColumnAt(draggedAt, 'renderer');

      await endTurn(Date.parse(draggedAt) + 39 * 60_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
    });

    it('runs the row for the turn a plan approval moved into the column', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      hoisted.rows = [row()];
      const approvedAt = secondsAgo(10);
      enterColumnAt(approvedAt, 'auto-move');

      // The turn's start falls before the move: the planning prompt's, or the
      // approval's own stamp when a busy task lock wrote the move after it.
      await endTurn(Date.parse(approvedAt) - 60_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
      expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Skipped a carried-in turn'))).toBe(false);
      logSpy.mockRestore();
    });

    it('hands the rows the implementation\'s reply as {{agentReply}} after a plan approval', async () => {
      hoisted.rows = [row({ config: { targetColumn: 'Testing', message: 'Review this: {{agentReply}}' } })];
      hoisted.findSession.mockImplementation(() => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/worktree' }));
      // The turn's final reply: what the agent said once it finished implementing.
      hoisted.retrievalCall.mockImplementation(async () => ({ text: 'Implemented the approved plan.', uuid: 'reply-1', ts: Date.now() }));
      const approvedAt = secondsAgo(10);
      enterColumnAt(approvedAt, 'auto-move');

      await endTurn(Date.parse(approvedAt) - 60_000);

      expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , trigger, options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, { agentReply: string | null }];
      expect(trigger).toBe('turn_end');
      expect(options.agentReply).toBe('Implemented the approved plan.');
    });

    it('reads only the latest entry: a drag back in after a plan approval drops the carried turn', async () => {
      hoisted.rows = [row()];
      enterColumnAt(secondsAgo(60), 'auto-move');
      const draggedBackAt = secondsAgo(10);
      enterColumnAt(draggedBackAt, 'renderer');

      await endTurn(Date.parse(draggedBackAt) - 1_000);

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

  describe('Text match rows', () => {
    function replyEndingOn(line: string): void {
      hoisted.findSession.mockImplementation(() => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/worktree' }));
      hoisted.retrievalCall.mockImplementation(async () => ({ text: `The review is done.\n\n${line}`, uuid: 'reply-1', ts: Date.now() }));
    }

    it('reads the reply for a Text match row and makes no Automation agent call', async () => {
      hoisted.rows = [row({ final_line: 'Verdict: Ready' })];
      replyEndingOn('Verdict: Ready');
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, { agentReply: string | null }];
      expect(options.agentReply).toBe('The review is done.\n\nVerdict: Ready');
    });

    it('asks the Automation agent about the Agent evaluation rows only, never a Text match row', async () => {
      hoisted.rows = [
        row({ id: 'row-back', name: 'Back for revisions', final_line: 'Verdict: Blocked' }),
        row({ id: 'row-prose', name: 'Ask the agent', position: 1, condition: 'The review is clean' }),
      ];
      replyEndingOn('Verdict: Ready');
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      const [, , , conditional] = hoisted.conditionCheckInput.mock.calls[0] as [unknown, unknown, string, ColumnAutomation[]];
      expect(conditional.map((candidate) => candidate.id)).toEqual(['row-prose']);
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

  // #803 came back from Done, and its second review ended Ready with the card
  // left in place: "On to Testing" had spent its one run on the first pass, and
  // the turn end dropped it with no record, so the log showed only the revisions
  // row's "Condition not met". A spent row now says so, once per visit, and a
  // task that left Done counts its Frequency from there.
  describe('a row whose Frequency is spent', () => {
    const SPENT_REASON = 'Already ran once on this task, its limit.';

    /** An executed run of the row, stamped `startedAt`: one from an earlier visit. */
    function ranAt(automation: ColumnAutomation, startedAt: string): void {
      const runId = randomUUID();
      runs.start({ id: runId, automation, taskId });
      runs.finish(runId, 'succeeded', 'Moved to Testing.');
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(startedAt, runId);
    }

    /** Record that the task was taken out of Done at `at`. */
    function leaveDoneAt(at: string): void {
      const doneLaneId = new SwimlaneRepository(database).list().find((lane) => lane.role === 'done')!.id;
      database
        .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), taskId, doneLaneId, laneId, 'renderer', null, at);
    }

    it('is skipped with its limit once per visit, and never checked or run', async () => {
      const spentRow = row({ max_runs: 1, condition: 'The verdict reads Ready' });
      hoisted.rows = [spentRow];
      ranAt(spentRow, secondsAgo(120));
      enterColumnAt(secondsAgo(60));

      await endTurn();
      await endTurn();
      await endTurn();

      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(3);
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      const skipped = skippedRows();
      expect(skipped.map((run) => run.detail)).toEqual([SPENT_REASON]);
      expect(skipped[0]).toMatchObject({ automation_name: 'On to Testing', trigger: 'turn_end', swimlane_id: laneId });
      // A skip is not a run, so it spends nothing more.
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
    });

    it('is recorded even when nothing else in the pass has work to do', async () => {
      hoisted.workflowStepApplies.mockImplementation(() => false);
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      ranAt(spentRow, secondsAgo(120));
      enterColumnAt(secondsAgo(60));

      await endTurn();

      // The pass stopped at the cheap gate, after writing the skip.
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([SPENT_REASON]);
    });

    it('is recorded again in the next visit (the control)', async () => {
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      ranAt(spentRow, secondsAgo(120));
      enterColumnAt(secondsAgo(60));
      await endTurn();
      // Age the first visit's skip to before the second visit began.
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE status = ?').run(secondsAgo(30), 'skipped');
      enterColumnAt(secondsAgo(10));

      await endTurn();

      expect(skippedRows().map((run) => run.detail)).toEqual([SPENT_REASON, SPENT_REASON]);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
    });

    it('runs again once the task has come back from Done', async () => {
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      // The first life: the row ran, then the task finished and was reopened.
      ranAt(spentRow, secondsAgo(300));
      leaveDoneAt(secondsAgo(200));
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds]).toEqual(['row-on-to-testing']);
      expect(skippedRows()).toEqual([]);
      // The run this life made is the one that counts now.
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
    });

    it('does not stop the rows after it: they still run, and only the spent row is skipped', async () => {
      const spentRow = row({ max_runs: 1 });
      const runnableRow = row({ id: 'row-after-the-spent-one', name: 'Move on after review', position: 1 });
      hoisted.rows = [spentRow, runnableRow];
      ranAt(spentRow, secondsAgo(120));
      enterColumnAt(secondsAgo(60));

      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds]).toEqual(['row-after-the-spent-one']);
      const skipped = skippedRows();
      expect(skipped.map((run) => run.detail)).toEqual([SPENT_REASON]);
      expect(skipped[0].automation_id).toBe('row-on-to-testing');
      expect(runs.countRuns('row-after-the-spent-one', taskId)).toBe(1);
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

    // Every check is one recorded call, filed against the project, task and
    // column it judged. The engine describes whose call it is; the pass hands
    // that description to the check, or the call is recorded against nobody.
    it('is handed the call context the engine describes for this task and column', async () => {
      await endTurn();

      expect(hoisted.conditionCheckCall).toHaveBeenCalledTimes(1);
      expect(hoisted.conditionCheckCall).toHaveBeenCalledWith(
        expect.objectContaining({ id: taskId }),
        expect.objectContaining({ id: laneId }),
      );
      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      // The same object the engine returned, as the third argument.
      expect(hoisted.checkConditions.mock.calls[0][2]).toBe(checkCall);
    });
  });

  // A turn whose terminal never stays quiet before the wait runs out. The CLI
  // paints a status line for its own background work (the repaint rate is in
  // docs/transition-engine.md), and its own agents can run for minutes after
  // the Stop. The session is idle throughout, so the turn is over and the rows
  // go on; the warning records the give-up.
  describe('a turn that never settles', () => {
    beforeEach(() => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      enterColumnAt(secondsAgo(60));
    });

    const turnEndWarnings = (warnSpy: { mock: { calls: unknown[][] } }): string[] => warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[turn-end]'));

    it('goes on to the rows when the session is idle at the give-up, and warns once, naming the task, the column and the activity', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      // The row has a run record now, whatever the Condition answered.
      expect(runs.listForTask(taskId)).toHaveLength(1);
      const lines = turnEndWarnings(warnSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`task ${taskId.slice(0, 8)}'s turn to settle in Code Review`);
      // Idle at the give-up: the terminal never went quiet, not the session never idle.
      expect(lines[0]).toContain('activity idle');
      expect(lines[0]).toContain('the pass goes on without a quiet terminal');
      warnSpy.mockRestore();
    });

    it('runs nothing when the session is not idle at the give-up, since the turn is not over', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'thinking' });

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      const lines = turnEndWarnings(warnSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('activity thinking');
      expect(lines[0]).toContain('nothing ran');
      warnSpy.mockRestore();
    });

    it('runs nothing when the activity cache has no entry for the session, since unknown is not idle', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({});

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      const lines = turnEndWarnings(warnSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('activity unknown');
      expect(lines[0]).toContain('nothing ran');
      warnSpy.mockRestore();
    });

    it('does not warn when a move superseded the wait (the control)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'aborted');

      await endTurn();

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(turnEndWarnings(warnSpy)).toEqual([]);
      warnSpy.mockRestore();
    });
  });

  // A check that ran and did not answer (a timeout, an abandoned wait) was still
  // paid for. Its outcome names the call, and the pass hands that to the engine
  // so the run rows it skips link to it. The runner stamping those rows from it
  // is pinned against a real run log in condition-check-call-link.test.ts.
  describe('a Condition check that ran without answering', () => {
    beforeEach(() => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      enterColumnAt(secondsAgo(60));
    });

    function optionsHandedToEngine(): ExecuteOptions {
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      return (hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions])[3];
    }

    it('hands the engine the call it ran on, so the skipped rows link to it', async () => {
      hoisted.checkConditions.mockImplementation(async () => ({ ok: false, reason: TIMED_OUT_REASON, callId: 'c1' }));

      await endTurn();

      const options = optionsHandedToEngine();
      expect(options.conditionUnavailableReason).toBe(TIMED_OUT_REASON);
      expect(options.conditionUnavailableCallId).toBe('c1');
    });

    it('hands the engine no call when the check never started (the control)', async () => {
      hoisted.checkConditions.mockImplementation(async () => ({ ok: false, reason: SETUP_REASON }));

      await endTurn();

      const options = optionsHandedToEngine();
      expect(options.conditionUnavailableReason).toBe(SETUP_REASON);
      expect(options.conditionUnavailableCallId).toBeNull();
    });

    it('hands the engine no call when the check answered (the control)', async () => {
      hoisted.checkConditions.mockImplementation(async () => ({
        ok: true,
        answers: new Map([['row-on-to-testing', { met: true, reason: 'Clean.', callId: 'c1' }]]),
      }));

      await endTurn();

      expect(optionsHandedToEngine().conditionUnavailableCallId).toBeNull();
    });
  });
});
