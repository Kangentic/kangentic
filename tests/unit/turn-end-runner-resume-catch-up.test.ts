/**
 * A resumed workflow task gets the step check its last turn never got
 * (src/main/automations/turn-end/turn-end-runner.ts).
 *
 * The step check runs at a turn end, and a resumed session comes back idle with
 * no turn end. Found in the preview (#732): an agent finished its work, its
 * turn ended, and the user pressed Pause while the check was out. The pause
 * abandoned the check, which wrote nothing, and Resume brought the agent back
 * idle, so its finished reply was never judged and the task sat in its column
 * until someone typed to it. A quit or crash between a turn end and its check
 * leaves the same reply behind at the next launch.
 *
 * So a session that comes back from a resume (`'session-resumed'`) judges the
 * reply no step check has judged: one in this visit, with no step row written
 * after it. A check that answered writes its row after the reply, so a "not
 * done" is never asked twice. The column's rows never run here: they answer a
 * turn end, and a resume ends no turn.
 *
 * Driven through `registerTurnEndAutomations` and the session manager's events,
 * as the app drives it, with `catchUpAfterResume` awaited directly where a test
 * needs the pass to have finished before it asserts that nothing ran.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SessionResumedPayload, TurnEndedPayload } from '../../src/main/pty/session-manager';

const hoisted = vi.hoisted(() => ({
  runWorkflowStep: vi.fn(),
  workflowStepApplies: vi.fn(),
  executeTransition: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  retrievalCall: vi.fn(),
  hasWorkflowStepSince: vi.fn(),
  visitStartedAt: vi.fn(),
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/worktree' }));
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: () => hoisted.task, list: () => [] },
    swimlanes: { getById: () => hoisted.column, list: () => [] },
    automations: { getForTrigger: () => [{ id: 'row-keep-going', type: 'send_message', config: {}, condition: null, max_runs: null }] },
    automationRuns: {
      hasRunSince: () => false,
      hasSkipSince: () => false,
      countRuns: () => 0,
      hasWorkflowStepSince: hoisted.hasWorkflowStepSince,
    },
    taskMoves: {
      visitStartedAt: hoisted.visitStartedAt,
      currentVisit: () => ({ at: hoisted.visitStartedAt(), origin: 'renderer' }),
    },
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({
    executeTransition: hoisted.executeTransition,
    resolveGroupTemplateVars: vi.fn(() => ({})),
    conditionCheckInput: vi.fn(() => ({})),
    conditionCheckCall: vi.fn(() => ({ projectId: null, taskId: null, swimlaneId: null, job: 'condition_check' })),
    checkConditions: vi.fn(),
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
  runWorkflowStep: hoisted.runWorkflowStep,
  workflowStepApplies: hoisted.workflowStepApplies,
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

const { registerTurnEndAutomations, catchUpAfterResume } = await import('../../src/main/automations/turn-end/turn-end-runner');

const SESSION_ID = 'session-resumed-1';
const PROJECT_ID = 'project-1';
/** The resumed session's work serial: no work reported since it came back. */
const RESUMED_WORK_SERIAL = 0;
/** When the task entered Executing. */
const VISIT_STARTED_AT = '2026-10-07T15:57:41.017Z';
/** The agent's finished reply, after the visit began and before the Pause. */
const REPLY = { text: 'Created docs/livec.md with "Hello from C" content.', uuid: 'reply-1', ts: Date.parse('2026-10-07T15:57:53.382Z') };

interface FakeSessionManager extends EventEmitter {
  getActivityCache: () => Record<string, string>;
  isLatestTurn: (sessionId: string, workSerial: number) => boolean;
}

describe('a resumed workflow task and its unjudged reply', () => {
  let sessionManager: FakeSessionManager;
  let context: IpcContext;
  let currentWorkSerial: number;
  /** What the session manager reports for each session's activity; a test may change it. */
  let activityCache: Record<string, string>;
  // Armed in beforeEach and restored in afterEach, so a failed assertion cannot
  // leave console.warn silenced for the tests after it.
  let warnSpy: MockInstance<typeof console.warn>;
  let taskCounter = 0;
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.executeTransition.mockImplementation(async () => ({ results: [] }));
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.retrievalCall.mockImplementation(async () => REPLY);
    hoisted.hasWorkflowStepSince.mockImplementation(() => false);
    hoisted.visitStartedAt.mockImplementation(() => VISIT_STARTED_AT);

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

    currentWorkSerial = RESUMED_WORK_SERIAL;
    activityCache = { [SESSION_ID]: 'idle' };
    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => activityCache,
      isLatestTurn: (sessionId: string, workSerial: number) =>
        sessionId === SESSION_ID && workSerial === currentWorkSerial,
    });
    context = {
      sessionManager,
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext;
    registerTurnEndAutomations(context);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** What the runner warned: a pass that gave up writes no run record, so this is its only trace. */
  function turnEndWarnings(): string[] {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[turn-end]'));
  }

  function gaveUpWarnings(): string[] {
    return turnEndWarnings().filter((line) => line.includes('Gave up waiting'));
  }

  function resumed(): SessionResumedPayload {
    return {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      workSerial: RESUMED_WORK_SERIAL,
    };
  }

  it('judges the reply a Pause left unjudged, once the resumed session comes back', async () => {
    sessionManager.emit('session-resumed', resumed());

    await vi.waitFor(() => expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1));
    const [, input] = hoisted.runWorkflowStep.mock.calls[0] as [unknown, {
      columnId: string;
      payload: { sessionId: string; taskId: string; workSerial: number; turnStartedAt: number | null };
      readAgentReply: () => Promise<string | null>;
    }];
    expect(input.columnId).toBe('lane-executing');
    expect(input.payload).toMatchObject({ sessionId: SESSION_ID, taskId, workSerial: RESUMED_WORK_SERIAL, turnStartedAt: null });
    await expect(input.readAgentReply()).resolves.toBe(REPLY.text);
    // Judged against the reply's own time: a step row written after it means judged.
    expect(hoisted.hasWorkflowStepSince).toHaveBeenCalledWith(taskId, 'lane-executing', new Date(REPLY.ts).toISOString());
  });

  it('reads the reply from the whole transcript tail, since a resume begins no turn to anchor to', async () => {
    // A resume ends no turn, so there is no point in the transcript where "the
    // turn began": the read must send no anchor to the retrieval worker. The
    // payload below carries a stray one, as a spread of a turn-end payload
    // would, to pin that the catch-up clears it rather than relying on the
    // resume payload never having one.
    const strayAnchor = { agentSessionId: 'agent-session-1', byteOffset: 4096 };
    const resumedWithStrayAnchor = { ...resumed(), transcriptAnchor: strayAnchor };

    await catchUpAfterResume(context, resumedWithStrayAnchor);

    expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
    expect(hoisted.retrievalCall).toHaveBeenCalledWith(
      'transcript.finalReply',
      expect.objectContaining({ since: null }),
      expect.anything(),
    );
  });

  it('runs none of the column\'s turn-end rows: a resume ends no turn', async () => {
    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
  });

  it('asks nothing when a step check already judged the reply', async () => {
    // A "not done" answer wrote its row after the reply: the agent asked something.
    hoisted.hasWorkflowStepSince.mockImplementation(() => true);

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('asks nothing about a reply from before the task entered its column', async () => {
    hoisted.retrievalCall.mockImplementation(async () => ({ ...REPLY, ts: Date.parse(VISIT_STARTED_AT) - 60_000 }));

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('asks nothing when the conversation has no reply to judge', async () => {
    hoisted.retrievalCall.mockImplementation(async () => null);

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('leaves it to the next turn end when the user started work after the resume', async () => {
    // The user typed "continue" into the resumed agent: that turn ends with a
    // turn end of its own, which judges it.
    currentWorkSerial = RESUMED_WORK_SERIAL + 1;

    await catchUpAfterResume(context, resumed());

    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('goes on to the step when the wait ran out with the resumed agent idle, since its repaint is not a turn', async () => {
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
  });

  it('says so when the wait ran out, naming the resume and the activity at the give-up', async () => {
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');

    await catchUpAfterResume(context, resumed());

    const warnings = turnEndWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Gave up waiting');
    expect(warnings[0]).toContain(`task ${taskId.slice(0, 8)}'s turn`);
    expect(warnings[0]).toContain('after its resume');
    expect(warnings[0]).toContain(`session ${SESSION_ID.slice(0, 8)}`);
    expect(warnings[0]).toContain('activity idle');
    expect(warnings[0]).toContain('the pass goes on without a quiet terminal');
  });

  it('asks nothing when the wait ran out with the resumed agent not idle, since the turn is not over', async () => {
    activityCache = { [SESSION_ID]: 'thinking' };
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
    const warnings = turnEndWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('activity thinking');
    expect(warnings[0]).toContain('nothing ran');
  });

  it('names the activity as unknown when the session manager has none for the session', async () => {
    // The `?? 'unknown'` fallback: a session absent from the activity cache.
    activityCache = {};
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'timeout');

    await catchUpAfterResume(context, resumed());

    const warnings = turnEndWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Gave up waiting');
    expect(warnings[0]).toContain('activity unknown');
  });

  it('writes no give-up warning when the resumed agent settled', async () => {
    // The control for the two above: the default wait is 'completed', and the
    // pass judges the reply, so a warning there would be a false alarm.
    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
    expect(gaveUpWarnings()).toEqual([]);
  });

  it('writes no give-up warning when the wait was aborted', async () => {
    // A newer pass or a move abandoned this one on purpose: nothing was given up on.
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'aborted');

    await catchUpAfterResume(context, resumed());

    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
    expect(gaveUpWarnings()).toEqual([]);
  });

  it('reads nothing for a task outside a running workflow', async () => {
    hoisted.workflowStepApplies.mockImplementation(() => false);

    await catchUpAfterResume(context, resumed());

    expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  it('asks nothing for a session that is no longer the task\'s live one', async () => {
    // The task moved on, or another session took it over, while the resume settled.
    hoisted.task = { ...hoisted.task, session_id: 'session-other' };

    await catchUpAfterResume(context, resumed());

    expect(hoisted.runWorkflowStep).not.toHaveBeenCalled();
  });

  // The runner keeps one pass per task, and ONE request queued behind it. What
  // fills that slot decides which pass runs next, so it is pinned from both
  // directions: the two ways a "last wins" or a "first wins" slot goes wrong.
  describe('a request that arrives while a pass for the same task is running', () => {
    /** When the turn began: after the task entered Executing, so the pass judges it. */
    const TURN_STARTED_AT = Date.parse(VISIT_STARTED_AT) + 10_000;

    function turnEnded(): TurnEndedPayload {
      return {
        sessionId: SESSION_ID,
        taskId,
        projectId: PROJECT_ID,
        agentSessionId: 'agent-session-1',
        isolatedSwimlaneId: null,
        turnStartedAt: TURN_STARTED_AT,
        workSerial: RESUMED_WORK_SERIAL,
      };
    }

    /**
     * Holds the next pass open at its wait for the agent to settle, and returns
     * what lets it go. Released as 'aborted' (a wait a move superseded), the
     * held pass ends having done nothing, so every effect the test then sees
     * belongs to the queued pass.
     */
    function holdNextPassOpen(): () => void {
      let release!: () => void;
      const held = new Promise<string>((resolve) => {
        release = () => resolve('aborted');
      });
      hoisted.waitForTurnCompletion.mockImplementationOnce(() => held);
      return release;
    }

    /** The turn-ended listener hands off through setImmediate; this lets that hand-off land. */
    function untilTurnEndedListenerHasRun(): Promise<void> {
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    /** The queued pass was the real turn end: the column's rows and the step ran, for that turn. */
    function expectOnlyTheTurnEndRan() {
      // The held pass, then exactly one queued pass: the slot holds one request.
      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(2);
      // Only a turn end runs the column's rows, and only a catch-up reads the reply itself.
      expect(hoisted.executeTransition).toHaveBeenCalledTimes(1);
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
      const [, input] = hoisted.runWorkflowStep.mock.calls[0] as [unknown, { payload: TurnEndedPayload }];
      // A catch-up carries no turn start; the turn end carries its own.
      expect(input.payload.turnStartedAt).toBe(TURN_STARTED_AT);
    }

    it('lets a real turn end replace a catch-up already queued behind the pass', async () => {
      const release = holdNextPassOpen();
      const heldPass = catchUpAfterResume(context, resumed());
      // Queued behind the held pass. Resolves at once: it only fills the slot.
      await catchUpAfterResume(context, resumed());
      sessionManager.emit('turn-ended', turnEnded());
      await untilTurnEndedListenerHasRun();

      release();
      await heldPass;

      expectOnlyTheTurnEndRan();
    });

    it('does not let a catch-up replace a real turn end already queued behind the pass', async () => {
      const release = holdNextPassOpen();
      const heldPass = catchUpAfterResume(context, resumed());
      sessionManager.emit('turn-ended', turnEnded());
      await untilTurnEndedListenerHasRun();
      await catchUpAfterResume(context, resumed());

      release();
      await heldPass;

      expectOnlyTheTurnEndRan();
    });

    it('runs a catch-up queued behind the pass when nothing outranks it', async () => {
      // The control for the two above: a queued request does run, so "the catch-up
      // did not run" in them means it lost the slot rather than never being queued.
      const release = holdNextPassOpen();
      const heldPass = catchUpAfterResume(context, resumed());
      await catchUpAfterResume(context, resumed());

      release();
      await heldPass;

      expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(2);
      expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
      expect(hoisted.executeTransition).not.toHaveBeenCalled();
      expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1);
      const [, input] = hoisted.runWorkflowStep.mock.calls[0] as [unknown, { payload: TurnEndedPayload }];
      expect(input.payload.turnStartedAt).toBeNull();
    });
  });
});
