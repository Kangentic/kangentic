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
import type { ColumnAutomation } from '../../src/shared/types';
import type { OpenWork } from '../../src/main/activity-engine/open-work-ledger';

const hoisted = vi.hoisted(() => ({
  checkAutomationConditions: vi.fn(),
  handleTaskMove: vi.fn(),
  recordWorkflowStep: vi.fn(),
  hasWorkflowStepDetailSince: vi.fn(() => false),
  task: {} as Record<string, unknown>,
  /** The state the workflow row reads, which a test moves to pause it. */
  workflowState: 'running',
  /** The column's enabled turn-end rows, which the step reads for its exit rows. */
  turnEndRows: [] as ColumnAutomation[],
  /** The row read the step makes, kept so a test can say which column and trigger it asked for. */
  getForTrigger: vi.fn(),
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
  { id: 'lane-todo', name: 'To Do', position: 0, role: 'todo', is_archived: false, is_ghost: false, description: null, auto_spawn: false },
  { id: 'lane-executing', name: 'Executing', position: 1, role: null, is_archived: false, is_ghost: false, description: null, auto_spawn: true },
  { id: 'lane-review', name: 'Code Review', position: 2, role: null, is_archived: false, is_ghost: false, description: null, auto_spawn: true },
  { id: 'lane-done', name: 'Done', position: 3, role: 'done', is_archived: false, is_ghost: false, description: null, auto_spawn: false },
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
    automations: { getForTrigger: hoisted.getForTrigger },
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
  /** What the session's hook events show still open (`SessionManager.getOpenWork`). */
  let openWork: OpenWork;

  beforeEach(() => {
    openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
    vi.clearAllMocks();
    hoisted.workflowState = 'running';
    hoisted.turnEndRows = [];
    // Set here, not in `vi.hoisted`, so it reads the rows a test assigns and a
    // reset or clear of the mocks never leaves it answering nothing.
    hoisted.getForTrigger.mockImplementation(() => hoisted.turnEndRows);
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
    // Reset, not only cleared: an answer a test queued and never used must not
    // answer the next test's check.
    hoisted.checkAutomationConditions.mockReset();
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
        getOpenWork: () => openWork,
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

    // A Pause that lands while the step's move waits for the task lock: the
    // lock then refuses the workflow's own move (WORKFLOW_REFUSALS.pausedForAgents),
    // so the move throws. The Pause is working, not a failed move. The workflow
    // flips inside the move, after the check's own `settled()` read it running.
    describe('when the move throws', () => {
      const PAUSED_REFUSAL = '#12 is in Release flow, which is paused. Resume it to move its tasks.';

      it('records no failed-move row and reports no verdict when the workflow was paused meanwhile', async () => {
        hoisted.handleTaskMove.mockImplementationOnce(async () => {
          hoisted.workflowState = 'paused';
          throw new Error(PAUSED_REFUSAL);
        });

        // Nothing to recover: the reply is judged again after Resume.
        await expect(runStep()).resolves.toBeUndefined();

        expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
        expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
      });

      it('still records the failed move and reports it when the workflow is running', async () => {
        hoisted.handleTaskMove.mockImplementationOnce(async () => {
          throw new Error('Column is full.');
        });

        await expect(runStep()).resolves.toEqual({
          verdict: 'move-failed',
          reason: 'the move to Code Review failed: Column is full.',
          workSerial: TURN_WORK_SERIAL,
        });

        expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
        expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
          met: true,
          detail: 'Step done, but the move to Code Review failed: Column is full.',
        }));
      });
    });
  });

  // Task #952: classify narrowly, unblock broadly. Only the agent's own
  // `Needs owner:` line waits on the owner; "still working" comes from the hook
  // events, never the wording; anything else is a stall, with a second ask that
  // names what it is stuck on so the nudge can aim at it.
  describe('the verdict on a turn that did not finish its step', () => {
    function firstAskNotDone(): void {
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'The gate has not been run.' }]]),
        agentName: 'Mock agent',
        callId: 'call-first',
      }));
    }

    /** The first ask says not done; the second names the blockers given. */
    function answers(blockers: { resource: boolean; mainFailsToo: boolean }): void {
      firstAskNotDone();
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([
          ['workflow-step-blocker:resource', { met: blockers.resource, reason: blockers.resource ? 'The gate was stopped for memory.' : 'Nothing about load.' }],
          ['workflow-step-blocker:main-fails-too', { met: blockers.mainFailsToo, reason: blockers.mainFailsToo ? 'main fails them too.' : 'Nothing about main.' }],
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

    it('says stopped, naming no blocker, when the reply names nothing the rows know (the incident)', async () => {
      answers({ resource: false, mainFailsToo: false });

      const result = await runWithReply("I couldn't finish: a service stopped answering. To finish: commit the working tree and run the gate.");

      expect(result).toEqual({ verdict: 'stopped', reason: 'The gate has not been run.', workSerial: TURN_WORK_SERIAL, blockers: [] });
      // One call for the step, one for what it is stuck on, carrying every blocker row.
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(2);
      const secondRows = (hoisted.checkAutomationConditions.mock.calls[1][1] as { rows: Array<{ automationId: string }> }).rows;
      expect(secondRows.map((row) => row.automationId)).toEqual(['workflow-step-blocker:resource', 'workflow-step-blocker:main-fails-too']);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Not done yet: The gate has not been run.',
        backgroundCallId: 'call-first',
      }));
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('names the blockers the reply describes, for the nudge to aim at (a gate killed on load that main fails too)', async () => {
      answers({ resource: true, mainFailsToo: true });

      await expect(runWithReply('Two of the three failing tests also fail on a clean main, and other runs were loading the machine.'))
        .resolves.toMatchObject({ verdict: 'stopped', blockers: ['resource', 'main-fails-too'] });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        detail: 'Not done yet: The gate has not been run. Stuck on: resource, main-fails-too.',
      }));
    });

    it('names the task\'s own base branch in the main-fails-too row, never a literal main', async () => {
      hoisted.task = { ...hoisted.task, base_branch: 'develop', resolved_base_branch: null };
      answers({ resource: false, mainFailsToo: false });
      await runWithReply('Stopped.');
      const secondRows = (hoisted.checkAutomationConditions.mock.calls[1][1] as { rows: Array<{ automationId: string; condition: string }> }).rows;
      expect(secondRows.find((row) => row.automationId === 'workflow-step-blocker:main-fails-too')?.condition).toContain('develop');
    });

    it('says working, with no second ask, when the hook events show a background command still open', async () => {
      openWork.backgroundShells = [{ id: 'shell-1', command: 'npm run test:unit', since: 1 }];
      firstAskNotDone();

      await expect(runWithReply('I will report when it finishes.'))
        .resolves.toMatchObject({ verdict: 'working', reason: 'The gate has not been run.' });
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Not done yet, still working: a background command is still running: npm run test:unit.',
      }));
    });

    it('says working for a background subagent still running past the turn end', async () => {
      openWork.backgroundSubagents = [{ id: 'agent-1', type: 'Explore', since: 1 }];
      firstAskNotDone();

      await expect(runWithReply('Waiting on the explorer.')).resolves.toMatchObject({ verdict: 'working' });
    });

    it('never reads "still working" from the wording: a reply that says it waits, with nothing open, is a stall', async () => {
      answers({ resource: false, mainFailsToo: false });

      await expect(runWithReply('The gate is running in the background; I will report when it finishes.'))
        .resolves.toMatchObject({ verdict: 'stopped' });
    });

    it('waits on the owner when the reply ends on its Needs owner line, with no paid check', async () => {
      await expect(runWithReply('I compared both layouts.\n\nNeeds owner: keep the old export, or drop it?'))
        .resolves.toMatchObject({ verdict: 'waiting', reason: 'keep the old export, or drop it?' });
      expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Waiting on you: keep the old export, or drop it?',
      }));
    });

    it('waits on the owner with a stand-in reason when the Needs owner line names no question', async () => {
      await expect(runWithReply('Done with the analysis.\nNeeds owner:')).resolves.toEqual({
        verdict: 'waiting',
        reason: 'the agent needs the owner to decide something.',
        workSerial: TURN_WORK_SERIAL,
      });
      expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        detail: 'Waiting on you: the agent needs the owner to decide something.',
      }));
    });

    // Reading the reply can take a while, as a check does. Whatever overtakes the
    // turn meanwhile owns what happens next, and the owner is not told to answer
    // a question from a turn that is no longer the agent's latest word.
    describe('when the turn is overtaken while the reply is read', () => {
      const NEEDS_OWNER_REPLY = 'I compared both layouts.\n\nNeeds owner: keep the old export, or drop it?';

      /** Runs the step on a Needs owner reply, with `whileReading` happening as the reply is read. */
      function runReadingReply(whileReading: () => void): ReturnType<typeof runWorkflowStep> {
        return runWorkflowStep(context, {
          payload: PAYLOAD,
          columnId: 'lane-executing',
          signal: new AbortController().signal,
          readAgentReply: async () => {
            whileReading();
            return NEEDS_OWNER_REPLY;
          },
        });
      }

      it('waits on the owner when nothing overtook it (the control)', async () => {
        await expect(runReadingReply(() => undefined)).resolves.toMatchObject({ verdict: 'waiting' });
        expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
          detail: 'Waiting on you: keep the old export, or drop it?',
        }));
      });

      it.each([
        // Said so, as after a check, so the runner can judge the reply again.
        ['a newer turn starts', 'newer-turn', () => { currentWorkSerial = NEXT_TURN_WORK_SERIAL; }],
        ['the task moves to another column', undefined, () => { moveTaskTo('lane-review'); }],
        ['the agent picks up work again', undefined, () => { activity[SESSION_ID] = 'thinking'; }],
        ['the workflow is paused', undefined, () => { hoisted.workflowState = 'paused'; }],
      ] as const)('reports no waiting verdict and writes no Waiting on you row when %s', async (_label, expected, whileReading) => {
        const result = await runReadingReply(whileReading);

        expect(result).toBe(expected);
        expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
        expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
        expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      });
    });

    it('lets the Needs owner line outrank running work: a question is never left to wait out a gate', async () => {
      openWork.backgroundShells = [{ id: 'shell-1', command: 'npm test', since: 1 }];
      await expect(runWithReply('The gate is running.\nNeeds owner: should the export include archived tasks?'))
        .resolves.toMatchObject({ verdict: 'waiting' });
    });

    it('does not wait on a question asked any other way: the nudge tells the agent how to ask', async () => {
      answers({ resource: false, mainFailsToo: false });
      await expect(runWithReply('Which of the two layouts do you want?')).resolves.toMatchObject({ verdict: 'stopped' });
    });

    it('calls a turn with no reply a stall, with no second ask', async () => {
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: false, reason: 'The agent ended its turn without a message.' }]]),
        agentName: 'Mock agent',
        callId: 'call-first',
      }));

      await expect(runWithReply(null)).resolves.toMatchObject({ verdict: 'stopped', blockers: [] });
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(1);
    });

    it('still nudges when the blocker ask fails: a stall with the general nudge, recorded as not done', async () => {
      firstAskNotDone();
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({ ok: false, reason: 'The Automation agent could not check the condition: overloaded', cause: 'failed', callId: 'call-second' }));

      await expect(runWithReply('Still going.')).resolves.toMatchObject({ verdict: 'stopped', blockers: [] });
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({ met: false }));
    });

    it('reports no verdict and writes nothing when the blocker ask was stopped because the task moved on', async () => {
      firstAskNotDone();
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: false,
        reason: 'The condition check was stopped because the task moved on.',
        cause: 'stopped',
      }));

      // The move owns what happens next, so there is nothing to nudge.
      await expect(runWithReply('Still going.')).resolves.toBeUndefined();
      expect(hoisted.checkAutomationConditions).toHaveBeenCalledTimes(2);
      expect(hoisted.recordWorkflowStep).not.toHaveBeenCalled();
    });
  });

  // Task 916: Code Review's two rows route on "Verdict: Blocked" (back to Executing)
  // and "Verdict: Ready" (on). The review ended "No changes to review.", which
  // neither matched, and the check answered met and moved the task on. The
  // column's own exit rows now outrank the check's yes. Every test here has the
  // check answer met, so a stay is the rows' doing.
  describe('a column\'s own exit rows outrank the check\'s yes', () => {
    const NO_CHANGES_REPLY = 'The branch is identical to main.\n\nNo changes to review.';

    function exitRow(name: string, finalLine: string, targetColumn: string, maxRuns: number | null): ColumnAutomation {
      return {
        id: `row-${name.toLowerCase().replace(/\s+/g, '-')}`,
        swimlane_id: 'lane-review',
        name,
        type: 'move_to_column',
        trigger: 'turn_end',
        position: 0,
        enabled: true,
        config: { targetColumn },
        condition: null,
        final_line: finalLine,
        max_runs: maxRuns,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };
    }

    const BACK_FOR_REVISIONS = exitRow('Back for revisions', 'Verdict: Blocked', 'Executing', 3);
    const ON_TO_DONE = exitRow('On to Done', 'Verdict: Ready', 'Done', 1);

    /** The first ask answers met. Queued alone: a test that moves the task makes no second ask. */
    function checkSaysDone(): void {
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([[WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'Code Review step finished: the agent reported no diff against main.' }]]),
        agentName: 'Mock agent',
        callId: 'call-first',
      }));
    }

    /** The second ask, of what the agent is stuck on: no blocker the rows know. */
    function whyStopped(): void {
      hoisted.checkAutomationConditions.mockImplementationOnce(async () => ({
        ok: true,
        answers: new Map([
          ['workflow-step-blocker:resource', { met: false, reason: 'Nothing about load.' }],
          ['workflow-step-blocker:main-fails-too', { met: false, reason: 'Nothing about main.' }],
        ]),
        agentName: 'Mock agent',
        callId: 'call-second',
      }));
    }

    function reviewWithReply(reply: string | null): ReturnType<typeof runWorkflowStep> {
      hoisted.task = { ...hoisted.task, swimlane_id: 'lane-review' };
      return runWorkflowStep(context, {
        payload: PAYLOAD,
        columnId: 'lane-review',
        signal: new AbortController().signal,
        readAgentReply: async () => reply,
      });
    }

    it('does not move on a reply no row matches, and nudges it as a stall (the incident)', async () => {
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
      checkSaysDone();
      whyStopped();

      const result = await reviewWithReply(NO_CHANGES_REPLY);

      const reason = 'the final line, "No changes to review.", is not one Code Review moves the task on from';
      expect(result).toEqual({ verdict: 'stopped', reason, workSerial: TURN_WORK_SERIAL, blockers: [] });
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledTimes(1);
      expect(hoisted.recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
        met: false,
        reason,
        detail: `Not done yet: ${reason}`,
        backgroundCallId: 'call-first',
      }));
      // The reason states the fact. It never hands the agent a line to type.
      expect(reason).not.toContain('Verdict');
    });

    it('still moves on when the column has no move rows (the control)', async () => {
      checkSaysDone();

      await expect(reviewWithReply(NO_CHANGES_REPLY)).resolves.toMatchObject({ verdict: 'done' });

      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: 'task-1', targetSwimlaneId: 'lane-done' }),
        'workflow',
        PROJECT_ID,
        '/mock/project',
        expect.anything(),
      );
    });

    it('does not move on a verdict only a send-back row matches, as when that row has spent its runs', async () => {
      // A fourth "Verdict: Blocked": the row's Frequency is spent, so it ran
      // nothing, and the step must not send the task forward in its place.
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
      checkSaysDone();
      whyStopped();

      const result = await reviewWithReply('1. src/main/a.ts:4: commit the extraction\nVerdict: Blocked');

      expect(result).toMatchObject({ verdict: 'stopped', reason: 'the final line, "Verdict: Blocked", sends the task back to Executing' });
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('moves on a verdict a forward row matches, as when that row has spent its one run', async () => {
      // A second pass through Code Review: "On to Done" is maxRuns 1, so the
      // step is what moves the task on.
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
      checkSaysDone();

      await expect(reviewWithReply('### Summary\n\nVerdict: Ready')).resolves.toMatchObject({ verdict: 'done' });

      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ targetSwimlaneId: 'lane-done' }),
        'workflow',
        PROJECT_ID,
        '/mock/project',
        expect.anything(),
      );
    });

    it('accepts a forward row whose target is Next column', async () => {
      hoisted.turnEndRows = [exitRow('On', 'Verdict: Ready', '', null)];
      checkSaysDone();

      await expect(reviewWithReply('Verdict: Ready')).resolves.toMatchObject({ verdict: 'done' });
      expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
    });

    it('stops for the owner when the reply no row matches ends on its Needs owner line', async () => {
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];

      await expect(reviewWithReply('The branch matches main.\nNeeds owner: review the release branch instead?'))
        .resolves.toMatchObject({ verdict: 'waiting', reason: 'review the release branch instead?' });
      expect(hoisted.checkAutomationConditions).not.toHaveBeenCalled();
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    it('nudges a question the reply asks any other way as a stall', async () => {
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
      checkSaysDone();
      whyStopped();

      await expect(reviewWithReply('The branch matches main. Should I review the release branch instead?'))
        .resolves.toMatchObject({ verdict: 'stopped' });
      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });

    /** Where the step must have moved the task: Done, the column after Code Review. */
    function expectMovedToDone(): void {
      expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: 'task-1', targetSwimlaneId: 'lane-done' }),
        'workflow',
        PROJECT_ID,
        '/mock/project',
        expect.anything(),
      );
    }

    // Which rows count as exits. The step reads only a column's turn-end rows
    // that move the task, behind a Text match, in a column that can run them,
    // whose target names a column. A row outside that is no exit, and a column
    // left with no forward exit lets the check alone judge.
    describe('which rows count as exits', () => {
      // Send message has no target, so a row of it read as an exit would resolve
      // to Next column (Done) and count as forward.
      const WAIT_FOR_CI: ColumnAutomation = {
        ...exitRow('Wait for CI', 'Checks pending', '', null),
        type: 'send_message',
        config: { message: 'Wait for CI.' },
      };

      it('does not count a row that moves nothing, so its Text match cannot send the task on', async () => {
        hoisted.turnEndRows = [WAIT_FOR_CI, ON_TO_DONE];
        checkSaysDone();
        whyStopped();

        // The line the Send message row matches is not one a row that moves the
        // task matches, so the one real exit (On to Done) refuses it.
        const result = await reviewWithReply('Checks pending');

        expect(result).toMatchObject({
          verdict: 'stopped',
          reason: 'the final line, "Checks pending", is not one Code Review moves the task on from',
        });
        expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      });

      it('leaves the check alone when the only row with a Text match moves nothing', async () => {
        hoisted.turnEndRows = [WAIT_FOR_CI];
        checkSaysDone();

        await expect(reviewWithReply('No changes to review.')).resolves.toMatchObject({ verdict: 'done' });

        expectMovedToDone();
      });

      it('has no exits in a column that cannot run the rows, so the check alone judges', async () => {
        // Start an agent here is off, so no agent ends a turn in this column and
        // neither row would ever run. The COLUMNS objects are what the repository
        // mock returns, so the column is put back whatever the test does.
        const reviewColumn = COLUMNS.find((column) => column.id === 'lane-review');
        if (!reviewColumn) throw new Error('The test board has no Code Review column.');
        const autoSpawnBefore = reviewColumn.auto_spawn;
        reviewColumn.auto_spawn = false;
        try {
          hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
          checkSaysDone();

          await expect(reviewWithReply('No changes to review.')).resolves.toMatchObject({ verdict: 'done' });

          expectMovedToDone();
        } finally {
          reviewColumn.auto_spawn = autoSpawnBefore;
        }
      });

      it('does not count a move row with no Text match, as a Condition-only row has none', async () => {
        const conditionOnly: ColumnAutomation = {
          ...exitRow('Condition only', '', 'Done', null),
          final_line: null,
          condition: 'All the tests pass',
        };
        hoisted.turnEndRows = [conditionOnly];
        checkSaysDone();

        await expect(reviewWithReply('No changes to review.')).resolves.toMatchObject({ verdict: 'done' });

        expectMovedToDone();
      });

      it('does not count a row whose target names no column, so it neither moves the task on nor sends it back', async () => {
        // The row matches the reply, but its target resolves to no column, and the
        // forward row beside it does not match: nothing moves the task on from here.
        hoisted.turnEndRows = [exitRow('Nowhere', 'No changes to review.', 'No such column', null), ON_TO_DONE];
        checkSaysDone();
        whyStopped();

        const result = await reviewWithReply('No changes to review.');

        expect(result).toMatchObject({
          verdict: 'stopped',
          reason: 'the final line, "No changes to review.", is not one Code Review moves the task on from',
        });
        expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      });
    });

    it('reads the rows of the column\'s turn end, once the check says done', async () => {
      hoisted.turnEndRows = [BACK_FOR_REVISIONS, ON_TO_DONE];
      checkSaysDone();

      await expect(reviewWithReply('Verdict: Ready')).resolves.toMatchObject({ verdict: 'done' });

      // The rows of this column, for this trigger: not another column's, and not
      // the enter or exit rows, which say nothing about where a turn end sends the task.
      expect(hoisted.getForTrigger).toHaveBeenCalledTimes(1);
      expect(hoisted.getForTrigger).toHaveBeenCalledWith('lane-review', 'turn_end');
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
