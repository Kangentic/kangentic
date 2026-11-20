/**
 * A saved source's Label (`ImportSource.taskLabel`): the store keeps it from the
 * add form and changes or clears it from Edit source, and BACKLOG_IMPORT_EXECUTE
 * puts it on every item the source imports, once. Without the stamp a user who
 * set a Label finds none of the imported tasks carrying it.
 *
 * The execute cases use the captured-IPC-handler pattern of
 * backlog-import-execute-hydrate.test.ts; the store cases write a real
 * `.kangentic/config.json` under a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ImportExecuteInput, ImportSource } from '../../src/shared/types';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

const backlogRepoMock = {
  findByExternalIds: vi.fn(() => new Set<string>()),
  create: vi.fn((input: Record<string, unknown>) => ({ id: 'backlog-new', ...input })),
  getById: vi.fn((_id: string) => undefined as Record<string, unknown> | undefined),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    findByExternalIds = backlogRepoMock.findByExternalIds;
    create = backlogRepoMock.create;
    getById = backlogRepoMock.getById;
  },
}));
vi.mock('../../src/main/db/repositories/remote-item-cache-repository', () => ({ RemoteItemCacheRepository: class {} }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({ BacklogAttachmentRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({ createProgressCallback: vi.fn(), clearSpawnProgress: vi.fn() }));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({ withTaskLock: vi.fn() }));

const adapter = { downloadImages: vi.fn(async () => ({ attachments: [], skippedCount: 0 })) };
let savedSources: ImportSource[] = [];

vi.mock('../../src/main/boards', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/source-store')>('../../src/main/boards/shared/source-store');
  return {
    boardRegistry: { requireStable: vi.fn(() => adapter), get: vi.fn(() => null) },
    repoFolderAdapter: {},
    // The real store for the store cases below; the execute cases read `savedSources`.
    ImportSourceStore: class extends actual.ImportSourceStore {
      list(): ImportSource[] {
        return savedSources.length > 0 ? savedSources : super.list();
      }
    },
  };
});
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/jira', () => ({ registerJiraIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/trello', () => ({ registerTrelloIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/gitlab', () => ({ registerGitLabIpcHandlers: vi.fn() }));

import { registerBacklogHandlers, withSourceTaskLabel } from '../../src/main/ipc/handlers/backlog';
import { ImportSourceStore, registerSourceUrlParser } from '../../src/main/boards/shared/source-store';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

registerSourceUrlParser('github_issues', {
  parse: (url) => ({ repository: url.replace(/^https?:\/\/github\.com\//, '') }),
  buildLabel: (repository) => repository,
});

function makeIssue(overrides: Partial<ImportExecuteInput['issues'][number]> = {}): ImportExecuteInput['issues'][number] {
  return { externalId: '1', externalUrl: '', title: 'A task', body: '', labels: [], assignee: null, ...overrides };
}

const SAVED_SOURCE: ImportSource = {
  id: 'source-1',
  source: 'repo_folder',
  label: 'openspec/changes',
  repository: 'openspec/changes',
  url: 'openspec/changes',
  createdAt: '2026-01-01T00:00:00.000Z',
  taskLabel: 'openspec',
};

let sandbox: string;
let context: IpcContext;

function handlerFor(channel: string) {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  savedSources = [];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-source-label-'));
  context = {
    currentProjectId: 'proj-1',
    currentProjectPath: sandbox,
    configManager: { getEffectiveConfig: vi.fn(() => ({ backlog: { priorities: [] } })) },
  } as unknown as IpcContext;
  registerBacklogHandlers(context);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('BACKLOG_IMPORT_EXECUTE with a saved source', () => {
  async function importedLabels(issues: ImportExecuteInput['issues'], sourceId: string | undefined): Promise<unknown[]> {
    await handlerFor(IPC.BACKLOG_IMPORT_EXECUTE)(null, { source: 'repo_folder', repository: 'openspec/changes', sourceId, issues });
    return backlogRepoMock.create.mock.calls.map((call) => call[0].labels);
  }

  it("adds the source's Label to every item beside the item's own labels", async () => {
    savedSources = [SAVED_SOURCE];
    const labels = await importedLabels([
      makeIssue({ externalId: 'add-login', labels: [] }),
      makeIssue({ externalId: 'fix-search', labels: ['bug'] }),
    ], 'source-1');
    expect(labels).toEqual([['openspec'], ['bug', 'openspec']]);
  });

  it('adds it once, whatever the letter case of a label the item already carries', async () => {
    savedSources = [SAVED_SOURCE];
    expect(await importedLabels([makeIssue({ labels: ['OpenSpec'] })], 'source-1')).toEqual([['OpenSpec']]);
  });

  it('adds nothing for a source with no Label, or when no saved source is named', async () => {
    savedSources = [{ ...SAVED_SOURCE, taskLabel: undefined }];
    expect(await importedLabels([makeIssue({ labels: ['bug'] })], 'source-1')).toEqual([['bug']]);
    backlogRepoMock.create.mockClear();
    savedSources = [SAVED_SOURCE];
    expect(await importedLabels([makeIssue({ labels: ['bug'] })], undefined)).toEqual([['bug']]);
  });

  it('withSourceTaskLabel ignores a blank Label', () => {
    expect(withSourceTaskLabel(['bug'], '   ')).toEqual(['bug']);
  });
});

describe('the Label on a saved source', () => {
  it('is saved from the add form, trimmed, and absent when blank', async () => {
    const added = await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, {
      source: 'github_issues',
      url: 'https://github.com/acme/web',
      taskLabel: '  web  ',
    }) as ImportSource;
    expect(added.taskLabel).toBe('web');

    const blank = await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, {
      source: 'github_issues',
      url: 'https://github.com/acme/api',
      taskLabel: ' ',
    }) as ImportSource;
    expect('taskLabel' in blank).toBe(false);
  });

  it('is changed and cleared by Edit source, and the change is what the next list reads', async () => {
    const added = new ImportSourceStore(sandbox).add('github_issues', 'https://github.com/acme/web');
    expect(added.taskLabel).toBeUndefined();

    const labelled = await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_UPDATE)(null, { id: added.id, taskLabel: 'frontend' }) as ImportSource;
    expect(labelled.taskLabel).toBe('frontend');
    expect(new ImportSourceStore(sandbox).list()[0].taskLabel).toBe('frontend');

    await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_UPDATE)(null, { id: added.id, taskLabel: '' });
    expect('taskLabel' in new ImportSourceStore(sandbox).list()[0]).toBe(false);
  });

  it('refuses an update for a source that is no longer saved', () => {
    expect(() => handlerFor(IPC.BACKLOG_IMPORT_SOURCES_UPDATE)(null, { id: 'gone', taskLabel: 'x' })).toThrow('That source is no longer saved.');
  });
});
