/**
 * A turn end abandoned for newer work is judged after all when that work ends
 * with no turn end of its own (src/main/automations/turn-end/abandoned-turns.ts,
 * `reclaimAbandonedTurn` in turn-end-runner.ts).
 *
 * The incident: a Code Review session ended its turn with `Verdict: Ready`. A
 * tool start from one of Claude Code's internal agents (most likely the run
 * that answers the prompt suggestion) arrived three seconds later and never
 * ended. It moved the work serial, so the pass for the Stop judged
 * its turn stale and quit. The newer "turn" got no Stop, the stuck-pending-tools
 * watchdog idled it seven minutes later, and a watchdog idle is no turn end, so
 * the column's "On to Testing" row never ran.
 *
 * The reclaim judges the earlier reply at that idle, but only when nothing a
 * person did came between: no prompt, no interrupt, no failed turn, no reply
 * the newer work wrote of its own, and no turn end of its own.
 *
 * Driven through `registerTurnEndAutomations` and the session manager's events,
 * the way the app drives them. The run log is the real repository on SQLite;
 * the transition engine is a fake that writes a run for a Text match that hits.
 *
 * The second half pins each place a pass keeps a turn end (the settle wait, the
 * workflow step, the paid Condition check), each guard that keeps nothing (a
 * turn end of the session's own, a session that left the registry), each check
 * the reclaim makes again after its read, and the move a turn-end group makes.
 * A test that asserts "nothing was judged" first waits on a signal that the
 * reclaim ran far enough to have judged (a read of the newer work, or the
 * reclaim being scheduled), so it cannot pass only because nothing ran yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation, Swimlane } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { matchFinalLine } from '../../src/shared/final-line-match';
import { supersedeTurnEndWork } from '../../src/main/automations/turn-end/turn-end-passes';
import { hasAbandonedTurn, resetAbandonedTurnsForTests } from '../../src/main/automations/turn-end/abandoned-turns';
import { openTestDatabase } from './helpers/test-database';

interface ExecuteOptions {
  onlyIds: ReadonlySet<string>;
  agentReply?: string | null;
  moveTask?: (move: { column: string | null; message: string | null; reason: string }) => Promise<{ columnName: string }>;
}

const hoisted = vi.hoisted(() => ({
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
  executeTransition: vi.fn(),
  checkConditions: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = () => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/project' });
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: vi.fn(() => ({})),
    conditionCheckCall: vi.fn(() => ({})),
    checkConditions: hoisted.checkConditions,
  })),
  resolveInjectionVerifier: vi.fn(() => undefined),
}));
vi.mock('../../src/main/ipc/helpers/automation-failures', () => ({ reportAutomationFailures: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
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
  runWorkflowStep: vi.fn(async () => undefined),
  workflowStepApplies: vi.fn(() => false),
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');
// The mocked modules, so a test can change what the runner's collaborators answer.
const { runWorkflowStep, workflowStepApplies } = await import('../../src/main/workflows/workflow-step');
const { handleTaskMove } = await import('../../src/main/ipc/handlers/task-move');
const { resolveMoveTarget } = await import('../../src/main/automations/move-target');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
const MAIN_WINDOW = { isDestroyed: () => false };
/** The work serial at the Stop: the turn end's identity. */
const STOP_SERIAL = 41;
/** Where the turn that ended began, and where the newer work began (the end of that turn). */
const TURN_ANCHOR: TranscriptAnchor = { agentSessionId: 'agent-session-1', byteOffset: 1_000 };
const NEWER_ANCHOR: TranscriptAnchor = { agentSessionId: 'agent-session-1', byteOffset: 5_000 };
const VERDICT = 'The review found no blockers.\n\nVerdict: Ready';

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
  hadLeftPlanModeBy: () => boolean;
  currentWorkSerial: (sessionId: string) => number | undefined;
  currentTurnAnchor: (sessionId: string) => TranscriptAnchor | null;
  isInternalAgentEvent: (sessionId: string, event: { subagentId?: string }) => boolean;
}

describe('a turn end abandoned for newer work', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let runs: AutomationRunRepository;
  let laneId: string;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;
  let workSerial: number;
  let activity: string;
  let newerAnchor: TranscriptAnchor | null;
  /** The reply the newer work wrote, read from where it began. None unless a test sets one. */
  let newerReply: string | null;
  /** Agent ids a `subagent_start` named, so a tool event from any other id is an internal agent's. */
  let startedSubagentIds: Set<string>;
  /** False once the session has left the registry: its engine state is gone, so it has no work serial. */
  let sessionInRegistry: boolean;

  afterEach(() => {
    for (const opened of openDatabases.splice(0)) opened.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetAbandonedTurnsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const database = openTestDatabase();
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
      .run(taskId, 'Document the board', '', laneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, laneId, 'automation', null, new Date(Date.now() - 600_000).toISOString());

    hoisted.task = { id: taskId, archived_at: null, session_id: SESSION_ID, swimlane_id: laneId, agent: 'claude', workflow_id: null };
    hoisted.column = { id: laneId, name: 'Code Review', role: null, auto_spawn: true };
    hoisted.rows = [onToTesting()];
    hoisted.repos = {
      tasks: { getById: () => hoisted.task, list: () => [] },
      swimlanes: { getById: () => hoisted.column, list: () => [] },
      automations: { getForTrigger: () => hoisted.rows },
      automationRuns: runs,
      taskMoves: new TaskMoveRepository(database),
      attachments: {},
    };

    workSerial = STOP_SERIAL;
    activity = 'idle';
    newerAnchor = NEWER_ANCHOR;
    newerReply = null;
    startedSubagentIds = new Set<string>();
    sessionInRegistry = true;

    // Reset, not only cleared: a mock's implementation and its queue of one-shot
    // implementations outlive `clearAllMocks`, and a test that changes one must not
    // leak it into the next.
    vi.mocked(workflowStepApplies).mockReset();
    vi.mocked(workflowStepApplies).mockReturnValue(false);
    vi.mocked(runWorkflowStep).mockReset();
    vi.mocked(runWorkflowStep).mockImplementation(async () => undefined);
    vi.mocked(handleTaskMove).mockReset();
    vi.mocked(handleTaskMove).mockImplementation(async () => undefined);
    vi.mocked(resolveMoveTarget).mockReset();
    hoisted.checkConditions.mockReset();
    hoisted.checkConditions.mockImplementation(async () => ({ ok: true, answers: new Map() }));

    // The incident's order: the suggestion run's tool start lands while the
    // pass waits out the CLI's last paint, so the pass finds a newer serial.
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockImplementationOnce(async () => {
      startNewerWork();
      return 'completed';
    });
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.retrievalCall.mockImplementation(async (_method: string, input: { since: TranscriptAnchor | null }) => {
      if (input.since?.byteOffset === NEWER_ANCHOR.byteOffset) {
        return newerReply === null ? null : { text: newerReply, uuid: 'newer', ts: Date.now() };
      }
      return { text: VERDICT, uuid: 'verdict', ts: Date.now() };
    });
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: ExecuteOptions) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        const started = { id: randomUUID(), automation: row, taskId: task.id };
        const match = matchFinalLine(row.final_line ?? '', options.agentReply);
        if (!match.met) {
          runs.recordSkipped(started, match.reason);
          continue;
        }
        runs.start(started);
        runs.finish(started.id, 'succeeded', 'Moved to Testing.');
      }
      return { results: [] };
    });

    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => ({ [SESSION_ID]: activity }),
      isLatestTurn: (sessionId: string, serial: number) => sessionInRegistry && sessionId === SESSION_ID && serial === workSerial,
      hadLeftPlanModeBy: () => false,
      currentWorkSerial: () => (sessionInRegistry ? workSerial : undefined),
      // A spy: the reclaim reads it first thing, so a call means a reclaim was scheduled.
      currentTurnAnchor: vi.fn(() => newerAnchor),
      isInternalAgentEvent: (_sessionId: string, event: { subagentId?: string }) =>
        event.subagentId !== undefined && !startedSubagentIds.has(event.subagentId),
    });
    registerTurnEndAutomations({
      sessionManager,
      mainWindow: MAIN_WINDOW,
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
      boardConfigManager: { getBoardProfiles: () => [] },
    } as unknown as IpcContext);
  });

  function onToTesting(): ColumnAutomation {
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
      final_line: 'Verdict: Ready',
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  /** Work the agent reported after the Stop: the serial moves and the session leaves idle. */
  function startNewerWork(serial = STOP_SERIAL + 1): void {
    workSerial = serial;
    activity = 'thinking';
  }

  /** One immediate: every mock resolves in microtasks, which drain before the next immediate. */
  const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  /** The engine's turn end for the session, emitted and not yet scheduled: the runner's pass starts on the next immediate. */
  function emitTurnEnded(serial = STOP_SERIAL, transcriptAnchor: TranscriptAnchor | null = TURN_ANCHOR): void {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: Date.now(),
      workSerial: serial,
      transcriptAnchor,
    });
  }

  async function endTurn(serial = STOP_SERIAL, transcriptAnchor: TranscriptAnchor | null = TURN_ANCHOR): Promise<void> {
    emitTurnEnded(serial, transcriptAnchor);
    await tick();
  }

  /**
   * Every wait settles with the serial where it was. For a test whose newer work
   * begins somewhere other than the settle wait: the wait is the first place a
   * pass looks, so newer work that began inside it is the `'newer'` outcome and
   * never reaches the later branches.
   */
  function waitCompletesWithoutNewerWork(): void {
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
  }

  /** The transcript offsets every final-reply read started from, in order. */
  const readOffsets = (): Array<number | undefined> =>
    hoisted.retrievalCall.mock.calls.map((call) => (call[1] as { since: TranscriptAnchor | null }).since?.byteOffset);

  /**
   * Run `act` once, inside the reclaim's read of the newer work (the call that
   * starts from the newer anchor): an event that lands while the read is out.
   * Later reads of the newer anchor answer as the default does.
   */
  function actDuringNewerRead(act: () => void): void {
    let acted = false;
    hoisted.retrievalCall.mockImplementation(async (_method: string, input: { since: TranscriptAnchor | null }) => {
      if (input.since?.byteOffset === NEWER_ANCHOR.byteOffset) {
        if (!acted) {
          acted = true;
          act();
        }
        return newerReply === null ? null : { text: newerReply, uuid: 'newer', ts: Date.now() };
      }
      return { text: VERDICT, uuid: 'verdict', ts: Date.now() };
    });
  }

  /** The newer work ends with no turn end: a watchdog, or an idle hint. */
  async function idleWithoutTurnEnd(): Promise<void> {
    activity = 'idle';
    sessionManager.emit('activity', SESSION_ID, 'idle');
    await tick();
    await tick();
  }

  const succeededRuns = () => runs.listForTask(taskId).filter((run) => run.status === 'succeeded');

  it('gives up for the newer work, then judges the earlier reply when that work ends with no turn end', async () => {
    await endTurn();

    // The pass gave up and ran nothing, as it always did.
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

    await idleWithoutTurnEnd();

    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
    expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
    expect(hoisted.executeTransition.mock.calls[0][3]).toEqual(expect.objectContaining({ agentReply: VERDICT }));
    // The reply was read from where the earlier turn began, not the newer work.
    const sinces = hoisted.retrievalCall.mock.calls.map((call) => (call[1] as { since: TranscriptAnchor | null }).since?.byteOffset);
    expect(sinces).toEqual([NEWER_ANCHOR.byteOffset, TURN_ANCHOR.byteOffset]);
    expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
  });

  it('judges it once: a second idle finds nothing left', async () => {
    await endTurn();
    await idleWithoutTurnEnd();
    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));

    await idleWithoutTurnEnd();

    expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
  });

  it('judges it at once when the newer work had already ended before the pass gave up', async () => {
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockImplementation(async () => {
      // Newer work that began and ended inside the wait, with no turn end.
      workSerial = STOP_SERIAL + 1;
      activity = 'idle';
      return 'completed';
    });

    await endTurn();

    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
  });

  it.each([
    ['a prompt the agent received', { type: 'prompt' }],
    ['an interrupt', { type: 'interrupted' }],
    ['a failed turn', { type: 'turn_failed', detail: 'server_error' }],
  ])('leaves it unjudged after %s', async (_label, event) => {
    await endTurn();
    sessionManager.emit('event', SESSION_ID, { ts: Date.now(), ...event });

    await idleWithoutTurnEnd();

    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(runs.listForTask(taskId)).toEqual([]);
  });

  it('still judges it after a prompt that is only PTY output standing in for one', async () => {
    await endTurn();
    sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'prompt', detail: 'pty-activity' });

    await idleWithoutTurnEnd();

    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
  });

  it('still judges it after an internal agent\'s interrupted tool, which names that agent', async () => {
    await endTurn();
    sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'interrupted', subagentId: 'a-internal' });

    await idleWithoutTurnEnd();

    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
  });

  it('leaves it unjudged when the newer work wrote a reply of its own', async () => {
    newerReply = 'I also checked the links.';
    await endTurn();

    await idleWithoutTurnEnd();

    expect(hoisted.executeTransition).not.toHaveBeenCalled();
  });

  it('leaves it unjudged when where the newer work began is unknown', async () => {
    newerAnchor = null;
    await endTurn();

    await idleWithoutTurnEnd();

    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
  });

  it('leaves it to the newer work\'s own turn end when one arrives', async () => {
    await endTurn();
    expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

    // The newer work ended with its own Stop: the engine emits the idle, then the turn end.
    activity = 'idle';
    sessionManager.emit('activity', SESSION_ID, 'idle');
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: Date.now(),
      workSerial: STOP_SERIAL + 1,
      transcriptAnchor: NEWER_ANCHOR,
    });
    await tick();
    await tick();

    expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    // Only the newer turn's own pass read a reply, from where it began.
    const sinces = hoisted.retrievalCall.mock.calls.map((call) => (call[1] as { since: TranscriptAnchor | null }).since?.byteOffset);
    expect(sinces).toEqual([NEWER_ANCHOR.byteOffset]);
  });

  it('is forgotten when the task moves out of the column', async () => {
    await endTurn();

    supersedeTurnEndWork(taskId);
    await idleWithoutTurnEnd();

    expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
  });

  it('is forgotten when the session leaves the registry', async () => {
    await endTurn();

    sessionManager.emit('session-removed', SESSION_ID);

    expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
  });

  it('waits for the next idle when work began again before the reclaim ran', async () => {
    await endTurn();
    activity = 'idle';
    sessionManager.emit('activity', SESSION_ID, 'idle');
    // More work starts in the same moment, before the scheduled reclaim runs.
    activity = 'thinking';
    await tick();
    await tick();
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

    await idleWithoutTurnEnd();

    await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
  });

  describe('where a pass keeps a turn end', () => {
    it('keeps it when the workflow step finds newer work, then judges the step again once that work ends with no turn end', async () => {
      hoisted.rows = [];
      vi.mocked(workflowStepApplies).mockReturnValue(true);
      // A plain wait: the newer work begins inside the step's own check. Begun inside
      // the settle wait it would be that wait's `'newer'` outcome, which keeps the turn
      // by another line and would leave the step's line unproven.
      waitCompletesWithoutNewerWork();
      vi.mocked(runWorkflowStep).mockImplementationOnce(async () => {
        startNewerWork();
        return 'newer-turn';
      });

      await endTurn();

      expect(runWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      await idleWithoutTurnEnd();

      await vi.waitFor(() => expect(runWorkflowStep).toHaveBeenCalledTimes(2));
      // The step is judged again under the newer work's serial. The column has no rows.
      expect(vi.mocked(runWorkflowStep).mock.calls[1][1].payload.workSerial).toBe(STOP_SERIAL + 1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });

    it('keeps it when newer work begins during the paid Condition check, then runs the rows once that work ends with no turn end', async () => {
      // An agent-evaluated Condition (no Text match, so the fake transition records a skip,
      // and these assertions count its calls instead of counting runs).
      hoisted.rows = [{ ...onToTesting(), condition: 'All tests pass', final_line: null }];
      // A plain wait, for the same reason as the workflow step's test above.
      waitCompletesWithoutNewerWork();
      hoisted.checkConditions.mockImplementationOnce(async () => {
        startNewerWork();
        return { ok: true, answers: new Map() };
      });

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      await idleWithoutTurnEnd();

      await vi.waitFor(() => expect(hoisted.executeTransition).toHaveBeenCalledTimes(1));
      // The Condition is checked again for the reclaimed pass.
      expect(hoisted.checkConditions).toHaveBeenCalledTimes(2);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });
  });

  describe('where a pass keeps nothing', () => {
    /**
     * The newer work ends with its own Stop while the first pass waits: the engine emits
     * the idle, then the turn end. `letItQueue` gives the turn end's immediate a turn to
     * run before the wait returns, so its pass is queued behind the first. Without it the
     * pass is not scheduled yet when the first resumes, and only the turn-end count shows
     * a turn end of the session's own arrived.
     */
    function newerTurnEndsDuringFirstWait(letItQueue: boolean): void {
      let waitCalls = 0;
      hoisted.waitForTurnCompletion.mockReset();
      hoisted.waitForTurnCompletion.mockImplementation(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          startNewerWork();
          activity = 'idle';
          sessionManager.emit('activity', SESSION_ID, 'idle');
          emitTurnEnded(STOP_SERIAL + 1, NEWER_ANCHOR);
          if (letItQueue) await tick();
        }
        return 'completed';
      });
    }

    async function expectOnlyTheNewerTurnJudged(): Promise<void> {
      // The newer turn's own pass ran the row, from where that turn began.
      await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
      expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
      // The first pass kept nothing, and scheduled no reclaim although the session is idle:
      // the reclaim's first act is to read the newer work's anchor.
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
      expect(sessionManager.currentTurnAnchor).not.toHaveBeenCalled();
      // A later idle with no turn end judges nothing more.
      await idleWithoutTurnEnd();
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
    }

    it('keeps nothing when the newer turn\'s own turn end is queued behind the pass', async () => {
      newerReply = VERDICT;
      newerTurnEndsDuringFirstWait(true);

      await endTurn();

      await expectOnlyTheNewerTurnJudged();
    });

    it('keeps nothing when the newer turn\'s own turn end is emitted but not yet scheduled as the pass resumes', async () => {
      newerReply = VERDICT;
      newerTurnEndsDuringFirstWait(false);

      await endTurn();

      await expectOnlyTheNewerTurnJudged();
    });

    it('still keeps it when only a resume\'s catch-up is queued behind the pass', async () => {
      let waitCalls = 0;
      hoisted.waitForTurnCompletion.mockReset();
      hoisted.waitForTurnCompletion.mockImplementation(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          startNewerWork();
          sessionManager.emit('session-resumed', {
            sessionId: SESSION_ID,
            taskId,
            projectId: PROJECT_ID,
            agentSessionId: 'agent-session-1',
            isolatedSwimlaneId: null,
            workSerial: STOP_SERIAL + 1,
          });
          // Let the resume's immediate run, so its catch-up is queued behind this pass.
          await tick();
        }
        return 'completed';
      });

      await endTurn();

      // A catch-up judges a reply no check judged, never this turn end, so it does not stand in for the reclaim.
      // Polled: the wait above gave an immediate away, so the pass resumes after `endTurn` returns.
      await vi.waitFor(() => expect(hasAbandonedTurn(SESSION_ID)).toBe(true));

      await idleWithoutTurnEnd();

      await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
    });

    it('keeps nothing for a session that left the registry while the pass waited', async () => {
      hoisted.waitForTurnCompletion.mockReset();
      hoisted.waitForTurnCompletion.mockImplementation(async () => {
        // Newer work that is not idle, so a wrongly kept entry would not be reclaimed and
        // dropped by the reclaim's own check. `session-removed` is not emitted either: its
        // handler forgets the entry, which would hide the guard.
        startNewerWork();
        sessionInRegistry = false;
        return 'completed';
      });

      await endTurn();

      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });
  });

  describe('the reclaim checks again after it reads the newer work', () => {
    it('judges nothing when a prompt reaches the agent during the read', async () => {
      actDuringNewerRead(() => {
        sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'prompt' });
      });
      await endTurn();

      await idleWithoutTurnEnd();

      // The read ran, and the earlier turn's reply was never read after it.
      expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(runs.listForTask(taskId)).toEqual([]);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });

    it('keeps the entry when more work begins during the read, and judges it at that work\'s idle', async () => {
      actDuringNewerRead(() => {
        startNewerWork(STOP_SERIAL + 2);
      });
      await endTurn();

      await idleWithoutTurnEnd();

      expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      await idleWithoutTurnEnd();

      await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });

    it('drops it when the newer work\'s own turn end arrives during the read', async () => {
      actDuringNewerRead(() => {
        emitTurnEnded(STOP_SERIAL + 1, NEWER_ANCHOR);
      });
      await endTurn();

      await idleWithoutTurnEnd();

      // The newer turn's own pass is the one that judges, from where it began, and it
      // has no reply to match. The earlier turn's reply is never read.
      await vi.waitFor(() => expect(hoisted.executeTransition).toHaveBeenCalledTimes(1));
      expect(hoisted.executeTransition.mock.calls[0][3]).toEqual(expect.objectContaining({ agentReply: null }));
      expect(readOffsets()).not.toContain(TURN_ANCHOR.byteOffset);
      expect(succeededRuns()).toEqual([]);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });
  });

  it('leaves it unjudged and says so when the newer work\'s reply cannot be read', async () => {
    // The reader logs a warning of its own when a read fails.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.retrievalCall.mockImplementation(async (_method: string, input: { since: TranscriptAnchor | null }) => {
      if (input.since?.byteOffset === NEWER_ANCHOR.byteOffset) throw new Error('the retrieval worker is down');
      return { text: VERDICT, uuid: 'verdict', ts: Date.now() };
    });
    await endTurn();

    await idleWithoutTurnEnd();

    // The read was tried, and the earlier turn's reply was not read after it failed.
    expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('could not be read'))).toBe(true);
  });

  it('runs nothing when the task moved to another column during the read', async () => {
    actDuringNewerRead(() => {
      // No `task_moves` row is written into the new column, so the pass finds no visit
      // there and the carried-in check cannot be what stops it. The session is unchanged,
      // so `resolveSubject` passes: only the column the entry was kept for can stop it.
      hoisted.task = { ...hoisted.task, swimlane_id: 'lane-other' };
      hoisted.column = { id: 'lane-other', name: 'Testing', role: null, auto_spawn: true };
    });
    await endTurn();

    await idleWithoutTurnEnd();

    // The reclaim got as far as judging: its pass started, and stopped at the column.
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('Judging task'))).toBe(true);
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
    expect(runs.listForTask(taskId)).toEqual([]);
  });

  it('counts the interrupt of a subagent that was started as the user\'s work', async () => {
    startedSubagentIds.add('a-started');
    await endTurn();
    sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'interrupted', subagentId: 'a-started' });

    await idleWithoutTurnEnd();

    // The idle scheduled a reclaim, which stopped before it read anything.
    expect(sessionManager.currentTurnAnchor).toHaveBeenCalledTimes(1);
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(runs.listForTask(taskId)).toEqual([]);
  });

  describe('when the reclaimed pass is abandoned for newer work too', () => {
    /** The reclaimed pass's own wait finds yet more newer work: the second abandonment. */
    function queueSecondAbandonment(duringWait: () => void = () => undefined): void {
      hoisted.waitForTurnCompletion.mockImplementationOnce(async () => {
        duringWait();
        startNewerWork(STOP_SERIAL + 2);
        return 'completed';
      });
    }

    it('still judges it at the idle after the second abandonment when nobody acted', async () => {
      queueSecondAbandonment();
      await endTurn();

      await idleWithoutTurnEnd();

      // The reclaimed pass gave up and kept the entry again, with the first turn end's marks.
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      await idleWithoutTurnEnd();

      await vi.waitFor(() => expect(succeededRuns()).toHaveLength(1));
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });

    it('leaves it unjudged when a prompt came after the second abandonment', async () => {
      queueSecondAbandonment();
      await endTurn();
      await idleWithoutTurnEnd();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'prompt' });
      await idleWithoutTurnEnd();

      // Two reclaims were scheduled; only the first read anything.
      expect(sessionManager.currentTurnAnchor).toHaveBeenCalledTimes(2);
      expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });

    it('leaves it unjudged when a prompt came after the first Stop but before the second abandonment', async () => {
      // The prompt lands inside the reclaimed pass's wait. The entry it keeps afterward
      // carries the first Stop's count, not the count at that moment, so the prompt still blocks it.
      queueSecondAbandonment(() => {
        sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: 'prompt' });
      });
      await endTurn();
      await idleWithoutTurnEnd();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(true);

      await idleWithoutTurnEnd();

      expect(sessionManager.currentTurnAnchor).toHaveBeenCalledTimes(2);
      expect(readOffsets()).toEqual([NEWER_ANCHOR.byteOffset]);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hasAbandonedTurn(SESSION_ID)).toBe(false);
    });
  });

  it('moves the task for a Move to column row as the turn-end group\'s own move, from the column it judged', async () => {
    waitCompletesWithoutNewerWork();
    vi.mocked(resolveMoveTarget).mockReturnValue({ ok: true, column: { id: 'lane-testing', name: 'Testing' } as Swimlane });
    vi.mocked(handleTaskMove).mockImplementation(async () => {
      // The move lands: the board row is in the new column when the helper reads it again.
      hoisted.task = { ...hoisted.task, swimlane_id: 'lane-testing' };
    });
    let moved: { columnName: string } | undefined;
    hoisted.executeTransition.mockImplementation(async (_task: unknown, _column: unknown, _trigger: string, options: ExecuteOptions) => {
      moved = await options.moveTask?.({ column: 'Testing', message: null, reason: 'On to Testing' });
      return { results: [] };
    });

    await endTurn();

    await vi.waitFor(() => expect(handleTaskMove).toHaveBeenCalledTimes(1));
    expect(handleTaskMove).toHaveBeenCalledWith(
      expect.objectContaining({ sessionManager }),
      { taskId, targetSwimlaneId: 'lane-testing', targetPosition: 0 },
      'automation',
      PROJECT_ID,
      '/mock/project',
      // The group's own move must not abort the group that made it, and must refuse unless the task is still in the judged column.
      { moveReason: 'On to Testing', fromTurnEndGroup: true, expectedFromSwimlaneId: laneId },
    );
    // The target was resolved from the column the pass judged, not from wherever the task is by then.
    expect(vi.mocked(resolveMoveTarget).mock.calls[0].slice(0, 3)).toEqual([[], laneId, 'Testing']);
    expect(moved).toEqual({ columnName: 'Testing' });
  });
});
