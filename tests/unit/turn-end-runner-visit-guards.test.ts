/**
 * What stops a turn end from running a column's On agent turn end rows when it
 * should not (src/main/automations/turn-end/turn-end-runner.ts):
 *
 * - **The visit gate.** A turn that began before the task entered the column did
 *   the last column's work, and `{{agentReply}}` would carry the wrong reply, so
 *   it runs no row. Each pending row records that skip once a visit, the pass
 *   logs one line, and the next turn end still runs the rows. A plan exit is the
 *   exception, since the agent implements in that same turn: a plan approval's
 *   move (`auto-move`), or a drag into the last column's plan exit target made
 *   once the agent had left plan mode (kangentic-mobile #119). The gate runs
 *   after the Frequency and task-switch records, so a spent or held row keeps
 *   its own reason and only the rows still pending are carried in.
 * - **Once per visit.** A row that already ran since the task entered the column
 *   is not run again at the next turn end. Only a run counts: a skip does not.
 * - **A "not set up" skip is written once per visit.** A column whose Condition
 *   cannot be checked (no Automation agent chosen) would otherwise write the same
 *   skipped row at every turn end of a long chat and bury the log.
 * - **A spent Frequency is written once per visit.** A row that has run its
 *   limit is never checked or run, but says why, and a task that came back
 *   from Done counts its Frequency from there.
 * - **A turn that never settles.** When the wait for idle and a quiet terminal
 *   runs out with the session idle, the rows go on. With it busy on the same
 *   turn, no row runs, each pending row records why once a visit, and the pass
 *   warns once. A newer turn is silent: its own turn end judges it.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import type { BoardProfile, ColumnAutomation, TaskMoveRecordOrigin } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { RunConditionAnswer } from '../../src/main/db/repositories/automation-run-repository';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { AUTOMATIONS_DISABLED_REASON } from '../../src/shared/automation-manifest';
import { supersedeTurnEndWork } from '../../src/main/automations/turn-end/turn-end-passes';
import { matchFinalLine, TEXT_MATCH_NO_REPLY_REASON } from '../../src/shared/final-line-match';
import { readFinalReply } from '../../src/main/agent/message-trail-read';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import type { TranscriptMethods } from '../../src/main/retrieval/worker/transcript-methods';
import { claudeTranscriptLines, claudeWindowAdapter, trailAnchorAfterRead } from './helpers/claude-transcript-fixture';
import { openTestDatabase } from './helpers/test-database';

interface ExecuteOptions {
  onlyIds: ReadonlySet<string>;
  agentReply?: string | null;
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

const {
  registerTurnEndAutomations,
  CARRIED_IN_TURN_REASON,
  AGENT_NOT_IDLE_REASON,
} = await import('../../src/main/automations/turn-end/turn-end-runner');

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
  hadLeftPlanModeBy: (sessionId: string, atMs: number) => boolean;
  currentWorkSerial: (sessionId: string) => number | undefined;
  currentTurnAnchor: (sessionId: string) => TranscriptAnchor | null;
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
  /** The Board Profiles the board config would hand a task that rides one. None unless a test sets them. */
  let boardProfiles: BoardProfile[];

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
        // A Text match is checked in code against the reply, as the runner does.
        if (row.final_line) {
          const match = matchFinalLine(row.final_line, options.agentReply);
          if (!match.met) {
            runs.recordSkipped(started, match.reason);
            continue;
          }
        }
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
      hadLeftPlanModeBy: vi.fn((_sessionId: string, _atMs: number) => false),
      currentWorkSerial: () => WORK_SERIAL,
      // Unknown, so a turn end abandoned for newer work is never judged again
      // here. turn-end-runner-abandoned-turn.test.ts covers the reclaim.
      currentTurnAnchor: () => null,
    });
    boardProfiles = [];
    registerTurnEndAutomations({
      sessionManager,
      mainWindow: MAIN_WINDOW,
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
      // Read only for a task with a `profile_id`, which is how a Board Profile re-points a plan exit.
      boardConfigManager: { getBoardProfiles: () => boardProfiles },
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
  function enterColumnAt(
    at: string,
    origin: TaskMoveRecordOrigin = 'renderer',
    columns: { from?: string | null; to?: string } = {},
  ): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, columns.from ?? null, columns.to ?? laneId, origin, null, at);
  }

  /** Fire a turn end and wait for its pass to finish (see the file header). */
  async function endTurn(turnStartedAt: number | null = null, transcriptAnchor: TranscriptAnchor | null = null): Promise<void> {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt,
      workSerial: WORK_SERIAL,
      transcriptAnchor,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
  const skippedRows = () => runs.listForTask(taskId).filter((run) => run.status === 'skipped');
  /** Each skip as [row id, reason], sorted, so a test pins which row got which reason and how many. */
  const skipPairs = () => skippedRows().map((run) => [run.automation_id, run.detail]).sort();

  describe('the visit gate', () => {
    // Every mover but a plan approval: a drag, the agent moving its own task, a
    // phone, a Move to column row, a workflow step. Each of those turns did the
    // last column's work, unless a hand move was the plan exit (the plan exit
    // describe below).
    it.each(['renderer', 'agent', 'mobile', 'automation', 'workflow'] as const)(
      'runs no row for a turn that began before a %s move into the column, and records and logs the skip',
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
        // The task's own run log says why (kangentic-mobile #119): a console line alone landed
        // in whichever project's log was open.
        expect(runs.listForTask(taskId).map((run) => [run.automation_id, run.status, run.detail]))
          .toEqual([['row-on-to-testing', 'skipped', CARRIED_IN_TURN_REASON]]);
        // The line carries the times, which the reason leaves out.
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
      expect(skippedRows().map((run) => run.detail)).toEqual([CARRIED_IN_TURN_REASON]);
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

  // A carried-in skip is a record, not a run. `hasRunSince` and `countRuns`
  // count executed statuses only (#835), so the rows stay pending for the next
  // turn end of the same visit and no Frequency is spent.
  describe('a carried-in skip', () => {
    it('is written once per row per visit, and the next turn end in the visit still runs the rows', async () => {
      hoisted.rows = [row(), row({ id: 'row-second', name: 'On to Merge', position: 1 })];
      const enteredAt = secondsAgo(60);
      enterColumnAt(enteredAt);
      const carriedInStart = Date.parse(enteredAt) - 1_000;

      await endTurn(carriedInStart);
      await endTurn(carriedInStart);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => [run.automation_id, run.detail]).sort()).toEqual([
        ['row-on-to-testing', CARRIED_IN_TURN_REASON],
        ['row-second', CARRIED_IN_TURN_REASON],
      ]);

      await endTurn(Date.parse(enteredAt) + 1_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds]).toEqual(['row-on-to-testing', 'row-second']);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
      expect(runs.countRuns('row-second', taskId)).toBe(1);
      // The run wrote no second skip.
      expect(skippedRows()).toHaveLength(2);
    });

    it('spends no Frequency: a row limited to one run still runs at the next turn end', async () => {
      hoisted.rows = [row({ max_runs: 1 })];
      const enteredAt = secondsAgo(60);
      enterColumnAt(enteredAt);

      await endTurn(Date.parse(enteredAt) - 1_000);
      await endTurn(Date.parse(enteredAt) + 1_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(1);
      expect(skippedRows().map((run) => run.detail)).toEqual([CARRIED_IN_TURN_REASON]);
    });

    // The gate runs after the loop that records why a row is held, and carries
    // in only the rows still pending. A task whose automations are off has none
    // pending: every row already says so, and no row says the turn was carried in.
    it('leaves a task with its automations disabled the disabled reason on every row, and no carried-in skip', async () => {
      hoisted.task = { ...hoisted.task, automations_disabled: true };
      hoisted.rows = [row(), row({ id: 'row-second', name: 'On to Merge', position: 1 })];
      const enteredAt = secondsAgo(60);
      enterColumnAt(enteredAt);
      const carriedInStart = Date.parse(enteredAt) - 1_000;

      await endTurn(carriedInStart);
      await endTurn(carriedInStart);

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', AUTOMATIONS_DISABLED_REASON],
        ['row-second', AUTOMATIONS_DISABLED_REASON],
      ]);
      expect(skippedRows().some((run) => run.detail === CARRIED_IN_TURN_REASON)).toBe(false);
    });
  });

  // kangentic-mobile #119. The plan was left in the conversation, not through an
  // approved ExitPlanMode, so the engine never re-stamped the turn. The user
  // typed "looks good" in Planning, dragged the card to Executing 96 s into the
  // turn, and the turn ended there on `Findings: applied`. That drag is the plan
  // exit, so the turn is Executing's work, but only when the agent had left plan
  // mode by the drag: a drag made mid-plan ends on a plan reply.
  //
  // The real seeded board, so the plan exit target is the one production reads:
  // Planning's `plan_exit_target_id` is Executing.
  describe('a drag into the last column\'s plan exit target (kangentic-mobile #119)', () => {
    let planningId: string;
    let executingId: string;
    let codeReviewId: string;

    beforeEach(() => {
      const lanes = new SwimlaneRepository(database);
      const idOf = (name: string): string => lanes.list().find((lane) => lane.name === name)!.id;
      planningId = idOf('Planning');
      executingId = idOf('Executing');
      codeReviewId = idOf('Code Review');
      expect(lanes.getById(planningId)?.plan_exit_target_id).toBe(executingId);
      hoisted.repos = { ...(hoisted.repos as Record<string, unknown>), swimlanes: lanes };
      hoisted.task = { ...hoisted.task, workflow_id: null };
      placeTaskIn(executingId);
    });

    function placeTaskIn(columnId: string): void {
      hoisted.task = { ...hoisted.task, swimlane_id: columnId };
      database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(columnId, taskId);
    }

    /** Two rows in the column, so each skip is pinned per row. */
    function rowsIn(columnId: string): ColumnAutomation[] {
      return [
        row({ id: 'row-first', name: 'On to Code Review', swimlane_id: columnId, config: { targetColumn: 'Code Review' } }),
        row({ id: 'row-second', name: 'On to Testing', swimlane_id: columnId, position: 1 }),
      ];
    }

    /** Drag the task from `from` into `to` 12 minutes ago; the turn began 96 s before that. */
    async function dragMidTurnAndEndTurn(from: string, to: string, origin: TaskMoveRecordOrigin = 'renderer'): Promise<string> {
      const draggedAt = secondsAgo(12 * 60);
      enterColumnAt(draggedAt, origin, { from, to });
      await endTurn(Date.parse(draggedAt) - 96_000);
      return draggedAt;
    }

    it.each(['renderer', 'mobile', 'agent'] as const)(
      'runs the rows when the agent had left plan mode by a %s move',
      async (origin) => {
        sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
        hoisted.rows = rowsIn(executingId);

        const draggedAt = await dragMidTurnAndEndTurn(planningId, executingId, origin);

        // Asked about the moment of the move, on the app's clock.
        expect(sessionManager.hadLeftPlanModeBy).toHaveBeenCalledWith(SESSION_ID, Date.parse(draggedAt));
        expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
        expect(runs.countRuns('row-first', taskId)).toBe(1);
        expect(runs.countRuns('row-second', taskId)).toBe(1);
        expect(skippedRows()).toEqual([]);
        expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
      },
    );

    it('skips each row once when the agent was still in plan mode at the drag', async () => {
      hoisted.rows = rowsIn(executingId);

      const draggedAt = await dragMidTurnAndEndTurn(planningId, executingId);

      expect(sessionManager.hadLeftPlanModeBy).toHaveBeenCalledWith(SESSION_ID, Date.parse(draggedAt));
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => [run.automation_id, run.detail]).sort()).toEqual([
        ['row-first', CARRIED_IN_TURN_REASON],
        ['row-second', CARRIED_IN_TURN_REASON],
      ]);
      expect(runs.countRuns('row-first', taskId)).toBe(0);
      expect(runs.countRuns('row-second', taskId)).toBe(0);
    });

    it('does not count a drag into a column that is not the last column\'s plan exit target', async () => {
      sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
      placeTaskIn(codeReviewId);
      hoisted.rows = rowsIn(codeReviewId);

      await dragMidTurnAndEndTurn(planningId, codeReviewId);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([CARRIED_IN_TURN_REASON, CARRIED_IN_TURN_REASON]);
    });

    it.each(['automation', 'workflow'] as const)(
      'does not count a %s move into the plan exit target, whatever the mode',
      async (origin) => {
        sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
        hoisted.rows = rowsIn(executingId);

        await dragMidTurnAndEndTurn(planningId, executingId, origin);

        expect(sessionManager.hadLeftPlanModeBy).not.toHaveBeenCalled();
        expect(hoisted.executeTransition).not.toHaveBeenCalled();
        expect(skippedRows()).toHaveLength(2);
      },
    );

    // A move recorded with no source column (`from_swimlane_id` null) has no
    // column to have left plan mode in, so it is no plan exit: the rows are
    // carried in and the session is never asked about its mode.
    it('does not count a move recorded without a source column, and never asks the session about its mode', async () => {
      sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
      hoisted.rows = rowsIn(executingId);
      const movedAt = secondsAgo(12 * 60);
      enterColumnAt(movedAt, 'renderer', { from: null, to: executingId });

      await endTurn(Date.parse(movedAt) - 96_000);

      expect(sessionManager.hadLeftPlanModeBy).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
      expect(skipPairs()).toEqual([
        ['row-first', CARRIED_IN_TURN_REASON],
        ['row-second', CARRIED_IN_TURN_REASON],
      ]);
    });

    // A workflow task's plan exit is its route's next column, wherever the
    // column itself points. The route skips Executing, so a drag from Planning
    // into Code Review is the plan exit, and a drag into Executing is not.
    describe('a workflow task', () => {
      beforeEach(() => {
        sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
        hoisted.task = {
          ...hoisted.task,
          workflow_id: 'workflow-1',
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [executingId],
        };
      });

      it('counts a drag into the next column on its route', async () => {
        placeTaskIn(codeReviewId);
        hoisted.rows = rowsIn(codeReviewId);

        await dragMidTurnAndEndTurn(planningId, codeReviewId);

        expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
        expect(skippedRows()).toEqual([]);
      });

      it('does not count a drag into the column\'s own plan exit target that its route skips', async () => {
        hoisted.rows = rowsIn(executingId);

        await dragMidTurnAndEndTurn(planningId, executingId);

        expect(hoisted.executeTransition).not.toHaveBeenCalled();
        expect(skippedRows()).toHaveLength(2);
      });

      // With no source column the route has no "next" to compute from, and
      // `nextOnRoute` falls back to the route's first step. Here that step is
      // the column the task is in, so only the null check keeps this from
      // reading as a plan exit.
      it('does not count a move recorded without a source column, though the route starts in this column', async () => {
        hoisted.task = { ...hoisted.task, route_start_swimlane_id: executingId, skipped_swimlane_ids: [] };
        hoisted.rows = rowsIn(executingId);
        const movedAt = secondsAgo(12 * 60);
        enterColumnAt(movedAt, 'renderer', { from: null, to: executingId });

        await endTurn(Date.parse(movedAt) - 96_000);

        expect(sessionManager.hadLeftPlanModeBy).not.toHaveBeenCalled();
        expect(hoisted.executeTransition).not.toHaveBeenCalled();
        expect(skipPairs()).toEqual([
          ['row-first', CARRIED_IN_TURN_REASON],
          ['row-second', CARRIED_IN_TURN_REASON],
        ]);
      });
    });

    // A Board Profile re-points a column's plan exit per task, and the runner
    // reads the same answer the plan-exit listener moves by. This task's profile
    // sends Planning's plan exit to Code Review instead of Executing.
    describe('a task on a Board Profile that re-points Planning\'s plan exit to Code Review', () => {
      beforeEach(() => {
        sessionManager.hadLeftPlanModeBy = vi.fn(() => true);
        boardProfiles = [{
          id: 'profile-review-first',
          name: 'Review first',
          columns: { [planningId]: { planExitTarget: 'Code Review' } },
        }];
        hoisted.task = { ...hoisted.task, profile_id: 'profile-review-first' };
      });

      it('counts a drag from Planning into Code Review as the plan exit once the agent had left plan mode', async () => {
        placeTaskIn(codeReviewId);
        hoisted.rows = rowsIn(codeReviewId);

        const draggedAt = await dragMidTurnAndEndTurn(planningId, codeReviewId);

        expect(sessionManager.hadLeftPlanModeBy).toHaveBeenCalledWith(SESSION_ID, Date.parse(draggedAt));
        expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
        expect(runs.countRuns('row-first', taskId)).toBe(1);
        expect(runs.countRuns('row-second', taskId)).toBe(1);
        expect(skippedRows()).toEqual([]);
      });

      it('carries in a drag from Planning into Executing, the board\'s own plan exit target the profile replaced', async () => {
        hoisted.rows = rowsIn(executingId);

        await dragMidTurnAndEndTurn(planningId, executingId);

        expect(sessionManager.hadLeftPlanModeBy).not.toHaveBeenCalled();
        expect(hoisted.executeTransition).not.toHaveBeenCalled();
        expect(skipPairs()).toEqual([
          ['row-first', CARRIED_IN_TURN_REASON],
          ['row-second', CARRIED_IN_TURN_REASON],
        ]);
      });
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

  // The reply a turn end judges is read from where the turn began
  // (`transcriptAnchor`), so a turn that wrote no text never hands on the line
  // an earlier turn ended on.
  describe('the turn\'s own reply', () => {
    const AGENT_SESSION_ID = 'agent-session-1';
    const FACTS = { sessionType: 'claude_agent', agentSessionId: AGENT_SESSION_ID, cwd: '/mock/worktree' };
    const { humanPrompt, notification, assistantText, assistantTool, toolResult, turnEnd } = claudeTranscriptLines({
      agentSessionId: AGENT_SESSION_ID,
      cwd: FACTS.cwd,
    });
    let tmpDir: string;
    let transcriptFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-end-own-reply-'));
      transcriptFile = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
      hoisted.findSession.mockImplementation(() => ({
        session_type: FACTS.sessionType,
        agent_session_id: AGENT_SESSION_ID,
        cwd: FACTS.cwd,
      }));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * The worker's read, run in-process over the temp transcript with the real
     * Claude window parser, so the runner gets what production would hand it.
     */
    function readFromTranscript(): void {
      const adapter = claudeWindowAdapter(transcriptFile);
      hoisted.retrievalCall.mockImplementation(async (method: string, params: TranscriptMethods['transcript.finalReply']['params']) => {
        expect(method).toBe('transcript.finalReply');
        return readFinalReply(adapter, params.facts, params.since ?? null);
      });
    }

    it('hands the turn\'s anchor to the reply read', async () => {
      hoisted.rows = [row({ final_line: 'Verdict: Ready' })];
      hoisted.retrievalCall.mockImplementation(async () => ({ text: 'Verdict: Ready', uuid: 'reply-1', ts: Date.now() }));
      enterColumnAt(secondsAgo(60));
      const anchor = { agentSessionId: AGENT_SESSION_ID, byteOffset: 4095 };

      await endTurn(null, anchor);

      expect(hoisted.retrievalCall).toHaveBeenCalledWith('transcript.finalReply', expect.objectContaining({ since: anchor }), expect.anything());
    });

    describe('back in Executing after a Code Review round trip, a turn a background job opened that wrote no text', () => {
      // The previous visit ended on the line the move row matches. Back in the
      // column, a notification opens a turn that only calls a tool.
      const previousVisit = humanPrompt('p1', 'Apply the findings.')
        + assistantText('a1', 'Applied all three.\n\nFindings: applied')
        + turnEnd('t1');
      const notificationTurn = notification('n1')
        + assistantTool('a2', 'toolu_1', 'TaskOutput')
        + toolResult('r1', 'toolu_1');

      async function setUp(): Promise<TranscriptAnchor> {
        hoisted.rows = [row({
          id: 'row-on-to-review',
          name: 'On to Code Review',
          config: { targetColumn: 'Code Review' },
          final_line: 'Findings: applied',
        })];
        fs.writeFileSync(transcriptFile, previousVisit);
        // Where the trail had read to when the resumed session went idle.
        const anchor = await trailAnchorAfterRead(transcriptFile, FACTS);
        fs.appendFileSync(transcriptFile, notificationTurn);
        readFromTranscript();
        enterColumnAt(secondsAgo(60));
        return anchor;
      }

      /** The read does real file I/O, so the pass outlives one immediate: wait for its `finally`. */
      async function endTurnAndWait(anchor: TranscriptAnchor | null): Promise<void> {
        await endTurn(Date.now() - 5_000, anchor);
        await vi.waitFor(() => expect(hoisted.clearSpawnProgress).toHaveBeenCalled());
      }

      it('without an anchor, judges the previous visit\'s line and moves the task again (the bug)', async () => {
        await setUp();

        await endTurnAndWait(null);

        expect(runs.countRuns('row-on-to-review', taskId)).toBe(1);
      });

      it('with the anchor, finds no reply of the turn\'s own, so the move row does not run', async () => {
        const anchor = await setUp();

        await endTurnAndWait(anchor);

        expect(runs.countRuns('row-on-to-review', taskId)).toBe(0);
        expect(skippedRows().map((run) => run.detail)).toEqual([TEXT_MATCH_NO_REPLY_REASON]);
      });
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
  // task that left Done counts its Frequency from there. Each visit here opens
  // with the board's own move (Back for revisions), which keeps the count: a
  // person's move would start it over (`automation-run-frequency-boundary.test.ts`).
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
      enterColumnAt(secondsAgo(60), 'automation');

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
      enterColumnAt(secondsAgo(60), 'automation');

      await endTurn();

      // The pass stopped at the cheap gate, after writing the skip.
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([SPENT_REASON]);
    });

    it('is recorded again in the next visit (the control)', async () => {
      const spentRow = row({ max_runs: 1 });
      hoisted.rows = [spentRow];
      ranAt(spentRow, secondsAgo(120));
      enterColumnAt(secondsAgo(60), 'automation');
      await endTurn();
      // Age the first visit's skip to before the second visit began.
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE status = ?').run(secondsAgo(30), 'skipped');
      enterColumnAt(secondsAgo(10), 'automation');

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
      enterColumnAt(secondsAgo(60), 'automation');

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
      enterColumnAt(secondsAgo(60), 'automation');

      await endTurn();

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds]).toEqual(['row-after-the-spent-one']);
      const skipped = skippedRows();
      expect(skipped.map((run) => run.detail)).toEqual([SPENT_REASON]);
      expect(skipped[0].automation_id).toBe('row-on-to-testing');
      expect(runs.countRuns('row-after-the-spent-one', taskId)).toBe(1);
    });

    // The carried-in gate runs after this loop and carries in only the rows
    // still pending. A spent row keeps its limit as its one skip; it is not
    // also told the turn was carried in, and a carried-in turn does not hide
    // the limit from the log.
    it('keeps its limit as its only skip on a carried-in turn, and only the pending row is carried in', async () => {
      const spentRow = row({ max_runs: 1 });
      const pendingRow = row({ id: 'row-pending', name: 'Move on after review', position: 1 });
      hoisted.rows = [spentRow, pendingRow];
      // The run that spent the limit is from before this visit: one inside it would drop the row with no record.
      ranAt(spentRow, secondsAgo(120));
      const enteredAt = secondsAgo(60);
      enterColumnAt(enteredAt, 'automation');
      const carriedInStart = Date.parse(enteredAt) - 1_000;

      await endTurn(carriedInStart);

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', SPENT_REASON],
        ['row-pending', CARRIED_IN_TURN_REASON],
      ]);

      // A second carried-in turn end of the visit adds no record for either row.
      await endTurn(carriedInStart);

      expect(skipPairs()).toHaveLength(2);

      // The skips spent nothing: the next turn end of the visit runs the pending
      // row, and the spent row is still held without a second record.
      await endTurn(Date.parse(enteredAt) + 1_000);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , , options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect([...options.onlyIds]).toEqual(['row-pending']);
      expect(runs.countRuns('row-pending', taskId)).toBe(1);
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', SPENT_REASON],
        ['row-pending', CARRIED_IN_TURN_REASON],
      ]);
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

  // The re-check after the Condition check. A newer turn abandons the pass
  // silently (pinned in turn-end-runner-workflow-step.test.ts); the same turn
  // with the session gone off idle holds the rows back and says so, since a
  // permission prompt with no tool hook before it moves no work serial and no
  // turn end may follow it.
  describe('the re-check before the rows', () => {
    beforeEach(() => {
      hoisted.rows = [row({ condition: 'The review is clean' })];
      enterColumnAt(secondsAgo(60));
      hoisted.checkConditions.mockImplementation(async () => {
        // The session goes to a permission prompt while the check is out.
        sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'permission' });
        return { ok: true, answers: new Map([['row-on-to-testing', { met: true, reason: 'Clean.' }]]) };
      });
    });

    it('runs no row when the session is not idle on the same turn, and records why once a visit', async () => {
      await endTurn();
      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'idle' });
      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(2);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([AGENT_NOT_IDLE_REASON]);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(0);
    });

    // Per row, like the give-up's skip: a conditional row (its check came back
    // and the session left idle meanwhile) and a plain one each say why, once.
    it('records the not-idle skip for each row it holds back, and for neither again at the next turn end', async () => {
      hoisted.rows = [
        row({ condition: 'The review is clean' }),
        row({ id: 'row-second', name: 'On to Merge', position: 1 }),
      ];

      await endTurn();

      expect(skipPairs()).toEqual([
        ['row-on-to-testing', AGENT_NOT_IDLE_REASON],
        ['row-second', AGENT_NOT_IDLE_REASON],
      ]);

      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'idle' });
      await endTurn();

      // The second turn end paid for its check again and the session left idle again.
      expect(hoisted.checkConditions).toHaveBeenCalledTimes(2);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toHaveLength(2);
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', AGENT_NOT_IDLE_REASON],
        ['row-second', AGENT_NOT_IDLE_REASON],
      ]);
    });

    // `runnable` leaves out a conditional row whose check is unavailable and that
    // already carries that skip this visit, since the engine would write nothing
    // new for it. The not-idle skip goes only to the rows `runnable` still holds,
    // so that row keeps its one reason and the plain row beside it gets the other.
    it('writes no not-idle skip for a conditional row already skipped as unavailable this visit', async () => {
      const conditionalRow = row({ condition: 'The review is clean' });
      hoisted.rows = [conditionalRow, row({ id: 'row-second', name: 'On to Merge', position: 1 })];
      // An earlier turn end of this visit found no Automation agent set up.
      runs.recordSkipped({ id: randomUUID(), automation: conditionalRow, taskId }, SETUP_REASON);
      hoisted.checkConditions.mockImplementation(async () => {
        // The session goes to a permission prompt while the check is out.
        sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'permission' });
        return { ok: false, reason: SETUP_REASON };
      });

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', SETUP_REASON],
        ['row-second', AGENT_NOT_IDLE_REASON],
      ]);
    });

    it('writes nothing when a newer turn began during the check (the control)', async () => {
      hoisted.checkConditions.mockImplementation(async () => {
        sessionManager.isLatestTurn = () => false;
        return { ok: true, answers: new Map([['row-on-to-testing', { met: true, reason: 'Clean.' }]]) };
      });

      await endTurn();

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
    });
  });

  // A turn whose terminal never stays quiet before the wait runs out. The CLI
  // paints a status line for its own background work (the repaint rate is in
  // docs/architecture/automations/triggers.md), and its own agents can run for minutes after
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

    // Busy on the same turn: the session left idle with no work reported, as a
    // permission prompt with no tool hook before it does, and no turn end may
    // follow. The column was waiting on this turn, so the row says why.
    it('runs nothing when the session is not idle at the give-up, and the row records why once a visit', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'thinking' });

      await endTurn();
      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([AGENT_NOT_IDLE_REASON]);
      expect(runs.countRuns('row-on-to-testing', taskId)).toBe(0);
      const lines = turnEndWarnings(warnSpy);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('activity thinking');
      expect(lines[0]).toContain('nothing ran');
      warnSpy.mockRestore();
    });

    // The skip is per row, not per task: a conditional row and a plain one each
    // say why, and a second turn end of the visit adds neither again.
    it('records the not-idle skip for each pending row, and for neither again at the next turn end', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.rows = [
        row({ condition: 'The review is clean' }),
        row({ id: 'row-second', name: 'On to Merge', position: 1 }),
      ];
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'thinking' });

      await endTurn();

      expect(skipPairs()).toEqual([
        ['row-on-to-testing', AGENT_NOT_IDLE_REASON],
        ['row-second', AGENT_NOT_IDLE_REASON],
      ]);

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toHaveLength(2);
      expect(skipPairs()).toEqual([
        ['row-on-to-testing', AGENT_NOT_IDLE_REASON],
        ['row-second', AGENT_NOT_IDLE_REASON],
      ]);
      warnSpy.mockRestore();
    });

    it('runs nothing when the activity cache has no entry for the session, since unknown is not idle', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({});

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(skippedRows().map((run) => run.detail)).toEqual([AGENT_NOT_IDLE_REASON]);
      const lines = turnEndWarnings(warnSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('activity unknown');
      expect(lines[0]).toContain('nothing ran');
      warnSpy.mockRestore();
    });

    // A turn the user began after this turn end is still running at the give-up.
    // Its own turn end judges it, so this pass writes nothing, and no warning
    // claims a turn did not settle.
    it('is silent when a newer turn began, writing neither a warning nor a record', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');
      sessionManager.getActivityCache = () => ({ [SESSION_ID]: 'thinking' });
      sessionManager.isLatestTurn = () => false;

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(turnEndWarnings(warnSpy)).toEqual([]);
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
