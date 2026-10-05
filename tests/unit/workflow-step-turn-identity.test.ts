/**
 * A workflow task's step acts only on the turn it judged
 * (src/main/workflows/workflow-step.ts).
 *
 * The step asks the Automation agent whether the turn finished the column's
 * work, and that check takes seconds. If the user starts a new turn meanwhile
 * and that turn fails (`turn_failed`, an API error) or is interrupted back to
 * idle, no turn end fires for it, and the agent is idle again by the time the
 * answer lands. Same session, same column, idle: the old re-check passed and
 * moved the task on the old turn's answer although a newer turn happened. The
 * step now asks `isLatestTurn` with the work serial its payload carries.
 *
 * The session manager is a fake whose `isLatestTurn` compares against a work
 * serial the test moves, the way the activity engine moves it when the agent
 * reports new work. Everything the step reads from the database is a fake too.
 *
 * The same re-check after the check also reads the workflow's state: a Pause
 * pressed while the check was out moves the task nowhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TurnEndedPayload } from '../../src/main/pty/session-manager';

const hoisted = vi.hoisted(() => ({
  checkAutomationConditions: vi.fn(),
  handleTaskMove: vi.fn(),
  recordWorkflowStep: vi.fn(),
  task: {} as Record<string, unknown>,
  /** The state the workflow row reads, which a test moves to pause it. */
  workflowState: 'running',
}));

const COLUMNS = [
  { id: 'lane-todo', name: 'To Do', position: 0, role: 'todo', is_archived: false, is_ghost: false, description: null },
  { id: 'lane-executing', name: 'Executing', position: 1, role: null, is_archived: false, is_ghost: false, description: null },
  { id: 'lane-review', name: 'Code Review', position: 2, role: null, is_archived: false, is_ghost: false, description: null },
  { id: 'lane-done', name: 'Done', position: 3, role: 'done', is_archived: false, is_ghost: false, description: null },
];

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/workflow-repository', () => ({
  WorkflowRepository: class {
    getById = vi.fn(() => ({ id: 'workflow-1', state: hoisted.workflowState }));
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: () => hoisted.task, list: () => [] },
    swimlanes: {
      getById: (id: string) => COLUMNS.find((column) => column.id === id) ?? null,
      list: () => COLUMNS,
    },
    automationRuns: { recordWorkflowStep: hoisted.recordWorkflowStep },
  })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({ conditionCheckDeps: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: hoisted.handleTaskMove }));
vi.mock('../../src/main/automations/condition-check/condition-check', () => ({
  checkAutomationConditions: hoisted.checkAutomationConditions,
}));

const { runWorkflowStep, WORKFLOW_STEP_CHECK_ID } = await import('../../src/main/workflows/workflow-step');

const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-1';
/** The work serial the turn end reports: the turn's identity. */
const TURN_WORK_SERIAL = 41;
/** The serial once the user's "continue" prompt starts a newer turn. */
const NEXT_TURN_WORK_SERIAL = 42;

const PAYLOAD: TurnEndedPayload = {
  sessionId: SESSION_ID,
  taskId: 'task-1',
  projectId: PROJECT_ID,
  agentSessionId: 'agent-session-1',
  isolatedSwimlaneId: null,
  turnStartedAt: null,
  workSerial: TURN_WORK_SERIAL,
};

describe('the workflow step and the turn it judged', () => {
  let activity: Record<string, string>;
  /** The session's current work serial, which new work the agent reports moves. */
  let currentWorkSerial: number;
  let context: IpcContext;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.workflowState = 'running';
    hoisted.task = {
      id: 'task-1',
      title: 'Add the export button',
      description: '',
      labels: [],
      pr_url: null,
      pr_state: null,
      archived_at: null,
      session_id: SESSION_ID,
      swimlane_id: 'lane-executing',
      workflow_id: 'workflow-1',
      workflow_project_id: null,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
    };
    activity = { [SESSION_ID]: 'idle' };
    currentWorkSerial = TURN_WORK_SERIAL;
    hoisted.checkAutomationConditions.mockImplementation(async () => ({
      ok: true,
      answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'The work is done.' }]]),
    }));
    hoisted.handleTaskMove.mockImplementation(async () => undefined);
    context = {
      sessionManager: {
        getActivityCache: () => activity,
        isLatestTurn: (sessionId: string, workSerial: number) =>
          sessionId === SESSION_ID && workSerial === currentWorkSerial,
      },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext;
  });

  function runStep(): Promise<void> {
    return runWorkflowStep(context, {
      payload: PAYLOAD,
      columnId: 'lane-executing',
      signal: new AbortController().signal,
      readAgentReply: async () => 'Done. The export button is in.',
    });
  }

  it('moves the task on when the turn it judged is still the latest (the control)', async () => {
    await runStep();

    expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: true }));
    expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
    expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ taskId: 'task-1', targetSwimlaneId: 'lane-review' }),
      'workflow',
      PROJECT_ID,
      '/mock/project',
      expect.anything(),
    );
  });

  it('moves nothing and writes nothing when a newer turn failed back to idle during the check', async () => {
    // The user typed "continue" while the check was out, and that turn ended
    // in an API error: idle again, with no turn end of its own.
    hoisted.checkAutomationConditions.mockImplementation(async () => {
      currentWorkSerial = NEXT_TURN_WORK_SERIAL;
      activity[SESSION_ID] = 'idle';
      return { ok: true, answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'The work is done.' }]]) };
    });

    await runStep();

    expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('asks nothing when a newer turn began before the step could check', async () => {
    currentWorkSerial = NEXT_TURN_WORK_SERIAL;

    await runStep();

    expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
    expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('moves nothing when the workflow was paused while the check was out', async () => {
    // Pause pressed during the seconds the check takes; the answer that lands is
    // "met" for the same, latest, idle turn, and the task is still in its column.
    hoisted.checkAutomationConditions.mockImplementation(async () => {
      hoisted.workflowState = 'paused';
      return { ok: true, answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'The work is done.' }]]) };
    });

    await runStep();

    expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    // A run-log line saying "Moving on to Code Review" for a move that never
    // happens would be false, so the step writes nothing either.
    expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
  });
});
