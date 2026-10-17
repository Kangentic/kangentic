/**
 * BACKLOG_DEMOTE routes by the project the caller stamps, and announces its
 * write to the main window however the demote settles.
 *
 * The Agent Monitor can demote a task of a project the board is not on. The
 * handler therefore takes a trailing `requestedProjectId`, resolves it with the
 * real `resolveProjectContext`, and opens that project's database and
 * repositories (`.claude/rules/project-scoped-ipc.md`). backlog-promote-abort
 * drives this handler with `null` as the event and only the input, so the
 * trailing id and the announce were never exercised there.
 *
 * Real: `registerBacklogHandlers`, `resolveProjectContext`, `getProjectRepos`,
 * `announceTaskWrite`, `sendToRenderer`, `withTaskLock`.
 * Doubled: the per-project repositories (each one remembers which database
 * handle it was built from, so a wrong route is visible), `getProjectDb`, and
 * `cleanupTaskResources`.
 *
 * Every routing test stamps `proj-2` while the ambient current project is
 * `proj-1`. A handler that drifted back to ambient routing would still pass a
 * test whose stamped id equalled the current one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Shared state, hoisted so the vi.mock factories below can reach it
// ---------------------------------------------------------------------------

interface DatabaseHandle {
  databaseFor: string;
}

interface ProjectDoubles {
  backlogRepository: {
    createFromTask: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
  };
  backlogAttachmentAdd: ReturnType<typeof vi.fn>;
  tasks: {
    getById: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  attachments: {
    list: ReturnType<typeof vi.fn>;
    deleteByTaskId: ReturnType<typeof vi.fn>;
  };
}

const shared = vi.hoisted(() => {
  const projectDoubles = new Map<string, unknown>();
  return {
    ATTACHMENT_BYTES: 'attachment-bytes',
    ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    projectDoubles,
    getProjectDb: vi.fn(),
    cleanupTaskResources: vi.fn(),
    /** The doubles for the project a repository was built for. */
    doublesFor(database: { databaseFor: string }): ProjectDoubles {
      const doubles = projectDoubles.get(database.databaseFor);
      if (!doubles) throw new Error(`No doubles registered for project ${database.databaseFor}`);
      return doubles as ProjectDoubles;
    },
  };
});

// ---------------------------------------------------------------------------
// Mocks (all hoisted above the import under test)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      shared.ipcHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from('attachment-bytes')),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (...args: unknown[]) => shared.getProjectDb(...args),
  getExistingProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    createFromTask: (...args: unknown[]) => unknown;
    getById: (...args: unknown[]) => unknown;
    constructor(database: DatabaseHandle) {
      const { backlogRepository } = shared.doublesFor(database);
      this.createFromTask = backlogRepository.createFromTask;
      this.getById = backlogRepository.getById;
    }
  },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    add: (...args: unknown[]) => unknown;
    constructor(database: DatabaseHandle) {
      this.add = shared.doublesFor(database).backlogAttachmentAdd;
    }
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById: (...args: unknown[]) => unknown;
    delete: (...args: unknown[]) => unknown;
    constructor(database: DatabaseHandle) {
      const { tasks } = shared.doublesFor(database);
      this.getById = tasks.getById;
      this.delete = tasks.delete;
    }
  },
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    list: (...args: unknown[]) => unknown;
    deleteByTaskId: (...args: unknown[]) => unknown;
    constructor(database: DatabaseHandle) {
      const { attachments } = shared.doublesFor(database);
      this.list = attachments.list;
      this.deleteByTaskId = attachments.deleteByTaskId;
    }
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));

// The helpers index is replaced, but `getProjectRepos` stays the real one, so
// the repositories it builds come from the doubled `getProjectDb` and the
// doubled repository classes above.
vi.mock('../../src/main/ipc/helpers', async () => {
  const projectRepos = await vi.importActual<typeof import('../../src/main/ipc/helpers/project-repos')>(
    '../../src/main/ipc/helpers/project-repos',
  );
  return {
    getProjectRepos: projectRepos.getProjectRepos,
    cleanupTaskResources: (...args: unknown[]) => shared.cleanupTaskResources(...args),
    createTransitionEngine: vi.fn(),
    ensureTaskWorktree: vi.fn(),
    ensureTaskBranchCheckout: vi.fn(),
    notifySpawnBlocked: vi.fn(),
    spawnAgent: vi.fn(),
    openAttachmentFile: vi.fn(),
  };
});

vi.mock('../../src/main/boards', () => ({
  boardRegistry: { get: vi.fn(() => null), requireStable: vi.fn() },
  ImportSourceStore: class {},
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import { IPC } from '../../src/shared/ipc-channels';
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';
import { getExistingProjectDb } from '../../src/main/db/database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import { openTestDatabase } from './helpers/test-database';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CURRENT_PROJECT_ID = 'proj-1';
const CURRENT_PROJECT_PATH = '/mock/project-one';
const OTHER_PROJECT_ID = 'proj-2';
const OTHER_PROJECT_PATH = '/mock/project-two';
const TASK_ID = 'task-to-demote';
const MAIN_WINDOW_WEB_CONTENTS_ID = 1;

/** The IPC event of a write made from the pop-out Agent Monitor. */
const FROM_OTHER_WINDOW = { sender: { id: 2, isDestroyed: () => false } };
/** The IPC event of a write made from the main window itself. */
const FROM_MAIN_WINDOW = { sender: { id: MAIN_WINDOW_WEB_CONTENTS_ID, isDestroyed: () => false } };

function titleIn(projectId: string): string {
  return `Demote me (${projectId})`;
}

function backlogIdIn(projectId: string): string {
  return `backlog-${projectId}`;
}

/**
 * One project's repository doubles. Both projects hold the same task id, under
 * a title that names the project, so a handler that routes to the wrong project
 * still finishes and the assertions show where it went.
 */
function createProjectDoubles(projectId: string): ProjectDoubles {
  return {
    backlogRepository: {
      createFromTask: vi.fn(() => ({ id: backlogIdIn(projectId), title: titleIn(projectId) })),
      getById: vi.fn((backlogTaskId: string) => ({ id: backlogTaskId, title: titleIn(projectId), attachment_count: 1 })),
    },
    backlogAttachmentAdd: vi.fn(),
    tasks: {
      getById: vi.fn((taskId: string) => (taskId === TASK_ID
        ? {
          id: TASK_ID,
          display_id: 7,
          title: titleIn(projectId),
          description: 'desc',
          labels: ['bug'],
          priority: 2,
          external_id: null,
          external_source: null,
          external_url: null,
          session_id: null,
          // No workflow: isInWorkflow() returns before it reads any database.
          workflow_id: null,
          workflow_project_id: null,
        }
        : undefined)),
      delete: vi.fn(),
    },
    attachments: {
      list: vi.fn(() => [{ filename: 'shot.png', file_path: '/mock/attachments/shot.png', media_type: 'image/png' }]),
      deleteByTaskId: vi.fn(),
    },
  };
}

function createContext() {
  const send = vi.fn();
  return {
    currentProjectId: CURRENT_PROJECT_ID as string | null,
    currentProjectPath: CURRENT_PROJECT_PATH as string | null,
    // resolveProjectContext looks a non-current project's path up here.
    projectRepo: {
      getById: vi.fn((projectId: string) => (projectId === OTHER_PROJECT_ID
        ? { id: projectId, path: OTHER_PROJECT_PATH }
        : undefined)),
    },
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { id: MAIN_WINDOW_WEB_CONTENTS_ID, send },
    },
    boardEvents: { emitBoardChanged: vi.fn() },
    terminalSubmitScheduler: { cancel: vi.fn() },
    sessionManager: {},
  };
}

function doublesIn(projectId: string): ProjectDoubles {
  return shared.doublesFor({ databaseFor: projectId });
}

let context: ReturnType<typeof createContext>;

/** Invoke the registered handler the way the preload does: event, input, then the trailing project id (if any). */
function invokeDemoteOf(taskId: string, event: unknown, ...trailingArguments: unknown[]): Promise<unknown> {
  const handler = shared.ipcHandlers.get(IPC.BACKLOG_DEMOTE);
  if (!handler) throw new Error('BACKLOG_DEMOTE handler not registered');
  return Promise.resolve(handler(event, { taskId }, ...trailingArguments));
}

function invokeDemote(event: unknown, ...trailingArguments: unknown[]): Promise<unknown> {
  return invokeDemoteOf(TASK_ID, event, ...trailingArguments);
}

/** Every TASK_CHANGED_IN_OTHER_WINDOW push the main window received. */
function otherWindowPushes(): unknown[][] {
  return context.mainWindow.webContents.send.mock.calls
    .filter((call: unknown[]) => call[0] === IPC.TASK_CHANGED_IN_OTHER_WINDOW);
}

function openedProjectIds(): unknown[] {
  return shared.getProjectDb.mock.calls.map((call: unknown[]) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.ipcHandlers.clear();
  shared.projectDoubles.clear();
  shared.projectDoubles.set(CURRENT_PROJECT_ID, createProjectDoubles(CURRENT_PROJECT_ID));
  shared.projectDoubles.set(OTHER_PROJECT_ID, createProjectDoubles(OTHER_PROJECT_ID));
  // clearAllMocks keeps implementations: re-arm the ones a test may have replaced.
  shared.getProjectDb.mockReset();
  shared.getProjectDb.mockImplementation((projectId: string): DatabaseHandle => ({ databaseFor: projectId }));
  shared.cleanupTaskResources.mockReset();
  shared.cleanupTaskResources.mockResolvedValue(undefined);

  context = createContext();
  registerBacklogHandlers(context as never);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('BACKLOG_DEMOTE routes by the explicit trailing projectId', () => {
  it('demotes the task inside the stamped project, not the current one', async () => {
    const result = await invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID);

    const stamped = doublesIn(OTHER_PROJECT_ID);
    const ambient = doublesIn(CURRENT_PROJECT_ID);

    // Only the stamped project's database was ever opened.
    expect(openedProjectIds()).toContain(OTHER_PROJECT_ID);
    expect(openedProjectIds()).not.toContain(CURRENT_PROJECT_ID);
    // Its path came from the project repo, not from the current project's context.
    expect(context.projectRepo.getById).toHaveBeenCalledWith(OTHER_PROJECT_ID);

    // The task was read and deleted in the stamped project; the ambient one saw nothing.
    expect(stamped.tasks.getById).toHaveBeenCalledWith(TASK_ID);
    expect(stamped.tasks.delete).toHaveBeenCalledWith(TASK_ID);
    expect(ambient.tasks.getById).not.toHaveBeenCalled();
    expect(ambient.tasks.delete).not.toHaveBeenCalled();

    // The backlog row was created through the stamped project's repository,
    // from that project's copy of the task.
    expect(stamped.backlogRepository.createFromTask).toHaveBeenCalledTimes(1);
    expect(stamped.backlogRepository.createFromTask).toHaveBeenCalledWith(
      titleIn(OTHER_PROJECT_ID), 'desc', 2, ['bug'],
      { externalId: null, externalSource: null, externalUrl: null },
    );
    expect(ambient.backlogRepository.createFromTask).not.toHaveBeenCalled();

    // The attachment copy was written against the stamped project's path.
    expect(stamped.backlogAttachmentAdd).toHaveBeenCalledWith(
      OTHER_PROJECT_PATH,
      backlogIdIn(OTHER_PROJECT_ID),
      'shot.png',
      Buffer.from(shared.ATTACHMENT_BYTES).toString('base64'),
      'image/png',
    );
    expect(ambient.backlogAttachmentAdd).not.toHaveBeenCalled();

    // The session cleanup is scoped to the stamped project and its repository.
    expect(shared.cleanupTaskResources).toHaveBeenCalledTimes(1);
    const [, cleanedTask, cleanedTasks, cleanedProjectId, cleanedProjectPath] = shared.cleanupTaskResources.mock.calls[0] as unknown[];
    expect(cleanedTask).toEqual(expect.objectContaining({ id: TASK_ID, title: titleIn(OTHER_PROJECT_ID) }));
    expect((cleanedTasks as { getById: unknown }).getById).toBe(stamped.tasks.getById);
    expect(cleanedProjectId).toBe(OTHER_PROJECT_ID);
    expect(cleanedProjectPath).toBe(OTHER_PROJECT_PATH);

    // The caller gets the re-fetched row of the stamped project's backlog.
    expect(result).toEqual(expect.objectContaining({ id: backlogIdIn(OTHER_PROJECT_ID), title: titleIn(OTHER_PROJECT_ID) }));
  });

  it.each([
    ['null', [null]],
    ['omitted', []],
  ])('falls back to the current project when the project id is %s', async (_label, trailingArguments) => {
    await invokeDemote(FROM_MAIN_WINDOW, ...trailingArguments);

    const ambient = doublesIn(CURRENT_PROJECT_ID);
    const unrelated = doublesIn(OTHER_PROJECT_ID);

    expect(openedProjectIds()).toContain(CURRENT_PROJECT_ID);
    expect(openedProjectIds()).not.toContain(OTHER_PROJECT_ID);
    // The current project's path is on the context: no lookup.
    expect(context.projectRepo.getById).not.toHaveBeenCalled();

    expect(ambient.tasks.delete).toHaveBeenCalledWith(TASK_ID);
    expect(ambient.backlogRepository.createFromTask).toHaveBeenCalledTimes(1);
    expect(unrelated.tasks.getById).not.toHaveBeenCalled();
    expect(unrelated.backlogRepository.createFromTask).not.toHaveBeenCalled();

    const [, , , cleanedProjectId, cleanedProjectPath] = shared.cleanupTaskResources.mock.calls[0] as unknown[];
    expect(cleanedProjectId).toBe(CURRENT_PROJECT_ID);
    expect(cleanedProjectPath).toBe(CURRENT_PROJECT_PATH);
  });

  it('refuses a stamped project it cannot find a path for, instead of demoting in the current project', async () => {
    await expect(invokeDemote(FROM_OTHER_WINDOW, 'proj-removed')).rejects.toThrow('No project is currently open');

    // Nothing was opened, cleaned up, or created anywhere, and with no write
    // there is nothing to announce.
    expect(shared.getProjectDb).not.toHaveBeenCalled();
    expect(shared.cleanupTaskResources).not.toHaveBeenCalled();
    expect(doublesIn(CURRENT_PROJECT_ID).backlogRepository.createFromTask).not.toHaveBeenCalled();
    expect(doublesIn(CURRENT_PROJECT_ID).tasks.delete).not.toHaveBeenCalled();
    expect(otherWindowPushes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Announce
// ---------------------------------------------------------------------------

describe('BACKLOG_DEMOTE announces the write on the board-changed bus', () => {
  it('emits task-deleted for the stamped project once, for a demote from the main window', async () => {
    // A paired phone is not the main window, so the board's own demote still
    // has to take the card off its board.
    await invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID);

    expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
      [{ projectId: OTHER_PROJECT_ID, change: 'task-deleted', ids: [TASK_ID] }],
    ]);
  });

  it('emits only after the task row is deleted, so a phone\'s re-read no longer lists the card', async () => {
    // Recorded inside the listener and asserted outside it, because the announce
    // swallows a listener's throw and an expect there could never fail the test.
    let taskDeletedAtEmit: boolean | undefined;
    context.boardEvents.emitBoardChanged.mockImplementation(() => {
      taskDeletedAtEmit = doublesIn(OTHER_PROJECT_ID).tasks.delete.mock.calls.length > 0;
    });

    await invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID);

    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);
    expect(taskDeletedAtEmit).toBe(true);
  });

  it('still emits once, and still rejects with the delete error, when the task delete fails after the backlog row was created', async () => {
    // The backlog row landed before the delete threw, so both lists changed and
    // a phone must re-read. Only the `finally` reaches the bus on this path.
    const deleteError = new Error('SQLITE_BUSY: database is locked');
    doublesIn(OTHER_PROJECT_ID).tasks.delete.mockImplementation(() => { throw deleteError; });

    await expect(invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID)).rejects.toBe(deleteError);

    expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
      [{ projectId: OTHER_PROJECT_ID, change: 'task-deleted', ids: [TASK_ID] }],
    ]);
  });

  it('emits for the resolved current project when no id was stamped', async () => {
    // Announcing the raw argument would hand the bus a null project and drop it.
    await invokeDemote(FROM_MAIN_WINDOW, null);

    expect(context.boardEvents.emitBoardChanged.mock.calls).toEqual([
      [{ projectId: CURRENT_PROJECT_ID, change: 'task-deleted', ids: [TASK_ID] }],
    ]);
  });

  it('emits nothing for a demote refused before any write', async () => {
    await expect(invokeDemote(FROM_OTHER_WINDOW, 'proj-removed')).rejects.toThrow('No project is currently open');

    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
  });
});

describe('BACKLOG_DEMOTE announces the write to the main window', () => {
  it('pushes the stamped project id once when another window demotes', async () => {
    await invokeDemote(FROM_OTHER_WINDOW, OTHER_PROJECT_ID);

    expect(otherWindowPushes()).toEqual([[IPC.TASK_CHANGED_IN_OTHER_WINDOW, OTHER_PROJECT_ID]]);
  });

  it('pushes the resolved current project id, not the missing request, when no id was stamped', async () => {
    // Announcing the raw argument would hand the helper null, which it treats as
    // "no project" and drops: the board would never hear of the demote.
    await invokeDemote(FROM_OTHER_WINDOW, null);

    expect(otherWindowPushes()).toEqual([[IPC.TASK_CHANGED_IN_OTHER_WINDOW, CURRENT_PROJECT_ID]]);
  });

  it('still pushes once, and still rejects with the delete error, when the task delete fails after the backlog row was created', async () => {
    // Red case: the shape before this change was
    //   const demoted = await withTaskLock(...);
    //   announceTaskWrite(context, event, projectId, ...);
    //   return demoted;
    // When tasks.delete throws, the lock rejects, the `await` throws, and the
    // announce line is never reached: zero pushes, so the one-push assertion
    // below fails. The `finally` is what makes it fire on this path.
    const deleteError = new Error('SQLITE_BUSY: database is locked');
    doublesIn(OTHER_PROJECT_ID).tasks.delete.mockImplementation(() => { throw deleteError; });

    await expect(invokeDemote(FROM_OTHER_WINDOW, OTHER_PROJECT_ID)).rejects.toBe(deleteError);

    // The write did commit before the failure: the session cleanup ran and the
    // backlog row exists, so both lists changed.
    expect(shared.cleanupTaskResources).toHaveBeenCalledTimes(1);
    expect(doublesIn(OTHER_PROJECT_ID).backlogRepository.createFromTask).toHaveBeenCalledTimes(1);
    expect(otherWindowPushes()).toEqual([[IPC.TASK_CHANGED_IN_OTHER_WINDOW, OTHER_PROJECT_ID]]);
  });

  it('sends nothing for a demote made from the main window itself', async () => {
    await invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID);

    expect(doublesIn(OTHER_PROJECT_ID).tasks.delete).toHaveBeenCalledWith(TASK_ID);
    expect(otherWindowPushes()).toEqual([]);
  });

  it('sends nothing for a failed demote made from the main window itself', async () => {
    const deleteError = new Error('SQLITE_BUSY: database is locked');
    doublesIn(OTHER_PROJECT_ID).tasks.delete.mockImplementation(() => { throw deleteError; });

    await expect(invokeDemote(FROM_MAIN_WINDOW, OTHER_PROJECT_ID)).rejects.toBe(deleteError);

    expect(otherWindowPushes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refusals announce nothing
//
// A demote of a task that is in a workflow, or that does not exist, changes
// nothing, so a paired phone must not hear `task-deleted` for a card that is
// still on the board, and the main window must not be told to reload. The
// handler refuses before it takes the task lock for exactly that reason.
//
// The workflow is a real row in a real migrated database, read through the
// real `isInWorkflow` and `workflowTitleOf`. `getExistingProjectDb` is the
// workflow's home and the only database read for it; the per-project repository
// doubles above stay as they are.
// ---------------------------------------------------------------------------

describe('BACKLOG_DEMOTE refuses without announcing', () => {
  const WORKFLOW_TITLE = 'Usage budgets';
  const UNKNOWN_TASK_ID = 'task-that-does-not-exist';
  let database: Database.Database;
  let workflowId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    vi.mocked(getExistingProjectDb).mockReturnValue(database as never);
    const workflows = new WorkflowRepository(database);
    const workflow = workflows.create({ title: WORKFLOW_TITLE });
    workflows.markStarted(workflow.id);
    workflowId = workflow.id;
  });

  afterEach(() => {
    // clearAllMocks keeps implementations, so put the file-wide default back.
    vi.mocked(getExistingProjectDb).mockReturnValue({} as never);
    database.close();
  });

  /** The stamped project's copy of the task, with or without its workflow membership. */
  function taskRow(inWorkflow: boolean): Record<string, unknown> {
    return {
      id: TASK_ID,
      display_id: 7,
      title: titleIn(OTHER_PROJECT_ID),
      description: 'desc',
      labels: ['bug'],
      priority: 2,
      external_id: null,
      external_source: null,
      external_url: null,
      session_id: null,
      workflow_id: inWorkflow ? workflowId : null,
      workflow_project_id: null,
    };
  }

  function refusalSentence(): string {
    return WORKFLOW_REFUSALS.removeFirst('#7', WORKFLOW_TITLE);
  }

  /** Nothing the demote does when it goes through happened. */
  function expectNothingDemoted(): void {
    const stamped = doublesIn(OTHER_PROJECT_ID);
    expect(shared.cleanupTaskResources).not.toHaveBeenCalled();
    expect(stamped.backlogRepository.createFromTask).not.toHaveBeenCalled();
    expect(stamped.backlogAttachmentAdd).not.toHaveBeenCalled();
    expect(stamped.attachments.deleteByTaskId).not.toHaveBeenCalled();
    expect(stamped.tasks.delete).not.toHaveBeenCalled();
  }

  it('a task in a workflow rejects with the refusal and announces nothing, even from another window', async () => {
    doublesIn(OTHER_PROJECT_ID).tasks.getById.mockReturnValue(taskRow(true));

    await expect(invokeDemote(FROM_OTHER_WINDOW, OTHER_PROJECT_ID))
      .rejects.toThrow(new Error(refusalSentence()));

    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
    expect(otherWindowPushes()).toEqual([]);
    expectNothingDemoted();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
  });

  it('refuses a workflow task before it queues on the task lock', async () => {
    doublesIn(OTHER_PROJECT_ID).tasks.getById.mockReturnValue(taskRow(true));
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = withTaskLock(TASK_ID, () => lockHeld);

    const outcome: { settled: boolean; error?: unknown } = { settled: false };
    const demotion = invokeDemote(FROM_OTHER_WINDOW, OTHER_PROJECT_ID)
      .catch((error: unknown) => { outcome.error = error; })
      .finally(() => { outcome.settled = true; });

    try {
      // A fixed turn of the event loop, on purpose. A demote parked on the held
      // lock never settles, and the absence of a settlement cannot be polled.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toEqual(new Error(refusalSentence()));
    } finally {
      releaseLock();
      await holder;
      await demotion;
    }

    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
    expect(otherWindowPushes()).toEqual([]);
    expectNothingDemoted();
  });

  it('a task that joins a workflow while the demote waits on the lock is refused inside the lock', async () => {
    // The first read (before the lock) sees an ordinary task, every later read
    // sees a member, which is the race the second check exists for.
    doublesIn(OTHER_PROJECT_ID).tasks.getById
      .mockReturnValueOnce(taskRow(false))
      .mockReturnValue(taskRow(true));
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = withTaskLock(TASK_ID, () => lockHeld);

    const refused = expect(invokeDemote(FROM_OTHER_WINDOW, OTHER_PROJECT_ID))
      .rejects.toThrow(new Error(refusalSentence()));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // Parked on the lock, so the body has not run yet.
    expect(shared.cleanupTaskResources).not.toHaveBeenCalled();

    releaseLock();
    await holder;
    await refused;

    expectNothingDemoted();
    expect(context.terminalSubmitScheduler.cancel).not.toHaveBeenCalled();
    // What the bus and the main window hear for this in-lock refusal is left
    // unpinned on purpose. The handler's finally announces it as it does a write
    // that committed, and backlog.ts accepts that for this race, since a phone
    // only re-reads the board on the event.
  });

  it('an unknown task id rejects with not found and announces nothing', async () => {
    await expect(invokeDemoteOf(UNKNOWN_TASK_ID, FROM_OTHER_WINDOW, OTHER_PROJECT_ID))
      .rejects.toThrow(`Task ${UNKNOWN_TASK_ID} not found`);

    expect(doublesIn(OTHER_PROJECT_ID).tasks.getById).toHaveBeenCalledWith(UNKNOWN_TASK_ID);
    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
    expect(otherWindowPushes()).toEqual([]);
    expectNothingDemoted();
  });
});
