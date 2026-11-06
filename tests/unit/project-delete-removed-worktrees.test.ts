/**
 * Deleting a project removes the worktrees a Done move set aside before it
 * removes `<project>/.kangentic/`. `cleanupProject`
 * (src/main/ipc/handlers/projects.ts) awaits `deleteRemovedWorktreesNow`
 * (src/main/git/removed-worktrees.ts) at step 7, because the `fs.rmSync` of
 * `.kangentic/` that follows would otherwise block main for the length of a
 * whole `node_modules` and could follow links out of the folder.
 *
 * `cleanupProject` runs for real here, with every collaborator mocked. The
 * deleter's mock holds its promise open on a gate the test controls, so the
 * ORDER is read without a timer:
 *
 *   - while the gate is shut, the `.kangentic` removal must not have started;
 *   - once the gate opens, the removal follows the deleter's completion.
 *
 * A dropped `await` runs the removal in the same tick the deleter is called, so
 * it shows up while the gate is still shut. A call moved below the removal, or
 * deleted, fails the order and the called-with assertions.
 *
 * A project path that is itself a git worktree (`isInsideWorktree`) keeps its
 * `.kangentic/` and never has removed worktrees of its own, so nothing is
 * deleted there.
 *
 * The same function discards the project's spare worktrees
 * (`discardProjectSpares`, src/main/ipc/helpers/spare-worktrees.ts) inside its
 * git block: after every task worktree is detached, with no task list (the
 * project's rows are going, so no spare folder counts as named), and awaited
 * before the `.kangentic/` removal that would otherwise follow a spare's
 * pnpm links out of the project. The seam is mocked the same gated way.
 *
 * Harness: the mock graph follows project-delete-task-windows.test.ts, which
 * drives the same function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const { callOrder, state } = vi.hoisted(() => ({
  callOrder: [] as string[],
  state: {
    existingPaths: new Set<string>(),
    /** The project's board tasks, as the repository lists them. */
    tasks: [] as Array<{ id: string; worktree_path: string | null; session_id: string | null }>,
  },
}));

const deleteRemovedWorktreesNowMock = vi.hoisted(() =>
  vi.fn<(projectPath: string) => Promise<void>>(async () => {}),
);

const discardProjectSparesMock = vi.hoisted(() =>
  vi.fn<(context: unknown, projectPath: string, tasks: unknown) => Promise<void>>(async () => {}),
);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
    unlinkSync: vi.fn(() => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    // No `.claude/` directory: step 4 skips its removal.
    readdirSync: vi.fn(() => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    // The only removal this file records is the `.kangentic/` one.
    rmSync: vi.fn((target: string) => {
      callOrder.push(`rmSync:${target}`);
    }),
  },
}));

// The seam under test. The rest of the module stays real, since other modules
// in the graph import its other exports.
vi.mock('../../src/main/git/removed-worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/removed-worktrees')>()),
  deleteRemovedWorktreesNow: deleteRemovedWorktreesNowMock,
}));

// The spare worktrees seam. The rest of the module stays real, since other
// modules in the graph import its other exports.
vi.mock('../../src/main/ipc/helpers/spare-worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/spare-worktrees')>()),
  discardProjectSpares: discardProjectSparesMock,
}));

vi.mock('../../src/main/ipc/handlers/project-relocate', () => ({
  relocateProject: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  sweepAutomationRuns: vi.fn(() => 0),
}));

// The queue runs a job at once and records the worktree removal, so the spare
// discard's position among the per-task removals can be read from callOrder.
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = vi.fn();
    withLock = async (job: () => Promise<unknown>) => job();
    removeWorktree = async (worktreePath: string) => {
      callOrder.push(`removeWorktree:${worktreePath}`);
      return true;
    };
  },
  prepareWorktreeForRemoval: vi.fn(async (worktreePath: string) => {
    callOrder.push(`prepare:${worktreePath}`);
  }),
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
  getExistingProjectDb: vi.fn(() => ({})),
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

vi.mock('../../src/main/ipc/helpers/task-windows', () => ({
  closeTaskWindows: vi.fn(),
  closeProjectTaskWindows: vi.fn(),
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

vi.mock('../../src/main/retrieval/retrieval-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-client')>()),
  retrievalClient: {
    call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
    closeProject: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/main/ipc/helpers/tool-breakdown-repair', () => ({
  repairToolBreakdownDurations: vi.fn(async () => ({ completed: true, scanned: 0, repaired: 0, unreadable: 0 })),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = () => [];
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = () => state.tasks;
    listArchived = () => [];
    countAll = () => 0;
  },
}));

vi.mock('../../src/main/workflows/workflow-project-delete', () => ({
  detachProjectFromWorkflows: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-agent')>()),
  endWorkflowAgentsOfProject: vi.fn(async () => {}),
}));

import { cleanupProject } from '../../src/main/ipc/handlers/projects';
import { isGitRepo, isInsideWorktree } from '../../src/main/git/git-checks';
import { prepareWorktreeForRemoval } from '../../src/main/git/worktree-manager';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const PROJECT_ID = 'project-1';
const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-delete-removed-worktrees'));
const KANGENTIC_DIR = path.join(PROJECT_PATH, '.kangentic');
const KANGENTIC_REMOVAL = `rmSync:${KANGENTIC_DIR}`;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

function makeContext(): IpcContext {
  return {
    boardConfigManager: { detach: vi.fn() },
    sessionManager: {
      closeProjectInPtyHost: vi.fn(async () => undefined),
      kill: vi.fn(),
      awaitExit: vi.fn(async () => {}),
      remove: vi.fn(),
      removeByTaskId: vi.fn(async () => {}),
      listSessions: vi.fn(() => []),
    },
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
  } as unknown as IpcContext;
}

const consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  state.existingPaths.clear();
  state.tasks = [];
  // The project folder and its `.kangentic/` both exist, so step 7 reaches the removal.
  state.existingPaths.add(PROJECT_PATH);
  state.existingPaths.add(KANGENTIC_DIR);
  // clearAllMocks keeps implementations, so a gated one from a test would leak.
  deleteRemovedWorktreesNowMock.mockReset();
  deleteRemovedWorktreesNowMock.mockImplementation(async () => {});
  discardProjectSparesMock.mockReset();
  discardProjectSparesMock.mockImplementation(async () => {});
  vi.mocked(isInsideWorktree).mockReturnValue(false);
  vi.mocked(isGitRepo).mockReturnValue(false);
  consoleSpies.push(
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe('cleanupProject deletes the removed worktrees before it removes .kangentic', () => {
  it('awaits deleteRemovedWorktreesNow for the project path, and only then removes .kangentic', async () => {
    const deleteReached = createDeferred();
    const deleteGate = createDeferred();
    deleteRemovedWorktreesNowMock.mockImplementation(async () => {
      callOrder.push('deleteRemovedWorktreesNow');
      deleteReached.resolve();
      await deleteGate.promise;
      callOrder.push('deleteRemovedWorktreesNow:done');
    });

    const cleanup = cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);
    // Raced against the cleanup itself so that a removed call fails the
    // assertions below instead of hanging here until the test timeout.
    await Promise.race([deleteReached.promise, cleanup]);

    // The deleter is running and its gate is shut: the removal has not started.
    expect(deleteRemovedWorktreesNowMock).toHaveBeenCalledTimes(1);
    expect(deleteRemovedWorktreesNowMock).toHaveBeenCalledWith(PROJECT_PATH);
    expect(callOrder).toEqual(['deleteRemovedWorktreesNow']);

    deleteGate.resolve();
    await cleanup;

    expect(callOrder).toEqual([
      'deleteRemovedWorktreesNow',
      'deleteRemovedWorktreesNow:done',
      KANGENTIC_REMOVAL,
    ]);
  });

  it('does not delete removed worktrees, and leaves .kangentic alone, when the project path is itself a worktree', async () => {
    vi.mocked(isInsideWorktree).mockReturnValue(true);

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(vi.mocked(isInsideWorktree)).toHaveBeenCalledWith(PROJECT_PATH);
    expect(deleteRemovedWorktreesNowMock).not.toHaveBeenCalled();
    // The same fixture removes `.kangentic` in the test above, so this is the
    // worktree guard at work and not a missing directory.
    expect(callOrder).not.toContain(KANGENTIC_REMOVAL);
  });
});

describe('cleanupProject discards the project spare worktrees', () => {
  const TASK_WORKTREE = path.join(KANGENTIC_DIR, 'worktrees', 'task-one');

  it('awaits discardProjectSpares with no task list, after the task worktrees are detached and before .kangentic is removed', async () => {
    vi.mocked(isGitRepo).mockReturnValue(true);
    state.existingPaths.add(TASK_WORKTREE);
    state.tasks = [{ id: 'task-1', worktree_path: TASK_WORKTREE, session_id: null }];
    const discardReached = createDeferred();
    const discardGate = createDeferred();
    discardProjectSparesMock.mockImplementation(async () => {
      callOrder.push('discardProjectSpares');
      discardReached.resolve();
      await discardGate.promise;
      callOrder.push('discardProjectSpares:done');
    });
    const context = makeContext();

    const cleanup = cleanupProject(context, PROJECT_ID, PROJECT_PATH);
    // Raced against the cleanup itself so that a removed call fails the
    // assertions below instead of hanging here until the test timeout.
    await Promise.race([discardReached.promise, cleanup]);
    // Several awaits stand between the discard and the .kangentic removal (the
    // retrieval worker and pty host closes), so a dropped await on the discard
    // would not show until they have run. Every collaborator here resolves in
    // microtasks, so one macrotask turn drains them all and nothing real is
    // waited for: with the await in place the cleanup is parked on the shut
    // gate instead.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The discard is running and its gate is shut: it came after the task's
    // worktree was prepared and removed, and nothing past it has started.
    expect(discardProjectSparesMock).toHaveBeenCalledTimes(1);
    // A null task list is the delete: the rows are going, so every spare folder
    // is discarded. A real list here would keep the spares a task names.
    expect(discardProjectSparesMock).toHaveBeenCalledWith(context, PROJECT_PATH, null);
    expect(deleteRemovedWorktreesNowMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual([
      `prepare:${TASK_WORKTREE}`,
      `removeWorktree:${TASK_WORKTREE}`,
      'discardProjectSpares',
    ]);

    discardGate.resolve();
    await cleanup;

    expect(callOrder).toEqual([
      `prepare:${TASK_WORKTREE}`,
      `removeWorktree:${TASK_WORKTREE}`,
      'discardProjectSpares',
      'discardProjectSpares:done',
      KANGENTIC_REMOVAL,
    ]);
    expect(deleteRemovedWorktreesNowMock).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('still discards the spares when a task worktree cannot be detached', async () => {
    vi.mocked(isGitRepo).mockReturnValue(true);
    state.existingPaths.add(TASK_WORKTREE);
    state.tasks = [{ id: 'task-1', worktree_path: TASK_WORKTREE, session_id: null }];
    vi.mocked(prepareWorktreeForRemoval).mockRejectedValueOnce(new Error('worktree is locked'));

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(discardProjectSparesMock).toHaveBeenCalledTimes(1);
    expect(discardProjectSparesMock).toHaveBeenCalledWith(expect.anything(), PROJECT_PATH, null);
  });

  it('discards nothing for a folder that is not a git repository, which has no worktrees to hold spares', async () => {
    vi.mocked(isGitRepo).mockReturnValue(false);

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(vi.mocked(isGitRepo)).toHaveBeenCalledWith(PROJECT_PATH);
    expect(discardProjectSparesMock).not.toHaveBeenCalled();
    // The rest of the delete still ran.
    expect(callOrder).toContain(KANGENTIC_REMOVAL);
  });
});
