/**
 * Deleting a project closes its tasks' OS pop-out windows and offscreen lanes.
 * `cleanupProject` (src/main/ipc/handlers/projects.ts) drives
 * `closeTaskWindows` / `closeProjectTaskWindows` (src/main/ipc/helpers/
 * task-windows.ts), and the one rule of the design is the ORDER: the windows
 * close only after the task's sessions have ended. A Browser pop-out that closes
 * while its agent still runs has its guest destroyed, and the lane hand-off then
 * stands an offscreen lane up for a task that is about to be deleted.
 *
 * `cleanupProject` runs for real here, with every collaborator mocked. The ORDER
 * is read off one shared `callOrder` array that the mocks write to:
 *
 *   - `remove:<id>`   `removeByTaskId` was called for the task
 *   - `settled:<id>`  that call's promise resolved (on a timer, a few ms later)
 *   - the window closes, `endWorkflowAgents`, `reap` and `closeProjectDb`
 *
 * `removeByTaskId` settles LATE on purpose. A close that did not await it would
 * land before the `settled:` entries, so a dropped `await` shows up as an order
 * mismatch instead of passing because every mock was already resolved.
 *
 * Three paths, all under the same deterministic registry fixture (a mix of this
 * project's sessions, another project's session, a transient session and a
 * session with no task):
 *
 *   1. the project folder is gone: no task list to go by, so the registry names
 *      the tasks and `closeProjectTaskWindows` closes whatever pop-outs name them;
 *   2. the folder exists and the task read works: `closeTaskWindows` per live and
 *      per archived task, the registry never consulted;
 *   3. the folder exists and the task read throws: the registry stands in for the
 *      lost list, as in path 1, ahead of the reap.
 *
 * The static scans in session-leftover-reap-wiring.test.ts still pin the source
 * order of the normal path. This file is the runtime proof for all three.
 *
 * Harness: the mock graph follows project-delete-clears-conversation-expired.test.ts,
 * which drives the same function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { Session, Task } from '../../src/shared/types';

const { callOrder, state } = vi.hoisted(() => ({
  callOrder: [] as string[],
  state: {
    existingPaths: new Set<string>(),
    liveTasks: [] as unknown[],
    archivedTasks: [] as unknown[],
    readThrows: false,
    registrySessions: [] as unknown[],
  },
}));

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
  },
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
  pruneOrphanedWorktreeTasks: vi.fn(async () => 0),
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
  getExistingProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(() => { callOrder.push('closeProjectDb'); }),
}));

vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => { callOrder.push('reap'); }),
  leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => {} })),
}));

// The seam under test: both closes record into the shared order.
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({
  closeTaskWindows: vi.fn((projectId: string, taskId: string) => {
    callOrder.push(`closeTaskWindows:${projectId}:${taskId}`);
  }),
  closeProjectTaskWindows: vi.fn((projectId: string) => {
    callOrder.push(`closeProjectTaskWindows:${projectId}`);
  }),
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
    list = () => {
      if (state.readThrows) throw new Error('database disk image is malformed');
      return state.liveTasks;
    };
    listArchived = () => state.archivedTasks;
    countAll = () => 0;
  },
}));

vi.mock('../../src/main/workflows/workflow-project-delete', () => ({
  detachProjectFromWorkflows: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-agent')>()),
  endWorkflowAgentsOfProject: vi.fn(async () => { callOrder.push('endWorkflowAgents'); }),
}));

import { cleanupProject } from '../../src/main/ipc/handlers/projects';
import { reapTaskLeftovers } from '../../src/main/ipc/helpers';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';
const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-delete-task-windows'));

/** How long a task's `removeByTaskId` takes to settle. Real timers: the only
 *  thing that matters is that it is later than the synchronous code after it. */
const REMOVAL_SETTLE_MS = 5;

function makeTask(id: string): Task {
  return { id, session_id: null, worktree_path: null } as unknown as Task;
}

function makeRegistrySession(id: string, projectId: string, taskId: string, overrides: Partial<Session> = {}): Session {
  return { id, projectId, taskId, ...overrides } as unknown as Session;
}

/**
 * The registry as the delete finds it. Only the first two entries name a task of
 * THIS project that the delete must remove; the rest must be left alone.
 */
function registryFixture(): Session[] {
  return [
    makeRegistrySession('pty-1', PROJECT_ID, 'task-reg-1'),
    makeRegistrySession('pty-2', PROJECT_ID, 'task-reg-2'),
    // A second session of the first task: its task is removed once, not twice.
    makeRegistrySession('pty-3', PROJECT_ID, 'task-reg-1'),
    // Another project's task: never this delete's to remove or to close.
    makeRegistrySession('pty-4', OTHER_PROJECT_ID, 'task-other'),
    // A Command Terminal or a workflow's own agent: no task's session.
    makeRegistrySession('pty-5', PROJECT_ID, 'task-transient', { transient: true }),
    // A session that names no task.
    makeRegistrySession('pty-6', PROJECT_ID, ''),
  ];
}

interface MockSessionManager {
  closeProjectInPtyHost: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  awaitExit: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  removeByTaskId: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
}

function makeContext(): { context: IpcContext; sessionManager: MockSessionManager } {
  const sessionManager: MockSessionManager = {
    closeProjectInPtyHost: vi.fn(async () => undefined),
    kill: vi.fn(),
    awaitExit: vi.fn(async () => {}),
    remove: vi.fn(),
    removeByTaskId: vi.fn((taskId: string) => {
      callOrder.push(`remove:${taskId}`);
      // Settles on a timer, so a caller that does not await it runs first.
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          callOrder.push(`settled:${taskId}`);
          resolve();
        }, REMOVAL_SETTLE_MS);
      });
    }),
    listSessions: vi.fn(() => state.registrySessions),
  };
  const context = {
    boardConfigManager: { detach: vi.fn() },
    sessionManager,
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
  } as unknown as IpcContext;
  return { context, sessionManager };
}

const consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  state.existingPaths.clear();
  state.liveTasks = [];
  state.archivedTasks = [];
  state.readThrows = false;
  state.registrySessions = registryFixture();
  // cleanupProject logs its progress, the "folder is gone" warning and a failed read.
  consoleSpies.push(
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe('cleanupProject closes the task windows after the sessions have ended', () => {
  it('folder gone: removes the project\'s registry tasks, then closes their windows, before the database closes', async () => {
    // PROJECT_PATH is not in existingPaths: the early-return branch.
    const { context, sessionManager } = makeContext();

    await cleanupProject(context, PROJECT_ID, PROJECT_PATH);

    // Each task of THIS project once. Not the other project's, not the transient
    // session's, not the session that names no task, and not task-reg-1 twice.
    expect(sessionManager.removeByTaskId.mock.calls).toEqual([['task-reg-1'], ['task-reg-2']]);
    expect(callOrder).toEqual([
      'endWorkflowAgents',
      'remove:task-reg-1',
      'remove:task-reg-2',
      'settled:task-reg-1',
      'settled:task-reg-2',
      `closeProjectTaskWindows:${PROJECT_ID}`,
      'closeProjectDb',
    ]);
  });

  it('folder gone: closes nothing while a task\'s sessions are still being removed', async () => {
    const { context } = makeContext();

    const cleanup = cleanupProject(context, PROJECT_ID, PROJECT_PATH);
    // The removals were started but have not settled. A fixed wait is right
    // here: non-occurrence cannot be polled for. Longer than the microtask
    // turns the mocks need, shorter than the removals' own timers.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(callOrder).toEqual(['endWorkflowAgents', 'remove:task-reg-1', 'remove:task-reg-2']);

    await cleanup;
    expect(callOrder.at(-2)).toBe(`closeProjectTaskWindows:${PROJECT_ID}`);
  });

  it('folder present, tasks read: closes every live and archived task\'s windows after the removals settle and before the reap', async () => {
    state.existingPaths.add(PROJECT_PATH);
    state.liveTasks = [makeTask('live-1'), makeTask('live-2')];
    state.archivedTasks = [makeTask('archived-1')];
    const { context, sessionManager } = makeContext();

    await cleanupProject(context, PROJECT_ID, PROJECT_PATH);

    // The task list names the tasks, so the registry is not consulted: its
    // sessions (task-reg-1 and the rest) are neither removed nor closed here, and
    // closeProjectTaskWindows never runs.
    expect(sessionManager.removeByTaskId.mock.calls).toEqual([['live-1'], ['live-2']]);
    expect(callOrder).toEqual([
      'remove:live-1',
      'remove:live-2',
      'settled:live-1',
      'settled:live-2',
      `closeTaskWindows:${PROJECT_ID}:live-1`,
      `closeTaskWindows:${PROJECT_ID}:live-2`,
      `closeTaskWindows:${PROJECT_ID}:archived-1`,
      'endWorkflowAgents',
      'reap',
      'closeProjectDb',
    ]);
    expect(vi.mocked(reapTaskLeftovers)).toHaveBeenCalledWith(
      context,
      PROJECT_PATH,
      [expect.objectContaining({ id: 'live-1' }), expect.objectContaining({ id: 'live-2' }), expect.objectContaining({ id: 'archived-1' })],
    );
  });

  it('folder present, tasks read: closes nothing while a task\'s sessions are still being removed', async () => {
    state.existingPaths.add(PROJECT_PATH);
    state.liveTasks = [makeTask('live-1')];
    state.archivedTasks = [makeTask('archived-1')];
    const { context } = makeContext();

    const cleanup = cleanupProject(context, PROJECT_ID, PROJECT_PATH);
    // Non-occurrence again, so a fixed wait: see the folder-gone case above.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(callOrder).toEqual(['remove:live-1']);

    await cleanup;
    expect(callOrder.indexOf(`closeTaskWindows:${PROJECT_ID}:live-1`)).toBeGreaterThan(callOrder.indexOf('settled:live-1'));
  });

  it('folder present, task read throws: still removes the registry\'s tasks, then closes the project\'s windows, ahead of the reap', async () => {
    state.existingPaths.add(PROJECT_PATH);
    state.readThrows = true;
    const { context, sessionManager } = makeContext();

    await cleanupProject(context, PROJECT_ID, PROJECT_PATH);

    // The same filtering as the folder-gone case: this project's task sessions only.
    expect(sessionManager.removeByTaskId.mock.calls).toEqual([['task-reg-1'], ['task-reg-2']]);
    expect(callOrder).toEqual([
      'remove:task-reg-1',
      'remove:task-reg-2',
      'settled:task-reg-1',
      'settled:task-reg-2',
      `closeProjectTaskWindows:${PROJECT_ID}`,
      'endWorkflowAgents',
      'reap',
      'closeProjectDb',
    ]);
    // The failed read left no task to reap for; the reap still ran, with none.
    expect(vi.mocked(reapTaskLeftovers)).toHaveBeenCalledWith(context, PROJECT_PATH, []);
  });
});
