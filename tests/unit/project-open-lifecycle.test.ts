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
  resumeSuspendedSessions: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('resumeSuspendedSessions');
    if (state.resumeError) throw state.resumeError;
  }),
  autoSpawnTasks: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('autoSpawnTasks');
    if (state.autoSpawnError) throw state.autoSpawnError;
  }),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('cleanupStaleResourcesAsync');
    if (state.cleanupGate) await state.cleanupGate.promise;
    if (state.cleanupError) throw state.cleanupError;
  }),
  pruneOrphanedWorktreeTasks: vi.fn(async (...args: unknown[]) => {
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

vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  registerProjectHandlers,
  openProjectByPath,
  activateAllProjects,
} from '../../src/main/ipc/handlers/projects';
import { ensureGitignore } from '../../src/main/ipc/helpers';
import { IPC } from '../../src/shared/ipc-channels';
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
  sessionManager: { setTranscriptRepository: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    attach: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    applyConfigOnOpen: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
  };
  currentProjectId: string | null;
  currentProjectPath: string | null;
  recoveredProjects: Set<string>;
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
    sessionManager: { setTranscriptRepository: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })) },
    boardConfigManager: {
      attach: vi.fn(),
      exists: vi.fn(() => false),
      applyConfigOnOpen: vi.fn(() => []),
      exportFromDb: vi.fn(),
    },
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
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
