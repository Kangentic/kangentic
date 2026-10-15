/**
 * A turn end that gave the agent a message gets no workflow decision
 * (src/main/automations/turn-end/turn-end-runner.ts).
 *
 * A column's On agent turn end Send message row starts the agent's next turn.
 * The workflow step judges "this turn ended, is the work done", so judging the
 * turn the message interrupts would move the task on a turn the message is
 * about to continue. The turn that answers the message gets the decision.
 *
 * Driven through `registerTurnEndAutomations` and the session manager's
 * 'turn-ended' event, the way the app drives it. The transition engine is a
 * fake whose `executeTransition` calls the `deliverToAgent` option the runner
 * hands it, and swallows a delivery's rejection as the real runner does (it
 * records a failed row and goes on), so "the step ran after a failed delivery"
 * is the runner's own decision rather than an escaped throw. `clearSpawnProgress`
 * runs in the pass's `finally`, so it is the barrier that the pass finished: a
 * "step was not called" assertion waits on it instead of a fixed sleep.
 *
 * The last block is the turn identity race: the user starts a new turn while
 * the Condition check is out, and that turn fails (`turn_failed`) back to idle,
 * which emits no turn end. Idle again, the old re-check passed and the rows ran
 * on the old turn's reply. The fake session manager's `isLatestTurn` compares
 * against a work serial the test moves, the way the activity engine moves it
 * when the agent reports new work (the "continue" prompt).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ColumnAutomation } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

interface DeliverOptions {
  signal: AbortSignal;
  deliverToAgent: (message: string, mode: string, signal: AbortSignal) => Promise<void>;
}

const hoisted = vi.hoisted(() => ({
  runWorkflowStep: vi.fn(),
  workflowStepApplies: vi.fn(),
  deliverMessageToSession: vi.fn(),
  clearSpawnProgress: vi.fn(),
  executeTransition: vi.fn(),
  checkConditions: vi.fn(),
  rows: [] as unknown[],
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => null);
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: () => hoisted.task, list: () => [] },
    swimlanes: { getById: () => hoisted.column, list: () => [] },
    automations: { getForTrigger: () => hoisted.rows },
    automationRuns: { hasRunSince: () => false, hasSkipSince: () => false, countRuns: () => 0 },
    taskMoves: { visitStartedAt: () => null, currentVisit: () => null },
    attachments: {},
  })),
}));
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
  waitForTurnCompletion: vi.fn(async () => 'completed'),
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
  deliverMessageToSession: hoisted.deliverMessageToSession,
  deliverMessageAfterMove: vi.fn(),
}));

const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
const MAIN_WINDOW = { isDestroyed: () => false };

const KEEP_GOING_ROW = {
  id: 'row-keep-going',
  type: 'send_message',
  name: 'Keep going',
  config: { message: 'Keep going' },
  condition: null,
  max_runs: null,
} as unknown as ColumnAutomation;

/** A row the Automation agent has to answer for, so the pass waits on a check. */
const CLEAN_REVIEW_ROW = {
  id: 'row-clean-review',
  type: 'move_to_column',
  name: 'On to Testing',
  config: { targetColumn: 'Testing' },
  condition: 'The review is clean',
  max_runs: null,
} as unknown as ColumnAutomation;

/** The work serial the turn end reports: the turn's identity. */
const TURN_WORK_SERIAL = 41;
/** The serial once the user's "continue" prompt starts a newer turn. */
const NEXT_TURN_WORK_SERIAL = 42;

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('a turn end and the workflow step', () => {
  let sessionManager: FakeSessionManager;
  let activity: Record<string, string>;
  /** The session's current work serial, which new work the agent reports moves. */
  let currentWorkSerial: number;
  let taskCounter = 0;
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.deliverMessageToSession.mockImplementation(async () => undefined);
    hoisted.checkConditions.mockImplementation(async () => ({
      ok: true,
      answers: new Map([[CLEAN_REVIEW_ROW.id, { met: true, reason: 'No findings.' }]]),
    }));
    // The fake engine runs the row the way the real runner does: it hands the
    // row's message to `deliverToAgent`, and a rejection is the row's failure,
    // recorded and not thrown.
    hoisted.executeTransition.mockImplementation(async (_task: unknown, _column: unknown, _trigger: string, options: DeliverOptions) => {
      try {
        await options.deliverToAgent('Keep going', 'immediate', options.signal);
      } catch {
        // A failed row.
      }
      return { results: [] };
    });

    // The runner keeps one pass per task in a module-level map, so each test
    // owns its task.
    taskCounter += 1;
    taskId = `task-${taskCounter}`;
    hoisted.task = {
      id: taskId,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: 'lane-executing',
      agent: 'claude',
      workflow_id: 'workflow-1',
      workflow_project_id: null,
    };
    hoisted.column = { id: 'lane-executing', name: 'Executing', role: null, auto_spawn: true };
    hoisted.rows = [KEEP_GOING_ROW];

    activity = { [SESSION_ID]: 'idle' };
    currentWorkSerial = TURN_WORK_SERIAL;
    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => activity,
      isLatestTurn: (sessionId: string, workSerial: number) =>
        sessionId === SESSION_ID && workSerial === currentWorkSerial,
    });
    registerTurnEndAutomations({
      sessionManager,
      mainWindow: MAIN_WINDOW,
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext);
  });

  /** Fire a turn end and wait for the pass to finish: its `finally` clears the spawn progress. */
  async function endTurn(): Promise<void> {
    sessionManager.emit('turn-ended', {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: null,
      workSerial: TURN_WORK_SERIAL,
      transcriptAnchor: null,
    });
    await vi.waitFor(() => expect(hoisted.clearSpawnProgress).toHaveBeenCalledWith(MAIN_WINDOW, taskId));
  }

  it('gives the workflow step no turn end when a row delivered the agent a message', async () => {
    await endTurn();

    expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverMessageToSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId,
      sessionId: SESSION_ID,
      message: 'Keep going',
    }));
    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('runs the workflow step when the row\'s delivery failed, since no turn was started', async () => {
    hoisted.deliverMessageToSession.mockRejectedValue(new Error('The agent never took the paste.'));

    await endTurn();

    expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it('runs the workflow step when the rows ran and delivered no message', async () => {
    // A notify or webhook row: the engine runs it and never calls deliverToAgent.
    hoisted.executeTransition.mockImplementation(async () => ({ results: [] }));

    await endTurn();

    expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverMessageToSession).not.toHaveBeenCalled();
    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it('runs the workflow step when the column has no turn-end rows at all', async () => {
    hoisted.rows = [];

    await endTurn();

    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it('runs the workflow step when the agent is no longer idle and the rows were held back', async () => {
    // The check can take a while; a row must not land on a running turn. The
    // rows run nothing, so there is no message to wait on, and the step makes
    // its own idle check.
    activity[SESSION_ID] = 'thinking';

    await endTurn();

    expect(hoisted.executeTransition).not.toHaveBeenCalled();
    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it('hands the step the task\'s column and the turn end it is judging', async () => {
    hoisted.rows = [];

    await endTurn();

    expect(hoisted.runWorkflowStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      columnId: 'lane-executing',
      payload: expect.objectContaining({ taskId, sessionId: SESSION_ID }),
    }));
  });

  it('runs no step for a task that is not in a running workflow, message or not', async () => {
    hoisted.workflowStepApplies.mockImplementation(() => false);

    await endTurn();

    expect(hoisted.deliverMessageToSession).toHaveBeenCalledTimes(1);
    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  describe('a new turn while the check is out', () => {
    beforeEach(() => {
      hoisted.rows = [CLEAN_REVIEW_ROW];
      hoisted.executeTransition.mockImplementation(async () => ({ results: [] }));
    });

    it('runs the rows when the turn the check judged is still the latest (the control)', async () => {
      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
    });

    it('runs no row and no step when a newer turn failed back to idle during the check', async () => {
      // The user typed "continue" while the check was out, and that turn ended
      // in an API error: idle again, with no turn end of its own.
      hoisted.checkConditions.mockImplementation(async () => {
        currentWorkSerial = NEXT_TURN_WORK_SERIAL;
        activity[SESSION_ID] = 'idle';
        return { ok: true, answers: new Map([[CLEAN_REVIEW_ROW.id, { met: true, reason: 'No findings.' }]]) };
      });

      await endTurn();

      expect(hoisted.checkConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
    });

    it('asks nothing when a newer turn began before the check could start', async () => {
      currentWorkSerial = NEXT_TURN_WORK_SERIAL;

      await endTurn();

      expect(hoisted.checkConditions).not.toHaveBeenCalled();
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
    });
  });
});
