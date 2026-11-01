/**
 * The workflow catch-up seam (src/main/workflows/workflow-catch-up.ts): how a
 * workflow's Resume asks the turn-end runner to judge the reply an agent left
 * while the workflow was paused.
 *
 * Two halves, each pinned from its own side:
 *
 * - `requestWorkflowCatchUp` is the caller's gate. Only an idle agent has a
 *   finished reply waiting, and only a session that still has a work serial can
 *   say which turn that reply belongs to. A working agent's own turn end is
 *   judged as usual, and a catch-up of that same turn would judge it twice.
 * - `registerTurnEndAutomations` installs the runner on the seam. Nothing else
 *   fills it in the app, and `workflow-service.test.ts` installs its own stub,
 *   so without a test of the registration, deleting it leaves Resume asking a
 *   runner that is not there and every other test green.
 *
 * The first half runs against fakes of the session manager alone. The second
 * drives the real runner through the real seam, reusing the harness of
 * `turn-end-runner-resume-catch-up.test.ts`, and sees the catch-up by what it
 * does: the workflow step it asks for.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SessionResumedPayload } from '../../src/main/pty/session-manager';
import type { Session } from '../../src/shared/types';

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

const { requestWorkflowCatchUp, setWorkflowCatchUp } = await import('../../src/main/workflows/workflow-catch-up');
const { registerTurnEndAutomations } = await import('../../src/main/automations/turn-end/turn-end-runner');

const SESSION_ID = 'session-live-1';
const PROJECT_ID = 'project-1';
/** A work serial that is neither 0 nor 1, so a hardcoded default cannot pass for the session's own. */
const LIVE_WORK_SERIAL = 7;

/** A live task agent as the session registry lists it; only the fields the seam reads. */
function liveSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    taskId: 'task-1',
    projectId: PROJECT_ID,
    ...overrides,
  } as unknown as Session;
}

// The runner slot is module-level and both halves fill it, so every test leaves it empty.
afterEach(() => {
  setWorkflowCatchUp(null);
});

describe('requestWorkflowCatchUp: the caller\'s gates', () => {
  /** A context whose session manager reports the given activity and work serial. */
  function contextWith(activity: Record<string, string>, workSerial: number | undefined) {
    const currentWorkSerial = vi.fn<(sessionId: string) => number | undefined>(() => workSerial);
    const context = {
      sessionManager: { getActivityCache: () => activity, currentWorkSerial },
    } as unknown as IpcContext;
    return { context, currentWorkSerial };
  }

  let runner: Mock<(resumed: SessionResumedPayload) => void>;

  beforeEach(() => {
    runner = vi.fn<(resumed: SessionResumedPayload) => void>();
    setWorkflowCatchUp(runner);
  });

  it('asks the runner once for an idle agent, with its session, task, project and work serial', () => {
    const { context, currentWorkSerial } = contextWith({ [SESSION_ID]: 'idle' }, LIVE_WORK_SERIAL);

    // No agent session id and no isolated lane on the session: the payload says null, never undefined.
    requestWorkflowCatchUp(context, liveSession());

    expect(currentWorkSerial).toHaveBeenCalledWith(SESSION_ID);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      taskId: 'task-1',
      projectId: PROJECT_ID,
      agentSessionId: null,
      isolatedSwimlaneId: null,
      workSerial: LIVE_WORK_SERIAL,
      // A person's Resume: no restart line, and the schedule's own pace.
      resumedBy: 'user',
    });
  });

  it('carries the agent session id and the isolated lane through when the session has them', () => {
    const { context } = contextWith({ [SESSION_ID]: 'idle' }, LIVE_WORK_SERIAL);

    requestWorkflowCatchUp(context, liveSession({ agentSessionId: 'agent-session-9', isolatedSwimlaneId: 'lane-review' }));

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      taskId: 'task-1',
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-9',
      isolatedSwimlaneId: 'lane-review',
      workSerial: LIVE_WORK_SERIAL,
      resumedBy: 'user',
    });
  });

  it('treats a work serial of 0 as a real serial: a session that has reported no work yet still has a reply', () => {
    const { context } = contextWith({ [SESSION_ID]: 'idle' }, 0);

    requestWorkflowCatchUp(context, liveSession());

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ workSerial: 0 }));
  });

  // The serial is a real number in each of these, so only the idle gate can hold them back.
  it.each(['thinking', 'permission'])('asks nothing of an agent that is %s, whatever its work serial', (activity) => {
    const { context } = contextWith({ [SESSION_ID]: activity }, LIVE_WORK_SERIAL);

    requestWorkflowCatchUp(context, liveSession());

    expect(runner).not.toHaveBeenCalled();
  });

  it('asks nothing of a session the activity cache has no entry for', () => {
    const { context } = contextWith({}, LIVE_WORK_SERIAL);

    requestWorkflowCatchUp(context, liveSession());

    expect(runner).not.toHaveBeenCalled();
  });

  it('judges the live session\'s own activity, not another session\'s', () => {
    const { context } = contextWith({ [SESSION_ID]: 'thinking', 'session-other': 'idle' }, LIVE_WORK_SERIAL);

    requestWorkflowCatchUp(context, liveSession());

    expect(runner).not.toHaveBeenCalled();
  });

  // The agent is idle here, so only the serial gate can hold the request back.
  it('asks nothing of an idle agent whose session has no work serial', () => {
    const { context, currentWorkSerial } = contextWith({ [SESSION_ID]: 'idle' }, undefined);

    requestWorkflowCatchUp(context, liveSession());

    // Reached the serial gate and stopped there, so the idle gate was not what held it.
    expect(currentWorkSerial).toHaveBeenCalledWith(SESSION_ID);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does nothing, and does not throw, when no runner is registered', () => {
    setWorkflowCatchUp(null);
    const { context } = contextWith({ [SESSION_ID]: 'idle' }, LIVE_WORK_SERIAL);

    expect(() => requestWorkflowCatchUp(context, liveSession())).not.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('registerTurnEndAutomations: the runner behind the catch-up seam', () => {
  const REPLY = { text: 'Created docs/livec.md with "Hello from C" content.', uuid: 'reply-1', ts: Date.parse('2026-10-07T15:57:53.382Z') };
  const VISIT_STARTED_AT = '2026-10-07T15:57:41.017Z';

  let context: IpcContext;
  let taskCounter = 0;
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runWorkflowStep.mockImplementation(async () => undefined);
    hoisted.workflowStepApplies.mockImplementation(() => true);
    hoisted.executeTransition.mockImplementation(async () => ({ results: [] }));
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.retrievalCall.mockImplementation(async () => REPLY);
    hoisted.hasWorkflowStepSince.mockImplementation(() => false);
    hoisted.visitStartedAt.mockImplementation(() => VISIT_STARTED_AT);

    // The runner keeps one pass per task in a module-level map, so each test owns its task.
    taskCounter += 1;
    taskId = `task-catch-up-${taskCounter}`;
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

    context = {
      sessionManager: Object.assign(new EventEmitter(), {
        getActivityCache: () => ({ [SESSION_ID]: 'idle' }),
        currentWorkSerial: (sessionId: string) => (sessionId === SESSION_ID ? LIVE_WORK_SERIAL : undefined),
        // The pass only goes on while the serial it was handed is still the session's latest.
        isLatestTurn: (sessionId: string, workSerial: number) => sessionId === SESSION_ID && workSerial === LIVE_WORK_SERIAL,
      }),
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext;
    registerTurnEndAutomations(context);
  });

  it('judges the idle live agent\'s reply as a resume would, for its session, task, project and work serial', async () => {
    requestWorkflowCatchUp(context, liveSession({ taskId, agentSessionId: 'agent-session-1' }));

    await vi.waitFor(() => expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1));
    const [, input] = hoisted.runWorkflowStep.mock.calls[0] as [unknown, {
      columnId: string;
      payload: Record<string, unknown>;
      readAgentReply: () => Promise<string | null>;
    }];
    expect(input.columnId).toBe('lane-executing');
    // A catch-up begins no turn and has no anchor: the shape of `catchUpAfterResume`.
    expect(input.payload).toMatchObject({
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      workSerial: LIVE_WORK_SERIAL,
      turnStartedAt: null,
      transcriptAnchor: null,
    });
    await expect(input.readAgentReply()).resolves.toBe(REPLY.text);
    // It ran the step alone: a resume ends no turn, so the column's rows stay with real turn ends.
    expect(hoisted.executeTransition).not.toHaveBeenCalled();
  });

  it('hands the catch-up off the caller\'s stack, as a resume\'s is', async () => {
    requestWorkflowCatchUp(context, liveSession({ taskId }));

    // Resume is still inside its own loop over the workflow's tasks: the runner
    // has read nothing yet. The pass reaches the workflow gate synchronously once
    // it starts, so this holds only while the start waits for the immediate.
    expect(hoisted.workflowStepApplies).not.toHaveBeenCalled();
    expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(hoisted.runWorkflowStep).toHaveBeenCalledTimes(1));
    expect(hoisted.workflowStepApplies).toHaveBeenCalledTimes(1);
  });
});
