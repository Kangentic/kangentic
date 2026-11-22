/**
 * A restart that cuts a turn off before its Stop keeps the owner's message for
 * the next turn end (kangentic-mobile #160): the owner typed "signed off", the
 * agent was still working when Kangentic restarted, and the turn that
 * recovery's nudge started ended with only the nudge to read, so the column's
 * Text match on the user's message never moved the card.
 *
 * Driven through `registerTurnEndAutomations`, the way the app drives it: the
 * owner's turn start arrives as `'turn-anchor'` and is kept on the session row,
 * the recovery resumes carry it with `carryInterruptedTurn` (what
 * `resumeSuspendedSessions` calls), and the nudged turn's end is a
 * `'turn-ended'`. The session records, the typed-message ledger, the run log
 * and the visit boundary are the REAL repositories on a real SQLite database,
 * and the user-message read is the real `readUserMessagesInTurn` and
 * `personMessagesInTurn`. Only the retrieval worker's transcript read is
 * mocked, answering by the byte offset it is asked to read from. The engine is
 * a fake that matches each Text match with the real `matchUserMessage`, as the
 * runner does, and moves the card when it runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation, TaskMoveRecordOrigin } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import type { UserMessageRead } from '../../src/shared/final-line-match';
import {
  CARRIED_USER_TEXT_MATCH_MET_REASON,
  CARRIED_USER_TEXT_MATCH_NO_MESSAGE_REASON,
  USER_TEXT_MATCH_NO_MESSAGE_REASON,
  USER_TEXT_MATCH_NOT_MET_REASON,
  matchUserMessage,
} from '../../src/shared/final-line-match';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SessionTypedMessageRepository } from '../../src/main/db/repositories/session-typed-message-repository';
import { insertSessionRecord, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const hoisted = vi.hoisted(() => ({
  database: null as unknown,
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  columns: new Map<string, Record<string, unknown>>(),
  executeTransition: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  runWorkflowStep: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => hoisted.database),
  getOpenProjectDb: vi.fn(() => hoisted.database),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: vi.fn(() => ({})),
    conditionCheckCall: vi.fn(),
    checkConditions: vi.fn(async () => ({ ok: true, answers: new Map() })),
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
vi.mock('../../src/main/retrieval/retrieval-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-client')>()),
  retrievalClient: { call: hoisted.retrievalCall },
}));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(), list: vi.fn(() => []), getBySessionType: vi.fn() },
}));
vi.mock('../../src/main/automations/automation-registry', () => ({ automationRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/automations/move-target', () => ({ resolveMoveTarget: vi.fn(), routeOf: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-step', () => ({
  heldMoveReason: vi.fn(() => null),
  runWorkflowStep: hoisted.runWorkflowStep,
  workflowStepApplies: vi.fn(() => true),
}));
vi.mock('../../src/main/workflows/workflow-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-home')>()),
  isTaskWorkflowPaused: vi.fn(() => false),
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');
const { carryInterruptedTurn } = await import('../../src/main/automations/turn-end/carried-owner-turn');

const PROJECT_ID = 'project-1';
const CONVERSATION = 'conversation-1';
const WORK_SERIAL = 7;
/** The records of #160's shape: the owner's, one resumed and suspended again with no turn, and the one nudged. */
const OWNER_RECORD = 'record-owner';
const IDLE_RECORD = 'record-idle';
const NUDGED_RECORD = 'record-nudged';
/** Where the owner's turn and the nudged turn began in the transcript. */
const OWNER_TURN_OFFSET = 100;
const NUDGED_TURN_OFFSET = 500;
const NUDGE = 'The Design step is not done yet. Kangentic restarted. Say signed off when it is.';

describe('a turn a restart cut off, and the owner\'s message in it', () => {
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let sessions: SessionRepository;
  let designLaneId: string;
  let planningLaneId: string;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: EventEmitter & Record<string, unknown>;
  /** What the transcript holds from each turn start the read is asked for. */
  let messagesFrom: Map<number, string[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    database = openMigratedProjectDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    hoisted.database = database;
    const lanes = new SwimlaneRepository(database).list().filter((lane) => lane.role === null);
    designLaneId = lanes[0].id;
    planningLaneId = lanes[1].id;
    runs = new AutomationRunRepository(database);
    sessions = new SessionRepository(database);

    // The runner keeps one pass per task in a module-level map, so each test owns its task.
    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'Earlier conversations', '', designLaneId, 0, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z');
    for (const [index, id] of [OWNER_RECORD, IDLE_RECORD, NUDGED_RECORD].entries()) {
      insertSessionRecord(database, { id, taskId, agentSessionId: CONVERSATION, startedAt: secondsAgo(900 - index * 10) });
    }

    hoisted.task = { id: taskId, archived_at: null, session_id: NUDGED_RECORD, swimlane_id: designLaneId, agent: 'claude', workflow_id: 'workflow-1' };
    hoisted.columns = new Map([
      [designLaneId, { id: designLaneId, name: 'Design', role: null, auto_spawn: true }],
      [planningLaneId, { id: planningLaneId, name: 'Planning', role: null, auto_spawn: true }],
    ]);
    hoisted.rows = [onToPlanning()];
    hoisted.repos = {
      tasks: { getById: () => hoisted.task, list: () => [] },
      swimlanes: { getById: (id: string) => hoisted.columns.get(id), list: () => [] },
      automations: { getForTrigger: (columnId: string) => (hoisted.rows as ColumnAutomation[]).filter((row) => row.swimlane_id === columnId) },
      automationRuns: runs,
      taskMoves: new TaskMoveRepository(database),
      attachments: {},
    };

    messagesFrom = new Map();
    hoisted.retrievalCall.mockImplementation(async (method: string, params: { since: TranscriptAnchor | null }) => {
      if (method === 'transcript.finalReply') return { text: 'The restart dropped the move.', uuid: 'reply-1', ts: Date.now() };
      return messagesFrom.get(params.since?.byteOffset ?? -1) ?? null;
    });
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    // The runner's own bookkeeping, with the Text match matched as the runner
    // matches it. A row that runs moves the card, as Move to column does.
    hoisted.executeTransition.mockImplementation(async (
      task: { id: string },
      _column: unknown,
      _trigger: string,
      options: { onlyIds: ReadonlySet<string>; userMessage?: UserMessageRead },
    ) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        const started = { id: randomUUID(), automation: row, taskId: task.id };
        const match = matchUserMessage(row.final_line ?? '', options.userMessage ?? { readable: false });
        if (!match.met) {
          runs.recordSkipped(started, match.reason);
          continue;
        }
        runs.start(started);
        runs.finish(started.id, 'succeeded', match.reason);
        hoisted.task.swimlane_id = planningLaneId;
        enterColumnAt(new Date().toISOString(), 'automation', planningLaneId);
      }
      return { results: [] };
    });

    sessionManager = Object.assign(new EventEmitter(), {
      setTaskStopped: vi.fn(),
      getActivityCache: () => ({ [String(hoisted.task.session_id)]: 'idle' }),
      isLatestTurn: (sessionId: string, workSerial: number) => sessionId === hoisted.task.session_id && workSerial === WORK_SERIAL,
      hadLeftPlanModeBy: vi.fn(() => false),
      currentWorkSerial: () => WORK_SERIAL,
      currentTurnAnchor: () => null,
      isInternalAgentEvent: () => false,
    });
    registerTurnEndAutomations({
      sessionManager,
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
      boardConfigManager: { getBoardProfiles: () => [] },
    } as unknown as IpcContext);
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  function secondsAgo(seconds: number): string {
    return new Date(Date.now() - seconds * 1000).toISOString();
  }

  function onToPlanning(): ColumnAutomation {
    return {
      id: 'row-on-to-planning',
      swimlane_id: designLaneId,
      name: 'On to Planning',
      type: 'move_to_column',
      trigger: 'turn_end',
      position: 0,
      enabled: true,
      config: { targetColumn: 'Planning' },
      condition: null,
      final_line: '*signed off*',
      text_match_source: 'user',
      max_runs: null,
      created_at: '2026-11-22T00:00:00.000Z',
      updated_at: '2026-11-22T00:00:00.000Z',
    };
  }

  function enterColumnAt(at: string, origin: TaskMoveRecordOrigin, toLaneId: string = designLaneId): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, toLaneId, origin, null, at);
  }

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** A turn start or end on a session, as the session manager announces it. */
  async function announceTurnAnchor(sessionId: string, byteOffset: number | null, turnStartedAt: number | null): Promise<void> {
    sessionManager.emit('turn-anchor', {
      sessionId,
      taskId,
      projectId: PROJECT_ID,
      anchor: byteOffset === null ? null : { agentSessionId: CONVERSATION, byteOffset },
      turnStartedAt,
    });
    await settle();
  }

  /** The owner's turn starts, then Kangentic restarts twice before its Stop: the #160 timeline. */
  async function ownerTurnCutOffByTwoRestarts(ownerTurnStartedAt: number = Date.now() - 300_000): Promise<void> {
    await announceTurnAnchor(OWNER_RECORD, OWNER_TURN_OFFSET, ownerTurnStartedAt);
    carryInterruptedTurn(sessions, OWNER_RECORD, IDLE_RECORD);
    carryInterruptedTurn(sessions, IDLE_RECORD, NUDGED_RECORD);
  }

  /** The nudged turn starts and ends on the session the task now runs. */
  async function nudgedTurnEnds(sessionId: string = NUDGED_RECORD, turnStartedAt: number = Date.now() - 10_000): Promise<void> {
    await announceTurnAnchor(sessionId, NUDGED_TURN_OFFSET, turnStartedAt);
    sessionManager.emit('turn-ended', {
      sessionId,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: CONVERSATION,
      isolatedSwimlaneId: null,
      turnStartedAt,
      workSerial: WORK_SERIAL,
      transcriptAnchor: { agentSessionId: CONVERSATION, byteOffset: NUDGED_TURN_OFFSET },
    });
    await announceTurnAnchor(sessionId, null, null);
    // The pass waits on real SQLite and microtasks; a few immediates see it through.
    for (let index = 0; index < 5; index += 1) await settle();
  }

  const planningRuns = () => runs.listForTask(taskId).filter((run) => run.automation_id === 'row-on-to-planning');
  const succeeded = () => planningRuns().filter((run) => run.status === 'succeeded');
  const skipReasons = () => planningRuns().filter((run) => run.status === 'skipped').map((run) => run.detail);
  const carriedOn = (recordId: string) =>
    (database.prepare('SELECT carried_owner_turn FROM sessions WHERE id = ?').get(recordId) as { carried_owner_turn: string | null }).carried_owner_turn;

  it('moves the card once at the nudged turn end, reading the owner\'s message from the turn the restarts cut off', async () => {
    enterColumnAt(secondsAgo(3_600), 'renderer');
    // A Kangentic text under the owner's record and the nudge under the new one
    // both name the phrase: only the owner's own message may count.
    new SessionTypedMessageRepository(database).record(OWNER_RECORD, 'To sign off, type signed off.');
    new SessionTypedMessageRepository(database).record(NUDGED_RECORD, NUDGE);
    messagesFrom.set(OWNER_TURN_OFFSET, ['signed off', 'To sign off, type signed off.', NUDGE]);
    messagesFrom.set(NUDGED_TURN_OFFSET, [NUDGE]);

    await ownerTurnCutOffByTwoRestarts();
    // The middle resume ran no turn, and still handed the owner's turn on.
    expect(JSON.parse(carriedOn(NUDGED_RECORD) ?? 'null')).toMatchObject({
      byteOffset: OWNER_TURN_OFFSET,
      recordIds: [OWNER_RECORD, IDLE_RECORD],
    });

    await nudgedTurnEnds();

    expect(succeeded()).toHaveLength(1);
    expect(succeeded()[0].detail).toBe(CARRIED_USER_TEXT_MATCH_MET_REASON);
    expect(hoisted.task.swimlane_id).toBe(planningLaneId);
    // Taken: it counts once.
    expect(carriedOn(NUDGED_RECORD)).toBeNull();

    // A later turn end, now in Planning, runs nothing more.
    await nudgedTurnEnds();
    expect(succeeded()).toHaveLength(1);
  });

  it('never counts Kangentic\'s own texts under any record the read spans as the owner\'s message', async () => {
    enterColumnAt(secondsAgo(3_600), 'renderer');
    new SessionTypedMessageRepository(database).record(OWNER_RECORD, 'To sign off, type signed off.');
    new SessionTypedMessageRepository(database).record(NUDGED_RECORD, NUDGE);
    // The cut-off turn was Kangentic's: no message of the owner's in it.
    messagesFrom.set(OWNER_TURN_OFFSET, ['To sign off, type signed off.', NUDGE]);
    messagesFrom.set(NUDGED_TURN_OFFSET, [NUDGE]);

    await ownerTurnCutOffByTwoRestarts();
    await nudgedTurnEnds();

    expect(succeeded()).toHaveLength(0);
    expect(skipReasons()).toEqual([CARRIED_USER_TEXT_MATCH_NO_MESSAGE_REASON]);
    expect(hoisted.task.swimlane_id).toBe(designLaneId);
  });

  it('moves nothing when the card was moved by hand after the owner\'s turn began', async () => {
    enterColumnAt(secondsAgo(3_600), 'renderer');
    new SessionTypedMessageRepository(database).record(NUDGED_RECORD, NUDGE);
    messagesFrom.set(OWNER_TURN_OFFSET, ['signed off', NUDGE]);
    messagesFrom.set(NUDGED_TURN_OFFSET, [NUDGE]);

    await ownerTurnCutOffByTwoRestarts(Date.now() - 300_000);
    // Out to Planning and back by hand: a new visit of Design.
    enterColumnAt(secondsAgo(120), 'renderer', planningLaneId);
    enterColumnAt(secondsAgo(60), 'renderer');
    await nudgedTurnEnds();

    expect(succeeded()).toHaveLength(0);
    expect(skipReasons()).toEqual([USER_TEXT_MATCH_NO_MESSAGE_REASON]);
    expect(carriedOn(NUDGED_RECORD)).toBeNull();
  });

  it('lets a newer message of the owner\'s decide, even one that matches nothing', async () => {
    enterColumnAt(secondsAgo(3_600), 'renderer');
    new SessionTypedMessageRepository(database).record(NUDGED_RECORD, NUDGE);
    messagesFrom.set(OWNER_TURN_OFFSET, ['signed off', 'Actually, what about B2?', NUDGE]);
    messagesFrom.set(NUDGED_TURN_OFFSET, ['Actually, what about B2?', NUDGE]);

    await ownerTurnCutOffByTwoRestarts();
    await nudgedTurnEnds();

    expect(succeeded()).toHaveLength(0);
    expect(skipReasons()).toEqual([USER_TEXT_MATCH_NOT_MET_REASON]);
  });

  it('moves nothing on a second resume after the move already ran', async () => {
    enterColumnAt(secondsAgo(3_600), 'renderer');
    new SessionTypedMessageRepository(database).record(NUDGED_RECORD, NUDGE);
    messagesFrom.set(OWNER_TURN_OFFSET, ['signed off', NUDGE]);
    messagesFrom.set(NUDGED_TURN_OFFSET, [NUDGE]);
    await ownerTurnCutOffByTwoRestarts();
    await nudgedTurnEnds();
    expect(succeeded()).toHaveLength(1);

    // The card comes back to Design by hand, and Kangentic restarts again: the
    // nudged turn ended, so its record has no open turn to hand on.
    enterColumnAt(new Date(Date.now() + 1_000).toISOString(), 'renderer');
    hoisted.task.swimlane_id = designLaneId;
    const nextRecord = 'record-after-second-restart';
    insertSessionRecord(database, { id: nextRecord, taskId, agentSessionId: CONVERSATION, startedAt: new Date().toISOString() });
    carryInterruptedTurn(sessions, NUDGED_RECORD, nextRecord);
    expect(carriedOn(nextRecord)).toBeNull();
    new SessionTypedMessageRepository(database).record(nextRecord, NUDGE);
    hoisted.task.session_id = nextRecord;
    // The owner's old sign-off is still in the transcript from the first offset,
    // but nothing points the read back to it any more.
    await nudgedTurnEnds(nextRecord, Date.now() + 2_000);

    expect(succeeded()).toHaveLength(1);
    expect(skipReasons()).toEqual([USER_TEXT_MATCH_NO_MESSAGE_REASON]);
  });
});
