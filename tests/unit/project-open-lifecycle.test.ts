/**
 * Unit tests for the PROJECT_OPEN cold-open recovery pipeline in
 * src/main/ipc/handlers/projects.ts.
 *
 * Covers three contracts:
 *
 *   1. pruneOrphanedTasksAndNotify (module-private): pushes
 *      IPC.TASK_SESSION_RESYNC with the project id only when the awaited
 *      pruneOrphanedWorktreeTasks resolves > 0; guards on
 *      `mainWindow && !mainWindow.isDestroyed()`; swallows a prune rejection
 *      (logs, treats as 0) and never rejects itself, so it never blocks
 *      session recovery. Exercised via its caller activateAllProjects, which
 *      awaits it directly (no setImmediate indirection).
 *
 *   2. registerProjectHandlers' PROJECT_OPEN cold-open block: runs inside a
 *      setImmediate callback, in order - await prune -> fire
 *      cleanupStaleResourcesAsync WITHOUT awaiting -> await
 *      resumeSuspendedSessions -> await autoSpawnTasks.
 *      `context.recoveredProjects.add(id)` happens SYNCHRONOUSLY before the
 *      deferred block is even scheduled (the rapid-double-open guard). The
 *      block deliberately carries NO `currentProjectId !== id` guard:
 *      recovery for a project the user immediately switched away from must
 *      still run.
 *
 *   3. openProjectByPath's deferred board-config block: the
 *      `context.currentProjectId !== openedProjectId` guard skips
 *      applyConfigOnOpen()/exportFromDb() when the current project changed
 *      before the setImmediate callback fires, and runs both when it hasn't.
 *
 * Section 6 adds a fourth: startToolBreakdownRepair (module-private) is started
 * from all three open paths once recovery has run, with the project's own
 * database and `<project>/.kangentic/sessions`, hands its replay to the
 * retrieval worker, and never runs twice at once for one project.
 *
 * Pattern: capture ipcMain.handle registrations (board-swimlane-update-restart
 * pattern) to invoke the real PROJECT_OPEN handler for #2; call the exported
 * activateAllProjects/openProjectByPath functions directly for #1/#3. Every
 * heavy dependency (git, DB, session lifecycle, PR/retrieval schedulers) is
 * mocked; TaskRepository/SessionRepository/SwimlaneRepository/
 * TranscriptRepository are left as their REAL trivial-constructor classes
 * (safe: every consumer that would call their query methods is itself
 * mocked, so no real db.prepare ever gets invoked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mutable test state (must be defined before vi.mock factories)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  callOrder: [] as string[],
  pruneResult: 0 as number | Error,
  cleanupError: null as Error | null,
  cleanupGate: null as { promise: Promise<void>; resolve: () => void } | null,
  resumeError: null as Error | null,
  autoSpawnError: null as Error | null,
  // One entry per repairToolBreakdownDurations call: the sessions directory it
  // was handed and a copy of `callOrder` at that moment.
  repairSnapshots: [] as Array<{ sessionsDir: string; callOrder: string[] }>,
  // While set, a mocked repair run stays in flight until it resolves.
  repairGate: null as { promise: Promise<void>; resolve: () => void } | null,
}));

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports)
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
    unlinkSync: vi.fn(() => {
      // syncProjectMcpConfig's "no handle" branch always attempts an unlink;
      // ENOENT (no pre-existing file) is the common, silently-swallowed case.
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
}));

vi.mock('../../src/main/ipc/handlers/project-relocate', () => ({
  relocateProject: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {
    state.callOrder.push('resumeSuspendedSessions');
    if (state.resumeError) throw state.resumeError;
  }),
  autoSpawnTasks: vi.fn(async () => {
    state.callOrder.push('autoSpawnTasks');
    if (state.autoSpawnError) throw state.autoSpawnError;
  }),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {
    state.callOrder.push('cleanupStaleResourcesAsync');
    if (state.cleanupGate) await state.cleanupGate.promise;
    if (state.cleanupError) throw state.cleanupError;
  }),
  pruneOrphanedWorktreeTasks: vi.fn(async () => {
    state.callOrder.push('pruneOrphanedWorktreeTasks');
    if (state.pruneResult instanceof Error) throw state.pruneResult;
    return state.pruneResult;
  }),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = vi.fn();
  },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(),
    getOrThrow: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));

vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => {}),
  leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => {} })),
}));

vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/git/git-fetch-scheduler', () => ({
  gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

// The worker client: `call` carries the tool breakdown replay (section 6),
// `closeProject` is awaited by cleanupProject.
vi.mock('../../src/main/retrieval/retrieval-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-client')>()),
  retrievalClient: {
    call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
    closeProject: vi.fn(async () => undefined),
  },
}));

// The one-time duration repair. The real helper is covered against a real
// database in tool-breakdown-repair.test.ts; here it only records that it was
// started, with what, and after which recovery steps, then forwards one replay
// to the worker the way the real one does.
vi.mock('../../src/main/ipc/helpers/tool-breakdown-repair', () => ({
  repairToolBreakdownDurations: vi.fn(async (
    _database: unknown,
    sessionsDir: string,
    replay: (sessionsDir: string, sessionIds: string[]) => Promise<unknown>,
  ) => {
    state.repairSnapshots.push({ sessionsDir, callOrder: [...state.callOrder] });
    if (state.repairGate) await state.repairGate.promise;
    await replay(sessionsDir, ['record-1']);
    return { completed: true, scanned: 1, repaired: 0, unreadable: 0 };
  }),
}));

// The board_snapshot analytics callback (scheduleBoardSnapshot, reached from
// openProjectByPath and the PROJECT_OPEN handler) is the ONE place in this
// file's exercised code paths that calls swimlaneRepo.list() /
// taskRepo.countAll() directly rather than merely passing the repo instance
// to an already-mocked function - every other consumer
// (pruneOrphanedWorktreeTasks, cleanupStaleResourcesAsync,
// resumeSuspendedSessions, autoSpawnTasks) is itself mocked and never invokes
// a method on the repo it's handed. Left as the REAL trivial-constructor
// class (per the file header's rationale), swimlaneRepo.list()/
// taskRepo.countAll() would call `db.prepare(...)` against the fake `{}` db
// object from the database mock above and throw, caught by the snapshot's
// own try/catch (which warns rather than swallowing) - which is exactly why
// trackEvent has never been asserted to receive a 'board_snapshot' call in
// this file until now.
const mockSwimlaneList = vi.fn(() => [] as Array<{ name: string }>);
const mockTaskCountAll = vi.fn(() => 0);

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = (...args: unknown[]) => mockSwimlaneList(...args);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    countAll = (...args: unknown[]) => mockTaskCountAll(...args);
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import { trackEvent } from '../../src/main/analytics/analytics';
import { isShuttingDown } from '../../src/main/shutdown-state';
import { gitFetchScheduler } from '../../src/main/git/git-fetch-scheduler';
import { getProjectDb } from '../../src/main/db/database';
import { retrievalClient } from '../../src/main/retrieval/retrieval-client';
import { repairToolBreakdownDurations } from '../../src/main/ipc/helpers/tool-breakdown-repair';
import { DEFAULT_SWIMLANES } from '../../src/main/db/migrations/default-data';
import {
  registerProjectHandlers,
  openProjectByPath,
  activateAllProjects,
  cleanupProject,
  recoverSessionsAfterPtyHostLoss,
} from '../../src/main/ipc/handlers/projects';
import { resumeSuspendedSessions, autoSpawnTasks } from '../../src/main/transition-engine/session-startup';
import { ensureGitignore } from '../../src/main/ipc/helpers';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { IPC, PROJECT_NOT_FOUND_PREFIX } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-open-lifecycle'));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Test Project',
    path: PROJECT_PATH,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockContext {
  projectRepo: {
    list: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateLastOpened: ReturnType<typeof vi.fn>;
  };
  sessionManager: Record<string, unknown>;
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    attach: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    applyConfigOnOpen: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
    getBoardProfiles: ReturnType<typeof vi.fn>;
    sendOpenWarnings: ReturnType<typeof vi.fn>;
  };
  currentProjectId: string | null;
  currentProjectPath: string | null;
  recoveredProjects: Set<string>;
  snapshottedProjects: Set<string>;
  mainWindow: { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } };
  mcpServerHandle: null;
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    projectRepo: {
      list: vi.fn(() => []),
      getById: vi.fn(),
      create: vi.fn(),
      updateLastOpened: vi.fn(),
    },
    // A project delete has the pty host close its database handle first. The
    // host-loss recovery reads the registry to map lost session ids to tasks.
    sessionManager: {
      closeProjectInPtyHost: vi.fn(async () => undefined),
      listSessions: vi.fn(() => []),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })) },
    boardConfigManager: {
      attach: vi.fn(),
      exists: vi.fn(() => false),
      applyConfigOnOpen: vi.fn(() => []),
      exportFromDb: vi.fn(),
      getBoardProfiles: vi.fn(() => []),
      sendOpenWarnings: vi.fn(),
    },
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    mcpServerHandle: null,
    ...overrides,
  };
}

function asIpcContext(context: MockContext): IpcContext {
  return context as unknown as IpcContext;
}

/** Deterministically flush ONE round of the setImmediate ("check") phase.
 *  Any setImmediate scheduled strictly before this call is guaranteed (FIFO)
 *  to have already run by the time this promise resolves. */
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  state.existingPaths.clear();
  state.callOrder = [];
  state.pruneResult = 0;
  state.cleanupError = null;
  state.cleanupGate = null;
  state.resumeError = null;
  state.autoSpawnError = null;
  state.repairSnapshots = [];
  state.repairGate = null;
  // mockReturnValue persists across tests (vi.clearAllMocks() resets call
  // history, not implementation), so reset both to their neutral defaults
  // here rather than letting one test's override leak into the next.
  mockSwimlaneList.mockReturnValue([]);
  mockTaskCountAll.mockReturnValue(0);
});

// ---------------------------------------------------------------------------
// 1. pruneOrphanedTasksAndNotify (exercised via activateAllProjects)
// ---------------------------------------------------------------------------

describe('pruneOrphanedTasksAndNotify (via activateAllProjects)', () => {
  it('pushes TASK_SESSION_RESYNC with the project id when the prune deletes rows', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = 3;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.TASK_SESSION_RESYNC, project.id);
  });

  it('does not push TASK_SESSION_RESYNC when the prune deletes nothing', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = 0;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('swallows a prune rejection as 0, never pushes, and never blocks session recovery', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = new Error('prune exploded');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must resolve, not reject: a prune failure never propagates.
    await expect(activateAllProjects(asIpcContext(context))).resolves.toBeUndefined();

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    // Recovery continued past the failed prune: cleanup/resume/autoSpawn all ran.
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
    errorSpy.mockRestore();
  });

  it('does not push when mainWindow is destroyed, even though the prune deleted rows', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.mainWindow.isDestroyed.mockReturnValue(true);
    state.existingPaths.add(project.path);
    state.pruneResult = 5;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1b. PROJECT_OPEN with an unknown id (Sentry DESKTOP-V)
// ---------------------------------------------------------------------------

describe('PROJECT_OPEN with an unknown id', () => {
  it('rejects with the PROJECT_NOT_FOUND sentinel rather than a bare message', async () => {
    const context = createMockContext();
    context.projectRepo.getById.mockReturnValue(undefined);
    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');

    // The renderer matches this with `.includes()` (Electron re-wraps the
    // error before the renderer sees it), so the sentinel must be a
    // substring of the rejection's message, not the whole message.
    await expect(handler(null, 'unknown-project-id')).rejects.toThrow(
      new RegExp(PROJECT_NOT_FOUND_PREFIX),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. PROJECT_OPEN cold-open block (registerProjectHandlers)
// ---------------------------------------------------------------------------

describe('PROJECT_OPEN cold-open block (registerProjectHandlers)', () => {
  async function registerAndOpen(context: MockContext, project: Project) {
    context.projectRepo.getById.mockReturnValue(project);
    state.existingPaths.add(project.path);
    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');
    await handler(null, project.id);
  }

  it('starts the git-fetch scheduler for the opened project', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);

    expect(vi.mocked(gitFetchScheduler.startForProject)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitFetchScheduler.startForProject)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: project.id, path: project.path }),
    );

    // Let the deferred cold-open block finish so it does not leak into the
    // next test.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('adds recoveredProjects synchronously, before the deferred cold-open block runs', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);

    // The handler's synchronous body has completed; setImmediate has only
    // SCHEDULED the deferred work, so recoveredProjects must already carry
    // the id while none of the deferred calls have fired yet.
    expect(context.recoveredProjects.has(project.id)).toBe(true);
    expect(state.callOrder).toEqual([]);

    // Let the deferred block finish so it doesn't leak into the next test.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('fires cleanupStaleResourcesAsync WITHOUT awaiting it before resuming sessions', async () => {
    const context = createMockContext();
    const project = makeProject();
    state.cleanupGate = createDeferred();

    await registerAndOpen(context, project);

    // resumeSuspendedSessions/autoSpawnTasks run to completion while
    // cleanupStaleResourcesAsync's own promise is still gated (unresolved) -
    // possible ONLY if the code does not await it.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(state.callOrder).toContain('cleanupStaleResourcesAsync');

    state.cleanupGate.resolve();
  });

  it('has no currentProjectId guard: cold-open recovery still runs after an immediate switch away', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);
    // Simulate the user switching to a different project before the
    // deferred setImmediate callback runs.
    context.currentProjectId = 'a-different-project';

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    // Full ordering held despite the switch: prune -> cleanup (fired) ->
    // resume -> autoSpawn, none skipped.
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
  });

  // -------------------------------------------------------------------------
  // 2b. board_snapshot analytics (fired once per project per run from its own
  //     deferred setImmediate callback, queued BEFORE the recovery block's, so
  //     it has run by the time recovery reaches autoSpawnTasks).
  // -------------------------------------------------------------------------

  function getBoardSnapshotProps(): Record<string, string | number | boolean> {
    const call = vi.mocked(trackEvent).mock.calls.find((args) => args[0] === 'board_snapshot');
    if (!call) throw new Error('board_snapshot was never tracked');
    return call[1] as Record<string, string | number | boolean>;
  }

  function countEvents(eventName: string): number {
    return vi.mocked(trackEvent).mock.calls.filter((args) => args[0] === eventName).length;
  }

  function countBoardSnapshots(): number {
    return countEvents('board_snapshot');
  }

  it('reports customColumns:false for the exact default 7-lane board', async () => {
    mockSwimlaneList.mockReturnValue(DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })));

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(false);
  });

  it('reports customColumns:true when a default-named lane was renamed', async () => {
    const renamedLanes = DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name }));
    renamedLanes[0] = { name: 'Backlog' }; // 'To Do' renamed
    mockSwimlaneList.mockReturnValue(renamedLanes);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(true);
  });

  it('reports customColumns:true when an 8th lane was added, even if it duplicates a default name', async () => {
    // Duplicating an existing default name (rather than adding a novel one)
    // isolates the LENGTH half of the customColumns check: every lane's name
    // is still present in the default-name Set, so a name-only comparison
    // would read this board as non-custom. Only the `lanes.length !==
    // DEFAULT_SWIMLANES.length` half catches the extra lane.
    const extraLanes = [
      ...DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })),
      { name: DEFAULT_SWIMLANES[0].name },
    ];
    mockSwimlaneList.mockReturnValue(extraLanes);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(true);
  });

  it('buckets taskCount from TaskRepository.countAll() into taskBucket', async () => {
    mockSwimlaneList.mockReturnValue(DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })));
    mockTaskCountAll.mockReturnValue(12);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    // Red: reverting to a stale count source (e.g. `tasks.list().length`, the
    // full-row scan countAll replaced) or dropping the countAll() call
    // entirely would leave taskCount at 0 and this at '0' instead of '10-49'.
    expect(getBoardSnapshotProps().taskBucket).toBe('10-49');
  });

  // -------------------------------------------------------------------------
  // 2c. board_snapshot fires the first time a project is VIEWED, keyed on its
  //     own set. Before this, it was keyed on recoveredProjects, which the boot
  //     auto-open and the background activation of every other project also
  //     mark, so the boot project never snapshotted and a later sidebar switch
  //     to any other project never did either. Each case below is red on that
  //     code.
  // -------------------------------------------------------------------------

  it('snapshots a project that recovery already marked warm (the production gap: warm from activateAllProjects, then clicked)', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.recoveredProjects.add(project.id);

    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    // Warm: the recovery block itself did not run.
    expect(state.callOrder).toEqual([]);
  });

  it('openProjectByPath (the boot auto-open) snapshots an existing project', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    expect(context.snapshottedProjects.has(project.id)).toBe(true);

    // Let the cold-open recovery chain settle so it does not leak.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('the boot auto-open followed by a sidebar open of the same project snapshots exactly once', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('activateAllProjects never snapshots: background activation is not the user viewing a board', async () => {
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', path: path.join(PROJECT_PATH, 'a') });
    const projectB = makeProject({ id: 'project-B', path: path.join(PROJECT_PATH, 'b') });
    context.projectRepo.list.mockReturnValue([projectA, projectB]);
    state.existingPaths.add(projectA.path);
    state.existingPaths.add(projectB.path);

    await activateAllProjects(asIpcContext(context));
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(0);
    expect(context.snapshottedProjects.size).toBe(0);
    // Both were recovered, which is what used to poison the later click.
    expect(context.recoveredProjects.has(projectA.id)).toBe(true);
    expect(context.recoveredProjects.has(projectB.id)).toBe(true);
  });

  it('a just-created project is neither snapshotted nor marked, so its first real view sends it', async () => {
    const context = createMockContext();
    const project = makeProject();
    // No registered project at this path: openProjectByPath creates one.
    context.projectRepo.list.mockReturnValue([]);
    context.projectRepo.create.mockReturnValue(project);
    Object.assign(context.configManager, {
      loadProjectOverrides: vi.fn(() => null),
      getProjectOverridableDefaults: vi.fn(() => ({})),
      saveProjectOverrides: vi.fn(),
    });
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path, { defaultAgent: 'claude' });
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(0);
    expect(context.snapshottedProjects.has(project.id)).toBe(false);
    // The creation itself is counted here: adding a folder is the common way
    // to create a project and it never reaches PROJECT_CREATE.
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('project_create');

    // The next open (the same id, now registered) is the first real view.
    context.projectRepo.list.mockReturnValue([project]);
    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    // Exactly once across BOTH opens. The creation branch is the only place
    // that counts, and it is gated on the path lookup above missing, so
    // reopening the same folder must not count a second project.
    expect(countEvents('project_create')).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('a failing lane read warns, sends nothing, stays marked, and leaves the recovery order unchanged', async () => {
    mockSwimlaneList.mockImplementation(() => {
      throw new Error('SQLITE_IOERR');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(countBoardSnapshots()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith('[ANALYTICS] board_snapshot failed:', expect.any(Error));
    // One attempt per run: a broken DB is not retried on every switch.
    expect(context.snapshottedProjects.has(project.id)).toBe(true);
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
    warnSpy.mockRestore();
  });

  it('a snapshot scheduled just before quit is skipped rather than reopening a database', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.recoveredProjects.add(project.id);

    await registerAndOpen(context, project);
    vi.mocked(isShuttingDown).mockReturnValue(true);
    await flushSetImmediate();
    vi.mocked(isShuttingDown).mockReturnValue(false);

    expect(countBoardSnapshots()).toBe(0);
  });

  it('opening two different projects as real views in the same run snapshots each exactly once, keyed by id', async () => {
    // The closest existing case ("the boot auto-open followed by a sidebar
    // open of the same project snapshots exactly once") only ever exercises
    // one project id, so it would still pass if snapshottedProjects were
    // collapsed to a single run-wide boolean instead of a per-project Set.
    // This case is red on that collapse: project B's open would find the
    // guard already tripped by project A and never snapshot.
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', path: path.join(PROJECT_PATH, 'a') });
    const projectB = makeProject({ id: 'project-B', path: path.join(PROJECT_PATH, 'b') });

    await registerAndOpen(context, projectA);
    await registerAndOpen(context, projectB);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(2);
    expect(context.snapshottedProjects.has(projectA.id)).toBe(true);
    expect(context.snapshottedProjects.has(projectB.id)).toBe(true);

    // Drain both projects' deferred recovery chains so they do not leak into
    // the next test.
    await vi.waitFor(() => {
      expect(state.callOrder.filter((call) => call === 'autoSpawnTasks').length).toBe(2);
    }, { timeout: 2000 });
  });

  it('cleanupProject clears the id from snapshottedProjects, so a project closed and reopened in the same run snapshots again', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    context.snapshottedProjects.add(project.id);
    state.existingPaths.add(project.path);
    // The mocked TaskRepository only defines countAll (see the module mock
    // above), so cleanupProject's own taskRepo.list() read throws and is
    // caught internally, logging an error this test does not care about.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cleanupProject(asIpcContext(context), project.id, project.path);

    expect(context.snapshottedProjects.has(project.id)).toBe(false);
    errorSpy.mockRestore();

    // The behavior that actually matters to a user: closing a project and
    // reopening it in the same run snapshots it a second time.
    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('cleanupProject stops the git-fetch scheduler even when the project path no longer exists on disk', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    // Deliberately NOT added to state.existingPaths: simulates a project
    // whose folder was moved or deleted, driving the path-exists guard's
    // early return branch. gitFetchScheduler.stop must still run - it sits
    // BEFORE that guard in cleanupProject, alongside prRefreshScheduler.stop.

    await cleanupProject(asIpcContext(context), project.id, project.path);

    expect(vi.mocked(gitFetchScheduler.stop)).toHaveBeenCalledWith(project.id);
  });

  it('kills and captures awaitExit for every task session before removing any, and removes wait for both exits', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    state.existingPaths.add(project.path);

    const timeline: string[] = [];
    const exitDeferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    Object.assign(context.sessionManager, {
      kill: vi.fn((sessionId: string) => { timeline.push(`kill:${sessionId}`); }),
      awaitExit: vi.fn((sessionId: string) => {
        timeline.push(`awaitExit:${sessionId}`);
        const deferred = createDeferred();
        exitDeferreds.set(sessionId, deferred);
        return deferred.promise;
      }),
      remove: vi.fn((sessionId: string) => { timeline.push(`remove:${sessionId}`); }),
      // cleanupProject also cancels and awaits every task's in-flight spawn and
      // any other session of the task, once the session rows are removed.
      removeByTaskId: vi.fn(async (taskId: string) => { timeline.push(`removeByTaskId:${taskId}`); }),
    });

    // The mocked TaskRepository class only defines countAll (see the module
    // mock above); patch `list` on its prototype for this test only so
    // cleanupProject sees two tasks with live sessions, then remove the patch
    // so later tests keep relying on taskRepo.list() throwing (see the two
    // cleanupProject tests above).
    const tasks = [
      { id: 'task-1', session_id: 'session-1', worktree_path: null },
      { id: 'task-2', session_id: 'session-2', worktree_path: null },
    ];
    (TaskRepository.prototype as unknown as { list: () => typeof tasks }).list = () => tasks;

    try {
      const cleanupPromise = cleanupProject(asIpcContext(context), project.id, project.path);

      // The kill-then-capture loop has no await inside it, so by the time the
      // call above returns control, both sessions have already been killed
      // and their exits captured - before the code ever reaches
      // `await Promise.all(sessionExits)`.
      expect(timeline).toEqual([
        'kill:session-1', 'awaitExit:session-1',
        'kill:session-2', 'awaitExit:session-2',
      ]);
      expect(context.sessionManager.remove).not.toHaveBeenCalled();

      exitDeferreds.get('session-1')!.resolve();
      exitDeferreds.get('session-2')!.resolve();
      await cleanupPromise;

      expect(timeline).toEqual([
        'kill:session-1', 'awaitExit:session-1',
        'kill:session-2', 'awaitExit:session-2',
        'remove:session-1', 'remove:session-2',
        'removeByTaskId:task-1', 'removeByTaskId:task-2',
      ]);
    } finally {
      delete (TaskRepository.prototype as unknown as { list?: unknown }).list;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. openProjectByPath's deferred board-config block
// ---------------------------------------------------------------------------

describe("openProjectByPath's deferred board-config block", () => {
  it('runs applyConfigOnOpen and exportFromDb when currentProjectId is unchanged when the deferred callback runs', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    // Warm reopen: isolates this test to the board-config block, skipping
    // the (separately tested) cold-open recovery block entirely.
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(context.boardConfigManager.applyConfigOnOpen).toHaveBeenCalledTimes(1);
    expect(context.boardConfigManager.exportFromDb).toHaveBeenCalledTimes(1);
  });

  it('skips applyConfigOnOpen and exportFromDb when currentProjectId changed before the deferred callback runs', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    // Simulate an immediate project switch before the deferred setImmediate
    // fires. This mutation happens synchronously right after
    // openProjectByPath resolves, strictly before the setImmediate ("check"
    // phase) callback runs.
    context.currentProjectId = 'a-different-project';
    await flushSetImmediate();

    expect(context.boardConfigManager.applyConfigOnOpen).not.toHaveBeenCalled();
    expect(context.boardConfigManager.exportFromDb).not.toHaveBeenCalled();
  });

  // The reconcile's warnings used to reach only the log, so a broken
  // kangentic.json left the board on stale data with nothing on screen.
  it('pushes the reconcile warnings to the renderer, tagged with the project', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    context.boardConfigManager.applyConfigOnOpen.mockReturnValue(['kangentic.json could not be read']);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(context.boardConfigManager.sendOpenWarnings).toHaveBeenCalledWith(project.id, ['kangentic.json could not be read']);
  });

  it('pushes an empty list when there is no kangentic.json, so the last banner clears', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.recoveredProjects.add(project.id);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(context.boardConfigManager.sendOpenWarnings).toHaveBeenCalledWith(project.id, []);
  });

  it('turns a reconcile that throws into a warning rather than only a log line', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    context.boardConfigManager.applyConfigOnOpen.mockImplementation(() => {
      throw new TypeError('(group ?? []) is not iterable');
    });
    state.existingPaths.add(project.path);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();
    const loggedErrors = consoleError.mock.calls.map((call) => call.map(String).join(' '));
    consoleError.mockRestore();

    const [, warnings] = context.boardConfigManager.sendOpenWarnings.mock.calls[0] as [string, string[]];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kangentic.json could not be applied');
    // The error goes to the log, not the banner: a message can carry an
    // absolute path, and the banner is on screen in demos and screen shares.
    expect(warnings[0]).not.toContain('is not iterable');
    expect(loggedErrors.some((message) => message.includes('is not iterable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. ensureGitignore fire-and-forget: its git tracked-file probe must not
//    block the open/switch critical path in either call site.
// ---------------------------------------------------------------------------

describe('ensureGitignore fire-and-forget on the open critical path', () => {
  afterEach(() => {
    // Restore the default no-op implementation so a per-test gate never
    // leaks into the next test (the top-level beforeEach's
    // vi.clearAllMocks() resets call history but not a custom
    // mockImplementation).
    vi.mocked(ensureGitignore).mockImplementation(async () => {});
  });

  it('openProjectByPath resolves before a gated ensureGitignore settles', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    // Warm reopen: isolates this test to the open body itself (matching the
    // board-config-block tests' pattern), so no unrelated deferred recovery
    // work needs draining afterwards.
    context.recoveredProjects.add(project.id);
    state.existingPaths.add(project.path);

    const gate = createDeferred();
    vi.mocked(ensureGitignore).mockImplementation(() => gate.promise);

    let resolved = false;
    const openPromise = openProjectByPath(asIpcContext(context), project.path).then((openedProject) => {
      resolved = true;
      return openedProject;
    });

    // Drain a few microtask ticks: fire-and-forget must not make
    // openProjectByPath wait on the gate to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    const openedProject = await openPromise;
    expect(openedProject.id).toBe(project.id);

    // Release the gate so its dangling promise doesn't leak into later
    // tests, and let the deferred board-config block (unrelated to the
    // gate) settle.
    gate.resolve();
    await flushSetImmediate();
  });

  it('the PROJECT_OPEN handler resolves before a gated ensureGitignore settles', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.getById.mockReturnValue(project);
    state.existingPaths.add(project.path);

    const gate = createDeferred();
    vi.mocked(ensureGitignore).mockImplementation(() => gate.promise);

    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');

    let resolved = false;
    const handlerPromise = (async () => {
      await handler(null, project.id);
    })();
    void handlerPromise.then(() => { resolved = true; });

    // Drain a few microtask ticks: fire-and-forget must not make the handler
    // wait on the gate to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    await handlerPromise;

    // Let the deferred cold-open block finish so it doesn't leak into the
    // next test, then release the gate.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
    gate.resolve();
  });
});

// ---------------------------------------------------------------------------
// 5. recoverSessionsAfterPtyHostLoss: the pty host died and a new one is up.
// ---------------------------------------------------------------------------

describe('recoverSessionsAfterPtyHostLoss', () => {
  // resumeSuspendedSessions' tenth parameter is the scope: without it the
  // recovery gather would also wake sessions the host never held. Red-green:
  // drop `lostSessionIds` from the call in projects.ts and the first test goes
  // red (the tenth argument is undefined).
  const RESUME_ONLY_SESSION_IDS_ARGUMENT = 9;
  // autoSpawnTasks' tenth parameter is its scope, for the same reason: an
  // unscoped pass would also restart a task whose agent exited earlier this run.
  // It is `{ taskIds, lostSessionIds }`: the lost sessions' tasks, and the lost
  // rows themselves, so the pass can tell them from a later row of the same task
  // (a resume whose spawn failed leaves one) that must keep a fresh agent away.
  // Red-green: pass `lostTaskIds` bare, or leave `lostSessionIds` out of the
  // object, in projects.ts and the two tests that read it go red.
  const AUTO_SPAWN_LOST_SCOPE_ARGUMENT = 9;

  function registerProjects(context: MockContext, projects: Project[]): void {
    const byId = new Map(projects.map((project) => [project.id, project]));
    context.projectRepo.getById.mockImplementation((projectId: string) => byId.get(projectId));
    for (const project of projects) state.existingPaths.add(project.path);
  }

  afterEach(() => {
    // The top-level beforeEach clears call history, not a custom implementation.
    vi.mocked(isShuttingDown).mockReturnValue(false);
  });

  it('resumes each project with exactly the session ids its host loss took down', async () => {
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', name: 'Project A', path: path.join(PROJECT_PATH, 'a'), default_agent: 'claude' });
    const projectB = makeProject({ id: 'project-B', name: 'Project B', path: path.join(PROJECT_PATH, 'b'), default_agent: 'codex' });
    registerProjects(context, [projectA, projectB]);
    const lostInA = new Set(['session-a1', 'session-a2']);
    const lostInB = new Set(['session-b1']);

    await recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([['project-A', lostInA], ['project-B', lostInB]]));

    const calls = vi.mocked(resumeSuspendedSessions).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('project-A');
    expect(calls[0][1]).toBe(projectA.path);
    expect(calls[0][2]).toBe(context.sessionManager);
    expect(calls[0][4]).toBe('claude');
    expect(calls[0][RESUME_ONLY_SESSION_IDS_ARGUMENT]).toBe(lostInA);
    expect(calls[1][0]).toBe('project-B');
    expect(calls[1][4]).toBe('codex');
    expect(calls[1][RESUME_ONLY_SESSION_IDS_ARGUMENT]).toBe(lostInB);
  });

  it('then starts fresh only the tasks whose sessions the loss took down, the way startup does', async () => {
    const context = createMockContext();
    const project = makeProject({ id: 'project-A', name: 'Project A', path: path.join(PROJECT_PATH, 'a') });
    registerProjects(context, [project]);
    // session-a2 had no agent session id, so the resume could not take it back;
    // session-other belongs to a task the host loss never touched.
    context.sessionManager.listSessions = vi.fn(() => [
      { id: 'session-a1', taskId: 'task-1', status: 'running' },
      { id: 'session-a2', taskId: 'task-2', status: 'exited' },
      { id: 'session-other', taskId: 'task-3', status: 'exited' },
    ]);

    const lostInA = new Set(['session-a1', 'session-a2']);

    await recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([['project-A', lostInA]]));

    expect(state.callOrder).toEqual(['resumeSuspendedSessions', 'autoSpawnTasks']);
    const autoSpawnCalls = vi.mocked(autoSpawnTasks).mock.calls;
    expect(autoSpawnCalls).toHaveLength(1);
    expect(autoSpawnCalls[0][0]).toBe('project-A');
    expect(autoSpawnCalls[0][2]).toBe(context.sessionManager);
    // Both lost tasks go in; which of them already has a session again is for
    // autoSpawnTasks to decide from the registry. `toEqual` on the object also
    // pins the shape: no key beyond these two.
    expect(autoSpawnCalls[0][AUTO_SPAWN_LOST_SCOPE_ARGUMENT]).toEqual({
      taskIds: new Set(['task-1', 'task-2']),
      lostSessionIds: lostInA,
    });
    // The project's own lost set, not a copy that could drift from what the resume got.
    expect(autoSpawnCalls[0][AUTO_SPAWN_LOST_SCOPE_ARGUMENT]?.lostSessionIds).toBe(lostInA);
  });

  it('reads the lost tasks before the resume replaces the rows it brings back, and leaves out a lost row with no task', async () => {
    // The resume swaps a lost row for a fresh one (new id, running), so a read
    // after it finds no lost id. Red-green: move the `lostTaskIds` read below the
    // resume in projects.ts and the set is empty; drop its `&& session.taskId`
    // filter and the set gains `undefined`.
    const context = createMockContext();
    const project = makeProject({ id: 'project-A', name: 'Project A', path: path.join(PROJECT_PATH, 'a') });
    registerProjects(context, [project]);
    interface RegistryRow { id: string; taskId: string | undefined; status: string }
    const listSessions = vi.fn((): RegistryRow[] => [
      { id: 'session-a1', taskId: 'task-1', status: 'exited' },
      { id: 'session-a2', taskId: 'task-2', status: 'exited' },
      { id: 'session-a3', taskId: undefined, status: 'exited' },
      { id: 'session-other', taskId: 'task-3', status: 'exited' },
    ]);
    context.sessionManager.listSessions = listSessions;
    let resumeRan = false;
    vi.mocked(resumeSuspendedSessions).mockImplementationOnce(async () => {
      state.callOrder.push('resumeSuspendedSessions');
      resumeRan = true;
      listSessions.mockReturnValue([
        { id: 'session-new-1', taskId: 'task-1', status: 'running' },
        { id: 'session-new-2', taskId: 'task-2', status: 'running' },
        { id: 'session-other', taskId: 'task-3', status: 'exited' },
      ]);
    });

    const lostInA = new Set(['session-a1', 'session-a2', 'session-a3']);

    await recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([['project-A', lostInA]]));

    // The swap happened before autoSpawnTasks ran, so a late read would see it.
    expect(resumeRan).toBe(true);
    expect(state.callOrder).toEqual(['resumeSuspendedSessions', 'autoSpawnTasks']);
    const autoSpawnCalls = vi.mocked(autoSpawnTasks).mock.calls;
    expect(autoSpawnCalls).toHaveLength(1);
    // The lost ids stay whole, session-a3 included: it has no task, so it is out
    // of `taskIds`, but it is still a lost row the scoped pass must not count.
    expect(autoSpawnCalls[0][AUTO_SPAWN_LOST_SCOPE_ARGUMENT]).toEqual({
      taskIds: new Set(['task-1', 'task-2']),
      lostSessionIds: lostInA,
    });
    expect(autoSpawnCalls[0][AUTO_SPAWN_LOST_SCOPE_ARGUMENT]?.lostSessionIds).toBe(lostInA);
  });

  it('skips a project that left the index and one whose folder is gone, and still resumes the rest', async () => {
    const context = createMockContext();
    const projectMoved = makeProject({ id: 'project-moved', path: path.join(PROJECT_PATH, 'moved') });
    const projectKept = makeProject({ id: 'project-kept', path: path.join(PROJECT_PATH, 'kept') });
    registerProjects(context, [projectMoved, projectKept]);
    // Deleted from disk after it was registered; 'project-deleted' was never in the index.
    state.existingPaths.delete(projectMoved.path);

    await recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([
      ['project-deleted', new Set(['session-1'])],
      ['project-moved', new Set(['session-2'])],
      ['project-kept', new Set(['session-3'])],
    ]));

    const resumedProjectIds = vi.mocked(resumeSuspendedSessions).mock.calls.map((call) => call[0]);
    expect(resumedProjectIds).toEqual(['project-kept']);
  });

  it('a project whose resume fails is logged and does not stop the next, and the recovery never rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const context = createMockContext();
      const projectA = makeProject({ id: 'project-A', name: 'Project A', path: path.join(PROJECT_PATH, 'a') });
      const projectB = makeProject({ id: 'project-B', name: 'Project B', path: path.join(PROJECT_PATH, 'b') });
      registerProjects(context, [projectA, projectB]);
      vi.mocked(resumeSuspendedSessions).mockRejectedValueOnce(new Error('resume exploded'));

      await expect(recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([
        ['project-A', new Set(['session-a1'])],
        ['project-B', new Set(['session-b1'])],
      ]))).resolves.toBeUndefined();

      expect(vi.mocked(resumeSuspendedSessions).mock.calls.map((call) => call[0])).toEqual(['project-A', 'project-B']);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('Project A');
    } finally {
      // Restored on a failed assertion too, or every later test runs with
      // console.error silenced and hides its own failure output.
      errorSpy.mockRestore();
    }
  });

  it('stops resuming once the quit has begun, even partway through the projects', async () => {
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', path: path.join(PROJECT_PATH, 'a') });
    const projectB = makeProject({ id: 'project-B', path: path.join(PROJECT_PATH, 'b') });
    registerProjects(context, [projectA, projectB]);
    // The first project's check passes; the quit begins before the second's.
    vi.mocked(isShuttingDown).mockReturnValueOnce(false).mockReturnValue(true);

    await recoverSessionsAfterPtyHostLoss(asIpcContext(context), new Map([
      ['project-A', new Set(['session-a1'])],
      ['project-B', new Set(['session-b1'])],
    ]));

    expect(vi.mocked(resumeSuspendedSessions).mock.calls.map((call) => call[0])).toEqual(['project-A']);
  });
});

// ---------------------------------------------------------------------------
// 6. startToolBreakdownRepair: the one-time repair of per-tool durations, fired
//    from the three open paths once recovery has run. Every case uses its own
//    project ids and counts only the repair calls made for that project's
//    sessions directory, because the in-flight set is module-level and a
//    neighbouring case's run must not be able to skip or inflate this one.
// ---------------------------------------------------------------------------

describe('startToolBreakdownRepair (the one-time tool breakdown duration repair)', () => {
  const COLD_OPEN_RECOVERY = [
    'pruneOrphanedWorktreeTasks',
    'cleanupStaleResourcesAsync',
    'resumeSuspendedSessions',
    'autoSpawnTasks',
  ];
  const databases = new Map<string, object>();

  /** A distinct database object per project id, so a repair handed the wrong project's database shows. */
  function databaseFor(projectId: string): object {
    let database = databases.get(projectId);
    if (!database) {
      database = { databaseOf: projectId };
      databases.set(projectId, database);
    }
    return database;
  }

  function makeRepairProject(name: string): Project {
    return makeProject({ id: `repair-${name}`, name: `Repair ${name}`, path: path.join(PROJECT_PATH, `repair-${name}`) });
  }

  function sessionsDirOf(project: Project): string {
    return path.join(project.path, '.kangentic', 'sessions');
  }

  function repairCallsFor(project: Project) {
    return vi.mocked(repairToolBreakdownDurations).mock.calls.filter((callArguments) => callArguments[1] === sessionsDirOf(project));
  }

  function resumeCallsFor(project: Project) {
    return vi.mocked(resumeSuspendedSessions).mock.calls.filter((callArguments) => callArguments[0] === project.id);
  }

  function recoveryBeforeRepairOf(project: Project): string[] | undefined {
    return state.repairSnapshots.find((snapshot) => snapshot.sessionsDir === sessionsDirOf(project))?.callOrder;
  }

  async function registerAndOpen(context: MockContext, project: Project): Promise<void> {
    context.projectRepo.getById.mockReturnValue(project);
    state.existingPaths.add(project.path);
    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');
    await handler(null, project.id);
  }

  function expectStartedOnceFor(project: Project): void {
    const calls = repairCallsFor(project);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(databaseFor(project.id));
    expect(calls[0][1]).toBe(path.join(project.path, '.kangentic', 'sessions'));
    // The replay it is handed runs in the retrieval worker, with no time limit
    // on a project's whole history.
    expect(vi.mocked(retrievalClient.call)).toHaveBeenCalledWith(
      'sessions.replayToolBreakdowns',
      { sessionsDir: sessionsDirOf(project), sessionIds: ['record-1'] },
      { timeoutMs: null },
    );
  }

  beforeEach(() => {
    databases.clear();
    vi.mocked(getProjectDb).mockImplementation(((projectId: string) => databaseFor(projectId)) as never);
  });

  afterEach(() => {
    // The top-level beforeEach clears call history, not a custom implementation.
    vi.mocked(getProjectDb).mockImplementation((() => ({})) as never);
    state.repairGate?.resolve();
    state.repairGate = null;
  });

  it('openProjectByPath: a cold open starts it after prune, cleanup, resume and auto-spawn', async () => {
    const context = createMockContext();
    const project = makeRepairProject('open-by-path');
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await vi.waitFor(() => {
      expect(repairCallsFor(project)).toHaveLength(1);
    }, { timeout: 2000 });

    expectStartedOnceFor(project);
    expect(recoveryBeforeRepairOf(project)).toEqual(COLD_OPEN_RECOVERY);
  });

  it('the PROJECT_OPEN handler: a cold open starts it after prune, cleanup, resume and auto-spawn', async () => {
    const context = createMockContext();
    const project = makeRepairProject('open-handler');

    await registerAndOpen(context, project);
    await vi.waitFor(() => {
      expect(repairCallsFor(project)).toHaveLength(1);
    }, { timeout: 2000 });

    expectStartedOnceFor(project);
    expect(recoveryBeforeRepairOf(project)).toEqual(COLD_OPEN_RECOVERY);
  });

  it('activateAllProjects: starts it for each other project with its own database and directory, and not for the current one', async () => {
    const context = createMockContext();
    const current = makeRepairProject('activate-current');
    const otherA = makeRepairProject('activate-a');
    const otherB = makeRepairProject('activate-b');
    context.currentProjectId = current.id;
    context.projectRepo.list.mockReturnValue([current, otherA, otherB]);
    for (const project of [current, otherA, otherB]) state.existingPaths.add(project.path);

    await activateAllProjects(asIpcContext(context));

    expect(repairCallsFor(current)).toHaveLength(0);
    expectStartedOnceFor(otherA);
    expectStartedOnceFor(otherB);
    // Each started after its own recovery chain had reached auto-spawn.
    expect(recoveryBeforeRepairOf(otherA)).toContain('autoSpawnTasks');
    expect(recoveryBeforeRepairOf(otherB)).toContain('autoSpawnTasks');
  });

  it('a warm reopen starts nothing: the repair belongs to a cold open', async () => {
    const context = createMockContext();
    const warmByHandler = makeRepairProject('warm-handler');
    const warmByPath = makeRepairProject('warm-path');
    context.recoveredProjects.add(warmByHandler.id);
    context.recoveredProjects.add(warmByPath.id);
    context.projectRepo.list.mockReturnValue([warmByPath]);
    state.existingPaths.add(warmByPath.path);

    await registerAndOpen(context, warmByHandler);
    await openProjectByPath(asIpcContext(context), warmByPath.path);
    // A call that must not happen cannot be polled for: two full rounds of the
    // event loop are the budget for any latent start to land.
    await flushSetImmediate();
    await flushSetImmediate();

    // Warm means recovery itself did not run for either project.
    expect(resumeCallsFor(warmByHandler)).toHaveLength(0);
    expect(resumeCallsFor(warmByPath)).toHaveLength(0);
    expect(repairCallsFor(warmByHandler)).toHaveLength(0);
    expect(repairCallsFor(warmByPath)).toHaveLength(0);
  });

  it('two overlapping starts for one project run one repair, leave other projects alone, and start again once the run settles', async () => {
    const context = createMockContext();
    const project = makeRepairProject('overlap');
    const otherProject = makeRepairProject('overlap-other');
    context.projectRepo.list.mockReturnValue([project, otherProject]);
    state.existingPaths.add(project.path);
    state.existingPaths.add(otherProject.path);

    // The first start comes from a cold open, and its run is held in flight.
    state.repairGate = createDeferred();
    await openProjectByPath(asIpcContext(context), project.path);
    await vi.waitFor(() => {
      expect(repairCallsFor(project)).toHaveLength(1);
    }, { timeout: 2000 });

    // A second open path for the same project fires meanwhile. activateAllProjects
    // does not skip a project that is already recovered, and the project it
    // opened is no longer the current one. The other project is a control
    // that the guard is per project and not global.
    context.currentProjectId = 'a-different-project';
    await activateAllProjects(asIpcContext(context));

    // Both open paths ran their recovery for the project; only one repair started.
    expect(resumeCallsFor(project)).toHaveLength(2);
    expect(repairCallsFor(project)).toHaveLength(1);
    expect(repairCallsFor(otherProject)).toHaveLength(1);

    // The run settles; the in-flight mark goes with it.
    state.repairGate.resolve();
    state.repairGate = null;
    await flushSetImmediate();

    await activateAllProjects(asIpcContext(context));
    expect(repairCallsFor(project)).toHaveLength(2);
  });
});
