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
 *
 * The run-log row a successful step writes waits for the move's outcome, so it
 * names a move that happened (or the one that failed), never one only intended.
 * The step reads the task back after the move resolves: a move a newer one
 * superseded returns without moving the task, and the row then says the task was
 * moved elsewhere. The mocked move puts the task in its target column, as the
 * real one does.
 * The check's input also carries the PR's merge readiness.
 *
 * The step returns its verdict, which recovery acts on (workflow-recovery.ts):
 * a not-done turn gets a second ask of why it stopped (still running, can carry
 * on, or waiting on the user), a turn with no reply is a stall with no second
 * ask, a check that cannot run is recorded with no judged answer, and a move
 * that fails is reported rather than thrown, so recovery can retry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TurnEndedPayload } from '../../src/main/pty/session-manager';

const hoisted = vi.hoisted(() => ({
  checkAutomationConditions: vi.fn(),
  handleTaskMove: vi.fn(),
  recordWorkflowStep: vi.fn(),
  hasWorkflowStepDetailSince: vi.fn(() => false),
  task: {} as Record<string, unknown>,
  /** The state the workflow row reads, which a test moves to pause it. */
  workflowState: 'running',
}));

interface MoveInput {
  taskId: string;
  targetSwimlaneId: string;
}

/** What a move does to the task row: the task is in the target column afterwards. */
function moveTaskTo(swimlaneId: string): void {
  hoisted.task = { ...hoisted.task, swimlane_id: swimlaneId };
}

const COLUMNS = [
  { id: 'lane-todo', name: 'To Do', position: 0, role: 'todo', is_archived: false, is_ghost: false, description: null },
  { id: 'lane-executing', name: 'Executing', position: 1, role: null, is_archived: false, is_ghost: false, description: null },
  { id: 'lane-review', name: 'Code Review', position: 2, role: null, is_archived: false, is_ghost: false, description: null },
  { id: 'lane-done', name: 'Done', position: 3, role: 'done', is_archived: false, is_ghost: false, description: null },
];

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})), getExistingProjectDb: vi.fn(() => ({})) }));
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
    automationRuns: { recordWorkflowStep: hoisted.recordWorkflowStep, hasWorkflowStepDetailSince: hoisted.hasWorkflowStepDetailSince },
    taskMoves: { visitStartedAt: () => '2026-10-25T06:00:00.000Z' },
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
  transcriptAnchor: null,
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
      pr_merge_readiness: 'ready',
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
    // The real move puts the task in its target column, and the step reads it back.
    hoisted.handleTaskMove.mockImplementation(async (_context: unknown, input: MoveInput) => {
      moveTaskTo(input.targetSwimlaneId);
    });
    context = {
      sessionManager: {
        getActivityCache: () => activity,
        isLatestTurn: (sessionId: string, workSerial: number) =>
          sessionId === SESSION_ID && workSerial === currentWorkSerial,
      },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext;
  });

  function runStep(columnId = 'lane-executing'): ReturnType<typeof runWorkflowStep> {
    return runWorkflowStep(context, {
      payload: PAYLOAD,
      columnId,
      signal: new AbortController().signal,
      readAgentReply: async () => 'Done. The export button is in.',
    });
  }

  it('moves the task on when the turn it judged is still the latest (the control)', async () => {
    // Nothing overtook the turn, so the step reports its verdict, not a newer turn.
    await expect(runStep()).resolves.toEqual({ verdict: 'done', reason: 'The work is done.', workSerial: TURN_WORK_SERIAL });

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

    // The step says a newer turn overtook it, so the runner can judge this
    // reply again if that newer work never ends in a turn end of its own
    // (abandoned-turns.ts). The check ran, and that is all it did.
    await expect(runStep()).resolves.toBe('newer-turn');

    expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('asks nothing when a newer turn began before the step could check', async () => {
    currentWorkSerial = NEXT_TURN_WORK_SERIAL;

    // Overtaken before the check: no paid check ran, and the step still says so.
    await expect(runStep()).resolves.toBe('newer-turn');

    expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
    expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  // The turn is still the session's latest, so nothing overtook it, but the
  // agent is not idle on it (working, or waiting on a permission prompt). The
  // step leaves it to a later turn end and reports no newer turn: undefined, so
  // the runner does not keep this reply to judge again.
  describe('when the turn is still the latest but the agent is not idle', () => {
    it.each(['thinking', 'permission'] as const)('asks nothing and reports no newer turn when the agent is %s before the check', async (busyState) => {
      activity[SESSION_ID] = busyState;

      await expect(runStep()).resolves.toBeUndefined();

      expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it.each(['thinking', 'permission'] as const)('moves nothing and reports no newer turn when the agent is %s again once the check lands', async (busyState) => {
      // The same turn is still the latest, but the agent picked up work again
      // while the check was out (no new work serial, no turn end).
      hoisted.checkAutomationConditions.mockImplementation(async () => {
        activity[SESSION_ID] = busyState;
        return { ok: true, answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'The work is done.' }]]) };
      });

      await expect(runStep()).resolves.toBeUndefined();

      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });
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

  // The Automation agent judges a Condition from the task facts it is handed.
  // The PR's merge readiness is one of them, so a step that dropped it would ask
  // "is the PR ready to merge?" with the answer missing from the input.
  it.each(['ready', 'running', null] as const)('hands the check the PR merge readiness (%s) with the rest of the task', async (readiness) => {
    hoisted.task = { ...hoisted.task, pr_merge_readiness: readiness };

    await runStep();

    expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    expect(hoisted.checkAutomationConditions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        task: expect.objectContaining({ title: 'Add the export button', prMergeReadiness: readiness }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      // Recorded as a workflow step check, against the task and its column.
      { projectId: 'project-1', taskId: 'task-1', swimlaneId: 'lane-executing', job: 'workflow_step' },
    );
  });

  // The check is a recorded call, and its run-log row links to it so the log
  // can show what the check cost. The row carries the call that gave the
  // answer (a retry's, when the first reply skipped it), else the call the
  // outcome names, whatever the answer or what became of the move.
  describe('the step\'s run-log row links the call that answered the check', () => {
    const answeredBy = (callId: string | null, met = true) => async () => ({
      ok: true,
      answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met, reason: met ? 'The work is done.' : 'Still working.' }]]),
      agentName: 'Mock agent',
      callId,
    });

    it('links the call when the answer was yes and the task moved on', async () => {
      hoisted.checkAutomationConditions.mockImplementation(answeredBy('call-step-1'));

      await runStep();

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: true, backgroundCallId: 'call-step-1' }));
    });

    it('links the call when the answer was no and the task stayed', async () => {
      hoisted.checkAutomationConditions.mockImplementation(answeredBy('call-step-2', false));

      await runStep();

      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: false, backgroundCallId: 'call-step-2' }));
    });

    it('links the call when the move was refused', async () => {
      hoisted.checkAutomationConditions.mockImplementation(answeredBy('call-step-3'));
      hoisted.handleTaskMove.mockRejectedValueOnce(new Error('Column is full.'));

      await expect(runStep()).resolves.toMatchObject({ verdict: 'move-failed' });

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ backgroundCallId: 'call-step-3' }));
    });

    it('links nothing when the outcome names no call (the control)', async () => {
      hoisted.checkAutomationConditions.mockImplementation(answeredBy(null));

      await runStep();

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ backgroundCallId: null }));
    });

    it('links the retry\'s call when the first reply skipped the step and a second ask answered it', async () => {
      // The outcome names the first call; the answer names the call that gave it.
      hoisted.checkAutomationConditions.mockImplementation(async () => ({
        ok: true,
        answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'Still working.', callId: 'call-step-retry' }]]),
        agentName: 'Mock agent',
        callId: 'call-step-first',
      }));

      await runStep();

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ backgroundCallId: 'call-step-retry' }));
    });
  });

  describe('the step\'s run-log row records the move\'s outcome, not its intent', () => {
    it('writes the succeeded row only after the move resolves', async () => {
      let finishMove: () => void = () => {};
      hoisted.handleTaskMove.mockImplementation((_context: unknown, input: MoveInput) => new Promise<void>((resolve) => {
        finishMove = () => {
          moveTaskTo(input.targetSwimlaneId);
          resolve();
        };
      }));

      const stepping = runStep();
      await vi.waitFor(() => expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1));

      // The move is still in flight. Red before the fix: the row already said
      // "Moving on to Code Review" here, before the move had an outcome.
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();

      finishMove();
      await stepping;

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'task-1',
        swimlaneId: 'lane-executing',
        workflowId: 'workflow-1',
        met: true,
        detail: 'Step done. Moved on to Code Review.',
      }));
    });

    it('says the task moved to Done when the next column on the route is Done', async () => {
      hoisted.task = { ...hoisted.task, swimlane_id: 'lane-review' };

      await runStep('lane-review');

      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: 'task-1', targetSwimlaneId: 'lane-done' }),
        'workflow',
        PROJECT_ID,
        '/mock/project',
        expect.anything(),
      );
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: true,
        detail: 'Step done. The route is finished, so the task moved to Done.',
      }));
    });

    // A move a newer one superseded returns without moving the task, and it does
    // not reject, so the step reads the task back to see whether it got there.
    describe('when the move resolves but the task is not in the column it was moved to', () => {
      const stepDetails = () => hoisted.recordWorkflowStep.mock.calls.map(([row]) => (row as { detail: string }).detail);

      it.each([
        ['stays where it was', null],
        ['is in a different column', 'lane-done'],
      ] as const)('records that the task was moved elsewhere, not that it moved on, when the task %s', async (_label, otherColumn) => {
        hoisted.handleTaskMove.mockImplementation(async () => {
          if (otherColumn) moveTaskTo(otherColumn);
        });

        await runStep();

        expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
        expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
        expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
          met: true,
          detail: 'Step done, but the task was moved elsewhere before it reached Code Review.',
        }));
        expect(stepDetails().some((detail) => detail.includes('Moved on'))).toBe(false);
      });

      it('does not say the task moved to Done when the move toward Done left it in its column', async () => {
        hoisted.task = { ...hoisted.task, swimlane_id: 'lane-review' };
        hoisted.handleTaskMove.mockImplementation(async () => undefined);

        await runStep('lane-review');

        expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
        expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
          met: true,
          detail: 'Step done, but the task was moved elsewhere before it reached Done.',
        }));
        expect(stepDetails().some((detail) => detail.includes('moved to Done'))).toBe(false);
      });
    });

    it('records the failure and reports it as a failed move when the move is refused', async () => {
      hoisted.handleTaskMove.mockRejectedValueOnce(new Error('Column is full.'));

      // Reported, not thrown: recovery moves it again on its schedule.
      await expect(runStep()).resolves.toEqual({
        verdict: 'move-failed',
        reason: 'the move to Code Review failed: Column is full.',
        workSerial: TURN_WORK_SERIAL,
      });

      // One row, and it names the failure. Red before the fix: the row was
      // written ahead of the move and said "Moving on to Code Review", so a
      // refused move left a log that claimed the task had moved.
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: true,
        detail: 'Step done, but the move to Code Review failed: Column is full.',
      }));
    });

    it('records a refusal that is not an Error by its text', async () => {
      hoisted.handleTaskMove.mockRejectedValueOnce('The board is read-only.');

      await expect(runStep()).resolves.toMatchObject({ verdict: 'move-failed' });

      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        detail: 'Step done, but the move to Code Review failed: The board is read-only.',
      }));
    });
  });

  // Not done gets a second ask of why the agent stopped, so recovery can tell a
  // question it must not nudge, and work still running, from a stall it nudges.
  describe('the verdict on a turn that did not finish its step', () => {
    /** The first ask says not done; the second answers `needsUser` and `running`. */
    function answers(needsUser: boolean, running: boolean): void {
      hoisted.checkAutomationConditions
        .mockImplementationOnce(async () => ({
          ok: true,
          answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'The gate has not been run.' }]]),
          agentName: 'Mock agent',
          callId: 'call-first',
        }))
        .mockImplementationOnce(async () => ({
          ok: true,
          answers: new Map([
            ['workflow-step-needs-user', { met: needsUser, reason: needsUser ? 'It asks which option the user wants.' : 'It asks the user for nothing.' }],
            ['workflow-step-running', { met: running, reason: running ? 'The gate is still running in the background.' : 'Nothing is running.' }],
          ]),
          agentName: 'Mock agent',
          callId: 'call-second',
        }));
    }

    function runWithReply(reply: string | null): ReturnType<typeof runWorkflowStep> {
      return runWorkflowStep(context, {
        payload: PAYLOAD,
        columnId: 'lane-executing',
        signal: new AbortController().signal,
        readAgentReply: async () => reply,
      });
    }

    it('says stopped when the agent needs nothing from the user and nothing is running (the incident)', async () => {
      answers(false, false);

      const result = await runWithReply("I couldn't finish: a service stopped answering. To finish: commit the working tree and run the gate.");

      expect(result).toEqual({ verdict: 'stopped', reason: 'The gate has not been run.', workSerial: TURN_WORK_SERIAL });
      // One call for the step, one for why it stopped, carrying both questions.
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(2);
      const secondRows = (hoisted.checkAutomationConditions.mock.calls[1][1] as { rows: Array<{ automationId: string }> }).rows;
      expect(secondRows.map((row) => row.automationId)).toEqual(['workflow-step-needs-user', 'workflow-step-running']);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Not done yet: The gate has not been run.',
        backgroundCallId: 'call-first',
      }));
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('says working when work the agent started is still running', async () => {
      answers(false, true);

      await expect(runWithReply('The gate is running in the background; I will report when it finishes.'))
        .resolves.toMatchObject({ verdict: 'working', reason: 'The gate is still running in the background.' });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Not done yet, still working: The gate is still running in the background.',
      }));
    });

    it('says waiting on the user only when the check shows a need the user alone can meet', async () => {
      answers(true, false);

      await expect(runWithReply('Which of the two layouts do you want?'))
        .resolves.toMatchObject({ verdict: 'waiting', reason: 'It asks which option the user wants.' });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Waiting on you: It asks which option the user wants.',
      }));
    });

    it('lets a need of the user outrank running work: a question is never left to wait out a gate', async () => {
      answers(true, true);

      await expect(runWithReply('The gate is running. Meanwhile: should the export include archived tasks?'))
        .resolves.toMatchObject({ verdict: 'waiting' });
    });

    it('calls a turn with no reply a stall, with no second ask', async () => {
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'The agent ended its turn without a message.' }]]),
        agentName: 'Mock agent',
        callId: 'call-first',
      }));

      await expect(runWithReply(null)).resolves.toMatchObject({ verdict: 'stopped' });
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    });

    it('reports a failed second ask as a check that failed, with the step recorded as not done', async () => {
      hoisted.checkAutomationConditions
        .mockImplementationOnce(async () => ({
          ok: true,
          answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'Not finished.' }]]),
          agentName: 'Mock agent',
          callId: 'call-first',
        }))
        .mockImplementationOnce(async () => ({ ok: false, reason: 'The Automation agent could not check the condition: overloaded', cause: 'failed', callId: 'call-second' }));

      await expect(runWithReply('Still going.')).resolves.toMatchObject({ verdict: 'check-failed' });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: false }));
    });
  });

  describe('a step check that could not run', () => {
    it('is recorded with no judged answer and reported as failed, so recovery tries again', async () => {
      hoisted.checkAutomationConditions.mockImplementation(async () => ({
        ok: false,
        reason: 'The Automation agent could not check the condition: 529 overloaded',
        cause: 'failed',
        callId: 'call-failed',
      }));

      await expect(runStep()).resolves.toMatchObject({ verdict: 'check-failed' });

      // Red before: `if (!outcome.ok) return;` wrote nothing at all.
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: null,
        unjudgedStatus: 'failed',
        detail: 'The step check could not run: The Automation agent could not check the condition: 529 overloaded',
        backgroundCallId: 'call-failed',
      }));
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('is a human gate, said once a visit, when no Automation agent is set up', async () => {
      hoisted.checkAutomationConditions.mockImplementation(async () => ({
        ok: false,
        reason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
        cause: 'unavailable',
      }));

      await expect(runStep()).resolves.toMatchObject({ verdict: 'human-gate', firstThisVisit: true });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: null, unjudgedStatus: 'skipped' }));

      // Already said this visit: no second row, and no second notice.
      hoisted.recordWorkflowStep.mockClear();
      hoisted.hasWorkflowStepDetailSince.mockReturnValue(true);
      await expect(runStep()).resolves.toMatchObject({ verdict: 'human-gate', firstThisVisit: false });
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
      hoisted.hasWorkflowStepDetailSince.mockReturnValue(false);
    });

    it('writes nothing when the check was stopped because the task moved on', async () => {
      hoisted.checkAutomationConditions.mockImplementation(async () => ({
        ok: false,
        reason: 'The condition check was stopped because the task moved on.',
        cause: 'stopped',
      }));

      await expect(runStep()).resolves.toBeUndefined();
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    });
  });
});
