/**
 * Import dedup must survive promotion (and demotion).
 *
 * Regression guards for the "import an issue -> promote it -> import again
 * creates a duplicate" bug. Three independent failure points:
 *
 *   1. findByExternalIds must scan promoted board tasks (the `tasks` table),
 *      not just `backlog_tasks`. Promotion deletes the backlog row, so a
 *      board-only match must still count as already-imported.
 *   2. BACKLOG_PROMOTE must carry external_id/source/url onto the created board
 *      task so guard #1 has something to find.
 *   3. createFromTask (the demote path) must carry the external origin back onto
 *      the new backlog item so a demote -> reimport round-trip stays deduped.
 *
 * better-sqlite3 cannot load under vitest (it is compiled for Electron's Node
 * ABI), so the repository guards run against a SQL-tracking mock / spies rather
 * than a real in-memory database, mirroring tests/unit/task-repository.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

type BacklogRepositoryModule = typeof import('../../src/main/db/repositories/backlog-repository');

// ---------------------------------------------------------------------------
// SQL-tracking mock DB (records prepared SQL + bound args, executes nothing).
// ---------------------------------------------------------------------------

interface PreparedStatement {
  sql: string;
  args: unknown[];
}

function createSqlTracker() {
  const statements: PreparedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const entry: PreparedStatement = { sql, args: [] };
      statements.push(entry);
      return {
        all: (...args: unknown[]) => {
          entry.args = args;
          return [];
        },
        get: (...args: unknown[]) => {
          entry.args = args;
          return undefined;
        },
        run: (...args: unknown[]) => {
          entry.args = args;
          return { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
  };
  return { db: db as unknown as Database.Database, statements };
}

// ---------------------------------------------------------------------------
// Hoisted mocks for the BACKLOG_PROMOTE IPC handler (guard #2).
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from('')),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

const backlogRepoMock = {
  getById: vi.fn(),
  delete: vi.fn(),
};
const taskRepoMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
};
const swimlaneRepoMock = {
  getById: vi.fn(),
};
const attachmentRepoMock = {
  add: vi.fn(),
  list: vi.fn(() => []),
  deleteByTaskId: vi.fn(),
};
const backlogAttachmentRepoMock = {
  add: vi.fn(),
  list: vi.fn(() => []),
  deleteByTaskId: vi.fn(),
};
const sessionRepoMock = {
  getLatestForTask: vi.fn(() => null),
  insert: vi.fn(),
  updateStatus: vi.fn(),
};
const actionRepoMock = {
  getTransitionsFor: vi.fn(() => []),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    getById = backlogRepoMock.getById;
    delete = backlogRepoMock.delete;
  },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = taskRepoMock.create;
    getById = taskRepoMock.getById;
    update = taskRepoMock.update;
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = swimlaneRepoMock.getById;
  },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {
    getTransitionsFor = actionRepoMock.getTransitionsFor;
  },
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    add = attachmentRepoMock.add;
    list = attachmentRepoMock.list;
    deleteByTaskId = attachmentRepoMock.deleteByTaskId;
  },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    add = backlogAttachmentRepoMock.add;
    list = backlogAttachmentRepoMock.list;
    deleteByTaskId = backlogAttachmentRepoMock.deleteByTaskId;
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = sessionRepoMock.getLatestForTask;
    insert = sessionRepoMock.insert;
    updateStatus = sessionRepoMock.updateStatus;
  },
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(async () => {}),
}));

vi.mock('../../src/main/boards', () => ({
  boardRegistry: {
    get: vi.fn(() => null),
    requireStable: vi.fn(),
  },
  ImportSourceStore: class {
    list = vi.fn(() => []);
    add = vi.fn();
    remove = vi.fn();
    updateLabel = vi.fn();
  },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({
  registerAsanaIpcHandlers: vi.fn(),
}));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Guard #1 + #3: repository-level behaviour against the REAL BacklogRepository.
// vi.importActual escapes the module mock above.
// ---------------------------------------------------------------------------

describe('findByExternalIds (import dedup query)', () => {
  it('scans both backlog_tasks and promoted board tasks', async () => {
    const { BacklogRepository } = await vi.importActual<BacklogRepositoryModule>(
      '../../src/main/db/repositories/backlog-repository',
    );
    const { db, statements } = createSqlTracker();
    const repo = new BacklogRepository(db);

    repo.findByExternalIds('github_issues', ['623']);

    expect(statements).toHaveLength(1);
    const sql = statements[0].sql;
    expect(sql).toContain('FROM backlog_tasks');
    // The fix: promoted tasks live in `tasks`, so the dedup query must scan it too.
    expect(sql).toContain('FROM tasks');
    expect(sql).toContain('UNION');
    // source + ids are bound once per unioned table.
    expect(statements[0].args).toEqual(['github_issues', '623', 'github_issues', '623']);
  });

  it('returns an empty set without touching the DB when no external IDs are given', async () => {
    const { BacklogRepository } = await vi.importActual<BacklogRepositoryModule>(
      '../../src/main/db/repositories/backlog-repository',
    );
    const { db, statements } = createSqlTracker();
    const repo = new BacklogRepository(db);

    const result = repo.findByExternalIds('github_issues', []);

    expect(result.size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});

describe('createFromTask (demote carry-back)', () => {
  it('forwards external origin into the new backlog item', async () => {
    const { BacklogRepository } = await vi.importActual<BacklogRepositoryModule>(
      '../../src/main/db/repositories/backlog-repository',
    );
    const { db } = createSqlTracker();
    const repo = new BacklogRepository(db);
    const createSpy = vi.spyOn(repo, 'create').mockReturnValue({
      id: 'backlog-new',
    } as never);

    repo.createFromTask('Title', 'Body', 2, ['bug'], {
      externalId: '623',
      externalSource: 'github_issues',
      externalUrl: 'https://github.com/acme/web/issues/623',
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: '623',
        externalSource: 'github_issues',
        externalUrl: 'https://github.com/acme/web/issues/623',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Guard #2: BACKLOG_PROMOTE carries external origin onto the created task.
// ---------------------------------------------------------------------------

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    sessionManager: {
      listSessions: vi.fn(() => []),
      removeByTaskId: vi.fn(),
    },
  };
}

describe('BACKLOG_PROMOTE external origin carry-through', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    taskRepoMock.create.mockReturnValue({
      id: 'task-promoted',
      title: 'Imported issue',
      swimlane_id: 'lane-todo',
      session_id: null,
    });
    taskRepoMock.getById.mockReturnValue({
      id: 'task-promoted',
      title: 'Imported issue',
      swimlane_id: 'lane-todo',
      session_id: null,
    });
    // auto_spawn:false keeps the handler fully synchronous (no Phase 2 spawn).
    swimlaneRepoMock.getById.mockReturnValue({
      id: 'lane-todo',
      name: 'To Do',
      auto_spawn: false,
      role: null,
    });

    context = createMockContext();
    registerBacklogHandlers(context as never);
  });

  it('passes external_id/source/url from the backlog item into tasks.create', async () => {
    backlogRepoMock.getById.mockReturnValue({
      id: 'backlog-1',
      title: 'Imported issue',
      description: 'desc',
      labels: ['bug'],
      priority: 1,
      external_id: '623',
      external_source: 'github_issues',
      external_url: 'https://github.com/acme/web/issues/623',
    });

    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    await handler(null, {
      backlogTaskIds: ['backlog-1'],
      targetSwimlaneId: 'lane-todo',
    });

    expect(taskRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: '623',
        externalSource: 'github_issues',
        externalUrl: 'https://github.com/acme/web/issues/623',
      }),
    );
  });

  it('leaves external fields undefined when the backlog item has no origin', async () => {
    backlogRepoMock.getById.mockReturnValue({
      id: 'backlog-2',
      title: 'Hand-written item',
      description: 'desc',
      labels: [],
      priority: 0,
      external_id: null,
      external_source: null,
      external_url: null,
    });

    const handler = capturedHandlers.get(IPC.BACKLOG_PROMOTE);
    if (!handler) throw new Error('BACKLOG_PROMOTE handler not registered');

    await handler(null, {
      backlogTaskIds: ['backlog-2'],
      targetSwimlaneId: 'lane-todo',
    });

    const createInput = taskRepoMock.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.externalId).toBeUndefined();
    expect(createInput.externalSource).toBeUndefined();
    expect(createInput.externalUrl).toBeUndefined();
  });
});
