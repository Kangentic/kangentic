/**
 * The held-move lifecycle across the turn-end runner and workflow recovery.
 *
 * A running workflow task whose step is judged done while a background shell
 * the activity engine holds is still open gets a `move-held` verdict, and
 * recovery stores a `HeldMove` (`workflow-recovery-state.ts`). The runner runs
 * that move at the next turn end with no shell open (`settleHeldMove`), and a
 * Move to column row's move is held the same way (`heldMoveRowId`).
 *
 * Driven the way `workflow-recovery.test.ts` drives it: the real turn-end
 * runner, the real step check (`runWorkflowStep`) and the real recovery, with
 * the session manager's events, a scripted Automation agent and the real run
 * log on SQLite. Replies are written for this test.
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
import { nextOnRoute } from '../../src/shared/workflow-route';
import { matchFinalLine } from '../../src/shared/final-line-match';
import { supersedeTurnEndWork } from '../../src/main/automations/turn-end/turn-end-passes';
import { resetAbandonedTurnsForTests } from '../../src/main/automations/turn-end/abandoned-turns';
import { markRecapSession, recapKindOf, resetRecapSessionsForTests } from '../../src/main/automations/turn-end/recap-turns';
import {
  cancelWorkflowRecovery,
  getHeldMove,
  resetWorkflowRecoveryForTests,
  setHeldMove,
} from '../../src/main/workflows/workflow-recovery-state';
import { workflowMemoryGate } from '../../src/main/workflows/workflow-memory-gate';
import type { OpenWork } from '../../src/main/activity-engine/open-work-ledger';
import { openTestDatabase } from './helpers/test-database';

interface CheckInput {
  agentReply: string | null;
  rows: Array<{ automationId: string; condition: string }>;
}

interface TransitionOptions {
  onlyIds: ReadonlySet<string>;
  agentReply?: string | null;
  holdMoves?: string;
  releaseHeldMoves?: ReadonlySet<string>;
}

const hoisted = vi.hoisted(() => ({
  database: null as unknown,
  repos: null as unknown,
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  workflowTasks: vi.fn(),
  workflowState: 'running',
  check: vi.fn(),
  handleTaskMove: vi.fn(),
  deliverMessageToSession: vi.fn(),
  executeTransition: vi.fn(),
  retrievalCall: vi.fn(),
  resolveMoveTarget: vi.fn(),
  waitForTurnCompletion: vi.fn(async (): Promise<string> => 'completed'),
  readWorktreeWork: vi.fn(),
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
vi.mock('../../src/main/transition-engine/turn-completion', () => ({ waitForTurnCompletion: hoisted.waitForTurnCompletion }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.retrievalCall } }));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(), list: vi.fn(() => []) } }));
vi.mock('../../src/main/automations/automation-registry', () => ({ automationRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/automations/move-target', () => ({ resolveMoveTarget: hoisted.resolveMoveTarget, routeOf: vi.fn() }));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: hoisted.deliverMessageToSession,
  deliverMessageAfterMove: vi.fn(),
}));
vi.mock('../../src/main/automations/condition-check/condition-check', () => ({ checkAutomationConditions: hoisted.check }));
vi.mock('../../src/main/workflows/workflow-home', () => ({
  workflowOfTask: vi.fn(() => ({ id: 'workflow-1', state: hoisted.workflowState })),
  isRunningWorkflowStepTask: vi.fn(() => hoisted.workflowState === 'running'),
  isInWorkflow: vi.fn(() => true),
}));
vi.mock('../../src/main/workflows/workflow-changed', () => ({ notifyWorkflowChanged: vi.fn(), notifyWorkflowOfTask: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-tasks')>()),
  workflowTasks: hoisted.workflowTasks,
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/git/worktree-head', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/worktree-head')>()),
  readWorktreeWork: hoisted.readWorktreeWork,
}));

const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');
const { stopWorkflowHangCheck } = await import('../../src/main/workflows/workflow-hang-check');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
const MARKER = 'Implementation: complete';
const ANCHOR: TranscriptAnchor = { agentSessionId: 'agent-session-1', byteOffset: 1_000 };
const MINUTE = 60_000;
const SHELL_ID = 'gate-shell';
const MOVE_ROW_ID = 'row-move-on';
const TEXT_ROW_ID = 'row-ship-it';

const STALLED_REPLY = 'I could not finish: the last edits are uncommitted and the gate has not run.\n\n**To finish:** commit and run the gate.';
const FINISHED_REPLY = `The gate passed on the committed tree.\n\n${MARKER}`;
const STOPPED_SHELL_REPLY = 'Stopped the gate shell: it was waiting on stdin.';
const OWNER_QUESTION = 'which layout do you want, the side panel or the drawer?';
const QUESTION_REPLY = `Two layouts would work here.\n\nNeeds owner: ${OWNER_QUESTION}`;
/** A check that ends because the task moved on: the step gives no verdict. */
const NO_VERDICT_CHECK = { ok: false, reason: 'The condition check was stopped because the task moved on.', cause: 'stopped', callId: null };

/** The Automation agent, scripted: the step is done when the reply carries the marker. */
function scriptedCheck(_deps: unknown, input: CheckInput): unknown {
  const reply = input.agentReply ?? '';
  const answers = new Map<string, { met: boolean; reason: string }>();
  for (const row of input.rows) {
    if (row.automationId === 'workflow-step') {
      const met = reply.includes(MARKER);
      answers.set(row.automationId, { met, reason: met ? 'It ends on the marker.' : 'It stopped before its marker; the gate has not passed' });
    } else {
      answers.set(row.automationId, { met: false, reason: 'Nothing matched.' });
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
  isTurnHeldByBackgroundWork: (sessionId: string) => boolean;
  getBackgroundShellOutputBytes: (sessionId: string, shellId: string) => Promise<number | null>;
  getHeldBackgroundShellIds: (sessionId: string) => string[];
}

describe('a held move across the turn-end runner and workflow recovery', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let runs: AutomationRunRepository;
  let lanes: Swimlane[];
  let workingLane: Swimlane;
  let nextLane: Swimlane;
  let taskId: string;
  let taskCounter = 0;
  let sessionManager: FakeSessionManager;
  let context: IpcContext;
  let workSerial: number;
  let activity: string;
  let currentReply: string | null;
  let replyAt: number;
  let openWork: OpenWork;
  let heldByBackgroundWork: boolean;
  let engineHeldShellIds: string[];
  /** Whether a released Move to column row moves the task, as its real move does. */
  let rowReleaseMoves: boolean;
  let notifyDesktop: ReturnType<typeof vi.fn>;
  let historyDirectory: string;

  afterEach(() => {
    resetWorkflowRecoveryForTests();
    resetRecapSessionsForTests();
    stopWorkflowHangCheck();
    fs.rmSync(historyDirectory, { recursive: true, force: true });
    vi.useRealTimers();
    for (const opened of openDatabases.splice(0)) opened.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-02T06:18:00.000Z'));
    vi.clearAllMocks();
    resetAbandonedTurnsForTests();
    resetWorkflowRecoveryForTests();
    resetRecapSessionsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.workflowState = 'running';

    const database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    hoisted.database = database;
    lanes = new SwimlaneRepository(database).list().map((lane) => ({ ...lane, auto_spawn: true }));
    workingLane = lanes.find((lane) => lane.role === null)!;
    runs = new AutomationRunRepository(database);

    taskCounter += 1;
    taskId = `held-task-${taskCounter}`;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'Rework the status badges', '', workingLane.id, 0, '2026-11-02T05:00:00.000Z', '2026-11-02T05:00:00.000Z');
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, null, workingLane.id, 'workflow', null, '2026-11-02T05:30:00.000Z');

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
    hoisted.workflowTasks.mockReset();
    hoisted.workflowTasks.mockImplementation(() => []);
    hoisted.repos = {
      tasks: { getById: () => hoisted.task, list: () => [] },
      swimlanes: { getById: (id: string) => lanes.find((lane) => lane.id === id) ?? null, list: () => lanes },
      automations: { getForTrigger: () => hoisted.rows },
      automationRuns: runs,
      taskMoves: new TaskMoveRepository(database),
      attachments: {},
    };

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
    hoisted.resolveMoveTarget.mockReset();
    hoisted.resolveMoveTarget.mockImplementation(() => ({ ok: true, column: nextLane }));
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    rowReleaseMoves = true;
    // The Move to column row's engine: held while the shell is open (`holdMoves`),
    // moving the task when released, and a Text match row that moves on its marker.
    hoisted.executeTransition.mockReset();
    hoisted.executeTransition.mockImplementation(async (task: { id: string }, _column: unknown, _trigger: string, options: TransitionOptions) => {
      for (const row of hoisted.rows as ColumnAutomation[]) {
        if (!options.onlyIds.has(row.id)) continue;
        if (row.id === MOVE_ROW_ID) {
          if (options.holdMoves) return { results: [], heldMoveRowId: row.id };
          if (options.releaseHeldMoves?.has(row.id) && rowReleaseMoves) {
            supersedeTurnEndWork(task.id, { exceptOwnGroup: true });
            hoisted.task = { ...hoisted.task, swimlane_id: nextLane.id };
          }
          continue;
        }
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
    openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
    heldByBackgroundWork = false;
    engineHeldShellIds = [];
    workflowMemoryGate.resetForTests();
    notifyDesktop = vi.fn();
    historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-held-move-history-'));
    fs.writeFileSync(path.join(historyDirectory, 'agent-session-1.jsonl'), '{}\n');
    stopWorkflowHangCheck();
    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => ({ [SESSION_ID]: activity }),
      isLatestTurn: (sessionId: string, serial: number) => sessionId === SESSION_ID && serial === workSerial,
      currentWorkSerial: () => workSerial,
      currentTurnAnchor: () => ANCHOR,
      hadLeftPlanModeBy: () => false,
      isInternalAgentEvent: () => false,
      getSession: (sessionId: string) => (sessionId === SESSION_ID
        ? { id: SESSION_ID, taskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null, agentSessionId: 'agent-session-1', isolatedSwimlaneId: null }
        : undefined),
      getPendingDraft: () => null,
      getFocusedSessions: () => new Set<string>(),
      getLastUserInputAt: () => null,
      getOpenWork: () => openWork,
      automatedKeysBlocker: () => null,
      listSessions: () => [{
        id: SESSION_ID, taskId, projectId: PROJECT_ID, status: 'running', transient: false, workflowId: null,
        agentSessionId: 'agent-session-1', cwd: historyDirectory,
      }],
      getActivityReason: () => ({ kind: 'turn-active' }),
      getSessionAgentName: () => 'claude',
      getSessionCliTarget: () => null,
      getReportedTranscriptPath: () => null,
      write: () => undefined,
      signalUserInterrupt: () => undefined,
      isTurnHeldByBackgroundWork: (sessionId: string) => sessionId === SESSION_ID && heldByBackgroundWork,
      getBackgroundShellOutputBytes: async () => 0,
      getHeldBackgroundShellIds: (sessionId: string) => (sessionId === SESSION_ID ? engineHeldShellIds : []),
    });
    context = {
      sessionManager,
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
      boardConfigManager: { getBoardProfiles: () => [] },
      terminalSubmitScheduler: { hasPending: () => false },
      desktopNotifier: { notifyWorkflowTask: notifyDesktop },
      mobileBridgeService: { notifyWorkflowTask: vi.fn() },
    } as unknown as IpcContext;
    registerTurnEndAutomations(context);
  });

  /** Lets every pass, attempt and immediate the events started run to its end. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 40; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function turnEndPayload(serial: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: Date.now() - MINUTE,
      workSerial: serial,
      transcriptAnchor: ANCHOR,
      ...extra,
    };
  }

  /** The agent ends a turn with its own Stop and nothing held: idle first, then the turn end. */
  async function endTurn(serial: number, reply: string | null): Promise<void> {
    workSerial = serial;
    activity = 'idle';
    currentReply = reply;
    replyAt = Date.now();
    sessionManager.emit('activity', SESSION_ID, 'idle');
    sessionManager.emit('turn-ended', turnEndPayload(serial));
    await settle();
  }

  /** The Stop lands with a background command still alive: the engine reports the turn end held. */
  async function endHeldTurn(serial: number, reply: string | null, held = true): Promise<void> {
    workSerial = serial;
    activity = 'thinking';
    heldByBackgroundWork = held;
    currentReply = reply;
    replyAt = Date.now();
    sessionManager.emit('turn-ended-held', turnEndPayload(serial));
    await settle();
  }

  /** The held work drains: the engine's turn end for the same turn, reported held before. */
  async function drain(serial: number, reply: string | null): Promise<void> {
    workSerial = serial;
    activity = 'idle';
    heldByBackgroundWork = false;
    currentReply = reply;
    replyAt = Date.now();
    sessionManager.emit('activity', SESSION_ID, 'idle');
    sessionManager.emit('turn-ended', turnEndPayload(serial, { heldReported: true }));
    await settle();
  }

  function startTurn(serial: number): void {
    workSerial = serial;
    activity = 'thinking';
    sessionManager.emit('activity', SESSION_ID, 'thinking');
  }

  /** A shell the agent left running, held by the engine and open in the ledger. */
  function leaveShellOpen(): void {
    openWork = { ...openWork, backgroundShells: [{ id: SHELL_ID, command: 'npm run verify', since: Date.now() - 10 * MINUTE }] };
    engineHeldShellIds = [SHELL_ID];
  }

  function closeShell(): void {
    openWork = { ...openWork, backgroundShells: [] };
    engineHeldShellIds = [];
    heldByBackgroundWork = false;
  }

  function moveRow(): ColumnAutomation {
    return {
      id: MOVE_ROW_ID,
      swimlane_id: workingLane.id,
      name: 'On to the next column',
      type: 'move_to_column',
      trigger: 'turn_end',
      position: 0,
      enabled: true,
      config: { targetColumn: nextLane.name },
      condition: null,
      final_line: null,
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } satisfies ColumnAutomation;
  }

  function textRow(): ColumnAutomation {
    return { ...moveRow(), id: TEXT_ROW_ID, name: 'Ship it', final_line: 'Ship it' };
  }

  /** The paid step checks so far. A reply judged not done also asks a second, blocker check, which is not one. */
  const stepChecks = (): number => hoisted.check.mock.calls
    .filter((call) => (call[1] as CheckInput).rows.some((row) => row.automationId === 'workflow-step')).length;

  const stepHold = {
    kind: 'step' as const,
    rowId: null,
    targetName: null as string | null,
  };

  /** The step's move held at a turn end, as the shell it left is still open. */
  async function holdStepMove(): Promise<void> {
    leaveShellOpen();
    await endTurn(41, FINISHED_REPLY);
    expect(hoisted.task.swimlane_id).toBe(workingLane.id);
    expect(getHeldMove(taskId)).toEqual({ columnId: workingLane.id, sessionId: SESSION_ID, ...stepHold, targetName: nextLane.name });
  }

  describe('a hold the shell still keeps', () => {
    it('leaves the task in its column, pays for no second check, and still moves it at the next shell-free Stop', async () => {
      await holdStepMove();
      expect(stepChecks()).toBe(1);

      // The shell is still open at the next Stop.
      startTurn(42);
      await endTurn(42, 'Still waiting on the gate shell.');
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(stepChecks()).toBe(1);
      expect(getHeldMove(taskId)).toEqual({ columnId: workingLane.id, sessionId: SESSION_ID, ...stepHold, targetName: nextLane.name });

      // The shell ends: the move runs with no check, whatever the reply says.
      closeShell();
      startTurn(43);
      await endTurn(43, STOPPED_SHELL_REPLY);
      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(stepChecks()).toBe(1);
      expect(getHeldMove(taskId)).toBeUndefined();
    });
  });

  describe('a reply that ends on the no-change line', () => {
    const NO_CHANGES_WHY = 'the route already returns 404, and nothing here needs to change.';
    const NO_CHANGES_REPLY = `I read the handler and its tests.\n\nNo changes needed: ${NO_CHANGES_WHY}`;
    const WORKTREE = '/mock/project/.kangentic/worktrees/badges';
    const EMPTY_BRANCH = { branch: 'badges', commitsNotOnBase: 0, uncommittedFiles: 0 };
    let doneLane: Swimlane;

    beforeEach(() => {
      doneLane = lanes.find((lane) => lane.role === 'done')!;
      hoisted.task = { ...hoisted.task, worktree_path: WORKTREE, base_branch: 'develop', resolved_base_branch: null };
      hoisted.readWorktreeWork.mockReset();
      hoisted.readWorktreeWork.mockImplementation(async () => EMPTY_BRANCH);
    });

    const stepRows = (): Array<{ met: number | null; detail: string | null }> => (hoisted.database as DatabaseType.Database)
      .prepare('SELECT condition_met AS met, detail FROM automation_runs WHERE task_id = ? ORDER BY started_at')
      .all(taskId) as Array<{ met: number | null; detail: string | null }>;

    it('moves the task straight to Done, past the rest of its route, with no check to pay for', async () => {
      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.task.swimlane_id).toBe(doneLane.id);
      expect(hoisted.readWorktreeWork).toHaveBeenCalledWith(WORKTREE, 'develop');
      expect(stepChecks()).toBe(0);
      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ taskId, targetSwimlaneId: doneLane.id }),
        'workflow',
        PROJECT_ID,
        '/mock/project',
        expect.objectContaining({ fromTurnEndGroup: true }),
      );
    });

    it('records the agent\'s reason in the run log', async () => {
      await endTurn(41, NO_CHANGES_REPLY);

      const reasons = (hoisted.database as DatabaseType.Database)
        .prepare('SELECT condition_reason AS reason FROM automation_runs WHERE task_id = ?')
        .all(taskId) as Array<{ reason: string | null }>;
      expect(reasons.map((row) => row.reason)).toContain(NO_CHANGES_WHY);
    });

    it('moves nothing on a branch with commits, and the nudge says why', async () => {
      hoisted.readWorktreeWork.mockImplementation(async () => ({ ...EMPTY_BRANCH, commitsNotOnBase: 2 }));

      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      await settle();
      expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
      const nudge = (hoisted.deliverMessageToSession.mock.calls[0] as unknown as [unknown, { message: string }])[1].message;
      expect(nudge).toContain('2 commits');
      expect(nudge).toContain('develop');
    });

    it('moves nothing on a dirty worktree', async () => {
      hoisted.readWorktreeWork.mockImplementation(async () => ({ ...EMPTY_BRANCH, uncommittedFiles: 1 }));

      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(stepRows().some((row) => row.detail?.includes('1 uncommitted file'))).toBe(true);
    });

    it.each([
      ['the read failed', null],
      ['the base branch does not resolve', { ...EMPTY_BRANCH, commitsNotOnBase: null }],
    ])('moves nothing when the branch cannot be read: %s', async (_label, work) => {
      hoisted.readWorktreeWork.mockImplementation(async () => work);

      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(stepRows().some((row) => row.detail?.includes('could not be read'))).toBe(true);
    });

    it('takes the agent\'s word on a task with no worktree: there is nothing to compare', async () => {
      hoisted.task = { ...hoisted.task, worktree_path: null };

      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.task.swimlane_id).toBe(doneLane.id);
      expect(hoisted.readWorktreeWork).not.toHaveBeenCalled();
    });

    // A plan column's "Finish the plan" row has no Text match, so it runs on
    // every reply. Its message would start a turn and take the step's turn with it.
    it('runs no row first, so a row with no Text match cannot message the agent over it', async () => {
      hoisted.rows = [{ ...moveRow(), id: 'row-finish-the-plan', name: 'Finish the plan', type: 'send_message', config: { message: 'Finish the plan.' } }];

      await endTurn(41, NO_CHANGES_REPLY);

      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.task.swimlane_id).toBe(doneLane.id);
    });

    it('runs the rows on any other reply, as before', async () => {
      hoisted.rows = [{ ...moveRow(), id: 'row-finish-the-plan', name: 'Finish the plan', type: 'send_message', config: { message: 'Finish the plan.' } }];

      await endTurn(41, 'Here is the plan so far.');

      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
    });

    it('waits for a background command the agent left, then goes to Done, not the next route column', async () => {
      leaveShellOpen();
      await endTurn(41, NO_CHANGES_REPLY);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(getHeldMove(taskId)).toMatchObject({ kind: 'no-changes', targetName: doneLane.name });

      closeShell();
      startTurn(42);
      await endTurn(42, STOPPED_SHELL_REPLY);

      expect(hoisted.task.swimlane_id).toBe(doneLane.id);
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('checks the branch again when the held move goes: the agent may have committed meanwhile', async () => {
      leaveShellOpen();
      await endTurn(41, NO_CHANGES_REPLY);

      hoisted.readWorktreeWork.mockImplementation(async () => ({ ...EMPTY_BRANCH, commitsNotOnBase: 1 }));
      closeShell();
      startTurn(42);
      await endTurn(42, STOPPED_SHELL_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('leaves a Needs owner reply alone: only the owner settles that', async () => {
      await endTurn(41, QUESTION_REPLY);

      expect(hoisted.readWorktreeWork).not.toHaveBeenCalled();
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
    });
  });

  describe('a column whose only exit rows send the task back', () => {
    const SEND_BACK_ROW_ID = 'row-checks-failing';
    const AWAITING_REVIEW_REPLY = `PR open, checks green.\n\n${MARKER}`;

    beforeEach(() => {
      const earlierLane = lanes.find((lane) => lane.role === 'todo')!;
      hoisted.resolveMoveTarget.mockImplementation(() => ({ ok: true, column: earlierLane }));
      hoisted.rows = [{ ...moveRow(), id: SEND_BACK_ROW_ID, name: 'Checks failing', final_line: 'PR: checks failing', config: { targetColumn: earlierLane.name } }];
    });

    it('stops the card on a yes: no move, one notice, and no nudge however long it waits', async () => {
      await endTurn(41, AWAITING_REVIEW_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
      expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting' }));

      await vi.advanceTimersByTimeAsync(120 * MINUTE);
      await settle();
      expect(hoisted.deliverMessageToSession).not.toHaveBeenCalled();
      expect(notifyDesktop).toHaveBeenCalledTimes(1);
    });

    it('asks the check its own question there', async () => {
      await endTurn(41, AWAITING_REVIEW_REPLY);

      const [, input] = hoisted.check.mock.calls[0] as [unknown, CheckInput];
      expect(input.rows[0].condition).toContain('finished what it can do alone');
    });

    it('tells the owner once a visit, and stays quiet across a person\'s later turns there', async () => {
      await endTurn(41, AWAITING_REVIEW_REPLY);
      startTurn(42);
      await endTurn(42, AWAITING_REVIEW_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(notifyDesktop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120 * MINUTE);
      await settle();
      expect(hoisted.deliverMessageToSession).not.toHaveBeenCalled();
    });

    it('still nudges a real stall, which the check answers no', async () => {
      await endTurn(41, STALLED_REPLY);

      expect(notifyDesktop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      await settle();
      expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
    });

    it('never holds a step move there: a yes with a command still open only stops', async () => {
      leaveShellOpen();
      await endTurn(41, AWAITING_REVIEW_REPLY);

      expect(getHeldMove(taskId)).toBeUndefined();
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
    });
  });

  describe('a hold that belongs elsewhere', () => {
    it('does not run a hold for another column: the reply is judged as any other', async () => {
      setHeldMove(taskId, { columnId: 'another-column', sessionId: SESSION_ID, kind: 'step', rowId: null, targetName: null });

      // A release would move the task with no check. An ordinary pass checks, and this reply is not done.
      await endTurn(41, STALLED_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(stepChecks()).toBe(1);
    });

    it('drops a hold for another session at a turn end, and judges the reply as any other', async () => {
      setHeldMove(taskId, { columnId: workingLane.id, sessionId: 'session-crashed', kind: 'step', rowId: null, targetName: null });

      await endTurn(41, STALLED_REPLY);

      expect(getHeldMove(taskId)).toBeUndefined();
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(stepChecks()).toBe(1);
    });
  });

  describe('what ends a hold', () => {
    it('a user move supersedes it', async () => {
      await holdStepMove();
      supersedeTurnEndWork(taskId);
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('a Pause of the workflow drops it', async () => {
      await holdStepMove();
      cancelWorkflowRecovery('workflow-1');
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('a reset of the recovery drops it', async () => {
      await holdStepMove();
      resetWorkflowRecoveryForTests();
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('a Needs owner reply at the release drops it and moves nothing', async () => {
      await holdStepMove();
      closeShell();
      startTurn(42);
      await endTurn(42, QUESTION_REPLY);

      expect(getHeldMove(taskId)).toBeUndefined();
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(notifyDesktop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting', reason: OWNER_QUESTION }));
    });
  });

  describe('a Move to column row held on the shell', () => {
    it('stores a row hold, runs no step, and runs the row again with its id released at the next shell-free turn end', async () => {
      hoisted.rows = [moveRow()];
      leaveShellOpen();
      await endTurn(41, FINISHED_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(getHeldMove(taskId)).toEqual({
        columnId: workingLane.id, sessionId: SESSION_ID, kind: 'row', rowId: MOVE_ROW_ID, targetName: nextLane.name,
      });
      expect(stepChecks()).toBe(0);
      const heldCall = hoisted.executeTransition.mock.calls[0][3] as TransitionOptions;
      expect(heldCall.holdMoves).toBeTruthy();

      closeShell();
      startTurn(42);
      await endTurn(42, STOPPED_SHELL_REPLY);

      const releaseCall = hoisted.executeTransition.mock.calls[1][3] as TransitionOptions;
      expect(releaseCall.releaseHeldMoves).toEqual(new Set([MOVE_ROW_ID]));
      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(stepChecks()).toBe(0);
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('judges the turn end as an ordinary pass when the row was deleted meanwhile', async () => {
      hoisted.rows = [moveRow()];
      leaveShellOpen();
      await endTurn(41, STALLED_REPLY);
      expect(getHeldMove(taskId)).toEqual(expect.objectContaining({ kind: 'row', rowId: MOVE_ROW_ID }));

      hoisted.rows = [];
      closeShell();
      startTurn(42);
      await endTurn(42, FINISHED_REPLY);

      // Judged: one paid step check on the reply, and the step's move.
      expect(stepChecks()).toBe(1);
      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(getHeldMove(taskId)).toBeUndefined();
    });

    it('holds the move again when the released row left the task in its column', async () => {
      rowReleaseMoves = false;
      hoisted.rows = [moveRow()];
      leaveShellOpen();
      await endTurn(41, FINISHED_REPLY);
      const held = getHeldMove(taskId);
      expect(held).toEqual(expect.objectContaining({ kind: 'row', rowId: MOVE_ROW_ID }));

      closeShell();
      startTurn(42);
      await endTurn(42, STOPPED_SHELL_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(getHeldMove(taskId)).toEqual(held);
    });
  });

  describe('a release that does not move the task', () => {
    it('holds a step move again when its move failed', async () => {
      await holdStepMove();
      const held = getHeldMove(taskId);

      closeShell();
      hoisted.handleTaskMove.mockRejectedValueOnce(new Error('the task lock refused the move'));
      startTurn(42);
      await endTurn(42, STOPPED_SHELL_REPLY);

      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(stepChecks()).toBe(1);
      expect(getHeldMove(taskId)).toEqual(held);

      // The next shell-free Stop retries it.
      startTurn(43);
      await endTurn(43, STOPPED_SHELL_REPLY);
      expect(hoisted.task.swimlane_id).toBe(nextLane.id);
      expect(getHeldMove(taskId)).toBeUndefined();
    });
  });

  describe('a held pass and the drain of the same turn', () => {
    it.each([
      ['settles busy', () => hoisted.waitForTurnCompletion.mockImplementationOnce(async () => 'timeout')],
      ['gets no step verdict', () => hoisted.check.mockImplementationOnce(async () => NO_VERDICT_CHECK)],
    ])('a held pass that %s leaves the step and the Text match rows to the drain, once', async (_name, arrange) => {
      hoisted.rows = [textRow()];
      arrange();
      // The busy case is a Stop whose session is not held and not idle.
      await endHeldTurn(51, STALLED_REPLY, _name !== 'settles busy');
      const checksAfterHeld = stepChecks();
      const transitionsAfterHeld = hoisted.executeTransition.mock.calls.length;

      await drain(51, STALLED_REPLY);

      expect(stepChecks() - checksAfterHeld).toBe(1);
      expect(hoisted.executeTransition.mock.calls.length - transitionsAfterHeld).toBe(1);
      const drainCall = hoisted.executeTransition.mock.calls.at(-1)![3] as TransitionOptions;
      expect(drainCall.onlyIds).toEqual(new Set([TEXT_ROW_ID]));
    });

    it('a drain emitted while the held pass waits to settle costs exactly one step check', async () => {
      let releaseSettle!: () => void;
      const gate = new Promise<void>((resolve) => { releaseSettle = resolve; });
      hoisted.waitForTurnCompletion.mockImplementationOnce(async () => {
        await gate;
        return 'completed';
      });

      await endHeldTurn(52, STALLED_REPLY);
      expect(stepChecks()).toBe(0);
      // The shell ends and its drain arrives behind the held pass.
      await drain(52, STALLED_REPLY);
      expect(stepChecks()).toBe(0);

      releaseSettle();
      await settle();

      expect(stepChecks()).toBe(1);
    });
  });

  describe('a recap turn', () => {
    it('is not read by its held turn end, which leaves the mark for the drain to end', async () => {
      markRecapSession(SESSION_ID, 'return');
      leaveShellOpen();

      await endHeldTurn(53, FINISHED_REPLY);

      expect(stepChecks()).toBe(0);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
      expect(recapKindOf(SESSION_ID)).toBe('return');

      closeShell();
      await drain(53, FINISHED_REPLY);

      // The drain's pass ends the mark with its one turn, and judges nothing.
      expect(recapKindOf(SESSION_ID)).toBeNull();
      expect(stepChecks()).toBe(0);
      expect(hoisted.task.swimlane_id).toBe(workingLane.id);
    });
  });
});
