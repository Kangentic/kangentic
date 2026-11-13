/**
 * What a user loses if these reports go quiet: a drag, a Resume, a project open
 * or a pty host restart that fails shows them a toast (or nothing) and tells the
 * team nothing, so a broken worktree step or a recovery pass that resumes nothing
 * stays invisible until someone writes in.
 *
 * Each case runs the real handler, makes one dependency throw, and asserts the
 * reporter call and its tags. They replace source-text pins in
 * error-reporting-feature-gaps.test.ts that only checked a call string was in a
 * file, and so passed with the call unreachable. Each describe installs its own
 * module mocks with doMock and loads a fresh module graph, because the three
 * handlers mock `ipc/helpers` differently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Swimlane, Task } from '../../src/shared/types';

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

interface ReportedCall {
  sent: Error;
  tags: Record<string, string>;
}

function reportedCalls(): ReportedCall[] {
  return reportHandledError.mock.calls.map((call) => ({ sent: call[0] as Error, tags: call[1] as Record<string, string> }));
}

// ---------------------------------------------------------------------------
// handleTaskMove: the worktree failure report and the rollback report
// ---------------------------------------------------------------------------

describe('handleTaskMove failures', () => {
  const SOURCE_LANE_ID = 'lane-todo';
  const TARGET_LANE_ID = 'lane-doing';
  const MOVE_INPUT = { taskId: 'task-aaa00001', targetSwimlaneId: TARGET_LANE_ID, targetPosition: 0 };

  const mockEnsureTaskWorktree = vi.fn();
  const mockGetProjectRepos = vi.fn();
  let handleTaskMove: typeof import('../../src/main/ipc/handlers/task-move').handleTaskMove;
  let isReported: typeof import('../../src/main/analytics/handled-report').isReported;
  let resetLaunchReports: typeof import('../../src/main/pty/agent-launch-report').resetLaunchReports;

  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 'task-aaa00001',
      display_id: 1,
      title: 'Fix Acme billing',
      description: '',
      swimlane_id: SOURCE_LANE_ID,
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
      ...overrides,
    } as Task;
  }

  function makeLane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
    return {
      id,
      name: `Lane ${id}`,
      role: null,
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
      ...overrides,
    } as Swimlane;
  }

  function makeContext(moveImpl: () => void) {
    const task = makeTask();
    const lanes = new Map([
      [SOURCE_LANE_ID, makeLane(SOURCE_LANE_ID, { role: 'todo' })],
      [TARGET_LANE_ID, makeLane(TARGET_LANE_ID)],
    ]);
    // Phase 1 reads the task in the source lane; the rollback reads it in the destination.
    const getById = vi.fn()
      .mockReturnValueOnce({ ...task })
      .mockReturnValue({ ...task, swimlane_id: TARGET_LANE_ID });
    const tasks = { getById, move: vi.fn(moveImpl), update: vi.fn(), list: vi.fn(() => [{ ...task }]), archive: vi.fn() };
    mockGetProjectRepos.mockReturnValue({
      tasks,
      swimlanes: { getById: vi.fn((id: string) => lanes.get(id) ?? null), list: vi.fn(() => [...lanes.values()]) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { deleteByTaskId: vi.fn() },
    });
    return {
      currentProjectId: 'proj-test',
      currentProjectPath: '/mock/project',
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
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
    };
  }

  beforeAll(async () => {
    vi.resetModules();
    installMocks({
      electron: () => ({ ipcMain: { handle: vi.fn() } }),
      'simple-git': () => ({ simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })) }),
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
          withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
          removeWorktree = vi.fn(async () => true);
          pruneWorktrees = vi.fn(async () => {});
          removeBranch = vi.fn(async () => {});
          static scheduleBackgroundPrune = vi.fn();
        },
      }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (text: string) => text }),
      '../../src/main/pr/pr-linking': () => ({ autoLinkPRForTask: vi.fn() }),
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
        getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
        ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
        ensureTaskBranchCheckout: vi.fn(async () => {}),
        spawnAgent: vi.fn(async () => {}),
        createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => ({ failures: [] })) })),
        cleanupTaskResources: vi.fn(async () => {}),
        deleteTaskWorktree: vi.fn(async () => true),
        autoSpawnForTask: vi.fn(async () => {}),
      }),
    });
    ({ handleTaskMove } = await import('../../src/main/ipc/handlers/task-move'));
    ({ isReported } = await import('../../src/main/analytics/handled-report'));
    ({ resetLaunchReports } = await import('../../src/main/pty/agent-launch-report'));
  });

  afterAll(removeInstalledMocks);

  beforeEach(() => {
    reportHandledError.mockReset();
    resetLaunchReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('reports a worktree failure once, under a fixed cause with no task text, and marks it so the rethrow is not sent again', async () => {
    const gitFailure = new Error("fatal: cannot lock ref 'refs/heads/fix-acme-billing'");
    mockEnsureTaskWorktree.mockRejectedValue(gitFailure);

    const rejection = await handleTaskMove(makeContext(() => undefined) as never, MOVE_INPUT, 'renderer').catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('Worktree setup failed');
    const calls = reportedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].sent.message).toBe('Agent launch failed: preflight (worktree_ref_lock)');
    expect(calls[0].tags).toMatchObject({ source: 'agent_launch', stage: 'preflight', cause: 'worktree_ref_lock' });
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toMatch(/acme/i);
    // The IPC wrap sees the rethrown wrapper and must find its cause marked.
    expect(isReported(rejection)).toBe(true);
  });

  it('reports a rollback that itself failed, under the task_move source and stage rollback', async () => {
    mockEnsureTaskWorktree.mockRejectedValue(new Error("fatal: cannot lock ref 'refs/heads/x'"));
    let moveCalls = 0;
    const context = makeContext(() => {
      moveCalls += 1;
      // The forward move succeeds; the reverse move in the rollback throws.
      if (moveCalls === 2) throw new TypeError("Cannot read properties of undefined (reading 'swimlane_id')");
    });

    await expect(handleTaskMove(context as never, MOVE_INPUT, 'renderer')).rejects.toThrow('Worktree setup failed');

    expect(moveCalls).toBe(2);
    const rollbackReports = reportedCalls().filter((call) => call.tags.source === 'task_move');
    expect(rollbackReports).toHaveLength(1);
    expect(rollbackReports[0].tags).toMatchObject({ source: 'task_move', stage: 'rollback', error_name: 'TypeError' });
    expect(rollbackReports[0].sent.message).toBe('Handled task_move failure: TypeError');
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toContain('swimlane_id');
  });
});

// ---------------------------------------------------------------------------
// resumeTaskSession: reportFailure reports before onFailed
// ---------------------------------------------------------------------------

describe('resumeTaskSession failures', () => {
  const PROJECT_ID = 'proj-1';
  const PAUSED_AT = '2026-10-28T13:00:37.505Z';

  const harness = {
    tasks: null as unknown as import('../../src/main/db/repositories/task-repository').TaskRepository,
    projectPath: '',
    laneId: '',
    worktreeError: null as Error | null,
    engineError: null as Error | null,
  };
  const engine = {
    resumeSuspendedSession: vi.fn(async (task: Task): Promise<void> => {
      if (harness.engineError) throw harness.engineError;
      harness.tasks.update({ id: task.id, session_id: 'sess-resumed' });
    }),
  };
  const lane = () => ({ id: harness.laneId, name: 'Code Review', role: null, permission_mode: null, auto_spawn: true, is_ghost: false });

  let resumeTaskSession: typeof import('../../src/main/ipc/handlers/session-resume').resumeTaskSession;
  let isReported: typeof import('../../src/main/analytics/handled-report').isReported;
  let resetLaunchReports: typeof import('../../src/main/pty/agent-launch-report').resetLaunchReports;
  let database: { close(): void };
  let taskId: string;
  let workspace: string;

  beforeAll(async () => {
    vi.resetModules();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-resume-report-'));
    harness.projectPath = workspace;
    installMocks({
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class {
          getLatestForTask() { return { status: 'suspended', suspended_at: PAUSED_AT }; }
          listForTaskNewestFirst() { return []; }
        },
      }),
      '../../src/main/db/repositories/task-move-repository': () => ({
        TaskMoveRepository: class {
          currentVisit() { return null; }
        },
      }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: () => ({
          tasks: harness.tasks,
          swimlanes: { getById: () => lane(), list: () => [lane()] },
          automations: {},
          automationRuns: {},
          attachments: {},
        }),
        ensureTaskWorktree: async () => {
          if (harness.worktreeError) throw harness.worktreeError;
          return null;
        },
        createTransitionEngine: () => engine,
        resolveSpawnOverrides: () => ({ forceFresh: false }),
        spawnAgent: vi.fn(async () => undefined),
      }),
      '../../src/main/ipc/helpers/project-repos': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/project-repos')>('../../src/main/ipc/helpers/project-repos')),
        resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: harness.projectPath }),
      }),
      '../../src/main/ipc/handlers/session-reconcile': () => ({
        reconcileTaskSessionRef: (_context: unknown, _projectId: string, id: string) => {
          const task = harness.tasks.getById(id)!;
          return task.session_id === 'sess-resumed'
            ? { task, liveSession: { id: 'sess-resumed', taskId: id, status: 'running' } }
            : { task, liveSession: null };
        },
      }),
      '../../src/main/transition-engine/column-strategy': () => ({ applyProfileToLane: (laneRow: unknown) => laneRow }),
      '../../src/main/ipc/helpers/task-profile': () => ({ loadTaskProfile: () => null }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (text: string) => text }),
    });
    ({ resumeTaskSession } = await import('../../src/main/ipc/handlers/session-resume'));
    ({ isReported } = await import('../../src/main/analytics/handled-report'));
    ({ resetLaunchReports } = await import('../../src/main/pty/agent-launch-report'));
  });

  afterAll(async () => {
    removeInstalledMocks();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  beforeEach(async () => {
    reportHandledError.mockReset();
    resetLaunchReports();
    harness.worktreeError = null;
    harness.engineError = null;
    engine.resumeSuspendedSession.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { openTestDatabase } = await import('./helpers/test-database');
    const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
    const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
    const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
    const opened = openTestDatabase();
    database = opened;
    runProjectMigrations(opened);
    harness.tasks = new TaskRepository(opened);
    harness.laneId = new SwimlaneRepository(opened).list().filter((row) => row.role === null)[0].id;
    taskId = harness.tasks.create({ title: 'Fix Acme billing export', description: '', swimlane_id: harness.laneId }).id;
  });

  function fakeContext() {
    return {
      currentProjectId: PROJECT_ID,
      currentProjectPath: harness.projectPath,
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      configManager: { getEffectiveConfig: () => ({ git: { worktreesEnabled: false } }) },
      boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
      projectRepo: { getById: () => ({ id: PROJECT_ID, path: harness.projectPath }), list: () => [] },
      sessionManager: {
        getSession: (id: string) => (id === 'sess-resumed' ? { id, status: 'running' } : undefined),
        findLiveSessionByTaskId: () => undefined,
        listSessions: () => [],
      },
    } as never;
  }

  it('reports a worktree failure under its classified cause, then hands the same error to onFailed', async () => {
    const gitFailure = new Error("fatal: cannot lock ref 'refs/heads/fix-acme-billing-export'");
    harness.worktreeError = gitFailure;
    const onFailed = vi.fn(() => {
      // The report must already have gone out when the hook runs.
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });

    await expect(resumeTaskSession(fakeContext(), taskId, { projectId: PROJECT_ID, onFailed })).rejects.toThrow('Worktree setup failed');

    const calls = reportedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ source: 'agent_launch', stage: 'preflight', cause: 'worktree_ref_lock' });
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toMatch(/acme/i);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]).toEqual(['worktree', gitFailure, expect.objectContaining({ id: taskId })]);
    expect(isReported(gitFailure)).toBe(true);
    database.close();
  });

  it('reports an engine failure under the fixed cause resume, and not a worktree one', async () => {
    harness.engineError = new TypeError("Cannot read properties of undefined (reading 'agent')");

    await expect(resumeTaskSession(fakeContext(), taskId, { projectId: PROJECT_ID })).rejects.toThrow(TypeError);

    // The fake database also trips the held-messages read, which reports on its own source.
    const calls = reportedCalls().filter((call) => call.tags.source === 'agent_launch');
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ source: 'agent_launch', stage: 'preflight', cause: 'resume' });
    expect(calls[0].sent.message).toBe('Agent launch failed: preflight (resume)');
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toContain('agent\'');
    database.close();
  });
});

// ---------------------------------------------------------------------------
// projects.ts: the cold open and the pty host loss recovery passes
// ---------------------------------------------------------------------------

describe('project recovery pass failures', () => {
  const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'error-report-recovery'));
  const state = { existingPaths: new Set<string>(), ownershipError: null as Error | null, resumeError: null as Error | null };

  let openProjectByPath: typeof import('../../src/main/ipc/handlers/projects').openProjectByPath;
  let recoverSessionsAfterPtyHostLoss: typeof import('../../src/main/ipc/handlers/projects').recoverSessionsAfterPtyHostLoss;
  let resetRecoveryPassReports: typeof import('../../src/main/ipc/helpers/recovery-report').resetRecoveryPassReports;
  let isReported: typeof import('../../src/main/analytics/handled-report').isReported;

  const project: Project = {
    id: 'project-1',
    name: 'Acme Billing',
    path: PROJECT_PATH,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Project;

  function makeContext() {
    return {
      projectRepo: {
        list: vi.fn(() => [project]),
        listHidden: vi.fn(() => []),
        getById: vi.fn(() => project),
        create: vi.fn(),
        updateLastOpened: vi.fn(),
      },
      sessionManager: { closeProjectInPtyHost: vi.fn(async () => undefined), listSessions: vi.fn(() => []) },
      configManager: { getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })) },
      boardConfigManager: {
        attach: vi.fn(),
        exists: vi.fn(() => false),
        applyConfigOnOpen: vi.fn(() => []),
        exportFromDb: vi.fn(),
        getBoardProfiles: vi.fn(() => []),
        getDefaultBaseBranchForPath: vi.fn(() => undefined),
        sendOpenWarnings: vi.fn(),
      },
      currentProjectId: null,
      currentProjectPath: null,
      recoveredProjects: new Set<string>(),
      snapshottedProjects: new Set<string>(),
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      mcpServerHandle: null,
    } as never;
  }

  beforeAll(async () => {
    vi.resetModules();
    installMocks({
      electron: () => ({ ipcMain: { handle: vi.fn() } }),
      '../../src/main/git/original-fs': () => ({
        default: {
          existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
          mkdirSync: vi.fn(),
          writeFileSync: vi.fn(),
          unlinkSync: vi.fn(() => {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }),
        },
      }),
      '../../src/main/ipc/handlers/project-relocate': () => ({ relocateProject: vi.fn() }),
      '../../src/main/transition-engine/session-startup': () => ({
        resumeSuspendedSessions: vi.fn(async () => {
          if (state.resumeError) throw state.resumeError;
        }),
        autoSpawnTasks: vi.fn(async () => undefined),
      }),
      '../../src/main/ipc/handlers/command-terminal-restore': () => ({
        claimCommandTerminalRestore: vi.fn(),
        startCommandTerminalRestore: vi.fn(async () => undefined),
        skipCommandTerminalRestore: vi.fn(),
        forgetCommandTerminalRestore: vi.fn(),
        restoreLostCommandTerminals: vi.fn(async () => undefined),
      }),
      '../../src/main/transition-engine/resource-cleanup': () => ({
        cleanupStaleResourcesAsync: vi.fn(async () => undefined),
        sweepAutomationRuns: vi.fn(() => 0),
      }),
      '../../src/main/project-ownership/project-ownership': () => ({
        verifyProjectOwnership: vi.fn(async () => {
          if (state.ownershipError) throw state.ownershipError;
          return { kind: 'owned', ownership: { projectPath: '' } };
        }),
      }),
      '../../src/main/ipc/helpers/spare-worktrees': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/spare-worktrees')>('../../src/main/ipc/helpers/spare-worktrees')),
        sweepSpareWorktreesAtOpen: vi.fn(),
      }),
      '../../src/main/git/worktree-manager': () => ({ WorktreeManager: class { static clearQueue = vi.fn(); } }),
      '../../src/main/git/git-checks': () => ({
        isGitRepo: vi.fn(() => false),
        isInsideWorktree: vi.fn(() => false),
        isKangenticWorktree: vi.fn(() => false),
      }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { list: vi.fn(() => []), get: vi.fn(), getOrThrow: vi.fn() } }),
      '../../src/main/db/database': () => ({
        getProjectDb: vi.fn(() => ({})),
        getExistingProjectDb: vi.fn(() => ({})),
        closeProjectDb: vi.fn(),
        projectDbPath: vi.fn((projectId: string) => `/data/projects/${projectId}.db`),
      }),
      '../../src/main/config/apply-runtime-config': () => ({ applyRuntimeConfig: vi.fn() }),
      '../../src/main/ipc/helpers': () => ({
        ensureGitignore: vi.fn(async () => undefined),
        reapTaskLeftovers: vi.fn(async () => undefined),
        leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => undefined })),
        autoSpawnForTask: vi.fn(async () => undefined),
      }),
      '../../src/main/ipc/helpers/project-entry-search': () => ({ searchProjectEntries: vi.fn() }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (text: string) => text }),
      '../../src/main/shutdown-state': () => ({ isShuttingDown: vi.fn(() => false) }),
      '../../src/main/diagnostics/project-log-context': () => ({
        runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
      }),
      '../../src/main/pr/pr-refresh-scheduler': () => ({ prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/git/git-fetch-scheduler': () => ({ gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/retrieval/retrieval-service': () => ({
        retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
      }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: {
          call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
          closeProject: vi.fn(async () => undefined),
        },
      }),
      '../../src/main/ipc/helpers/tool-breakdown-repair': () => ({
        repairToolBreakdownDurations: vi.fn(async () => ({ completed: true, scanned: 0, repaired: 0, unreadable: 0 })),
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class { list = () => []; } }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class { countAll = () => 0; } }),
      '../../src/main/workflows/workflow-project-delete': () => ({ detachProjectFromWorkflows: vi.fn() }),
      '../../src/main/workflows/workflow-agent': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/workflows/workflow-agent')>('../../src/main/workflows/workflow-agent')),
        endWorkflowAgentsOfProject: vi.fn(async () => undefined),
      }),
    });
    ({ openProjectByPath, recoverSessionsAfterPtyHostLoss } = await import('../../src/main/ipc/handlers/projects'));
    ({ resetRecoveryPassReports } = await import('../../src/main/ipc/helpers/recovery-report'));
    ({ isReported } = await import('../../src/main/analytics/handled-report'));
  });

  afterAll(removeInstalledMocks);

  beforeEach(() => {
    reportHandledError.mockReset();
    resetRecoveryPassReports();
    state.existingPaths.clear();
    state.existingPaths.add(PROJECT_PATH);
    state.ownershipError = null;
    state.resumeError = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('a cold open that throws is reported once as pass cold_open, with no project name', async () => {
    const defect = new TypeError("Cannot read properties of undefined (reading 'Acme Billing')");
    state.ownershipError = defect;

    await openProjectByPath(makeContext(), PROJECT_PATH);
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled(), { timeout: 2000 });

    const calls = reportedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ source: 'project_recovery', pass: 'cold_open', error_name: 'TypeError' });
    expect(calls[0].sent.message).toBe('Handled project_recovery failure: TypeError');
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toContain('Acme');
    expect(isReported(defect)).toBe(true);
  });

  it('a pty host loss recovery that throws is reported once as pass pty_host_loss and never rejects', async () => {
    const defect = new TypeError("Cannot read properties of undefined (reading 'agent_session_id')");
    state.resumeError = defect;

    await expect(recoverSessionsAfterPtyHostLoss(makeContext(), new Map([[project.id, new Set(['lost-session'])]]))).resolves.toBeUndefined();

    const calls = reportedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ source: 'project_recovery', pass: 'pty_host_loss', error_name: 'TypeError' });
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toContain('agent_session_id');
    expect(isReported(defect)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// register-all.ts: the one site that stays a source read
// ---------------------------------------------------------------------------

describe('the remote projects recovery in register-all.ts', () => {
  // register-all.ts wires every handler, the pty host transport, the mobile
  // bridge and the config manager at import, and no unit test loads it without
  // mocking about forty modules (register-all-idempotency.test.ts needs
  // that to run it at all). The callback is also a closure inside that function, so
  // there is no export to drive. This one site stays a source read. Rebuild it as a
  // behavior test if `onHostFirstConnected` moves to an importable module.
  it('hands a failed recoverRemoteProjectsOnHost to reportRecoveryPassFailure as remote_projects', () => {
    // Comment lines are dropped first, so a commented-out call does not satisfy the pin.
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/register-all.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(source).toMatch(/recoverRemoteProjectsOnHost\([^\n]*\)\.catch\(\(error: unknown\) => \{[\s\S]*?reportRecoveryPassFailure\('remote_projects', error\);/);
  });
});
