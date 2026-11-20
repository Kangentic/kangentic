/**
 * Backlog IPC handlers that carry a source's repository (#872) and the priority
 * remap. Each case drives the real handler in `ipc/handlers/backlog.ts` through
 * the captured-IPC-handler pattern, with the repositories mocked.
 *
 *  - BACKLOG_REMAP_PRIORITIES remaps the backlog, the board tasks and the
 *    automations' Priority lines, inside one write transaction on the project
 *    database. The rollback itself is pinned on a real database in
 *    backlog-remap-priorities-transaction.test.ts.
 *  - BACKLOG_REPO_FOLDERS_LIST browses the resolved project's folders.
 *  - BACKLOG_IMPORT_EXECUTE and BACKLOG_PROMOTE keep the repository on the item,
 *    so the same issue id from two sources of one provider never collides.
 *  - BACKLOG_IMPORT_RECONCILE scopes its already-imported lookup to the source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

const PROJECT_DB = { name: 'project-db' };
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => PROJECT_DB),
  getExistingProjectDb: vi.fn(() => PROJECT_DB),
}));

// A transaction that records which database it was opened on, and whether its
// body is running, so the remap's three calls can be shown to run inside it.
const transactionState = { openedOn: [] as unknown[], insideBody: false };
vi.mock('../../src/main/db/transaction', () => ({
  writeTransaction: vi.fn((database: unknown, body: () => unknown) => () => {
    transactionState.openedOn.push(database);
    transactionState.insideBody = true;
    try {
      return body();
    } finally {
      transactionState.insideBody = false;
    }
  }),
}));

const backlogRepoMock = {
  findByExternalIds: vi.fn((..._args: unknown[]) => new Set<string>()),
  create: vi.fn((input: Record<string, unknown>) => ({ id: 'backlog-new', ...input })),
  getById: vi.fn((_id: string) => undefined as Record<string, unknown> | undefined),
  delete: vi.fn(),
  remapPriorities: vi.fn((_mapping: Record<number, number>) => 0),
};
const taskRepoMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remapPriorities: vi.fn((_mapping: Record<number, number>) => 0),
};
const automationRepoMock = {
  remapFilterPriorities: vi.fn((_mapping: Record<number, number>) => 0),
};
const swimlaneRepoMock = { getById: vi.fn() };
const cacheRepoMock = {
  getOldestFetchedAt: vi.fn(() => undefined),
  count: vi.fn(() => 0),
  getWatermark: vi.fn(() => undefined),
  upsertMany: vi.fn(() => ({ added: 0, updated: 0 })),
  getForSource: vi.fn(() => [] as Array<{ externalId: string }>),
  pruneMissing: vi.fn(() => 0),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    findByExternalIds = backlogRepoMock.findByExternalIds;
    create = backlogRepoMock.create;
    getById = backlogRepoMock.getById;
    delete = backlogRepoMock.delete;
    remapPriorities = backlogRepoMock.remapPriorities;
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
vi.mock('../../src/main/db/repositories/remote-item-cache-repository', () => ({
  RemoteItemCacheRepository: class {
    getOldestFetchedAt = cacheRepoMock.getOldestFetchedAt;
    count = cacheRepoMock.count;
    getWatermark = cacheRepoMock.getWatermark;
    upsertMany = cacheRepoMock.upsertMany;
    getForSource = cacheRepoMock.getForSource;
    pruneMissing = cacheRepoMock.pruneMissing;
  },
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    add = vi.fn();
    list = vi.fn(() => []);
    deleteByTaskId = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    add = vi.fn();
    list = vi.fn(() => []);
    deleteByTaskId = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(async () => {}),
  openAttachmentFile: vi.fn(),
}));

const adapter = {
  downloadImages: vi.fn(async () => ({ attachments: [], skippedCount: 0 })),
  fetch: vi.fn(async (
    _query: unknown,
    findAlreadyImported: (source: string, externalIds: string[]) => Set<string>,
  ) => {
    findAlreadyImported('github_issues', ['7']);
    return { issues: [], hasNextPage: false };
  }),
};
const repoFolderAdapterMock = { listFolders: vi.fn(async (_project: unknown) => ['openspec/changes']) };

vi.mock('../../src/main/boards', () => ({
  boardRegistry: { requireStable: vi.fn(() => adapter), get: vi.fn(() => null) },
  repoFolderAdapter: { listFolders: (project: unknown) => repoFolderAdapterMock.listFolders(project) },
  ImportSourceStore: class {
    list = vi.fn(() => []);
  },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/jira', () => ({ registerJiraIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/trello', () => ({ registerTrelloIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/gitlab', () => ({ registerGitLabIpcHandlers: vi.fn() }));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { writeTransaction } from '../../src/main/db/transaction';
import { IPC } from '../../src/shared/ipc-channels';
import { RefusalError } from '../../src/shared/refusal';
import type { ImportExecuteInput } from '../../src/shared/types';

interface TestContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  [key: string]: unknown;
}

function makeContext(overrides: Partial<TestContext> = {}): TestContext {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ backlog: { priorities: [] }, git: { defaultBaseBranch: 'develop' } })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: { getById: vi.fn((id: string) => (id === 'proj-2' ? { id, path: '/mock/other-project' } : undefined)) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: { listSessions: vi.fn(() => []), removeByTaskId: vi.fn() },
    terminalSubmitScheduler: { cancel: vi.fn() },
    boardEvents: { emitBoardChanged: vi.fn() },
    ...overrides,
  };
}

function handlerFor(channel: string) {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

function register(overrides: Partial<TestContext> = {}): TestContext {
  const context = makeContext(overrides);
  registerBacklogHandlers(context as never);
  return context;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  transactionState.openedOn = [];
  transactionState.insideBody = false;
  backlogRepoMock.findByExternalIds.mockImplementation(() => new Set<string>());
  backlogRepoMock.remapPriorities.mockImplementation(() => 0);
  taskRepoMock.remapPriorities.mockImplementation(() => 0);
  automationRepoMock.remapFilterPriorities.mockImplementation(() => 0);
  mockGetProjectRepos.mockReturnValue({ tasks: taskRepoMock, automations: automationRepoMock });
});

describe('BACKLOG_REMAP_PRIORITIES', () => {
  const mapping = { 2: 0, 3: 2, 4: 3 };

  it('remaps the backlog, the tasks and the automations with the mapping, and returns the backlog plus task count', () => {
    backlogRepoMock.remapPriorities.mockReturnValue(3);
    taskRepoMock.remapPriorities.mockReturnValue(4);
    // An automation count is not part of the answer: 100 must not be added.
    automationRepoMock.remapFilterPriorities.mockReturnValue(100);
    register();

    const changed = handlerFor(IPC.BACKLOG_REMAP_PRIORITIES)(null, mapping);

    expect(changed).toBe(7);
    expect(backlogRepoMock.remapPriorities).toHaveBeenCalledWith(mapping);
    expect(taskRepoMock.remapPriorities).toHaveBeenCalledWith(mapping);
    expect(automationRepoMock.remapFilterPriorities).toHaveBeenCalledWith(mapping);
  });

  it('runs all three remaps inside one write transaction on the project database', () => {
    const insideWhenCalled: Record<string, boolean> = {};
    backlogRepoMock.remapPriorities.mockImplementation(() => {
      insideWhenCalled.backlog = transactionState.insideBody;
      return 0;
    });
    taskRepoMock.remapPriorities.mockImplementation(() => {
      insideWhenCalled.tasks = transactionState.insideBody;
      return 0;
    });
    automationRepoMock.remapFilterPriorities.mockImplementation(() => {
      insideWhenCalled.automations = transactionState.insideBody;
      return 0;
    });
    register();

    handlerFor(IPC.BACKLOG_REMAP_PRIORITIES)(null, mapping);

    expect(writeTransaction).toHaveBeenCalledTimes(1);
    expect(transactionState.openedOn).toEqual([PROJECT_DB]);
    expect(insideWhenCalled).toEqual({ backlog: true, tasks: true, automations: true });
  });

  it('refuses when no project is open and remaps nothing', () => {
    register({ currentProjectId: null, currentProjectPath: null });

    expect(() => handlerFor(IPC.BACKLOG_REMAP_PRIORITIES)(null, mapping)).toThrow(RefusalError);
    expect(backlogRepoMock.remapPriorities).not.toHaveBeenCalled();
    expect(taskRepoMock.remapPriorities).not.toHaveBeenCalled();
  });
});

describe('BACKLOG_REPO_FOLDERS_LIST', () => {
  it('refuses with a RefusalError when no project resolves', () => {
    register({ currentProjectId: null, currentProjectPath: null });

    expect(() => handlerFor(IPC.BACKLOG_REPO_FOLDERS_LIST)(null)).toThrow(RefusalError);
    expect(repoFolderAdapterMock.listFolders).not.toHaveBeenCalled();
  });

  it("lists the current project's folders with its path and base branch", async () => {
    register();

    const folders = await handlerFor(IPC.BACKLOG_REPO_FOLDERS_LIST)(null);

    expect(folders).toEqual(['openspec/changes']);
    expect(repoFolderAdapterMock.listFolders).toHaveBeenCalledTimes(1);
    expect(repoFolderAdapterMock.listFolders).toHaveBeenCalledWith({ path: '/mock/project', baseBranch: 'develop' });
  });

  it('lets an explicit projectId win over the current project', async () => {
    register();

    await handlerFor(IPC.BACKLOG_REPO_FOLDERS_LIST)(null, { projectId: 'proj-2' });

    expect(repoFolderAdapterMock.listFolders).toHaveBeenCalledWith({ path: '/mock/other-project', baseBranch: 'develop' });
  });
});

describe('BACKLOG_IMPORT_EXECUTE repository', () => {
  it('stamps every created backlog item with the input repository', async () => {
    register();
    const issues: ImportExecuteInput['issues'] = [
      { externalId: '1', externalUrl: '', title: 'First', body: '', labels: [], assignee: null },
      { externalId: '2', externalUrl: '', title: 'Second', body: '', labels: [], assignee: null },
    ];

    await handlerFor(IPC.BACKLOG_IMPORT_EXECUTE)(null, { source: 'github_issues', repository: 'acme/web', issues });

    expect(backlogRepoMock.create).toHaveBeenCalledTimes(2);
    expect(backlogRepoMock.create.mock.calls.map((call) => call[0].externalRepository)).toEqual(['acme/web', 'acme/web']);
  });

  it('looks up already-imported ids within the input repository', async () => {
    register();
    const issues: ImportExecuteInput['issues'] = [
      { externalId: '1', externalUrl: '', title: 'First', body: '', labels: [], assignee: null },
    ];

    await handlerFor(IPC.BACKLOG_IMPORT_EXECUTE)(null, { source: 'github_issues', repository: 'acme/web', issues });

    expect(backlogRepoMock.findByExternalIds).toHaveBeenCalledWith('github_issues', ['1'], 'acme/web');
  });
});

describe('BACKLOG_IMPORT_RECONCILE repository', () => {
  it('scopes the already-imported lookup handed to the adapter, and the final stamp, to the input repository', async () => {
    register();
    cacheRepoMock.getForSource.mockReturnValue([{ externalId: '7' }]);

    await handlerFor(IPC.BACKLOG_IMPORT_RECONCILE)(null, { source: 'github_issues', repository: 'acme/web', mode: 'full' });

    // One call from inside adapter.fetch, one from the already-imported stamp.
    expect(backlogRepoMock.findByExternalIds).toHaveBeenCalledTimes(2);
    for (const call of backlogRepoMock.findByExternalIds.mock.calls) {
      expect(call[2]).toBe('acme/web');
    }
  });
});

describe('BACKLOG_PROMOTE repository', () => {
  async function promoteWith(backlogItem: Record<string, unknown>): Promise<void> {
    register();
    backlogRepoMock.getById.mockReturnValue(backlogItem);
    taskRepoMock.create.mockReturnValue({ id: 'task-promoted', title: 'Promote me', swimlane_id: 'lane-todo', session_id: null });
    taskRepoMock.getById.mockReturnValue({ id: 'task-promoted', title: 'Promote me', swimlane_id: 'lane-todo', session_id: null });
    swimlaneRepoMock.getById.mockReturnValue({ id: 'lane-todo', auto_spawn: false, role: 'todo' });
    await handlerFor(IPC.BACKLOG_PROMOTE)(null, { backlogTaskIds: ['backlog-1'], targetSwimlaneId: 'lane-todo' });
  }

  it("creates the task with the backlog item's external repository", async () => {
    await promoteWith({
      id: 'backlog-1', title: 'Promote me', description: '', labels: [], priority: 0,
      external_id: '42', external_source: 'github_issues', external_url: 'https://example.test/42', external_repository: 'acme/web',
    });

    expect(taskRepoMock.create).toHaveBeenCalledTimes(1);
    expect(taskRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
      externalId: '42',
      externalSource: 'github_issues',
      externalRepository: 'acme/web',
    }));
  });

  it('carries no repository for an item that had none', async () => {
    await promoteWith({
      id: 'backlog-1', title: 'Promote me', description: '', labels: [], priority: 0,
      external_id: null, external_source: null, external_url: null, external_repository: null,
    });

    expect(taskRepoMock.create.mock.calls[0][0].externalRepository).toBeUndefined();
  });
});
