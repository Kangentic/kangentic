/**
 * A running workflow task whose turn ends without its step done is recovered:
 * it moves on, or the user gets one notice saying why it cannot
 * (src/main/workflows/workflow-recovery.ts).
 *
 * The incident (2026-10-25): a service the agent's shell calls go through
 * stopped answering for five minutes, so the agent could not commit or run its
 * gate, and it ended its turn listing what it still had to do, without its
 * column's completion marker. The step check said "not done", correctly, and
 * nothing came after it: no retry, no notice. The idle sweep paused the session
 * half an hour later, and the workflow sat for 7.7 hours.
 *
 * Driven through `registerTurnEndAutomations` and the session manager's events,
 * the way the app drives them, with the real step check (`runWorkflowStep`) and
 * the real recovery. The Automation agent is a script that answers each
 * Condition from the reply's text, the way a careful one would; the run log is
 * the real repository on SQLite; time is faked, so the schedule's minutes pass
 * at once. Replies are written for this test, not copied from any board.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation, Swimlane } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { IPC } from '../../src/shared/ipc-channels';
import { nextOnRoute } from '../../src/shared/workflow-route';
import { matchFinalLine } from '../../src/shared/final-line-match';
import { supersedeTurnEndWork } from '../../src/main/automations/turn-end/turn-end-passes';
import { resetAbandonedTurnsForTests } from '../../src/main/automations/turn-end/abandoned-turns';
import {
  cancelWorkflowRecovery,
  isUnderWorkflowRecovery,
  resetWorkflowRecoveryForTests,
  WORKING_WAIT_MS,
} from '../../src/main/workflows/workflow-recovery-state';
import { markOwnCallSession } from '../../src/main/ipc/handlers/own-call-turn-wait';
import { workflowMemoryGate } from '../../src/main/workflows/workflow-memory-gate';
import type { OpenWork } from '../../src/main/activity-engine/open-work-ledger';
import { openTestDatabase } from './helpers/test-database';
import { GIBIBYTE, windowsSample } from './helpers/host-memory-sample';

interface CheckInput {
  agentReply: string | null;
  rows: Array<{ automationId: string; condition: string }>;
}

const hoisted = vi.hoisted(() => ({
  database: null as unknown,
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  /** A second workflow task in the same column, for the tests that put two through the memory gate. */
  otherTask: null as Record<string, unknown> | null,
  /** The tasks of the workflow, as the recovery reads them to name the siblings whose PR landed. */
  workflowTasks: vi.fn(),
  workflowState: 'running',
  check: vi.fn(),
  handleTaskMove: vi.fn(),
  deliverMessageToSession: vi.fn(),
  executeTransition: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = () => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/project' });
  },
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => hoisted.database),
  getExistingProjectDb: vi.fn(() => hoisted.database),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: vi.fn(() => ({})),
    conditionCheckCall: vi.fn(() => ({})),
    checkConditions: vi.fn(async () => ({ ok: true, answers: new Map() })),
  })),
  resolveInjectionVerifier: vi.fn(() => null),
  conditionCheckDeps: vi.fn(() => ({})),
}));
vi.mock('../../src/main/ipc/helpers/automation-failures', () => ({ reportAutomationFailures: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: hoisted.handleTaskMove }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/turn-completion', () => ({ waitForTurnCompletion: vi.fn(async () => 'completed') }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.retrievalCall } }));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(), list: vi.fn(() => []) } }));
vi.mock('../../src/main/automations/automation-registry', () => ({ automationRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/automations/move-target', () => ({ resolveMoveTarget: vi.fn(), routeOf: vi.fn() }));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: hoisted.deliverMessageToSession,
  deliverMessageAfterMove: vi.fn(),
}));
vi.mock('../../src/main/automations/condition-check/condition-check', () => ({ checkAutomationConditions: hoisted.check }));
vi.mock('../../src/main/workflows/workflow-home', () => ({
  workflowOfTask: vi.fn(() => ({ id: 'workflow-1', state: hoisted.workflowState })),
  // As the real one: a task whose own automations are paused is no step task.
  isRunningWorkflowStepTask: vi.fn(() => hoisted.workflowState === 'running' && !hoisted.task.automations_disabled),
  isInWorkflow: vi.fn(() => true),
}));
vi.mock('../../src/main/workflows/workflow-changed', () => ({ notifyWorkflowChanged: vi.fn(), notifyWorkflowOfTask: vi.fn() }));
// Only the read the recovery makes for its siblings is replaced; the rest of the module stays real.
vi.mock('../../src/main/workflows/workflow-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-tasks')>()),
  workflowTasks: hoisted.workflowTasks,
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { registerTurnEndAutomations, catchUpAfterResume } = await import('../../src/main/automations/turn-end/turn-end-runner');
const {
  announceWorkflowStall,
  noteWorkflowTaskPaused,
  nudgeMessage,
  RECOVERY_DELAYS_MS,
  OUTAGE_RETRY_MS,
  HOLD_RECHECK_MS,
} = await import('../../src/main/workflows/workflow-recovery');
const { applyAutomationsHoldChange } = await import('../../src/main/workflows/workflow-task-hold');
const { sendToRenderer } = await import('../../src/main/ipc/send-to-renderer');
const { checkForHungTurns, stopWorkflowHangCheck, INTERRUPT_LANDING_MS } = await import('../../src/main/workflows/workflow-hang-check');
const { agentRegistry } = await import('../../src/main/agent/agent-registry');

/** Below the 2 GB pressure threshold of a 64 GB commit limit. */
const LOW_COMMIT_BYTES = 1 * GIBIBYTE;
/** Past its 4 GB recovery line. */
const RECOVERED_COMMIT_BYTES = 8 * GIBIBYTE;

const SESSION_ID = 'session-1';
/** The second task's session, for the tests that put two tasks through the memory gate. */
const OTHER_SESSION_ID = 'session-other';
/** Its turn's serial, apart from the first session's `workSerial`, which `startTurn` and `endTurn` move. */
const OTHER_WORK_SERIAL = 7;
const PROJECT_ID = 'project-1';
const MARKER = 'Implementation: complete';
const ANCHOR: TranscriptAnchor = { agentSessionId: 'agent-session-1', byteOffset: 1_000 };
const MINUTE = 60_000;

/** The incident's reply, written fresh: it stopped with work left that it can do itself. */
const STALLED_REPLY = 'I could not finish: the service that approves shell commands stopped answering, so the last edits are '
  + 'uncommitted and the gate has not run.\n\n**To finish:** commit the working tree, run the gate, and fix what it finds.';
const FINISHED_REPLY = `The gate passed on the committed tree.\n\n${MARKER}`;
/** The agent's words while its gate runs: what holds it is the open shell, never these words. */
const BACKGROUND_REPLY = 'The gate is still running in the background. I will report when it finishes.';
const OWNER_QUESTION = 'which layout do you want, the side panel or the drawer?';
/** A real question, named the one way a workflow agent stops for the owner. */
const QUESTION_REPLY = `Two layouts would work here, and they change what the user sees.\n\nNeeds owner: ${OWNER_QUESTION}`;
/** A gate the memory reaper stopped: a resource blocker, which the nudge answers by itself. */
const REAPED_REPLY = 'The gate was killed by the memory reaper while the machine was low on memory. I will not start it again on my own.';

/**
 * The Automation agent, scripted: each Condition answered from the reply's
 * text. The step is done on the marker. The blocker rows read a reaped gate
 * and failures that also happen on main. Anything else is a stall with no
 * blocker. `serviceDown` makes every check fail, as an outage does.
 */
let serviceDown = false;
function scriptedCheck(_deps: unknown, input: CheckInput): unknown {
  if (serviceDown) {
    return { ok: false, reason: 'The Automation agent could not check the condition: 529 overloaded', cause: 'failed', callId: null };
  }
  const reply = input.agentReply ?? '';
  const answers = new Map<string, { met: boolean; reason: string }>();
  for (const row of input.rows) {
    if (row.automationId === 'workflow-step') {
      const met = reply.includes(MARKER);
      answers.set(row.automationId, { met, reason: met ? 'It ends on the marker.' : 'It stopped before its marker; the gate has not passed' });
    } else if (row.automationId === 'workflow-step-blocker:resource') {
      const met = reply.includes('low on memory');
      answers.set(row.automationId, { met, reason: met ? 'The memory reaper killed the gate.' : 'Nothing was stopped for memory.' });
    } else if (row.automationId === 'workflow-step-blocker:main-fails-too') {
      const met = reply.includes('fail on main too');
      answers.set(row.automationId, { met, reason: met ? 'The same tests fail on main.' : 'It names no failure on main.' });
    } else {
      throw new Error(`An unexpected condition row: ${row.automationId}`);
    }
  }
  return { ok: true, answers, agentName: 'Scripted agent', callId: null };
}

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
  currentWorkSerial: (sessionId: string) => number | undefined;
  currentTurnAnchor: (sessionId: string) => TranscriptAnchor | null;
  hadLeftPlanModeBy: () => boolean;
  isInternalAgentEvent: () => boolean;
  getSession: (sessionId: string) => unknown;
  getPendingDraft: (sessionId: string) => string | null;
  getFocusedSessions: () => Set<string>;
  getLastUserInputAt: (sessionId: string) => number | null;
  getOpenWork: (sessionId: string) => OpenWork;
  automatedKeysBlocker: (sessionId: string) => string | null;
  listSessions: () => unknown[];
  getActivityReason: (sessionId: string) => unknown;
  getSessionAgentName: (sessionId: string) => string;
  getSessionCliTarget: (sessionId: string) => null;
  getReportedTranscriptPath: (sessionId: string) => string | null;
  write: (sessionId: string, data: string) => void;
  signalUserInterrupt: (sessionId: string) => void;
}

describe('a running workflow task whose turn ends without its step done', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let runs: AutomationRunRepository;
  let lanes: Swimlane[];
  let workingLane: Swimlane;
  let nextLane: Swimlane;
  let taskId: string;
  /** The second task, once a test adds it (`addOtherWorkflowTask`), or null. */
  let otherTaskId: string | null;
  /** What the second session shows: idle by default, and nothing in these tests moves it. */
  let otherActivity: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;
  let context: IpcContext;
  let workSerial: number;
  let activity: string;
  let currentReply: string | null;
  let replyAt: number;
  let draft: string | null;
  let focused: Set<string>;
  /** The user typing into the terminal: their last input is always just now. */
  let userTyping: boolean;
  /** What the session's hook events still have open (`SessionManager.getOpenWork`). */
  let openWork: OpenWork;
  /** Why the session cannot take automated keys, or null (`automatedKeysBlocker`). */
  let keysBlocker: string | null;
  let notifyDesktop: ReturnType<typeof vi.fn>;
  let notifyPhone: ReturnType<typeof vi.fn>;
  /** What the session shows it is working on; a busy turn by default once it thinks. */
  let activityReason: unknown;
  /** Keys written to the terminal outside a message delivery (the hang check's interrupt). */
  let typed: string[];
  let historyDirectory: string;
  let historyFile: string;

  afterEach(() => {
    resetWorkflowRecoveryForTests();
    stopWorkflowHangCheck();
    fs.rmSync(historyDirectory, { recursive: true, force: true });
    vi.useRealTimers();
    for (const opened of openDatabases.splice(0)) opened.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-25T06:18:00.000Z'));
    vi.clearAllMocks();
    resetAbandonedTurnsForTests();
    resetWorkflowRecoveryForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    serviceDown = false;
    hoisted.workflowState = 'running';

    const database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    hoisted.database = database;
    // Every column runs an agent, so a turn-end row can run in it.
    lanes = new SwimlaneRepository(database).list().map((lane) => ({ ...lane, auto_spawn: true }));
    workingLane = lanes.find((lane) => lane.role === null)!;
    runs = new AutomationRunRepository(database);

    // The runner and recovery keep per-task state in module maps, so each test owns its task.
    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'Rework the status badges', '', workingLane.id, 0, '2026-10-25T05:00:00.000Z', '2026-10-25T05:00:00.000Z');
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, workingLane.id, 'workflow', null, '2026-10-25T05:30:00.000Z');

    hoisted.task = {
      id: taskId,
      title: 'Rework the status badges',
      description: '',
      labels: [],
      pr_url: null,
      pr_state: null,
      pr_merge_readiness: null,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: workingLane.id,
      agent: 'claude',
      workflow_id: 'workflow-1',
      workflow_project_id: null,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
      automations_disabled: 0,
    };
    nextLane = nextOnRoute(lanes, hoisted.task as never, workingLane.id)!;
    hoisted.rows = [];
    hoisted.otherTask = null;
    otherTaskId = null;
    otherActivity = 'idle';
    // The siblings the recovery reads: none, until a test lists some.
    hoisted.workflowTasks.mockReset();
    hoisted.workflowTasks.mockImplementation(() => []);
    hoisted.repos = {
      tasks: { getById: (id: string) => (hoisted.otherTask !== null && id === hoisted.otherTask.id ? hoisted.otherTask : hoisted.task), list: () => [] },
      swimlanes: { getById: (id: string) => lanes.find((lane) => lane.id === id) ?? null, list: () => lanes },
      automations: { getForTrigger: () => hoisted.rows },
      automationRuns: runs,
      taskMoves: new TaskMoveRepository(database),
      attachments: {},
    };

    // The move the step makes: the task is in the target column afterwards,
    // and a move out of the column supersedes the task's turn-end work, as
    // `handleTaskMove` does.
    hoisted.handleTaskMove.mockReset();
    hoisted.handleTaskMove.mockImplementation(async (_context: unknown, input: { taskId: string; targetSwimlaneId: string }) => {
      supersedeTurnEndWork(input.taskId, { exceptOwnGroup: true });
      hoisted.task = { ...hoisted.task, swimlane_id: input.targetSwimlaneId };
    });
    hoisted.check.mockReset();
    hoisted.check.mockImplementation(async (deps: unknown, input: CheckInput) => scriptedCheck(deps, input));
    hoisted.deliverMessageToSession.mockReset();
    hoisted.deliverMessageToSession.mockImplementation(async () => undefined);
    hoisted.retrievalCall.mockReset();
    hoisted.retrievalCall.mockImplementation(async () => (currentReply === null ? null : { text: currentReply, uuid: 'reply', ts: replyAt }));
    // A Text match row the test arms: on its marker, it moves the task as a
    // Move to column row's own move does.
    hoisted.executeTransition.mockReset();
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: { onlyIds: ReadonlySet<string>; agentReply?: string | null }) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        const started = { id: randomUUID(), automation: row, taskId: task.id };
        const match = matchFinalLine(row.final_line ?? '', options.agentReply);
        if (!match.met) {
          runs.recordSkipped(started, match.reason);
          continue;
        }
        runs.start(started);
        supersedeTurnEndWork(task.id, { exceptOwnGroup: true });
        hoisted.task = { ...hoisted.task, swimlane_id: nextLane.id };
        runs.finish(started.id, 'succeeded', `Moved to ${nextLane.name}.`);
      }
      return { results: [] };
    });

    workSerial = 41;
    activity = 'idle';
    currentReply = null;
    replyAt = Date.now();
    draft = null;
    focused = new Set();
    userTyping = false;
    openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
    keysBlocker = null;
    workflowMemoryGate.resetForTests();
    notifyDesktop = vi.fn();
    notifyPhone = vi.fn();
    activityReason = { kind: 'turn-active' };
    typed = [];
    historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-recovery-history-'));
    historyFile = path.join(historyDirectory, 'agent-session-1.jsonl');
    fs.writeFileSync(historyFile, '{}\n');
    stopWorkflowHangCheck();
    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => ({ [SESSION_ID]: activity, ...(otherTaskId !== null ? { [OTHER_SESSION_ID]: otherActivity } : {}) }),
      isLatestTurn: (sessionId: string, serial: number) => (sessionId === SESSION_ID && serial === workSerial)
        || (otherTaskId !== null && sessionId === OTHER_SESSION_ID && serial === OTHER_WORK_SERIAL),
      currentWorkSerial: (sessionId: string) => (otherTaskId !== null && sessionId === OTHER_SESSION_ID ? OTHER_WORK_SERIAL : workSerial),
      currentTurnAnchor: () => ANCHOR,
      hadLeftPlanModeBy: () => false,
      isInternalAgentEvent: () => false,
      getSession: (sessionId: string) => {
        if (sessionId === SESSION_ID) {
          return { id: SESSION_ID, taskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null };
        }
        if (otherTaskId !== null && sessionId === OTHER_SESSION_ID) {
          return { id: OTHER_SESSION_ID, taskId: otherTaskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null };
        }
        return undefined;
      },
      getPendingDraft: () => draft,
      getFocusedSessions: () => focused,
      getLastUserInputAt: () => (userTyping ? Date.now() : null),
      getOpenWork: () => openWork,
      automatedKeysBlocker: () => keysBlocker,
      listSessions: () => [{
        id: SESSION_ID, taskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null,
        agentSessionId: 'agent-session-1', cwd: historyDirectory,
      }],
      getActivityReason: () => activityReason,
      getSessionAgentName: () => 'claude',
      getSessionCliTarget: () => null,
      getReportedTranscriptPath: () => null,
      write: (_sessionId: string, data: string) => { typed.push(data); },
      // The engine's own settling of an interrupt; the tests drive the idle themselves.
      signalUserInterrupt: () => undefined,
    });
    context = {
      sessionManager,
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
      boardConfigManager: { getBoardProfiles: () => [] },
      terminalSubmitScheduler: { hasPending: () => false },
      desktopNotifier: { notifyWorkflowTask: notifyDesktop },
      mobileBridgeService: { notifyWorkflowTask: notifyPhone },
    } as unknown as IpcContext;
    registerTurnEndAutomations(context);
  });

  /** Lets every pass, attempt and immediate the events started run to its end. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 40; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function wait(milliseconds: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await settle();
  }

  /** The agent ends a turn with its own Stop: idle first, then the turn end, as the engine emits them. */
  async function endTurn(serial: number, reply: string | null): Promise<void> {
    workSerial = serial;
    activity = 'idle';
    currentReply = reply;
    replyAt = Date.now();
    sessionManager.emit('activity', SESSION_ID, 'idle');
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: Date.now() - MINUTE,
      workSerial: serial,
      transcriptAnchor: ANCHOR,
    });
    await settle();
  }

  /** A nudge landed: the agent starts a turn on it. */
  function startTurn(serial: number): void {
    workSerial = serial;
    activity = 'thinking';
    sessionManager.emit('activity', SESSION_ID, 'thinking');
  }

  const nudges = (): string[] => hoisted.deliverMessageToSession.mock.calls.map((call) => (call[1] as { message: string }).message);
  const stallNotices = (): unknown[] => notifyDesktop.mock.calls.filter((call) => (call[0] as { kind: string }).kind === 'stalled');
  const recoveryRows = () => runs.listForTask(taskId).filter((run) => (run.type as string) === 'workflow_recovery');
  /** The nudges tried for one task, a rejected delivery included. */
  const deliveriesTo = (deliveredTaskId: string): number => hoisted.deliverMessageToSession.mock.calls
    .filter((call) => (call[1] as { taskId: string }).taskId === deliveredTaskId).length;

  /**
   * A second workflow task in the same column, with its own session, idle and on
   * its own turn serial. Its rows are written for the run log, whose foreign keys
   * need the task. Returns its id.
   */
  function addOtherWorkflowTask(): string {
    const id = `${taskId}-other`;
    otherTaskId = id;
    const database = hoisted.database as DatabaseType.Database;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'Add the export button', '', workingLane.id, 1, '2026-10-25T05:00:00.000Z', '2026-10-25T05:00:00.000Z');
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, null, workingLane.id, 'workflow', null, '2026-10-25T05:30:00.000Z');
    hoisted.otherTask = { ...hoisted.task, id, title: 'Add the export button', session_id: OTHER_SESSION_ID };
    return id;
  }

  /** A check that ends because the task moved on: the step gives no verdict, so the pass arms nothing. */
  const NO_VERDICT_CHECK = { ok: false, reason: 'The condition check was stopped because the task moved on.', cause: 'stopped', callId: null };

  /**
   * Holds the next step check open, so a turn-end pass stays running while time
   * passes. Releasing it answers the check with `answer`, or the scripted
   * answer for the reply when none is given.
   */
  function holdNextCheck(answer?: unknown): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    hoisted.check.mockImplementationOnce(async (deps: unknown, input: CheckInput) => {
      await gate;
      return answer === undefined ? scriptedCheck(deps, input) : answer;
    });
    return { release };
  }

  it('replays the incident: one nudge at five minutes, and the next turn moves the task with nobody there', async () => {
    await endTurn(41, STALLED_REPLY);

    // Judged stopped before done: no notice, and the idle sweep is held off.
    expect(hoisted.task.swimlane_id).toBe(workingLane.id);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    expect(nudges()).toHaveLength(0);
    expect(notifyDesktop).not.toHaveBeenCalled();

    await wait(RECOVERY_DELAYS_MS[0] - 1_000);
    expect(nudges()).toHaveLength(0);
    await wait(1_000);

    // One line, typed into its terminal: the step, why, and what to do.
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain(`The ${workingLane.name} step is not done yet`);
    expect(nudges()[0]).toContain('Carry on from where you stopped.');
    // It answers a "shall I go on?" rather than inviting one.
    expect(nudges()[0]).toContain('Go ahead with this step\'s own work without asking first.');
    // The one way to stop: the agent's own line, for the three things only the owner can settle.
    expect(nudges()[0]).toContain('end your reply with the line "Needs owner: <the question>". Otherwise act on it.');
    expect(nudges()[0]).not.toContain('\n');
    expect(recoveryRows()).toEqual([expect.objectContaining({ status: 'succeeded', detail: 'Recovery 1 of 4: asked the agent to carry on.' })]);

    // The service is back: the agent commits, runs its gate and ends on its marker.
    startTurn(42);
    await endTurn(42, FINISHED_REPLY);

    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    expect(nudges()).toHaveLength(1);
    expect(notifyDesktop).not.toHaveBeenCalled();
    expect(notifyPhone).not.toHaveBeenCalled();
  });

  it('replays the incident where the column\'s own Text match row moves the task on', async () => {
    hoisted.rows = [{
      id: 'row-on-to-review',
      swimlane_id: workingLane.id,
      name: 'On to the next column',
      type: 'move_to_column',
      trigger: 'turn_end',
      position: 0,
      enabled: true,
      config: { targetColumn: nextLane.name },
      condition: null,
      final_line: MARKER,
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } satisfies ColumnAutomation];

    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);

    startTurn(42);
    await endTurn(42, FINISHED_REPLY);

    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    // The row moved it, so the step check had nothing left to do.
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('logs a step check that fails, retries it, and a finished turn still moves the task', async () => {
    serviceDown = true;
    await endTurn(41, FINISHED_REPLY);

    // Red before: a check that could not run wrote nothing and armed nothing.
    const failed = runs.listForTask(taskId).find((run) => (run.type as string) === 'workflow_step');
    expect(failed).toEqual(expect.objectContaining({ status: 'failed', condition_met: null }));
    expect(failed?.detail).toContain('The step check could not run');
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    expect(hoisted.task.swimlane_id).toBe(workingLane.id);

    // The check works again by the first attempt, which judges the same reply.
    serviceDown = false;
    await wait(RECOVERY_DELAYS_MS[0]);

    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    expect(nudges()).toHaveLength(0);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
  });

  it('in an outage, sends one notice on time and moves the task once the service is back, with nobody there', async () => {
    serviceDown = true;
    await endTurn(41, STALLED_REPLY);

    // The whole schedule passes with every check failing: nothing is nudged,
    // and nothing is spent toward the nudges.
    const schedule = RECOVERY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    await wait(schedule);
    expect(nudges()).toHaveLength(0);
    expect(stallNotices()).toHaveLength(1);
    expect(notifyPhone).toHaveBeenCalledTimes(1);
    expect(stallNotices()[0]).toEqual([expect.objectContaining({ projectId: PROJECT_ID, taskId, kind: 'stalled' })]);
    // Still recovering: the hourly re-check keeps the session alive for when the service returns.
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    // Two more hours of outage: no second notice.
    await wait(2 * OUTAGE_RETRY_MS);
    expect(stallNotices()).toHaveLength(1);

    // The service comes back at night. The next hourly re-check nudges, and the
    // nudged turn finishes the step.
    serviceDown = false;
    await wait(OUTAGE_RETRY_MS);
    expect(nudges()).toHaveLength(1);
    startTurn(42);
    await endTurn(42, FINISHED_REPLY);

    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    expect(stallNotices()).toHaveLength(1);
  });

  it('gives a nudged turn that fails its next attempt, and the failed nudge does not count', async () => {
    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);

    // The nudged turn fails (an API error): no turn end, back to idle.
    startTurn(42);
    sessionManager.emit('event', SESSION_ID, { type: 'turn_failed', timestamp: Date.now() });
    activity = 'idle';
    currentReply = null;
    sessionManager.emit('activity', SESSION_ID, 'idle');
    await settle();

    expect(recoveryRows()[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    await wait(RECOVERY_DELAYS_MS[1]);
    expect(nudges()).toHaveLength(2);
  });

  /** The gate the agent left running in the background, open in its hook events. */
  function leaveGateRunning(): void {
    openWork = { ...openWork, backgroundShells: [{ id: 'gate-shell', command: 'npm run verify', since: Date.now() }] };
  }

  it('leaves an agent waiting on its own background job alone for an hour, then nudges it to check on it', async () => {
    leaveGateRunning();
    await endTurn(41, BACKGROUND_REPLY);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    // Read from the open shell, with no second check about the wording.
    expect(hoisted.check).toHaveBeenCalledTimes(1);

    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(0);

    await wait(WORKING_WAIT_MS - RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('Check on the work you left running');
  });

  // Red before: "still working" came from the reply's wording, so the same
  // words with nothing left running waited an hour on a gate that was gone.
  it('nudges an agent whose reply says it waits on a gate that is not running, on the first step', async () => {
    await endTurn(41, BACKGROUND_REPLY);

    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('Carry on from where you stopped.');
  });

  it('judges the turn the background job woke the agent for, and does not nudge', async () => {
    leaveGateRunning();
    await endTurn(41, BACKGROUND_REPLY);
    await wait(20 * MINUTE);

    // The gate finished and woke the agent, which ended on its marker.
    openWork = { ...openWork, backgroundShells: [] };
    startTurn(42);
    await endTurn(42, FINISHED_REPLY);

    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    await wait(WORKING_WAIT_MS);
    expect(nudges()).toHaveLength(0);
  });

  it('sends the notice at once for the agent\'s own Needs owner line, nudges nothing, and lets the idle sweep apply', async () => {
    await endTurn(41, QUESTION_REPLY);

    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting', sessionId: SESSION_ID, reason: OWNER_QUESTION }));
    expect(notifyPhone).toHaveBeenCalledWith(expect.objectContaining({ detail: `Waiting on you: ${OWNER_QUESTION}` }));
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    // Read in code: no check is paid for the line.
    expect(hoisted.check).not.toHaveBeenCalled();

    await wait(3 * 60 * MINUTE);
    expect(nudges()).toHaveLength(0);
  });

  // The owner's rule: whether a stall needs the owner is the agent's own call.
  // A question with no Needs owner line is a stall like any other, and its
  // nudge tells the agent how to say so if only the owner can settle it.
  it('nudges a question that does not end on the Needs owner line, and tells nobody', async () => {
    await endTurn(41, 'Two layouts would work here. Which one do you want: the side panel or the drawer?');

    expect(notifyDesktop).not.toHaveBeenCalled();
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('"Needs owner: <the question>"');

    // The agent names it the one way that stops the workflow: the notice goes out then.
    startTurn(42);
    await endTurn(42, QUESTION_REPLY);
    expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting', reason: OWNER_QUESTION }));
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
  });

  it('answers a gate the memory reaper stopped: memory is back, run it again, one run at a time', async () => {
    await endTurn(41, REAPED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('The machine has memory to spare again');
    expect(nudges()[0]).toContain('one run at a time');
    // Never the general "carry on" when the blocker is known.
    expect(nudges()[0]).not.toContain('Carry on from where you stopped.');
  });

  // The claim is the agent's own, so the nudge has it checked: a wrong claim
  // told "not this step's to fix" would leave a regression the step made.
  it('tells an agent whose failures it says also happen on main to check that, record those, and fix the rest', async () => {
    hoisted.task = { ...hoisted.task, resolved_base_branch: 'main' };
    await endTurn(41, 'Three tests fail, and two of them fail on main too on a clean checkout. The gate is not green.');
    await wait(RECOVERY_DELAYS_MS[0]);

    expect(nudges()[0]).toContain('Run the failing tests on a separate clean checkout of main to check, leaving this branch as it is.');
    expect(nudges()[0]).toContain('Record the ones that fail there too, and that main fails them: those are not this step\'s to fix.');
    expect(nudges()[0]).toContain('Fix any that pass on main, then carry on.');
  });

  it('holds a nudge while memory reads low, spends nothing, and sends it once memory recovers', async () => {
    // The sampler's minute tick, as the app feeds the gate.
    let remainingBytes = LOW_COMMIT_BYTES;
    let sampling = true;
    const tick = (): void => {
      if (!sampling) return;
      workflowMemoryGate.onSample(windowsSample(remainingBytes));
      setTimeout(tick, MINUTE);
    };
    tick();
    try {
      await endTurn(41, REAPED_REPLY);
      await wait(RECOVERY_DELAYS_MS[0] + 30 * MINUTE);

      // Nothing typed into low memory, and one row says why.
      expect(nudges()).toHaveLength(0);
      expect(recoveryRows().filter((run) => run.detail?.includes('held while memory is low'))).toHaveLength(1);

      // Memory recovers: the held nudge goes on the next look, as the first of four.
      remainingBytes = RECOVERED_COMMIT_BYTES;
      await wait(HOLD_RECHECK_MS + MINUTE);
      expect(nudges()).toHaveLength(1);
      expect(nudges()[0]).toContain('(8.0 GB free)');
      expect(recoveryRows().some((run) => run.detail === 'Recovery 1 of 4: asked the agent to carry on.')).toBe(true);
    } finally {
      sampling = false;
    }
  });

  // The one question in a real board's workflow history asked to go on with
  // the step's own work, and the person answered by moving the card on.
  it('nudges an agent that only asks whether to go on with its own work, and tells nobody', async () => {
    await endTurn(41, 'The review fixes are in, but nothing is committed yet. Should I commit and run the gate now?');

    expect(notifyDesktop).not.toHaveBeenCalled();
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('without asking first');
  });

  it('sends exactly one notice when four nudged turns run and still do not finish, then lets the idle sweep apply', async () => {
    await endTurn(41, STALLED_REPLY);
    for (let attempt = 0; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
      await wait(RECOVERY_DELAYS_MS[attempt]);
      expect(nudges()).toHaveLength(attempt + 1);
      startTurn(42 + attempt);
      await endTurn(42 + attempt, STALLED_REPLY);
    }

    expect(stallNotices()).toHaveLength(1);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    // Nothing more: no fifth nudge, no second notice.
    await wait(5 * OUTAGE_RETRY_MS);
    expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length);
    expect(stallNotices()).toHaveLength(1);
    // The latch is in the run log, so a restart sends it no second time.
    resetWorkflowRecoveryForTests();
    replyAt = Date.now() - MINUTE;
    await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial });
    await settle();
    await wait(2 * OUTAGE_RETRY_MS);
    expect(stallNotices()).toHaveLength(1);
    expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length);
  });

  // Red before: once a task had stalled, recovery read its run log as spent
  // for the rest of the visit, so a second stop on the same task was silent.
  it('starts over after a stall when a turn it did not start stops again: new nudges, and one notice for the new stall', async () => {
    await endTurn(41, STALLED_REPLY);
    for (let attempt = 0; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
      await wait(RECOVERY_DELAYS_MS[attempt]);
      startTurn(42 + attempt);
      await endTurn(42 + attempt, STALLED_REPLY);
    }
    expect(stallNotices()).toHaveLength(1);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);

    // Morning: the user types "continue" and leaves. The agent stops again.
    await wait(6 * OUTAGE_RETRY_MS);
    startTurn(60);
    await endTurn(60, STALLED_REPLY);

    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_recovery_start')).toBe(true);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length + 1);

    // That one runs out too: its own notice, once.
    startTurn(61);
    await endTurn(61, STALLED_REPLY);
    for (let attempt = 1; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
      await wait(RECOVERY_DELAYS_MS[attempt]);
      startTurn(62 + attempt);
      await endTurn(62 + attempt, STALLED_REPLY);
    }
    expect(nudges()).toHaveLength(2 * RECOVERY_DELAYS_MS.length);
    expect(stallNotices()).toHaveLength(2);
  });

  it('carries its recovery on through the turns its own nudges start, so they never start it over', async () => {
    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);
    startTurn(42);
    await endTurn(42, STALLED_REPLY);

    expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_recovery_start')).toBe(false);
    // The second attempt comes on the schedule's second step, not the first.
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    await wait(RECOVERY_DELAYS_MS[1] - RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(2);
  });

  it('holds a nudge off while the user is typing into the terminal, without holding off the schedule', async () => {
    userTyping = true;
    await endTurn(41, STALLED_REPLY);

    // Typing the whole night: every attempt is held through to the next one's
    // turn, the last through an hour, and the notice still goes out.
    const schedule = RECOVERY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    await wait(schedule + OUTAGE_RETRY_MS + 2 * MINUTE);
    expect(nudges()).toHaveLength(0);
    expect(stallNotices()).toHaveLength(1);
    expect(recoveryRows().some((run) => run.detail?.includes('held off, you typed into it in the last few minutes'))).toBe(true);
    // A held attempt reuses its verdict: the step was judged at the turn end only.
    expect(hoisted.check).toHaveBeenCalledTimes(2);

    // The user leaves: the next look nudges.
    userTyping = false;
    await wait(OUTAGE_RETRY_MS);
    expect(nudges()).toHaveLength(1);
  });

  // Red before: a terminal left on screen held one task an hour overnight with
  // nobody at the keys.
  it('does not take a terminal left on screen for the user', async () => {
    focused = new Set([SESSION_ID]);
    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
  });

  it('holds a nudge while the session cannot take keys, and tells the owner of a call left open on an idle agent', async () => {
    // The lost prompt: the engine reads idle, and a tool call has no end.
    openWork = { ...openWork, toolCalls: [{ id: 'artifact-call', tool: 'Artifact', since: Date.now() }] };
    keysBlocker = 'the Artifact tool call has not ended';
    await endTurn(41, STALLED_REPLY);

    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(0);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    // Still open past ten minutes (`OPEN_CALL_NOTICE_MS`): most likely a
    // prompt nobody answered. The owner is told, and nothing was ever typed
    // into it.
    await wait(6 * MINUTE);
    expect(nudges()).toHaveLength(0);
    expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'waiting',
      reason: 'it may be waiting on a permission prompt for Artifact, which nothing has answered.',
    }));
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
  });

  it('records keys that reached a permission prompt as their own outcome, and does not count them', async () => {
    const { KeysReachedPermissionPromptError } = await import('../../src/main/pty/automated-keys-guard');
    hoisted.deliverMessageToSession.mockRejectedValueOnce(new KeysReachedPermissionPromptError());
    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0]);

    expect(recoveryRows()).toEqual([expect.objectContaining({
      status: 'failed',
      detail: 'Recovery 1 of 4: the nudge\'s keys reached a permission prompt, so they may have answered it. It does not count.',
    })]);
    // The next look comes a minute on, still as the first of four.
    await wait(HOLD_RECHECK_MS + 1_000);
    expect(nudges()).toHaveLength(2);
    expect(recoveryRows().some((run) => run.detail === 'Recovery 1 of 4: asked the agent to carry on.')).toBe(true);
  });

  it('does not nudge while the user has text typed into the prompt', async () => {
    draft = 'half a thought';
    await endTurn(41, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[0] + RECOVERY_DELAYS_MS[1] - MINUTE);
    expect(nudges()).toHaveLength(0);

    draft = null;
    await wait(2 * MINUTE);
    expect(nudges()).toHaveLength(1);
  });

  it('does not nudge an agent at a permission prompt', async () => {
    await endTurn(41, STALLED_REPLY);
    activity = 'permission';
    await wait(RECOVERY_DELAYS_MS[0]);

    expect(nudges()).toHaveLength(0);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
  });

  it('cancels a pending recovery when the workflow is paused', async () => {
    await endTurn(41, STALLED_REPLY);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    cancelWorkflowRecovery('workflow-1');
    hoisted.workflowState = 'paused';
    await wait(3 * 60 * MINUTE);

    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    expect(nudges()).toHaveLength(0);
    expect(notifyDesktop).not.toHaveBeenCalled();
  });

  it('after a person resumes a parked task, judges it again within one step of its schedule', async () => {
    await endTurn(41, STALLED_REPLY);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    // Recovery's memory goes, the run log stays. A person resumes the
    // session, whose reply the step check already judged.
    resetWorkflowRecoveryForTests();
    replyAt = Date.now() - MINUTE;
    await wait(10 * MINUTE);
    await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial, resumedBy: 'user' });
    await settle();

    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    await wait(RECOVERY_DELAYS_MS[0]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).not.toContain('Kangentic restarted');
  });

  // Red before: recovery kept each task's pre-quit "work left running" verdict
  // and waited an hour on a gate that died with the quit.
  it('after Kangentic restarts the agent, drops the old working verdict and nudges at once, saying its background commands stopped', async () => {
    leaveGateRunning();
    await endTurn(41, BACKGROUND_REPLY);
    expect(nudges()).toHaveLength(0);

    // The app quits and relaunches: the gate died with the old process, and
    // the resumed session has nothing open.
    resetWorkflowRecoveryForTests();
    openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
    replyAt = Date.now() - MINUTE;
    await wait(30 * MINUTE);
    await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial, resumedBy: 'recovery' });
    await settle();
    await wait(1_000);

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('Kangentic restarted, so the background commands you started before it (such as a gate run) were stopped. Start them again.');
    // A fresh recovery, from its first step, with a row that says why.
    expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_recovery_start'
      && run.detail?.includes('Kangentic started this agent again after a restart'))).toBe(true);
    expect(recoveryRows().some((run) => run.detail === 'Recovery 1 of 4: asked the agent to carry on.')).toBe(true);

    // Said once: the next nudge does not repeat it.
    startTurn(42);
    await endTurn(42, STALLED_REPLY);
    await wait(RECOVERY_DELAYS_MS[1]);
    expect(nudges()).toHaveLength(2);
    expect(nudges()[1]).not.toContain('Kangentic restarted');
  });

  // Red before (seen live): the resumed session's first idle armed the
  // schedule's first step, the memory resume's catch-up kept that timer, and
  // the nudge came five minutes after the agent was back.
  it('after a memory resume, nudges at once even when the resumed session\'s first idle armed the schedule first', async () => {
    await endTurn(41, STALLED_REPLY);
    noteWorkflowTaskPaused(context, taskId);
    replyAt = Date.now() - MINUTE;
    await wait(10 * MINUTE);

    // The resumed session commits idle before its catch-up has read the reply.
    sessionManager.emit('activity', SESSION_ID, 'idle');
    await settle();
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial, resumedBy: 'memory' });
    await settle();
    await wait(1_000);

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).not.toContain('Kangentic restarted');
  });

  it('stops recovery quietly when low memory pauses a task under recovery: its agent comes back by itself', async () => {
    await endTurn(41, STALLED_REPLY);

    noteWorkflowTaskPaused(context, taskId);

    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    // No notice: a running workflow's task resumes on its own once memory recovers.
    expect(stallNotices()).toHaveLength(0);
    // A boundary, so the agent that comes back starts its recovery from the first step.
    expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_recovery_start'
      && run.detail?.includes('Paused to free memory'))).toBe(true);
    await wait(2 * 60 * MINUTE);
    expect(nudges()).toHaveLength(0);
  });

  // A turn that never ends keeps the session busy at every attempt. Recovery
  // looks again each step, but only until its day is up.
  it('stops looking at a session that stays busy past the 24-hour limit', async () => {
    await endTurn(41, STALLED_REPLY);
    startTurn(42);

    await wait(23 * 60 * MINUTE);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    await wait(2 * 60 * MINUTE);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    expect(nudges()).toHaveLength(0);
  });

  it('cancels recovery when the task moves on by any other hand', async () => {
    await endTurn(41, STALLED_REPLY);

    supersedeTurnEndWork(taskId);
    await wait(3 * 60 * MINUTE);

    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    expect(nudges()).toHaveLength(0);
  });

  // Red before: the attempt cleared the working wait before it held, so the
  // hold's re-check read a wait that was new and armed another hour.
  it('holds a working wait that ran out for a minute while the user is there, not for another hour', async () => {
    userTyping = true;
    leaveGateRunning();
    await endTurn(41, BACKGROUND_REPLY);

    // The hour runs out with the user in the terminal: the nudge is held.
    await wait(WORKING_WAIT_MS + 1_000);
    expect(nudges()).toHaveLength(0);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);

    // The user leaves. The next look is a minute on, and it nudges.
    userTyping = false;
    await wait(HOLD_RECHECK_MS + 1_000);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('Check on the work you left running');
  });

  // Red before: the attempt ended the working wait before any of its holds, not
  // only the presence check's. A hold after that (the keys guard, the memory
  // gate) left the next try reading a wait that was new, and armed another hour.
  describe('a working wait that ran out, held by something after the presence check', () => {
    const holds = [
      {
        name: 'memory reads low',
        hold: (): void => workflowMemoryGate.onSample(windowsSample(LOW_COMMIT_BYTES)),
        clear: (): void => workflowMemoryGate.onSample(windowsSample(RECOVERED_COMMIT_BYTES)),
      },
      {
        name: 'the gate is busy with another task\'s nudge',
        hold: (): void => { expect(workflowMemoryGate.tryAcquire('task:another').go).toBe(true); },
        clear: (): void => workflowMemoryGate.release('task:another'),
      },
      {
        name: 'the session cannot take keys',
        hold: (): void => { keysBlocker = 'the Artifact tool call has not ended'; },
        clear: (): void => { keysBlocker = null; },
      },
    ];

    it.each(holds)('nudges within two minutes of the hold clearing, not an hour later, when $name', async ({ hold, clear }) => {
      leaveGateRunning();
      await endTurn(41, BACKGROUND_REPLY);
      const presenceChecks = vi.spyOn(sessionManager, 'getPendingDraft');

      // The hold is in place a second before the hour is up, so it is there when the wait runs out.
      await wait(WORKING_WAIT_MS - 1_000);
      hold();
      presenceChecks.mockClear();
      await wait(2_000);

      // The attempt came, got past the presence check, and was held after it.
      expect(presenceChecks).toHaveBeenCalled();
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      clear();
      await wait(2 * HOLD_RECHECK_MS);
      expect(nudges()).toHaveLength(1);
      expect(nudges()[0]).toContain('Check on the work you left running');
    });
  });

  // The user is taken to be there for five minutes after their last input
  // (`PRESENCE_WINDOW_MS`). The ages are written out, one minute either side.
  describe('the window in which the user\'s last input holds a nudge', () => {
    /** The user last typed this long before the first attempt comes due. */
    function userLastTypedBeforeTheFirstAttempt(milliseconds: number): ReturnType<typeof vi.fn> {
      const typedAt = Date.now() + RECOVERY_DELAYS_MS[0] - milliseconds;
      const lastInput = vi.fn(() => typedAt);
      sessionManager.getLastUserInputAt = lastInput;
      return lastInput;
    }

    it('does not hold a nudge for input six minutes old', async () => {
      const lastInput = userLastTypedBeforeTheFirstAttempt(6 * MINUTE);
      await endTurn(41, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0] + 1_000);

      expect(lastInput).toHaveBeenCalled();
      expect(nudges()).toHaveLength(1);
    });

    it('holds a nudge for input four minutes old, and sends it once the input has aged past the window', async () => {
      const lastInput = userLastTypedBeforeTheFirstAttempt(4 * MINUTE);
      await endTurn(41, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0] + 1_000);
      expect(lastInput).toHaveBeenCalled();
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      // The input is old enough two looks on, and nothing else holds the nudge.
      await wait(3 * HOLD_RECHECK_MS);
      expect(nudges()).toHaveLength(1);
    });
  });

  // The siblings a nudge names (`landedSiblings`): tasks of the same workflow
  // whose PR merged into this task's base branch since this step began.
  describe('the siblings a nudge names as merged', () => {
    /** Before this task entered its column (its first move into it is at 05:30), and after. */
    const ARCHIVED_BEFORE_THE_VISIT = '2026-10-25T05:00:00.000Z';
    const ARCHIVED_DURING_THE_VISIT = '2026-10-25T06:00:00.000Z';

    /** A task of the same workflow, as the board lists it: merged into main and archived during the visit unless a field says otherwise. */
    function sibling(fields: Record<string, unknown>): { projectId: string; task: Record<string, unknown> } {
      return {
        projectId: PROJECT_ID,
        task: {
          id: `sibling-${String(fields.display_id)}`,
          title: 'A sibling',
          pr_state: 'merged',
          archived_at: ARCHIVED_DURING_THE_VISIT,
          resolved_base_branch: 'main',
          base_branch: 'main',
          ...fields,
        },
      };
    }

    beforeEach(() => {
      hoisted.task = { ...hoisted.task, resolved_base_branch: 'main', base_branch: 'main' };
    });

    it('names only a sibling that merged into this task\'s base branch since the visit began', async () => {
      hoisted.workflowTasks.mockImplementation(() => [
        sibling({ display_id: 11, title: 'Pipeline stages' }),
        // The base is the resolved one, else the configured one.
        sibling({ display_id: 12, title: 'Export button', resolved_base_branch: null }),
        sibling({ display_id: 13, title: 'Develop work', resolved_base_branch: 'develop' }),
        sibling({ display_id: 14, title: 'Archived early', archived_at: ARCHIVED_BEFORE_THE_VISIT }),
        sibling({ display_id: 15, title: 'Still open', pr_state: 'open' }),
        sibling({ display_id: 16, title: 'No PR', pr_state: null }),
        sibling({ display_id: 17, title: 'On the board', archived_at: null }),
        // This task itself, listed with its workflow's other tasks.
        sibling({ display_id: 18, title: 'Rework the status badges', id: taskId }),
      ]);
      await endTurn(41, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0]);

      expect(nudges()).toHaveLength(1);
      expect(nudges()[0].match(/Task #\d+/g)).toEqual(['Task #11', 'Task #12']);
      expect(nudges()[0]).toContain('Task #11 (Pipeline stages) merged into main since this step began.');
      expect(nudges()[0]).toContain('Task #12 (Export button) merged into main since this step began.');
      // A fact, not an order: the general instruction still goes with it.
      expect(nudges()[0]).toContain('Carry on from where you stopped.');
    });

    it('reads the siblings from the project the workflow lives in', async () => {
      hoisted.task = { ...hoisted.task, workflow_project_id: 'home-project' };
      await endTurn(41, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0]);

      expect(hoisted.workflowTasks).toHaveBeenCalledWith(context, 'home-project', 'workflow-1');
    });

    it('names a sibling once, and names a sibling that merged since at the next nudge', async () => {
      const landedFirst = sibling({ display_id: 11, title: 'Pipeline stages' });
      const landedLater = sibling({ display_id: 12, title: 'Export button', archived_at: '2026-10-25T06:30:00.000Z' });
      let listed = [landedFirst];
      hoisted.workflowTasks.mockImplementation(() => listed);
      await endTurn(41, STALLED_REPLY);

      // The first nudge, at 06:23, names the sibling that merged at 06:00.
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()[0].match(/Task #\d+/g)).toEqual(['Task #11']);

      // Another lands at 06:30, and the second nudge, at 06:38, names only that one.
      listed = [landedFirst, landedLater];
      startTurn(42);
      await endTurn(42, STALLED_REPLY);
      await wait(RECOVERY_DELAYS_MS[1]);
      expect(nudges()).toHaveLength(2);
      expect(nudges()[1].match(/Task #\d+/g)).toEqual(['Task #12']);
    });

    it('names none when the board cannot be read, and the nudge still goes', async () => {
      hoisted.workflowTasks.mockImplementation(() => { throw new Error('the board could not be read'); });
      await endTurn(41, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0]);

      expect(nudges()).toHaveLength(1);
      expect(nudges()[0]).not.toContain('merged into');
      expect(nudges()[0]).toContain('Carry on from where you stopped.');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('workflow siblings'), expect.any(Error));
    });
  });

  // Two workflow tasks stall together and their nudges take turns in the
  // memory gate: the second is typed only after the first one's turn is under
  // way, and a minute after the first went (`PACE_MS`).
  //
  // The second stalls 30 seconds after the first, so the first is nudged at 300
  // seconds and the second is due at 330. Stalled together, the second's re-check
  // would fall exactly one pace after the first's release (`HOLD_RECHECK_MS` and
  // `PACE_MS` are both a minute), and the pace would never be what held it.
  describe('two stalled tasks, one nudge at a time', () => {
    /** The first task stalls now, the second 30 seconds on. Returns the second's id. */
    async function stallTwoTasksThirtySecondsApart(): Promise<string> {
      const otherId = addOtherWorkflowTask();
      await endTurn(41, STALLED_REPLY);
      await wait(30_000);
      sessionManager.emit('activity', OTHER_SESSION_ID, 'idle');
      await settle();
      expect(isUnderWorkflowRecovery(otherId)).toBe(true);
      return otherId;
    }

    /** Runs to one second past the first task's nudge, at 301 seconds. */
    async function runPastTheFirstNudge(): Promise<void> {
      await wait(RECOVERY_DELAYS_MS[0] - 30_000 + 1_000);
      expect(deliveriesTo(taskId)).toBe(1);
    }

    it('types the second task\'s nudge only once the first one\'s turn is under way and a minute has passed', async () => {
      const otherId = await stallTwoTasksThirtySecondsApart();
      await runPastTheFirstNudge();

      // The first agent starts its turn, through the activity path the turn-end runner listens on.
      sessionManager.emit('activity', SESSION_ID, 'thinking');
      await settle();

      // The second is due at 330 seconds. Nothing is in flight, but the first went only 30 seconds ago.
      await wait(30_000);
      expect(deliveriesTo(otherId)).toBe(0);

      // Its next look, at 390 seconds, finds the pace passed. A held look spent nothing.
      await wait(60_000);
      expect(deliveriesTo(otherId)).toBe(1);
      expect(deliveriesTo(taskId)).toBe(1);
      expect(runs.listForTask(otherId).filter((run) => (run.type as string) === 'workflow_recovery').map((run) => run.detail))
        .toEqual(['Recovery 1 of 4: asked the agent to carry on.']);
    });

    it('keeps the second task\'s nudge behind a first whose turn never starts, until the gate stops waiting for it', async () => {
      const otherId = await stallTwoTasksThirtySecondsApart();
      await runPastTheFirstNudge();

      // Looks at 330, 390 and 450 seconds: the first went at 300 and has not started its turn.
      await wait(150_000);
      expect(deliveriesTo(otherId)).toBe(0);

      // The look at 510 seconds is past the three minutes the gate waits for a turn to start (`TURN_WAIT_MS`).
      await wait(60_000);
      expect(deliveriesTo(otherId)).toBe(1);
    });

    it('does not hold the second task\'s nudge behind a first whose delivery failed', async () => {
      const otherId = await stallTwoTasksThirtySecondsApart();
      hoisted.deliverMessageToSession.mockRejectedValueOnce(new Error('the terminal was closed'));
      await runPastTheFirstNudge();
      expect(recoveryRows()).toEqual([
        expect.objectContaining({ status: 'failed', detail: 'Recovery 1 of 4: the nudge was not delivered: the terminal was closed' }),
      ]);

      // Nothing was typed, so the gate moved on at once: the second goes when it is due, at 330 seconds.
      await wait(30_000);
      expect(deliveriesTo(otherId)).toBe(1);
    });
  });

  describe('the nudge, typed into the agent\'s terminal', () => {
    // Red before: an Esc, a Ctrl+C or a paste marker in the reason (the
    // Automation agent's words about a reply that can quote anything), or in a
    // column's name, was typed into the agent as a keystroke.
    const plainInput = {
      columnName: 'Executing',
      reason: null,
      leftRunning: false,
      blockers: [],
      restarted: false,
      memory: { low: false, freeBytes: null },
      landedSiblings: [],
      baseBranch: 'main',
    };

    it('is one line with no control character, from the reason and the column name alike', () => {
      const message = nudgeMessage({
        ...plainInput,
        columnName: 'Code\x1b Review',
        reason: 'It printed \x1b[201~ then \x03 and stopped\x7f\nbefore the \u009bgate.',
      });

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message.startsWith(
        'The Code Review step is not done yet: It printed [201~ then and stopped before the gate. Carry on from where you stopped.',
      )).toBe(true);
    });

    // Red before: a reason cut at 200 characters lost its "..." to the period
    // the sentence added, and read "free memor." to the agent.
    it('keeps a cut reason\'s ellipsis rather than ending it mid-word with a period', () => {
      const message = nudgeMessage({ ...plainInput, reason: 'The gate was stopped to free memory and the agent says it will not...' });
      expect(message).toContain('not done yet: The gate was stopped to free memory and the agent says it will not... Carry on');
    });

    it('names each fact it knows and drops the general carry-on', () => {
      const message = nudgeMessage({
        ...plainInput,
        restarted: true,
        blockers: ['resource', 'main-fails-too'],
        memory: { low: false, freeBytes: 12 * GIBIBYTE },
        landedSiblings: [{ number: 69, title: 'Pipeline \x1b stages' }],
        baseBranch: 'develop',
      });

      expect(message).toMatch(/^The Executing step is not done yet\. Kangentic restarted/);
      expect(message).toContain('The machine has memory to spare again (12.0 GB free).');
      expect(message).toContain('Run the failing tests on a separate clean checkout of develop to check, leaving this branch as it is.');
      // A fact, not an order: the sibling's merge may have nothing to do with this step.
      expect(message).toContain('Task #69 (Pipeline stages) merged into develop since this step began.');
      expect(message).not.toContain('Merge develop into your branch');
      expect(message).not.toContain('Carry on from where you stopped.');
      expect(message).toContain('Go ahead with this step\'s own work without asking first.');
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    // Red before: the sibling line once was an order, so it stood in for the
    // general one. As a fact, a nudge with only a sibling to name lost both
    // the check's reason and "Carry on", and told the agent nothing to do.
    it('keeps the reason and the general carry-on when a sibling\'s merge is the only fact it knows', () => {
      const message = nudgeMessage({
        ...plainInput,
        reason: 'The tests were not run yet...',
        landedSiblings: [{ number: 69, title: 'Pipeline stages' }],
        baseBranch: 'develop',
      });

      expect(message).toContain('The Executing step is not done yet: The tests were not run yet...');
      expect(message).toContain('Task #69 (Pipeline stages) merged into develop since this step began. Carry on from where you stopped.');
    });

    it('gives no free-memory figure where the platform reports a level, not bytes', () => {
      const message = nudgeMessage({ ...plainInput, blockers: ['resource'], memory: { low: false, freeBytes: null } });
      expect(message).toContain('The machine has memory to spare again. Run what was stopped');
    });
  });

  describe('an agent that goes idle with no turn end', () => {
    // Red before: only a turn end armed recovery, so a turn that ended with no
    // Stop (a failed turn, an interrupt) sat parked for good.
    it('is recovered on the schedule: the first nudge at the first step', async () => {
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();

      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      await wait(RECOVERY_DELAYS_MS[0] - 1_000);
      expect(nudges()).toHaveLength(0);
      await wait(1_000);

      expect(nudges()).toHaveLength(1);
      expect(nudges()[0]).toContain(`The ${workingLane.name} step is not done yet`);
    });

    it('is left alone when its last turn end asked the user something', async () => {
      await endTurn(41, QUESTION_REPLY);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      const checksAtTheQuestion = hoisted.check.mock.calls.length;

      // Minutes later it goes idle again, still waiting on the answer.
      await wait(3 * MINUTE);
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(3 * 60 * MINUTE);
      expect(nudges()).toHaveLength(0);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(hoisted.check).toHaveBeenCalledTimes(checksAtTheQuestion);
    });

    // Red before (#925): a card a person dragged into this column, then resumed,
    // had its last column's reply judged as this column's step. One that read
    // done moved the card past work it never did.
    it('nudges, and judges nothing, when its last reply was written before it moved into this column', async () => {
      // The reply, done by its marker, was written in the last column...
      currentReply = FINISHED_REPLY;
      replyAt = Date.now() - 10 * MINUTE;
      // ...and a person then dragged the card into this one.
      const otherLane = lanes.find((lane) => lane.role === null && lane.id !== workingLane.id)!;
      (hoisted.database as DatabaseType.Database)
        .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), taskId, otherLane.id, workingLane.id, 'renderer', null, new Date(Date.now() - MINUTE).toISOString());

      // Resumed there: it comes back idle, with no turn end.
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();
      await wait(RECOVERY_DELAYS_MS[0]);

      expect(hoisted.check).not.toHaveBeenCalled();
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(nudges()).toHaveLength(1);
      expect(nudges()[0]).toContain(`The ${workingLane.name} step is not done yet: your last reply was written before this task moved to ${workingLane.name}.`);
    });

    // #916. The agent moved its own task, and the move keeps its session until
    // the turn that made it ends. That idle lands while the task already sits in
    // the new column with the old session, which the move is about to end.
    it('is left alone when the idle ends the turn that moved its own task', async () => {
      const release = markOwnCallSession(SESSION_ID);
      try {
        sessionManager.emit('activity', SESSION_ID, 'idle');
        await settle();
      } finally {
        release();
      }

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(3 * 60 * MINUTE);
      expect(nudges()).toHaveLength(0);
    });

    // A column that is not a working column has no step for recovery to finish.
    it.each(['todo', 'done'] as const)('is left alone in a %s column', async (role) => {
      const restingLane = lanes.find((lane) => lane.role === role);
      expect(restingLane).toBeDefined();
      hoisted.task = { ...hoisted.task, swimlane_id: restingLane!.id };

      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(3 * 60 * MINUTE);
      expect(nudges()).toHaveLength(0);
      expect(hoisted.check).not.toHaveBeenCalled();
    });
  });

  // Red before: `ensureEntry` and `attempt` only overwrote the entry's session
  // id, so a respawned task's attempt acted on the old session's verdict.
  it('forgets the old session\'s verdict when the task has a new session, and judges its turn again', async () => {
    await endTurn(41, STALLED_REPLY);
    const checksAtTheStop = hoisted.check.mock.calls.length;

    // The task is respawned. The new session counts its turns from the start,
    // so its work serial reaches the old session's 41, and it finished the step.
    const newSessionId = 'session-2';
    hoisted.task = { ...hoisted.task, session_id: newSessionId };
    sessionManager.getSession = (sessionId: string) => (sessionId === newSessionId
      ? { id: newSessionId, taskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null }
      : undefined);
    sessionManager.getActivityCache = () => ({ [newSessionId]: 'idle' });
    sessionManager.isLatestTurn = (sessionId: string, serial: number) => sessionId === newSessionId && serial === workSerial;
    currentReply = FINISHED_REPLY;
    replyAt = Date.now();

    await wait(RECOVERY_DELAYS_MS[0]);

    // The step was checked again on the new session's turn, not nudged on the old verdict.
    expect(hoisted.check.mock.calls.length).toBeGreaterThan(checksAtTheStop);
    expect(nudges()).toHaveLength(0);
    expect(hoisted.task.swimlane_id).toBe(nextLane.id);
    expect(isUnderWorkflowRecovery(taskId)).toBe(false);
  });

  // Red before: the stall was written to the log and sent to the desktop and
  // the phone, but the in-app toast was never pushed.
  it('pushes the in-app toast when recovery runs out', async () => {
    await endTurn(41, STALLED_REPLY);
    for (let attempt = 0; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
      await wait(RECOVERY_DELAYS_MS[attempt]);
      startTurn(42 + attempt);
      await endTurn(42 + attempt, STALLED_REPLY);
    }
    expect(stallNotices()).toHaveLength(1);

    const toasts = vi.mocked(sendToRenderer).mock.calls.filter((call) => call[1] === IPC.WORKFLOW_STALLED);
    expect(toasts).toHaveLength(1);
    expect(toasts[0][0]).toBe(context.mainWindow);
    expect(toasts[0][2]).toEqual({
      workflowId: 'workflow-1',
      projectId: PROJECT_ID,
      taskId,
      taskTitle: 'Rework the status badges',
      reason: 'It stopped before its marker; the gate has not passed',
    });
    // The same words the desktop notice carries.
    expect(stallNotices()[0]).toEqual([expect.objectContaining({ reason: (toasts[0][2] as { reason: string }).reason })]);
  });

  // A recovery attempt that comes due while a turn end's pass is still running
  // waits for that pass (one pass per task), and is not lost.
  describe('a recovery attempt that comes due while a turn end\'s pass is running', () => {
    // The pass is held in its step check from the second turn end on. The
    // first turn end's verdict armed the attempt, which comes due meanwhile.
    async function holdSecondTurnEnd(answer?: unknown): Promise<{ release: () => void }> {
      await endTurn(41, STALLED_REPLY);
      const held = holdNextCheck(answer);
      startTurn(42);
      await endTurn(42, STALLED_REPLY);
      return held;
    }

    // Red before: the queued attempt found the pass's own verdict already
    // armed, and still ran, nudging at once instead of on the schedule.
    it('leaves the schedule to the verdict the pass gives, and nudges one step after it', async () => {
      const held = await holdSecondTurnEnd();

      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      // The pass ends stopped, which arms the next step. The attempt that came
      // due behind it has nothing to add.
      held.release();
      await settle();
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(RECOVERY_DELAYS_MS[0] - 1_000);
      expect(nudges()).toHaveLength(0);
      await wait(1_000);
      expect(nudges()).toHaveLength(1);
      expect(recoveryRows()[0].detail).toContain('Recovery 1 of 4');
    });

    // Red before: a request that found a pass running was dropped when it could
    // not queue, and a pass that arms nothing left the task with no timer.
    it('runs the moment the pass ends when the pass arms nothing', async () => {
      const held = await holdSecondTurnEnd(NO_VERDICT_CHECK);

      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);

      held.release();
      await settle();

      // The queued attempt judged the second turn and nudged, with no timer to wait on.
      expect(nudges()).toHaveLength(1);
    });

    // The attempt cannot queue behind a turn end: that turn end outranks it
    // and judges a newer turn. It is armed again for a minute on, so a turn
    // end that arms nothing does not leave the task with no timer.
    it('is armed again for a minute on when a turn end is queued behind the pass', async () => {
      const held = await holdSecondTurnEnd(NO_VERDICT_CHECK);
      // A second Stop for the same turn queues behind the held pass, and its
      // check ends with no verdict too.
      hoisted.check.mockImplementationOnce(async () => NO_VERDICT_CHECK);
      await endTurn(42, STALLED_REPLY);

      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);

      held.release();
      await settle();
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(HOLD_RECHECK_MS + 1_000);
      expect(nudges()).toHaveLength(1);
    });

    // A turn end that arrives after the attempt queued replaces it, for the
    // same reason, and the attempt is armed again the same way.
    it('is armed again for a minute on when a turn end replaces it in the queue', async () => {
      const held = await holdSecondTurnEnd(NO_VERDICT_CHECK);
      await wait(RECOVERY_DELAYS_MS[0]);
      hoisted.check.mockImplementationOnce(async () => NO_VERDICT_CHECK);
      await endTurn(42, STALLED_REPLY);

      held.release();
      await settle();
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(HOLD_RECHECK_MS + 1_000);
      expect(nudges()).toHaveLength(1);
    });
  });

  // Red before: the catch re-armed at the same delay without moving the
  // schedule's step, so an attempt that kept throwing retried every five
  // minutes for a day and never reached the notice.
  it('spends the schedule\'s step on an attempt that throws, and still ends in one notice', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await endTurn(41, STALLED_REPLY);

    // Every attempt throws, from the part of it that looks for the user.
    const stoppedAt = Date.now();
    const attemptOffsets: number[] = [];
    sessionManager.getPendingDraft = () => {
      attemptOffsets.push(Date.now() - stoppedAt);
      throw new Error('The prompt could not be read.');
    };

    const schedule = RECOVERY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    await wait(schedule + OUTAGE_RETRY_MS + MINUTE);

    // Each attempt comes one schedule step after the one that threw. Past the
    // schedule's end, the hourly cadence, and then the notice.
    expect(attemptOffsets).toEqual([5, 20, 50, 110, 170].map((minutes) => minutes * MINUTE));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('A recovery attempt for task'), expect.any(Error));
    expect(stallNotices()).toHaveLength(1);
    expect(nudges()).toHaveLength(0);

    // It keeps looking hourly, and says nothing more.
    await wait(3 * OUTAGE_RETRY_MS);
    expect(stallNotices()).toHaveLength(1);
    expect(isUnderWorkflowRecovery(taskId)).toBe(true);
  });

  // A hung turn ends no turn. The hang check interrupts it, and recovery must
  // take the interrupted turn on a fresh schedule, the way it takes any stop.
  describe('a turn that hangs, through the hang check', () => {
    beforeEach(() => {
      vi.mocked(agentRegistry.get).mockImplementation(() => ({
        hungTurn: { quietLimitMs: 20 * MINUTE, interruptKeys: '\x1b' },
        locateSessionHistoryFile: async () => historyFile,
        statSubagentTranscripts: () => null,
      }) as never);
    });

    /** The agent starts a turn and hangs in it: busy, and nothing written for 25 minutes. */
    function hangInTurn(serial: number): void {
      startTurn(serial);
      activityReason = { kind: 'turn-active' };
      const quietSince = new Date(Date.now() - 25 * MINUTE);
      fs.utimesSync(historyFile, quietSince, quietSince);
    }

    /** The interrupt lands: the agent goes idle with no turn end and writes no reply. */
    async function interruptLands(): Promise<void> {
      activity = 'idle';
      currentReply = null;
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();
    }

    // Red before: a hung turn after a spent recovery found the visit's stall
    // row, read its recovery as spent, and was never nudged at all.
    it('nudges an interrupted turn five minutes after it goes idle, even after a spent recovery', async () => {
      await endTurn(41, STALLED_REPLY);
      for (let attempt = 0; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
        await wait(RECOVERY_DELAYS_MS[attempt]);
        startTurn(42 + attempt);
        await endTurn(42 + attempt, STALLED_REPLY);
      }
      expect(stallNotices()).toHaveLength(1);
      const nudgesBefore = nudges().length;

      // Morning: the user types, and that turn hangs.
      await wait(2 * MINUTE);
      hangInTurn(60);
      await checkForHungTurns(context);
      expect(typed).toEqual(['\x1b']);
      expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_interrupt')).toBe(true);

      await interruptLands();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(nudgesBefore + 1);
    });

    // Red before: the hang notice's stall row read as a spent schedule, so an
    // agent that came back waited the hourly cadence for its first nudge.
    it('nudges an agent that comes back after the hang notice on the first step, not an hour later', async () => {
      hangInTurn(41);
      await checkForHungTurns(context);
      expect(typed).toEqual(['\x1b']);

      // The interrupt does not land: the user is told, once.
      await wait(INTERRUPT_LANDING_MS + MINUTE);
      await checkForHungTurns(context);
      expect(stallNotices()).toEqual([[expect.objectContaining({ kind: 'stalled', reason: expect.stringContaining('stopped responding') })]]);

      // Later the agent is reachable again and goes idle.
      await wait(10 * MINUTE);
      await interruptLands();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(1);
      expect(typed).toEqual(['\x1b']);
    });
  });

  describe('a reply that cannot be read', () => {
    // A read that failed is not a turn with no reply: judging it as one would
    // call a question a stall and nudge over it. The idle-only arming leaves no
    // verdict in hand, so the first attempt has to read the reply itself.
    it('is not judged, nudged or counted, and the next attempt reads it again', async () => {
      currentReply = STALLED_REPLY;
      replyAt = Date.now();
      hoisted.retrievalCall.mockRejectedValueOnce(new Error('the transcript worker is restarting'));
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(RECOVERY_DELAYS_MS[0]);
      expect(hoisted.check).not.toHaveBeenCalled();
      expect(nudges()).toHaveLength(0);
      expect(stallNotices()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      // It spent the schedule's step, so the retry comes at the second one.
      await wait(RECOVERY_DELAYS_MS[1] - 1_000);
      expect(nudges()).toHaveLength(0);
      await wait(1_000);
      expect(hoisted.check).toHaveBeenCalled();
      expect(nudges()).toHaveLength(1);
      expect(recoveryRows()[0].detail).toContain('Recovery 2 of 4');
    });
  });

  describe('a nudge that cannot be delivered', () => {
    it('is logged as failed, retried on the schedule, and does not spend one of the four nudges', async () => {
      await endTurn(41, STALLED_REPLY);
      hoisted.deliverMessageToSession.mockRejectedValueOnce(new Error('the terminal was closed'));
      await wait(RECOVERY_DELAYS_MS[0]);

      expect(recoveryRows()).toEqual([
        expect.objectContaining({ status: 'failed', detail: 'Recovery 1 of 4: the nudge was not delivered: the terminal was closed' }),
      ]);
      expect(stallNotices()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      // The retry comes at the second step, and the agent takes it.
      await wait(RECOVERY_DELAYS_MS[1] - 1_000);
      expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
      await wait(1_000);
      expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(2);

      // Three more nudges ran their turns and the schedule is out, with only
      // three of the four spent: the notice goes out and the hourly look goes on.
      for (let attempt = 1; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
        startTurn(42 + attempt);
        await endTurn(42 + attempt, STALLED_REPLY);
        if (attempt < RECOVERY_DELAYS_MS.length - 1) await wait(RECOVERY_DELAYS_MS[attempt + 1]);
      }
      expect(recoveryRows().filter((run) => run.status === 'succeeded')).toHaveLength(3);
      expect(stallNotices()).toHaveLength(1);
      const stall = runs.listForTask(taskId).find((run) => (run.type as string) === 'workflow_stalled');
      expect(stall?.attempts).toBe(3);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    });
  });

  describe('a step with no Automation agent to judge it', () => {
    it('tells the user once a visit that they move the card, nudges nothing, and leaves no recovery', async () => {
      hoisted.check.mockImplementation(async () => ({
        ok: false,
        reason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
        cause: 'unavailable',
        callId: null,
      }));
      await endTurn(41, STALLED_REPLY);

      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'waiting',
        reason: 'no Automation agent can judge this step, so drag the card on when it is done.',
      }));
      expect(notifyPhone).toHaveBeenCalledWith(expect.objectContaining({
        detail: 'Waiting on you: no Automation agent can judge this step, so drag the card on when it is done.',
      }));
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);

      // Another turn end in the same visit says nothing more.
      startTurn(42);
      await endTurn(42, STALLED_REPLY);
      await wait(3 * 60 * MINUTE);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    });
  });

  describe('a step that was done but whose move failed', () => {
    it('is judged again on the schedule, moves the task, and nudges nothing', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      hoisted.handleTaskMove.mockRejectedValueOnce(new Error('the worktree is locked'));
      await endTurn(41, FINISHED_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(errorLog).toHaveBeenCalled();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(RECOVERY_DELAYS_MS[0]);
      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      expect(nudges()).toHaveLength(0);
      expect(notifyDesktop).not.toHaveBeenCalled();
    });
  });

  describe('a restart while the agent waits on the user', () => {
    it('does not arm a recovery for the question that was already told', async () => {
      await endTurn(41, QUESTION_REPLY);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      const checksAtTheQuestion = hoisted.check.mock.calls.length;

      resetWorkflowRecoveryForTests();
      replyAt = Date.now() - MINUTE;
      await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial });
      await settle();

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(3 * 60 * MINUTE);
      expect(nudges()).toHaveLength(0);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(hoisted.check).toHaveBeenCalledTimes(checksAtTheQuestion);
    });
  });

  describe('an attempt that finds the agent not ready to be nudged', () => {
    it('leaves a busy agent alone, judges nothing, and nudges once it is idle again', async () => {
      await endTurn(41, STALLED_REPLY);
      const checksAtTheStop = hoisted.check.mock.calls.length;

      // The agent is working on something when the attempt comes due.
      activity = 'thinking';
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);
      expect(hoisted.check.mock.calls.length).toBe(checksAtTheStop);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      activity = 'idle';
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(1);
      expect(recoveryRows()[0].detail).toContain('Recovery 1 of 4');
    });

    it('stops quietly when the session is no longer running, such as a pause or an exit', async () => {
      await endTurn(41, STALLED_REPLY);
      sessionManager.getSession = () => ({
        id: SESSION_ID, taskId, projectId: PROJECT_ID, status: 'exited', transient: false, workflowId: null, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null,
      });
      await wait(RECOVERY_DELAYS_MS[0]);

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(3 * 60 * MINUTE);
      expect(nudges()).toHaveLength(0);
      expect(notifyDesktop).not.toHaveBeenCalled();
    });

    it('looks again a minute on when a newer turn began after the verdict, rather than typing over it', async () => {
      await endTurn(41, STALLED_REPLY);
      sessionManager.isLatestTurn = () => false;
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      sessionManager.isLatestTurn = (sessionId: string, serial: number) => sessionId === SESSION_ID && serial === workSerial;
      await wait(HOLD_RECHECK_MS + 1_000);
      expect(nudges()).toHaveLength(1);
    });
  });

  describe('an attempt that judges a turn with no turn end', () => {
    it('tells the user when the agent\'s last message asks them something, and nudges nothing', async () => {
      currentReply = QUESTION_REPLY;
      replyAt = Date.now();
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      expect(notifyDesktop).not.toHaveBeenCalled();

      await wait(RECOVERY_DELAYS_MS[0]);

      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting', sessionId: SESSION_ID, reason: OWNER_QUESTION }));
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    });
  });

  // The task's own hold (`tasks.automations_disabled` on a workflow task): a
  // person works it by hand, so the workflow neither judges, nudges nor moves it.
  // `applyAutomationsHoldChange` is the real module, called as the task update
  // IPC calls it after its write; the switch is flipped on the task row the repos
  // return, the way the write flips it in SQLite.
  describe('a workflow task whose automations are paused and resumed', () => {
    /** Flip the switch on the task row, then run what the write's caller runs. */
    function setHold(held: boolean): void {
      const before = hoisted.task as never;
      hoisted.task = { ...hoisted.task, automations_disabled: held };
      applyAutomationsHoldChange(context, PROJECT_ID, before, hoisted.task as never);
    }

    /** Four nudged turns that still do not finish: the schedule is spent, with its one notice. */
    async function spendTheSchedule(): Promise<void> {
      await endTurn(41, STALLED_REPLY);
      for (let attempt = 0; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
        await wait(RECOVERY_DELAYS_MS[attempt]);
        startTurn(42 + attempt);
        await endTurn(42 + attempt, STALLED_REPLY);
      }
      expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length);
      expect(stallNotices()).toHaveLength(1);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    }

    it('nudges a stalled task on the schedule when nothing holds it (the control)', async () => {
      await endTurn(41, STALLED_REPLY);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      await wait(RECOVERY_DELAYS_MS[0]);

      expect(nudges()).toHaveLength(1);
    });

    it('stops a pending recovery when it is paused, so no nudge lands and no notice goes out', async () => {
      await endTurn(41, STALLED_REPLY);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);

      setHold(true);

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(RECOVERY_DELAYS_MS.reduce((total, delay) => total + delay, 0) + OUTAGE_RETRY_MS);
      expect(nudges()).toHaveLength(0);
      expect(notifyDesktop).not.toHaveBeenCalled();
      expect(stallNotices()).toHaveLength(0);
    });

    it('judges, nudges and moves nothing at a turn end while it is paused, even a finished reply', async () => {
      setHold(true);
      const checksBefore = hoisted.check.mock.calls.length;

      await endTurn(41, FINISHED_REPLY);

      expect(hoisted.check.mock.calls.length).toBe(checksBefore);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(RECOVERY_DELAYS_MS[0] + HOLD_RECHECK_MS);
      expect(nudges()).toHaveLength(0);
    });

    it('arms no recovery when a paused task\'s agent goes idle without a turn end', async () => {
      setHold(true);

      activity = 'idle';
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await settle();

      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(0);
    });

    it('judges the reply its last turn left when it resumes with its agent live, and moves a finished task on', async () => {
      // The person finishes the step by hand and leaves the agent idle on its marker.
      setHold(true);
      await endTurn(41, FINISHED_REPLY);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);

      setHold(false);
      await settle();

      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(nudges()).toHaveLength(0);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
    });

    it('does not judge that reply when the agent is not live: the session\'s own resume does', async () => {
      setHold(true);
      await endTurn(41, FINISHED_REPLY);
      const original = sessionManager.getSession;
      sessionManager.getSession = (sessionId: string) => {
        const session = original(sessionId) as Record<string, unknown> | undefined;
        return session ? { ...session, status: 'suspended' } : undefined;
      };
      const checksBefore = hoisted.check.mock.calls.length;

      setHold(false);
      await settle();

      // Nothing judged and nothing moved, though the recovery did start over.
      expect(hoisted.check.mock.calls.length).toBe(checksBefore);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      const startRows = runs.listForTask(taskId).filter((run) => (run.type as string) === 'workflow_recovery_start');
      expect(startRows).toHaveLength(1);
      expect(startRows[0].detail).toBe('Recovery starts over: automations resumed.');
    });

    it('starts the recovery over in the run log when it resumes in a working column, and not in To Do', async () => {
      const startRows = () => runs.listForTask(taskId).filter((run) => (run.type as string) === 'workflow_recovery_start');
      setHold(true);
      setHold(false);
      await settle();
      expect(startRows()).toHaveLength(1);

      // The same flip for a task that sits in To Do has no step to start over.
      const todoLane = lanes.find((lane) => lane.role === 'todo')!;
      hoisted.task = { ...hoisted.task, swimlane_id: todoLane.id };
      setHold(true);
      setHold(false);
      await settle();

      expect(startRows()).toHaveLength(1);
    });

    it('gives a task paused while stalled a fresh schedule and a notice of its own once it resumes', async () => {
      await spendTheSchedule();
      // The control: a catch-up alone finds the recovery spent and arms nothing,
      // which is what a resume of the same task did before the release started it over.
      await catchUpAfterResume(context, { sessionId: SESSION_ID, taskId, projectId: PROJECT_ID, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null, workSerial });
      await wait(2 * OUTAGE_RETRY_MS);
      expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);

      setHold(true);
      await wait(6 * OUTAGE_RETRY_MS);
      expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length);

      setHold(false);
      await settle();
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_recovery_start')).toBe(true);

      // The first step again, not the last or an hour on.
      await wait(RECOVERY_DELAYS_MS[0]);
      expect(nudges()).toHaveLength(RECOVERY_DELAYS_MS.length + 1);
      expect(recoveryRows().at(-1)).toMatchObject({ detail: 'Recovery 1 of 4: asked the agent to carry on.' });

      // That schedule runs out too, with its own notice.
      startTurn(70);
      await endTurn(70, STALLED_REPLY);
      for (let attempt = 1; attempt < RECOVERY_DELAYS_MS.length; attempt += 1) {
        await wait(RECOVERY_DELAYS_MS[attempt]);
        startTurn(71 + attempt);
        await endTurn(71 + attempt, STALLED_REPLY);
      }
      expect(nudges()).toHaveLength(2 * RECOVERY_DELAYS_MS.length);
      expect(stallNotices()).toHaveLength(2);
    });

    describe('announcing a stall, which the engine host also does when a start keeps failing', () => {
      const stall = () => ({
        projectId: PROJECT_ID,
        taskId,
        columnId: workingLane.id,
        workflowId: 'workflow-1',
        reason: 'the start kept failing.',
        countedNudges: 0,
      });
      const stallRows = () => runs.listForTask(taskId).filter((run) => (run.type as string) === 'workflow_stalled');

      it('writes the stall row and tells the user for a task that is not held (the control)', () => {
        announceWorkflowStall(context, stall());

        expect(stallRows()).toHaveLength(1);
        expect(stallNotices()).toHaveLength(1);
        expect(sendToRenderer).toHaveBeenCalledWith(expect.anything(), IPC.WORKFLOW_STALLED, expect.objectContaining({ taskId }));
      });

      it('writes no stall row and tells nobody for a task whose automations are paused', () => {
        hoisted.task = { ...hoisted.task, automations_disabled: true };

        announceWorkflowStall(context, stall());

        expect(stallRows()).toHaveLength(0);
        expect(stallNotices()).toHaveLength(0);
        expect(notifyPhone).not.toHaveBeenCalled();
        expect(sendToRenderer).not.toHaveBeenCalledWith(expect.anything(), IPC.WORKFLOW_STALLED, expect.anything());
      });

      it('announces it again once the task\'s automations resume', () => {
        hoisted.task = { ...hoisted.task, automations_disabled: true };
        announceWorkflowStall(context, stall());
        expect(stallNotices()).toHaveLength(0);

        hoisted.task = { ...hoisted.task, automations_disabled: false };
        announceWorkflowStall(context, stall());

        expect(stallRows()).toHaveLength(1);
        expect(stallNotices()).toHaveLength(1);
      });
    });

    it('leaves no stall notice from a held task whose schedule would have run out', async () => {
      await endTurn(41, STALLED_REPLY);
      await wait(RECOVERY_DELAYS_MS[0]);
      startTurn(42);
      await endTurn(42, STALLED_REPLY);
      expect(nudges()).toHaveLength(1);

      setHold(true);
      await wait(5 * OUTAGE_RETRY_MS);

      expect(nudges()).toHaveLength(1);
      expect(stallNotices()).toHaveLength(0);
      expect(runs.listForTask(taskId).some((run) => (run.type as string) === 'workflow_stalled')).toBe(false);
    });
  });

  describe('a recovery that runs for a day', () => {
    it('stops looking after 24 hours of an outage, having told the user once', async () => {
      serviceDown = true;
      await endTurn(41, STALLED_REPLY);

      await wait(23 * 60 * MINUTE);
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
      expect(stallNotices()).toHaveLength(1);

      await wait(2 * 60 * MINUTE);
      expect(isUnderWorkflowRecovery(taskId)).toBe(false);
      const checksAtTheEnd = hoisted.check.mock.calls.length;
      await wait(3 * 60 * MINUTE);
      expect(hoisted.check.mock.calls.length).toBe(checksAtTheEnd);
      expect(stallNotices()).toHaveLength(1);
      expect(nudges()).toHaveLength(0);
    });
  });
});
