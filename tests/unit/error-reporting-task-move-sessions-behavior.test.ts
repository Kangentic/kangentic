/**
 * What a user loses if these reports go quiet: a drag whose exit or enter rules
 * never ran, a card that keeps the last run's PR chip, a phone that never hears
 * its move land, a session record that stays `queued` or `running` after the
 * agent ended, a resume that names a conversation the CLI no longer has, an
 * "Agent didn't start" notice that never shows, a PR that never links, and a
 * sign-in or usage read on the Accounts tab that fails with nothing on screen.
 * Each of those fails today with a console line and nothing in Sentry.
 *
 * Each case runs the real entry point (`handleTaskMove`, the listeners
 * `registerSessionHandlers` attaches to the session manager, the Accounts
 * handlers), makes ONE dependency throw a code defect whose message quotes a
 * task title, and asserts the report's source and stage tags, that nothing of
 * the title reached the serialized call, and what the user still gets.
 *
 * Modules are reloaded per case (`vi.resetModules`) because each reporter is
 * module-private and latches a key once per run: a second case that passed only
 * because the first latched its key would prove nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { EventType, type Swimlane, type Task } from '../../src/shared/types';
import { reportedFailures, reportedText, type ReportedFailure } from './helpers/reported-failures';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the describe can unmock it when done. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

function removeInstalledMocks(): void {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.resetModules();
}

/** A defect whose message quotes user text, as V8 quotes the property it could not read. */
function userTextDefect(): TypeError {
  return new TypeError("Cannot read properties of undefined (reading 'Fix Acme billing')");
}

/** The whole call, with each Error spelled out, so a title in a message or a stack header shows. */
function serializeCalls(calls: unknown[][]): string {
  return JSON.stringify(calls, (_key, value) => (value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack, cause: String(value.cause ?? '') }
    : value));
}

function expectNoUserText(): void {
  expect(reportedText(reportHandledError)).not.toMatch(/acme/i);
  // Also spells out an Error nested in a tag or context, with its cause, which the shared text does not.
  expect(serializeCalls(reportHandledError.mock.calls)).not.toMatch(/acme/i);
}

function reportsFrom(source: string): ReportedFailure[] {
  return reportedFailures(reportHandledError).filter((report) => report.tags.source === source);
}

function silenceConsole(): void {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}

// ---------------------------------------------------------------------------
// handleTaskMove: the stages after the move row is written
// ---------------------------------------------------------------------------

describe('handleTaskMove stages', () => {
  const DOING_LANE_ID = 'lane-doing';
  const TODO_LANE_ID = 'lane-todo';
  const TASK_ID = 'task-aaa00001';
  const MOVE_TO_TODO = { taskId: TASK_ID, targetSwimlaneId: TODO_LANE_ID, targetPosition: 0 };

  const harness = {
    forgetImplementation: vi.fn(),
    executeTransition: vi.fn(),
    /** Throws from the Nth push on the mobile move channel, counting from 1. Zero: never. */
    throwOnMobilePush: 0,
    mobilePushes: 0,
  };
  let handleTaskMove: typeof import('../../src/main/ipc/handlers/task-move').handleTaskMove;

  function makeTask(): Task {
    return {
      id: TASK_ID,
      display_id: 1,
      title: 'Fix Acme billing',
      description: '',
      swimlane_id: DOING_LANE_ID,
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      use_worktree: null,
      labels: [],
      priority: 0,
      attachment_count: 0,
      archived_at: null,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    } as Task;
  }

  function makeLane(id: string, role: string | null): Swimlane {
    return {
      id,
      name: `Lane ${id}`,
      role,
      position: 0,
      color: '#888',
      icon: null,
      is_archived: false,
      is_ghost: false,
      permission_mode: null,
      auto_spawn: true,
      auto_command: null,
      plan_exit_target_id: null,
      agent_override: null,
      model_override: null,
      effort_override: null,
      handoff_context: false,
      created_at: '2025-01-01T00:00:00.000Z',
    } as Swimlane;
  }

  function makeContext() {
    const task = makeTask();
    const lanes = new Map([
      [DOING_LANE_ID, makeLane(DOING_LANE_ID, null)],
      [TODO_LANE_ID, makeLane(TODO_LANE_ID, 'todo')],
    ]);
    const getById = vi.fn()
      .mockReturnValueOnce({ ...task })
      .mockReturnValue({ ...task, swimlane_id: TODO_LANE_ID });
    const tasks = { getById, move: vi.fn(), update: vi.fn(), list: vi.fn(() => [{ ...task }]), archive: vi.fn(), clearArchived: vi.fn() };
    mockGetProjectRepos.mockReturnValue({
      tasks,
      swimlanes: { getById: vi.fn((id: string) => lanes.get(id) ?? null), list: vi.fn(() => [...lanes.values()]) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { deleteByTaskId: vi.fn() },
      automations: {},
      automationRuns: {},
    });
    const send = vi.fn((channel: string) => {
      if (channel !== IPC.TASK_MOVED_BY_MOBILE) return;
      harness.mobilePushes += 1;
      if (harness.mobilePushes === harness.throwOnMobilePush) throw userTextDefect();
    });
    return {
      tasks,
      send,
      context: {
        currentProjectId: 'proj-test',
        currentProjectPath: '/mock/project',
        boardEvents: { emitBoardChanged: vi.fn() },
        mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send } },
        sessionManager: {
          removeByTaskId: vi.fn(),
          killByTaskId: vi.fn(),
          listSessions: vi.fn(() => []),
          suspend: vi.fn(async () => {}),
          drainQueue: vi.fn(),
          columnBlocks: vi.fn(() => false),
          isResuming: vi.fn(() => false),
          holdColumnSlot: vi.fn(() => () => undefined),
          getSession: vi.fn((id: string) => ({ id, status: 'running' })),
          findLiveSessionByTaskId: vi.fn(() => null),
        },
        configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
        boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
        terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
        projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
      },
    };
  }

  const mockGetProjectRepos = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    reportHandledError.mockReset();
    harness.forgetImplementation.mockReset();
    harness.executeTransition.mockReset();
    harness.executeTransition.mockResolvedValue({ failures: [] });
    harness.throwOnMobilePush = 0;
    harness.mobilePushes = 0;
    silenceConsole();
    installMocks({
      electron: () => ({ ipcMain: { handle: vi.fn() } }),
      '../../src/main/git/git-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/git-client')>('../../src/main/git/git-client')),
        gitAt: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
      }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class {} }),
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class {
          getLatestForTask = vi.fn(() => null);
          updateGitStats = vi.fn();
        },
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class {} }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class {} }),
      '../../src/main/db/repositories/attachment-repository': () => ({ AttachmentRepository: class {} }),
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: class {
          withLock = vi.fn(async (work: () => Promise<unknown>) => work());
          removeWorktree = vi.fn(async () => true);
          pruneWorktrees = vi.fn(async () => {});
          removeBranch = vi.fn(async () => {});
          static scheduleBackgroundPrune = vi.fn();
        },
      }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (text: string) => text }),
      '../../src/main/pr/pr-linking': () => ({ autoLinkPRForTask: vi.fn() }),
      '../../src/main/pr/pr-link-reset': () => ({
        forgetPRLinkOnTodoReset: (...callArguments: unknown[]) => harness.forgetImplementation(...callArguments),
      }),
      '../../src/main/transition-engine/session-lifecycle': () => ({ markRecordExited: vi.fn(), markRecordSuspended: vi.fn() }),
      '../../src/main/transition-engine/spawn-progress': () => ({
        emitSpawnProgress: vi.fn(),
        clearSpawnProgress: vi.fn(),
        createProgressCallback: vi.fn(() => vi.fn()),
      }),
      '../../src/main/transition-engine/agent-resolver': () => ({ resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })) }),
      '../../src/main/ipc/handlers/backlog': () => ({ abortBacklogPromotion: vi.fn() }),
      '../../src/main/ipc/handlers/session-metrics': () => ({
        captureSessionMetrics: vi.fn(),
        refineTranscriptTokens: vi.fn(),
        refineTranscriptToolCounts: vi.fn(),
      }),
      '../../src/main/agent/shared': () => ({
        interpolateTemplate: vi.fn((template: string) => template),
        resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
        execVersion: vi.fn(async () => '1.0.0'),
      }),
      '../../src/main/ipc/helpers/index': () => ({
        getProjectRepos: (...callArguments: unknown[]) => mockGetProjectRepos(...callArguments),
        ensureTaskWorktree: vi.fn(async () => undefined),
        ensureTaskBranchCheckout: vi.fn(async () => {}),
        spawnAgent: vi.fn(async () => {}),
        createTransitionEngine: vi.fn(() => ({ executeTransition: (...callArguments: unknown[]) => harness.executeTransition(...callArguments) })),
        cleanupTaskResources: vi.fn(async () => {}),
        deleteTaskWorktree: vi.fn(async () => true),
        autoSpawnForTask: vi.fn(async () => {}),
        reportAutomationFailures: vi.fn(),
      }),
    });
    ({ handleTaskMove } = await import('../../src/main/ipc/handlers/task-move'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(removeInstalledMocks);

  it('reports the exit automations that cannot run once, as exit_automations, and the move still lands', async () => {
    harness.executeTransition.mockImplementation(async (_task: unknown, _lane: unknown, trigger: string) => {
      if (trigger === 'exit') throw userTextDefect();
      return { failures: [] };
    });
    const { context, tasks } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'exit_automations', error_name: 'TypeError' });
    expect(reports[0].sent.message).toBe('Handled task_move failure: TypeError');
    expectNoUserText();
    expect(tasks.move).toHaveBeenCalledTimes(1);
  });

  it('reports the enter automations that cannot run once, as enter_automations, and the move still lands', async () => {
    harness.executeTransition.mockImplementation(async (_task: unknown, _lane: unknown, trigger: string) => {
      if (trigger === 'enter') throw userTextDefect();
      return { failures: [] };
    });
    const { context, tasks } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'enter_automations', error_name: 'TypeError' });
    expectNoUserText();
    expect(tasks.move).toHaveBeenCalledTimes(1);
  });

  it('reports a failed PR forget at the commit, as pr_forget, and still runs the To Do reset', async () => {
    harness.forgetImplementation
      .mockImplementationOnce(() => { throw userTextDefect(); })
      .mockImplementation(() => undefined);
    const { context } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'pr_forget' });
    expectNoUserText();
    // The second pass, after the cleanup, still ran.
    expect(harness.forgetImplementation).toHaveBeenCalledTimes(2);
  });

  it('reports a failed PR forget after the cleanup, as pr_forget, from the second pass', async () => {
    harness.forgetImplementation
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw userTextDefect(); });
    const { context } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'pr_forget' });
    expectNoUserText();
    expect(harness.forgetImplementation).toHaveBeenCalledTimes(2);
  });

  it('reports a commit-time push that throws as commit_push, and the settle-time push still goes out', async () => {
    harness.throwOnMobilePush = 1;
    const { context, send } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'mobile')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'commit_push' });
    expectNoUserText();
    // Both pushes were attempted: the failed one did not stop the settle announce.
    expect(send.mock.calls.filter((call) => call[0] === IPC.TASK_MOVED_BY_MOBILE)).toHaveLength(2);
  });

  it('reports a settle-time push that throws as settle_announce, and the move still resolves', async () => {
    harness.throwOnMobilePush = 2;
    const { context } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'mobile')).resolves.toBeUndefined();

    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'settle_announce' });
    expectNoUserText();
  });

  it('reports a caller callback that throws as on_committed, and the move still runs to its end', async () => {
    const { context, tasks } = makeContext();
    const onCommitted = vi.fn(() => { throw userTextDefect(); });

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer', undefined, undefined, { onCommitted })).resolves.toBeUndefined();

    expect(onCommitted).toHaveBeenCalledTimes(1);
    const reports = reportsFrom('task_move');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'task_move', stage: 'on_committed' });
    expectNoUserText();
    // The reset after the commit still ran: the exit group asked the engine.
    expect(harness.executeTransition).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'exit', expect.anything());
    expect(tasks.move).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a move whose steps all succeed', async () => {
    const { context } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'mobile', undefined, undefined, { onCommitted: vi.fn() })).resolves.toBeUndefined();

    expect(reportsFrom('task_move')).toHaveLength(0);
  });

  it('reports nothing for an exit group stopped by an abort', async () => {
    harness.executeTransition.mockImplementation(async (_task: unknown, _lane: unknown, trigger: string) => {
      if (trigger === 'exit') throw new DOMException('The operation was aborted', 'AbortError');
      return { failures: [] };
    });
    const { context } = makeContext();

    await expect(handleTaskMove(context as never, MOVE_TO_TODO, 'renderer')).resolves.toBeUndefined();

    expect(reportsFrom('task_move')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// registerSessionHandlers: the listeners it attaches to the session manager
// ---------------------------------------------------------------------------

describe('session handler listeners', () => {
  const PROJECT_ID = 'proj-1';
  type Listener = (...listenerArguments: unknown[]) => unknown;

  const control = {
    databaseError: null as Error | null,
    database: null as Database.Database | null,
    pauseTaskSession: vi.fn(),
    linkPR: vi.fn(),
    recordPushedBranchForSession: vi.fn(),
    handleTaskMove: vi.fn(),
    readQueueSnapshot: vi.fn(),
    trackerOptions: null as null | {
      resolveSessionFacts: (sessionId: string, projectId: string) => unknown;
    },
  };
  const listeners = new Map<string, Listener[]>();

  let sessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let registerSessionHandlers: typeof import('../../src/main/ipc/handlers/sessions').registerSessionHandlers;

  function emit(event: string, ...eventArguments: unknown[]): void {
    const attached = listeners.get(event) ?? [];
    if (attached.length === 0) throw new Error(`No listener was attached for ${event}`);
    for (const listener of attached) void listener(...eventArguments);
  }

  function register(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): void {
    sessionManager = {
      getSession: vi.fn(() => ({ id: 'sess-1', taskId: 'task-1', status: 'running', transient: false })),
      getSessionProjectId: vi.fn(() => PROJECT_ID),
      getSessionAgentName: vi.fn(() => undefined),
      getActivityCache: vi.fn(() => ({})),
      getPendingDraft: vi.fn(() => null),
      getOpenWork: vi.fn(() => ({ backgroundShells: [], toolCalls: [] })),
      isTaskOpen: vi.fn(() => false),
      markStartBlocked: vi.fn(),
      retireRefusedStart: vi.fn(),
      noteAgentExitedAtStart: vi.fn(),
      getRawScrollback: vi.fn(async () => 'agent output'),
      launchOutputClass: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
      off: vi.fn(),
      ...overrides,
    };
    const proxiedSessionManager = new Proxy(sessionManager, {
      // Anything registration reads that a case does not care about.
      get(target, property) {
        if (property in target) return (target as Record<string | symbol, unknown>)[property];
        return vi.fn(() => ({}));
      },
    });
    registerSessionHandlers({
      currentProjectId: PROJECT_ID,
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: proxiedSessionManager,
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
      boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
      terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
      projectRepo: { getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })) },
    } as never);
  }

  function openMigratedDatabase(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    return database;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    reportHandledError.mockReset();
    listeners.clear();
    control.databaseError = null;
    control.database = null;
    control.trackerOptions = null;
    control.pauseTaskSession.mockReset();
    control.linkPR.mockReset();
    control.recordPushedBranchForSession.mockReset();
    control.handleTaskMove.mockReset();
    control.readQueueSnapshot.mockReset();
    silenceConsole();
    installMocks({
      electron: () => ({
        ipcMain: { handle: vi.fn(), on: vi.fn() },
        MessageChannelMain: class {},
        webContents: { fromId: vi.fn() },
      }),
      '../../src/main/db/database': () => ({
        getProjectDb: () => {
          if (control.databaseError) throw control.databaseError;
          return control.database;
        },
        getOpenProjectDb: () => {
          if (control.databaseError) throw control.databaseError;
          return control.database;
        },
      }),
      '../../src/main/ipc/handlers/session-pause': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/handlers/session-pause')>('../../src/main/ipc/handlers/session-pause')),
        pauseTaskSession: (...callArguments: unknown[]) => control.pauseTaskSession(...callArguments),
      }),
      '../../src/main/pr/pr-linking': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/pr/pr-linking')>('../../src/main/pr/pr-linking')),
        linkPR: (...callArguments: unknown[]) => control.linkPR(...callArguments),
        recordPushedBranchForSession: (...callArguments: unknown[]) => control.recordPushedBranchForSession(...callArguments),
      }),
      '../../src/main/ipc/handlers/task-move': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/handlers/task-move')>('../../src/main/ipc/handlers/task-move')),
        handleTaskMove: (...callArguments: unknown[]) => control.handleTaskMove(...callArguments),
      }),
      '../../src/main/ipc/helpers/queue-snapshot': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/queue-snapshot')>('../../src/main/ipc/helpers/queue-snapshot')),
        readQueueSnapshot: (...callArguments: unknown[]) => control.readQueueSnapshot(...callArguments),
      }),
      '../../src/main/agent/message-trail-tracker': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/agent/message-trail-tracker')>('../../src/main/agent/message-trail-tracker')),
        MessageTrailTracker: class {
          constructor(options: NonNullable<typeof control.trackerOptions>) { control.trackerOptions = options; }
          on(): void {}
          snapshot(): unknown[] { return []; }
        },
      }),
    });
    ({ registerSessionHandlers } = await import('../../src/main/ipc/handlers/sessions'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(removeInstalledMocks);

  it('message_trail_facts: a facts read that throws reports once and leaves the card with no trail', () => {
    register();
    control.databaseError = userTextDefect();

    const facts = control.trackerOptions?.resolveSessionFacts('sess-1', PROJECT_ID);

    expect(facts).toBeNull();
    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'message_trail_facts', error_name: 'TypeError' });
    expect(reports[0].sent.message).toBe('Handled session_handlers failure: TypeError');
    expectNoUserText();
  });

  it('message_trail_facts: a session with no record is an answer, not a failure', async () => {
    register();
    const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
    const database = openMigratedDatabase();
    runProjectMigrations(database);
    control.database = database;

    expect(control.trackerOptions?.resolveSessionFacts('sess-none', PROJECT_ID)).toBeNull();

    expect(reportHandledError).not.toHaveBeenCalled();
    database.close();
  });

  it('session_db_write: a running promotion that cannot reach the database reports once and still announces the status', () => {
    register();
    control.databaseError = userTextDefect();

    emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', projectId: PROJECT_ID, status: 'running', transient: false });

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'session_db_write', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('session_db_write: an exit that cannot reach the database reports once and still broadcasts the exit', () => {
    register();
    control.databaseError = userTextDefect();

    emit('exit', 'sess-1', 1, true);

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'session_db_write', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('session_db_write: a dropped connection is an expected failure and reports nothing', () => {
    register();
    control.databaseError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

    emit('exit', 'sess-1', 1, true);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('queue_snapshot: a snapshot read that throws reports once, as queue_snapshot, after the coalesce delay', async () => {
    register();
    control.readQueueSnapshot.mockImplementation(() => { throw userTextDefect(); });

    emit('queue-changed');
    expect(reportHandledError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'queue_snapshot', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('stale_session_id: a recovery that cannot reach the database reports once, as stale_session_id', () => {
    register();
    control.databaseError = userTextDefect();

    emit('agent-session-id', 'sess-1', 'task-1', PROJECT_ID, 'agent-reported-id');

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'stale_session_id', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('startup_failure_notice: a notice that cannot be raised reports once, after the CLI named the failure', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ describeStartupFailure: () => 'The CLI could not start' } as never);
    register({ getSessionAgentName: vi.fn(() => 'claude') });
    control.databaseError = userTextDefect();

    emit('agent-absent', 'sess-1', { id: 'sess-1', taskId: 'task-1', transient: false });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'startup_failure_notice', error_name: 'TypeError' });
    expectNoUserText();
    // The one-report gate still closed, so the sweep does not report this launch a second time.
    expect(sessionManager.noteAgentExitedAtStart).toHaveBeenCalledWith('sess-1');
  });

  it('startup_failure_read: a ring that cannot be read reports once, as startup_failure_read, and not as a notice', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ describeStartupFailure: () => 'The CLI could not start' } as never);
    register({ getSessionAgentName: vi.fn(() => 'claude'), getRawScrollback: vi.fn(async () => { throw userTextDefect(); }) });

    emit('agent-absent', 'sess-1', { id: 'sess-1', taskId: 'task-1', transient: false });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'startup_failure_read', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('startup_failure_read: a CLI that said nothing is no failure and reports nothing', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ describeStartupFailure: () => undefined } as never);
    register({ getSessionAgentName: vi.fn(() => 'claude') });

    emit('agent-absent', 'sess-1', { id: 'sess-1', taskId: 'task-1', transient: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.getRawScrollback).toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('start_blocked_record: a reason that cannot be written reports once, and the row still says it', async () => {
    const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
    const { SessionRepository } = await import('../../src/main/db/repositories/session-repository');
    const database = openMigratedDatabase();
    runProjectMigrations(database);
    control.database = database;
    vi.spyOn(SessionRepository.prototype, 'setStartBlockedReason').mockImplementation(() => { throw userTextDefect(); });
    control.pauseTaskSession.mockResolvedValue('paused');
    register();

    emit('agent-start-refused', 'sess-1', { id: 'sess-1', taskId: 'task-1', resuming: true }, { reason: 'folder-missing' });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'start_blocked_record', error_name: 'TypeError' });
    expectNoUserText();
    // The in-memory row, which the card reads, was marked before the write failed.
    expect(sessionManager.markStartBlocked).toHaveBeenCalledWith('sess-1', 'folder-missing');
    expect(sessionManager.retireRefusedStart).not.toHaveBeenCalled();
    database.close();
  });

  it('refused_start_pause: a pause that rejects reports once, as refused_start_pause, and retires the row', async () => {
    control.pauseTaskSession.mockRejectedValue(userTextDefect());
    register();

    emit('agent-start-refused', 'sess-1', { id: 'sess-1', taskId: 'task-1', resuming: true }, { reason: 'folder-missing' });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'refused_start_pause', error_name: 'TypeError' });
    expectNoUserText();
    expect(sessionManager.retireRefusedStart).toHaveBeenCalledWith('sess-1');
  });

  it('pushed_branch_record: a record that rejects reports once, as pushed_branch_record', async () => {
    control.recordPushedBranchForSession.mockRejectedValue(userTextDefect());
    register();

    emit('branch-pushed', 'sess-1', 'fix-acme-billing');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'pushed_branch_record', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('pushed_branch_record: a Command Terminal push records nothing and reports nothing', async () => {
    control.recordPushedBranchForSession.mockRejectedValue(userTextDefect());
    register({ getSession: vi.fn(() => ({ id: 'sess-1', transient: true })) });

    emit('branch-pushed', 'sess-1', 'fix-acme-billing');
    await vi.advanceTimersByTimeAsync(0);

    expect(control.recordPushedBranchForSession).not.toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('pr link: a candidate whose resolve rejects reports once under source pr, stage link', async () => {
    control.linkPR.mockRejectedValue(userTextDefect());
    register();

    emit('pr-candidate', 'sess-1', 'scrollback naming Fix Acme billing');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('pr');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'pr', stage: 'link', error_name: 'TypeError' });
    expect(reports[0].sent.message).toBe('Handled pr failure: TypeError');
    expectNoUserText();
    expect(control.linkPR).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 'sess-1', bypassThrottle: true }));
  });

  it('pr link: a resolve that succeeds reports nothing', async () => {
    control.linkPR.mockResolvedValue({ status: 'unchanged', task: null });
    register();

    emit('pr-candidate', 'sess-1', 'scrollback');
    await vi.advanceTimersByTimeAsync(0);

    expect(control.linkPR).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('plan_exit_move: an auto-move that throws reports once, as plan_exit_move, and never rejects the listener', async () => {
    control.databaseError = userTextDefect();
    register();

    emit('plan-exit', 'sess-1');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const reports = reportsFrom('session_handlers');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'session_handlers', stage: 'plan_exit_move', error_name: 'TypeError' });
    expectNoUserText();
    expect(control.handleTaskMove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerAccountHandlers
// ---------------------------------------------------------------------------

describe('account handler reports', () => {
  type Handler = (...handlerArguments: unknown[]) => unknown;

  const harness = {
    handlers: new Map<string, Handler>(),
    database: null as Database.Database | null,
    configDir: '',
    loginRunnerOptions: null as null | { onEnded: (loginId: string, accountId: string, cancelled: boolean) => void },
    sendToRenderer: vi.fn(),
    /** The next `listSessions` call throws this, once. */
    listSessionsFailure: null as Error | null,
    sessions: [] as Array<Record<string, unknown>>,
  };
  let root: string;
  let sessionManager: import('node:events').EventEmitter;
  let registerAccountHandlers: typeof import('../../src/main/ipc/handlers/accounts').registerAccountHandlers;
  let stopAccounts: typeof import('../../src/main/ipc/handlers/accounts').stopAccounts;
  let setAccountService: typeof import('../../src/main/accounts/account-service').setAccountService;

  function invoke(channel: string, ...handlerArguments: unknown[]): Promise<unknown> {
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return Promise.resolve(handler(null, ...handlerArguments));
  }

  function register() {
    return registerAccountHandlers({
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      sessionManager,
      projectRepo: { getById: () => ({ path: path.join(root, 'project') }) },
      configManager: {
        load: () => ({ agent: { accounts: { orderMode: 'manual', autoSwitchAtLimit: true }, cliPaths: {} } }),
        save: vi.fn(),
      },
    } as never);
  }

  const folderAdapter = {
    name: 'move-agent',
    detect: async () => ({ found: true, path: '/usr/bin/test-cli' }),
    accounts: {
      kind: 'folder',
      accountEnv: (accountFolder: string) => ({ TEST_AGENT_HOME: accountFolder }),
      homeEnvVars: ['TEST_AGENT_HOME'],
      defaultHome: () => path.join(root, 'home'),
      loginArgs: ['login'],
      sharedEntries: [],
      identify: async () => ({ signedIn: true, email: null, plan: null, hasSubscription: null }),
      overridingCredentialEnvVars: [],
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    reportHandledError.mockReset();
    harness.handlers.clear();
    harness.sendToRenderer.mockReset();
    harness.listSessionsFailure = null;
    harness.sessions = [];
    harness.loginRunnerOptions = null;
    silenceConsole();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-reports-'));
    harness.configDir = path.join(root, 'config');
    harness.database = new Database(':memory:');
    const { runGlobalMigrations } = await import('../../src/main/db/migrations/global-schema');
    runGlobalMigrations(harness.database);
    const { EventEmitter } = await import('node:events');
    sessionManager = Object.assign(new EventEmitter(), {
      listSessions: () => {
        if (harness.listSessionsFailure) {
          const failure = harness.listSessionsFailure;
          harness.listSessionsFailure = null;
          throw failure;
        }
        return harness.sessions;
      },
      getSession: (sessionId: string) => harness.sessions.find((session) => session.id === sessionId),
      getSessionAgentName: () => 'move-agent',
      getActivityCache: () => ({}),
      automatedKeysBlocker: () => null,
      getOpenWork: () => ({ toolCalls: [], backgroundShells: [], backgroundSubagents: [] }),
      getActivityStatsSnapshot: () => null,
      getPendingDraft: () => null,
      readPendingDraft: async () => null,
      getSessionCliTarget: () => null,
      getSessionHomeAccountId: () => null,
      setAccountHomeResolver: vi.fn(),
    });
    installMocks({
      electron: () => ({
        ipcMain: {
          handle: vi.fn((channel: string, handler: Handler) => { harness.handlers.set(channel, handler); }),
          on: vi.fn((channel: string, handler: Handler) => { harness.handlers.set(channel, handler); }),
        },
        dialog: { showOpenDialog: vi.fn() },
      }),
      '../../src/main/db/database': () => ({
        getGlobalDb: () => harness.database,
        getProjectDb: () => { throw new Error('no project database in this test'); },
      }),
      '../../src/main/config/paths': () => ({ PATHS: { get configDir() { return harness.configDir; } } }),
      '../../src/main/accounts/account-login': () => ({
        AccountLoginRunner: vi.fn(function (options: NonNullable<typeof harness.loginRunnerOptions>) {
          harness.loginRunnerOptions = options;
          return { start: vi.fn(), cancel: vi.fn(), write: vi.fn(), resize: vi.fn(), backlog: vi.fn(() => ''), dispose: vi.fn() };
        }),
      }),
      '../../src/main/accounts/account-usage': () => ({
        AccountUsageRefresher: vi.fn(function () {
          return {
            start: vi.fn(),
            dispose: vi.fn(),
            refreshAccount: vi.fn(async () => undefined),
            refreshAll: vi.fn(async () => undefined),
            readBeforeRanking: vi.fn(async () => undefined),
            checkHome: vi.fn(async () => undefined),
          };
        }),
      }),
      '../../src/main/accounts/account-login-watch': () => ({
        AccountLoginWatch: vi.fn(function () { return { sync: vi.fn(), dispose: vi.fn(), watchedFiles: () => [] }; }),
      }),
      '../../src/main/agent/agent-registry': () => ({
        agentRegistry: {
          get: (name: string) => (name === 'move-agent' ? folderAdapter : undefined),
          list: () => ['move-agent'],
        },
      }),
      '../../src/main/agent/shared/cli-target': () => ({ resolveCliTarget: async () => null }),
      '../../src/main/ipc/send-to-renderer': () => ({ sendToRenderer: (...callArguments: unknown[]) => harness.sendToRenderer(...callArguments) }),
      '../../src/main/ipc/handlers/session-reconcile': () => ({ restartSessionForSettingsChange: vi.fn() }),
      '../../src/main/ipc/handlers/transient-sessions': () => ({ restartCommandTerminalOn: vi.fn(async () => 'moved') }),
      '../../src/main/workflows/workflow-agent': () => ({ restartWorkflowAgentOn: vi.fn(async () => 'moved') }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: { call: vi.fn(async () => true) },
      }),
      '../../src/main/ipc/helpers': () => ({ getProjectRepos: () => ({ tasks: { getById: () => null } }) }),
    });
    ({ registerAccountHandlers, stopAccounts } = await import('../../src/main/ipc/handlers/accounts'));
    ({ setAccountService } = await import('../../src/main/accounts/account-service'));
  });

  afterEach(() => {
    stopAccounts();
    setAccountService(null);
    harness.database?.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(removeInstalledMocks);

  it('usage_record: a usage report that cannot be recorded reports once, as usage_record', () => {
    const service = register();
    vi.spyOn(service, 'recordUsage').mockImplementation(() => { throw userTextDefect(); });

    sessionManager.emit('usage', 'sess-1', { rateLimits: [{ accountId: 'account-1' }] });

    const reports = reportsFrom('accounts');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'accounts', stage: 'usage_record', error_name: 'TypeError' });
    expect(reports[0].sent.message).toBe('Handled accounts failure: TypeError');
    expectNoUserText();
  });

  it('usage_record: a dropped connection is an expected failure and reports nothing', () => {
    const service = register();
    vi.spyOn(service, 'recordUsage').mockImplementation(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });

    sessionManager.emit('usage', 'sess-1', { rateLimits: [{ accountId: 'account-1' }] });

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('turn_failure_report: a failed turn whose account check throws reports once, as turn_failure_report', () => {
    register();
    harness.sessions = [{ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', transient: false, status: 'running', accountId: 'account-1', agentName: 'move-agent' }];
    harness.listSessionsFailure = userTextDefect();

    sessionManager.emit('event', 'sess-1', { type: EventType.TurnFailed, detail: 'rate limited on Fix Acme billing' });

    const reports = reportsFrom('accounts');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'accounts', stage: 'turn_failure_report', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('turn_failure_report: a failed turn of a session on no account is read and reports nothing', () => {
    register();
    harness.sessions = [{ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', transient: false, status: 'running', accountId: null, agentName: 'move-agent' }];

    sessionManager.emit('event', 'sess-1', { type: EventType.TurnFailed, detail: 'rate limited' });

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('login_complete: a sign-in whose result cannot be read reports once, and the dialog still hears it ended', async () => {
    const service = register();
    vi.spyOn(service, 'completeLogin').mockRejectedValue(userTextDefect());

    harness.loginRunnerOptions?.onEnded('login-1', 'account-1', false);
    await vi.waitFor(() => expect(harness.sendToRenderer).toHaveBeenCalled());

    const reports = reportsFrom('accounts');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'accounts', stage: 'login_complete', error_name: 'TypeError' });
    expectNoUserText();
    expect(harness.sendToRenderer).toHaveBeenCalledWith(
      expect.anything(),
      IPC.ACCOUNTS_LOGIN_ENDED,
      { loginId: 'login-1', account: null, duplicateOf: null, cancelled: false },
    );
  });

  it('login_start: a sign-in that cannot start reports once, as login_start, and answers failed', async () => {
    const service = register();
    vi.spyOn(service, 'createFolderAccount').mockRejectedValue(userTextDefect());

    const answer = await invoke(IPC.ACCOUNTS_START_LOGIN, { agent: 'move-agent' });

    expect(answer).toMatchObject({ ok: false, reason: 'failed' });
    const reports = reportsFrom('accounts');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ source: 'accounts', stage: 'login_start', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('login_start: a malformed request is answered unsupported and reports nothing', async () => {
    register();

    await expect(invoke(IPC.ACCOUNTS_START_LOGIN, 'not a request')).resolves.toEqual({ ok: false, reason: 'unsupported' });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
