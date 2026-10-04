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
    taskMoves: { visitStartedAt: () => null },
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({ executeTransition: hoisted.executeTransition })),
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

describe('a turn end and the workflow step', () => {
  let sessionManager: EventEmitter & { getActivityCache: () => Record<string, string> };
  let activity: Record<string, string>;
  let taskCounter = 0;
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.deliverMessageToSession.mockImplementation(async () => undefined);
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
    sessionManager = Object.assign(new EventEmitter(), { getActivityCache: () => activity });
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
});
