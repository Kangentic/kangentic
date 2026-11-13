/**
 * What a user loses if these reports go quiet: a defect that fails every turn-end
 * pass (so no column's On agent turn end rows run and no workflow step is
 * checked) or every workflow engine pass (so no workflow starts a task, drops a
 * stale link, or finishes) would show the user a stuck card and tell the team
 * nothing.
 *
 * These tests run the real turn-end runner and the real workflow engine host,
 * make one dependency throw a defect (a TypeError, which is never an expected
 * failure), and assert the one report that reaches `reportHandledError` and its
 * `stage` tag. They replace the source-text pins in
 * `error-reporting-chokepoints.test.ts` for these two files, which passed as
 * long as the call string sat in the file, whether or not the catch ran it.
 *
 * Every stage is driven through behavior. None needed a source read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SessionResumedPayload, TurnEndedPayload } from '../../src/main/pty/session-manager';

interface MoveInput {
  taskId: string;
  targetSwimlaneId: string;
}

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const hoisted = vi.hoisted(() => ({
  // Workflow engine host: real migrated databases by project id.
  dbs: new Map<string, unknown>(),
  // Turn-end runner: any project id gets a stand-in database handle.
  lenient: false,
  failProjectDb: null as Error | null,
  handleTaskMove: vi.fn(),
  endWorkflowAgent: vi.fn(),
  waitForTurnCompletion: vi.fn(),
  runRecoveryAttempt: vi.fn(),
  recoveryRunner: null as null | ((projectId: string, taskId: string, sessionId: string) => void),
  retrievalCall: vi.fn(),
  task: {} as Record<string, unknown>,
  column: {} as Record<string, unknown>,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    if (hoisted.failProjectDb) throw hoisted.failProjectDb;
    const projectDatabase = hoisted.dbs.get(projectId);
    if (projectDatabase) return projectDatabase;
    if (hoisted.lenient) return {};
    throw new Error(`No database for ${projectId}`);
  },
  getExistingProjectDb: (projectId: string) => hoisted.dbs.get(projectId) ?? null,
  getOpenProjectDb: (projectId: string) => hoisted.dbs.get(projectId) ?? null,
  peekProjectDb: () => null,
}));

// Workflow engine host collaborators.
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: hoisted.handleTaskMove }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ forgetRecentFetches: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  BranchCheckoutBlockedError: class BranchCheckoutBlockedError extends Error {},
  notifySpawnBlocked: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', () => ({ endWorkflowAgent: hoisted.endWorkflowAgent }));
vi.mock('../../src/main/workflows/workflow-complete', () => ({ announceWorkflowComplete: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-runtime', () => ({ setWorkflowRuntimeContext: vi.fn() }));

// Turn-end runner collaborators.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/worktree' }));
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: () => hoisted.task, list: () => [] },
    swimlanes: { getById: () => hoisted.column, list: () => [] },
    automations: { getForTrigger: () => [{ id: 'row-keep-going', type: 'send_message', config: {}, condition: null, max_runs: null }] },
    automationRuns: { hasRunSince: () => false, hasSkipSince: () => false, countRuns: () => 0, hasWorkflowStepSince: () => false },
    taskMoves: { visitStartedAt: () => null, currentVisit: () => null },
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  createTransitionEngine: vi.fn(() => ({})),
  resolveInjectionVerifier: vi.fn(() => undefined),
}));
vi.mock('../../src/main/ipc/helpers/automation-failures', () => ({ reportAutomationFailures: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
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
  heldMoveReason: vi.fn(() => null),
  runWorkflowStep: vi.fn(async () => undefined),
  workflowStepApplies: vi.fn(() => true),
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));
// The real recovery module, except the attempt (made to throw), the idle arming
// (a timer the test has no use for), and the runner hook (captured to fire it).
vi.mock('../../src/main/workflows/workflow-recovery', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/workflows/workflow-recovery')>();
  return {
    ...original,
    runRecoveryAttempt: hoisted.runRecoveryAttempt,
    armWorkflowRecoveryOnIdle: vi.fn(),
    setRecoveryAttemptRunner: (runner: (projectId: string, taskId: string, sessionId: string) => void) => {
      hoisted.recoveryRunner = runner;
      original.setRecoveryAttemptRunner(runner);
    },
  };
});

const { registerTurnEndAutomations, catchUpAfterResume, turnEndReporter } = await import('../../src/main/automations/turn-end/turn-end-runner');
const { noteAbandonedTurn, turnEndMark, userWorkMark, resetAbandonedTurnsForTests } = await import('../../src/main/automations/turn-end/abandoned-turns');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { setHomeLinkRemover } = await import('../../src/main/db/repositories/workflow-home-links');
const { registerWorkflowEngine, getWorkflowEngine, workflowEngineReporter } = await import('../../src/main/workflows/workflow-engine-host');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');

import { openTestDatabase } from './helpers/test-database';

/** The tags and name of the n-th report. */
function reportedTags(callIndex = 0): Record<string, string> {
  return reportHandledError.mock.calls[callIndex][1] as Record<string, string>;
}

describe('the turn-end runner reports a defect that fails a pass', () => {
  const SESSION_ID = 'session-report-1';
  const PROJECT_ID = 'project-1';
  const WORK_SERIAL = 0;
  const TURN_STARTED_AT = Date.parse('2026-10-07T15:57:53.000Z');
  let sessionManager: EventEmitter;
  let context: IpcContext;
  let activityCache: Record<string, string>;
  let taskCounter = 0;
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.lenient = true;
    hoisted.failProjectDb = null;
    hoisted.dbs.clear();
    hoisted.recoveryRunner = null;
    reportHandledError.mockReset();
    turnEndReporter.reset();
    resetAbandonedTurnsForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.waitForTurnCompletion.mockImplementation(async () => 'completed');
    hoisted.runRecoveryAttempt.mockImplementation(async () => undefined);
    hoisted.retrievalCall.mockImplementation(async () => null);

    taskCounter += 1;
    taskId = `task-report-${taskCounter}`;
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

    activityCache = { [SESSION_ID]: 'idle' };
    sessionManager = Object.assign(new EventEmitter(), {
      getActivityCache: () => activityCache,
      isLatestTurn: () => true,
      currentWorkSerial: () => WORK_SERIAL,
      currentTurnAnchor: () => ({ agentSessionId: 'agent-session-1', byteOffset: 4096 }),
      isInternalAgentEvent: () => false,
    });
    context = {
      sessionManager,
      mainWindow: { isDestroyed: () => false },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as unknown as IpcContext;
    registerTurnEndAutomations(context);
  });

  afterEach(() => {
    hoisted.lenient = false;
    vi.restoreAllMocks();
  });

  function turnEnded(): TurnEndedPayload {
    return {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      turnStartedAt: TURN_STARTED_AT,
      workSerial: WORK_SERIAL,
      transcriptAnchor: null,
    };
  }

  function resumed(): SessionResumedPayload {
    return {
      sessionId: SESSION_ID,
      taskId,
      projectId: PROJECT_ID,
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      workSerial: WORK_SERIAL,
    };
  }

  it('reports stage pass when a turn end\'s pass throws', async () => {
    hoisted.waitForTurnCompletion.mockImplementation(async () => { throw new TypeError('boom'); });

    sessionManager.emit('turn-ended', turnEnded());

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportedTags()).toMatchObject({ source: 'turn_end', stage: 'pass', error_name: 'TypeError' });
  });

  it('reports stage catch_up when a resume\'s catch-up throws', async () => {
    hoisted.waitForTurnCompletion.mockImplementation(async () => { throw new TypeError('boom'); });

    await catchUpAfterResume(context, resumed());

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'turn_end', stage: 'catch_up', error_name: 'TypeError' });
  });

  it('reports stage recovery when a workflow recovery attempt throws', async () => {
    hoisted.runRecoveryAttempt.mockImplementation(async () => { throw new TypeError('boom'); });
    expect(hoisted.recoveryRunner).not.toBeNull();

    hoisted.recoveryRunner!(PROJECT_ID, taskId, SESSION_ID);

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportedTags()).toMatchObject({ source: 'turn_end', stage: 'recovery', error_name: 'TypeError' });
  });

  it('reports stage reclaim when judging an abandoned turn end throws', async () => {
    noteAbandonedTurn({
      payload: turnEnded(),
      columnId: 'lane-executing',
      userWorkMarkAtTurnEnd: userWorkMark(SESSION_ID),
      turnEndMarkAtTurnEnd: turnEndMark(SESSION_ID),
    });
    // The reclaim opens the project's database after its checks pass.
    hoisted.failProjectDb = new TypeError('boom');

    sessionManager.emit('activity', SESSION_ID, 'idle');

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportedTags()).toMatchObject({ source: 'turn_end', stage: 'reclaim', error_name: 'TypeError' });
  });

  it('reports nothing for an expected failure (an abort)', async () => {
    hoisted.waitForTurnCompletion.mockImplementation(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    await catchUpAfterResume(context, resumed());

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the workflow engine host reports a defect in its own work', () => {
  const DEBOUNCE_MS = 150;
  let context: IpcContext;
  let engine: ReturnType<typeof registerWorkflowEngine>;
  let projects: Array<{ id: string; name: string; path: string }>;
  let listFails: boolean;

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    hoisted.dbs.set(projectId, projectDatabase);
    return projectDatabase;
  }

  const dbOf = (projectId: string) => hoisted.dbs.get(projectId) as Database.Database;
  const laneOf = (projectId: string, match: (lane: { role: string | null; name: string }) => boolean) =>
    new SwimlaneRepository(dbOf(projectId)).list().find(match)!;
  const todoOf = (projectId: string) => laneOf(projectId, (lane) => lane.role === 'todo');
  const doneOf = (projectId: string) => laneOf(projectId, (lane) => lane.role === 'done');
  const planningOf = (projectId: string) => laneOf(projectId, (lane) => lane.name === 'Planning');
  const advance = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);

  function createTask(projectId: string, workflowId: string, title: string, swimlaneId: string): string {
    return new TaskRepository(dbOf(projectId)).create({
      title,
      description: '',
      swimlane_id: swimlaneId,
      workflow: {
        workflow_id: workflowId,
        workflow_project_id: 'home',
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
      },
    }).id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    reportHandledError.mockReset();
    workflowEngineReporter.reset();
    hoisted.handleTaskMove.mockReset();
    hoisted.endWorkflowAgent.mockReset();
    hoisted.endWorkflowAgent.mockImplementation(async () => undefined);
    hoisted.lenient = false;
    hoisted.failProjectDb = null;
    hoisted.dbs.clear();
    database('home');
    database('mobile');
    projects = [
      { id: 'home', name: 'kangentic', path: '/mock/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/mock/mobile' },
    ];
    listFails = false;
    context = {
      projectRepo: {
        listHidden: () => [],
        list: () => {
          if (listFails) throw new TypeError('boom');
          return projects;
        },
        getById: (id: string) => projects.find((project) => project.id === id),
        isHidden: () => false,
      },
      sessionManager: Object.assign(new EventEmitter(), { getFreeAgentSlots: () => 10 }),
      boardEvents: { onBoardChanged: vi.fn(), emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    engine = registerWorkflowEngine(context);
  });

  afterEach(() => {
    getWorkflowEngine()?.dispose();
    setHomeLinkRemover(null);
    setWorkflowWake(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const projectDatabase of hoisted.dbs.values()) (projectDatabase as Database.Database).close();
    hoisted.dbs.clear();
  });

  /** A running workflow with one task waiting in the home project's To Do. */
  function workflowWithWaitingTask(): string {
    const workflows = new WorkflowRepository(dbOf('home'));
    const workflowId = workflows.create({ title: 'Usage budgets' }).id;
    createTask('home', workflowId, 'Budget page', todoOf('home').id);
    workflows.markStarted(workflowId);
    return workflowId;
  }

  it('reports stage evaluate when a pass throws', async () => {
    listFails = true;

    engine.wake();
    await advance(DEBOUNCE_MS);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'workflow_engine', stage: 'evaluate', error_name: 'TypeError' });
  });

  it('reports stage start for a start that fails, on its first attempt only', async () => {
    workflowWithWaitingTask();
    // The first attempt fails with an expected abort, which is skipped, and the
    // retry fails with a defect, which is attempt 2 and so is not reported.
    hoisted.handleTaskMove
      .mockImplementationOnce(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); })
      .mockImplementation(async () => { throw new TypeError('boom'); });

    await advance(DEBOUNCE_MS);
    expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();

    await advance(30_000 + DEBOUNCE_MS);
    expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(2);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports stage start when the first attempt of a start fails with a defect', async () => {
    workflowWithWaitingTask();
    hoisted.handleTaskMove.mockImplementation(async () => { throw new TypeError('boom'); });

    await advance(DEBOUNCE_MS);

    expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'workflow_engine', stage: 'start', error_name: 'TypeError' });
  });

  it('reports stage drop_links when dropping a link to a removed task throws', async () => {
    const workflows = new WorkflowRepository(dbOf('home'));
    const workflowId = workflows.create({ title: 'Usage budgets' }).id;
    const blockerId = createTask('mobile', workflowId, 'Budget API', planningOf('mobile').id);
    const dependentId = createTask('home', workflowId, 'Budget page', todoOf('home').id);
    new TaskLinkRepository(dbOf('home')).insert({
      workflow_id: workflowId,
      blocker_project_id: 'mobile',
      blocker_task_id: blockerId,
      blocked_project_id: 'home',
      blocked_task_id: dependentId,
    });
    workflows.markStarted(workflowId);
    // Deleted without the remover: the link end is provably gone.
    dbOf('mobile').prepare('DELETE FROM tasks WHERE id = ?').run(blockerId);
    vi.spyOn(TaskLinkRepository.prototype, 'delete').mockImplementation(() => {
      throw new TypeError('boom');
    });
    hoisted.handleTaskMove.mockImplementation(async () => undefined);

    await advance(DEBOUNCE_MS);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'workflow_engine', stage: 'drop_links', error_name: 'TypeError' });
  });

  /** A running workflow whose only task is Done, so the next pass completes it. */
  function finishedWorkflow(): string {
    const workflows = new WorkflowRepository(dbOf('home'));
    const workflowId = workflows.create({ title: 'Usage budgets' }).id;
    createTask('home', workflowId, 'Budget page', doneOf('home').id);
    workflows.markStarted(workflowId);
    return workflowId;
  }

  it('reports stage complete when finishing a workflow throws', async () => {
    finishedWorkflow();
    vi.spyOn(WorkflowRepository.prototype, 'setState').mockImplementation(() => {
      throw new TypeError('boom');
    });

    await advance(DEBOUNCE_MS);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'workflow_engine', stage: 'complete', error_name: 'TypeError' });
  });

  it('reports stage end_agent when ending the finished workflow\'s agent rejects', async () => {
    const workflowId = finishedWorkflow();
    hoisted.endWorkflowAgent.mockImplementation(async () => { throw new TypeError('boom'); });

    await advance(DEBOUNCE_MS);

    expect(hoisted.endWorkflowAgent).toHaveBeenCalledWith(context, workflowId);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'workflow_engine', stage: 'end_agent', error_name: 'TypeError' });
    expect(new WorkflowRepository(dbOf('home')).getById(workflowId)?.state).toBe('done');
  });
});
