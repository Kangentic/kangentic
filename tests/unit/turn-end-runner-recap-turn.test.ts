/**
 * The turn that answers an expired conversation's recap runs nothing
 * (src/main/automations/turn-end/turn-end-runner.ts, recap-turns.ts).
 *
 * A resume whose conversation the agent deleted starts a fresh session whose
 * whole prompt is a recap that asks the agent to summarize and wait. The reply
 * is a report for the user, not the column's work, so its turn end runs no On
 * agent turn end row and no workflow step. Only that turn: a Ctrl+C ends a turn
 * with no turn end, so after an interrupted recap the user's next turn begins
 * with a prompt the agent received after the session first went idle, and runs
 * its rows as usual.
 *
 * The first idle alone does not end the recap's turn. An idle no Stop caused
 * (the stale-thinking watchdog) can land mid-turn, and the engine re-stamps the
 * turn's start when thinking resumes, so a start after the first idle with no
 * prompt behind it is still the recap's turn. A prompt that is PTY output
 * standing in for one (`PromptReason.PtyActivity`) is not a prompt the agent
 * received.
 *
 * Driven through `registerTurnEndAutomations`, the session manager's
 * 'activity', 'event', 'turn-ended' and 'session-removed' events, and the real
 * `recap-turns` module, the way the app drives them. The run log is the REAL
 * repository on a real SQLite database, and the transition engine is a fake that
 * writes a run for each row it is handed, so "no run record" means the pass
 * never reached the engine. `Date` is faked so the first idle and each turn's
 * start are exact; timers are real, since the pass starts on a `setImmediate`
 * and everything after that is a microtask, which drains before the next
 * immediate (awaiting one immediate after an emit is the barrier that the pass
 * has finished).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { EventType, PromptReason } from '../../src/shared/types';
import type { ColumnAutomation, SessionEvent } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { markRecapSession, isRecapTurn, resetRecapSessionsForTests } from '../../src/main/automations/turn-end/recap-turns';
import { openTestDatabase } from './helpers/test-database';

interface ExecuteOptions {
  onlyIds: ReadonlySet<string>;
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
    conditionCheckCall: vi.fn(() => ({ projectId: null, taskId: null, swimlaneId: null, job: 'condition_check' })),
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
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: vi.fn(async () => null) } }));
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

const SESSION_ID = 'recap-session-1';
const PROJECT_ID = 'project-1';
const MAIN_WINDOW = { isDestroyed: () => false };
const WORK_SERIAL = 41;
const ROW_ID = 'row-on-to-testing';
/** When the recap session spawned: its opening turn began here. */
const SPAWNED_AT = Date.parse('2026-10-15T12:00:00.000Z');

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('the turn that answers an expired conversation\'s recap', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let laneId: string;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRecapSessionsForTests();
    // Only `Date`: the pass starts on a real `setImmediate`.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SPAWNED_AT);

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
      .run(taskId, 'A task whose conversation expired', '', laneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    hoisted.task = {
      id: taskId,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: laneId,
      agent: 'claude',
      workflow_id: null,
      workflow_project_id: null,
    };
    hoisted.column = { id: laneId, name: 'Code Review', role: null, auto_spawn: true };
    hoisted.rows = [row()];
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
    // Rows only, unless a test makes the task a workflow task.
    hoisted.workflowStepApplies.mockImplementation(() => false);
    hoisted.checkConditions.mockImplementation(async () => ({ ok: true, answers: new Map() }));
    // The runner's own bookkeeping for the rows it is handed: a run for each.
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: ExecuteOptions) => {
      for (const automation of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(automation.id)) continue;
        const started = { id: randomUUID(), automation, taskId: task.id };
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

  afterEach(() => {
    vi.useRealTimers();
    for (const opened of openDatabases.splice(0)) opened.close();
    // A console spy a failed assertion left in place.
    vi.restoreAllMocks();
    resetRecapSessionsForTests();
  });

  function row(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
    return {
      id: ROW_ID,
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

  /** Move the faked clock forward. */
  function advanceClock(milliseconds: number): void {
    vi.setSystemTime(Date.now() + milliseconds);
  }

  /** The engine reports the session's activity; the listener stamps the clock's now. */
  function reportActivity(activity: 'idle' | 'thinking' | 'permission'): void {
    sessionManager.emit('activity', SESSION_ID, activity, { kind: 'idle' });
  }

  /** The session manager re-emits each event the agent's hooks write. */
  function emitSessionEvent(event: Omit<SessionEvent, 'ts'>): void {
    sessionManager.emit('event', SESSION_ID, { ts: Date.now(), ...event });
  }

  /** Emit a turn end that began at `turnStartedAt`, then wait for its pass to finish (see the file header). */
  async function endTurn(turnStartedAt: number | null): Promise<void> {
    emitTurnEnd(turnStartedAt);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function emitTurnEnd(turnStartedAt: number | null): void {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt,
      workSerial: WORK_SERIAL,
    });
  }

  /** The log lines the recap skip writes: it leaves no run record, so the log is its only trace. */
  const recapSkipLines = (logSpy: { mock: { calls: unknown[][] } }): string[] => logSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('Skipped the recap turn'));

  describe('a session that opened on the recap', () => {
    beforeEach(() => {
      markRecapSession(SESSION_ID);
    });

    it('runs no row for the turn that answered the recap, and logs the skip', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // The recap's reply lands: the session goes idle, then the turn ends.
      advanceClock(20_000);
      reportActivity('idle');

      await endTurn(SPAWNED_AT);

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      const skipLines = recapSkipLines(logSpy);
      expect(skipLines).toHaveLength(1);
      expect(skipLines[0]).toContain(`task ${taskId.slice(0, 8)}`);
      expect(skipLines[0]).toContain('Code Review');
    });

    it('runs the row for the next turn, the one the user starts after the recap', async () => {
      advanceClock(20_000);
      reportActivity('idle');
      await endTurn(SPAWNED_AT);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();

      // The user answers the summary: a prompt reaches the agent and a new turn
      // begins after the first idle.
      advanceClock(60_000);
      emitSessionEvent({ type: EventType.Prompt });
      const userTurnStartedAt = Date.now();
      advanceClock(30_000);
      reportActivity('idle');
      await endTurn(userTurnStartedAt);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      const [, , trigger, options] = hoisted.executeTransition.mock.calls[0] as [unknown, unknown, string, ExecuteOptions];
      expect(trigger).toBe('turn_end');
      expect([...options.onlyIds]).toEqual([ROW_ID]);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });

    // A task session's hook-written prompt carries no detail (prompt text stays out of
    // its events file); a Command Terminal's carries the prompt text. Neither is PTY output.
    it.each([
      ['no detail (a task session)', undefined],
      ['the prompt text as its detail (a Command Terminal)', 'now summarize the failing test'],
    ])('runs the row for the turn after an interrupted recap, which ended with no turn end: a hook prompt with %s', async (_label, detail) => {
      // Ctrl+C on the recap: the session goes idle, and no turn end follows.
      advanceClock(5_000);
      reportActivity('idle');
      expect(hoisted.executeTransition).not.toHaveBeenCalled();

      // The user's next turn starts with a prompt after that idle and ends normally.
      advanceClock(60_000);
      emitSessionEvent({ type: EventType.Prompt, detail });
      const userTurnStartedAt = Date.now();
      advanceClock(30_000);
      reportActivity('idle');
      await endTurn(userTurnStartedAt);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });

    it('still skips the recap turn when an idle no Stop caused landed mid-turn and the start was re-stamped', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // The stale-thinking watchdog goes idle while the recap's turn is still running...
      advanceClock(20_000);
      reportActivity('idle');
      // ...the agent resumes, the engine re-stamps the turn's start, and the turn ends. No prompt arrived.
      advanceClock(5_000);
      const restampedStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');

      await endTurn(restampedStartedAt);

      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(recapSkipLines(logSpy)).toHaveLength(1);
    });

    it('does not take a PTY-activity prompt after the idle for the user\'s prompt', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');
      // Output on the terminal stands in for a prompt: the agent received none.
      advanceClock(5_000);
      emitSessionEvent({ type: EventType.Prompt, detail: PromptReason.PtyActivity });
      const restampedStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');

      await endTurn(restampedStartedAt);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(recapSkipLines(logSpy)).toHaveLength(1);
    });

    it('does not take an event that is not a prompt after the idle for the user\'s prompt', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');
      advanceClock(5_000);
      emitSessionEvent({ type: EventType.ToolStart, tool: 'Read' });
      const restampedStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');

      await endTurn(restampedStartedAt);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(recapSkipLines(logSpy)).toHaveLength(1);
    });

    it('does not take the recap\'s own opening prompt, which arrives before any idle, for the user\'s', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // The recap reaches the agent as a prompt, so a Prompt event lands before the first idle.
      emitSessionEvent({ type: EventType.Prompt });
      advanceClock(20_000);
      reportActivity('idle');
      advanceClock(5_000);
      const restampedStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');

      await endTurn(restampedStartedAt);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(recapSkipLines(logSpy)).toHaveLength(1);
    });

    it('forgets the mark once the recap turn end is skipped, so a later turn end runs the row with no prompt behind it', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');
      await endTurn(SPAWNED_AT);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(recapSkipLines(logSpy)).toHaveLength(1);
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);

      // Without the forget this start, after the idle and with no prompt, would read as a re-stamped recap turn.
      advanceClock(5_000);
      const laterStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');
      await endTurn(laterStartedAt);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });

    it('forgets the mark even when the column has nothing to skip, so a row added later runs on the next turn end', async () => {
      // The fast path returns before the skip is logged, but the mark still ends with the recap's turn.
      hoisted.rows = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');
      await endTurn(SPAWNED_AT);
      expect(recapSkipLines(logSpy)).toEqual([]);
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);

      hoisted.rows = [row()];
      advanceClock(5_000);
      const laterStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');
      await endTurn(laterStartedAt);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });

    // The mark is judged and forgotten before the subject is resolved, so a
    // recap turn end that finds no subject still ends it. Otherwise the mark
    // outlives its turn and swallows the first turn the user starts afterwards.
    it.each([
      [
        'the task\'s live session is another one',
        () => { hoisted.task.session_id = 'another-session'; },
        () => { hoisted.task.session_id = SESSION_ID; },
      ],
      [
        'the task was archived',
        () => { hoisted.task.archived_at = '2026-10-15T12:30:00.000Z'; },
        () => { hoisted.task.archived_at = null; },
      ],
    ])('forgets the mark when the recap turn end finds no subject, so a later turn runs the row: %s', async (_label, loseSubject, regainSubject) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');
      // The mark is live going in, so what follows is the pass's doing.
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
      loseSubject();

      await endTurn(SPAWNED_AT);

      // The pass returned at the subject check: no row, no skip line, no run.
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(recapSkipLines(logSpy)).toEqual([]);
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);

      // The subject is back and a later turn begins after the idle with no prompt
      // behind it. Had the mark survived, it would read as the recap's own.
      regainSubject();
      advanceClock(5_000);
      const laterStartedAt = Date.now();
      advanceClock(10_000);
      reportActivity('idle');
      await endTurn(laterStartedAt);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });

    it('still skips the recap turn when its turn end arrives before the idle event', async () => {
      // The engine reports the idle first, but the pass starts on a later tick, so
      // the order the two events were emitted in must not matter.
      advanceClock(20_000);
      emitTurnEnd(SPAWNED_AT);
      reportActivity('idle');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
    });

    it('does not take a thinking event for the first idle', async () => {
      // Only an idle ends the recap's turn. A session that has reported nothing
      // but work has not left its opening turn, so a turn end still answers the recap.
      advanceClock(5_000);
      reportActivity('thinking');
      advanceClock(5_000);

      await endTurn(Date.now());

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
    });

    it('runs no workflow step for the turn that answered the recap, and runs it for the next turn', async () => {
      hoisted.rows = [];
      hoisted.workflowStepApplies.mockImplementation(() => true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');

      await endTurn(SPAWNED_AT);

      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
      expect(recapSkipLines(logSpy)).toHaveLength(1);

      advanceClock(60_000);
      const userTurnStartedAt = Date.now();
      advanceClock(30_000);
      reportActivity('idle');
      await endTurn(userTurnStartedAt);

      expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
    });

    it('writes nothing to the log for a column with no turn end rows and no workflow step', async () => {
      // The skip comes after the cheap fast path: most columns have nothing to skip.
      hoisted.rows = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      advanceClock(20_000);
      reportActivity('idle');

      await endTurn(SPAWNED_AT);

      expect(recapSkipLines(logSpy)).toEqual([]);
      expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
    });

    it('runs the row once the session has left the registry, since a removed session is forgotten', async () => {
      advanceClock(20_000);
      sessionManager.emit('session-removed', SESSION_ID, {});

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
      await endTurn(SPAWNED_AT);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });
  });

  describe('a session that did not open on the recap (the control)', () => {
    it('runs the row for its first turn end, as every other turn end does', async () => {
      advanceClock(20_000);
      reportActivity('idle');

      await endTurn(SPAWNED_AT);

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(ROW_ID, taskId)).toBe(1);
    });
  });
});
