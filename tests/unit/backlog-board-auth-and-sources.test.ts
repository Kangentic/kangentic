/**
 * Board import IPC handlers that had no coverage:
 *
 * - BACKLOG_IMPORT_SOURCES_ADD with an adapter that validates sources
 *   (`prepareSource`, Jira): a refusal saves nothing, and a resolved label and
 *   repository reach `ImportSourceStore.add`.
 *
 * Uses the captured-IPC-handler pattern from backlog-import-execute-hydrate.test.ts.
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

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => false), readFileSync: vi.fn(() => Buffer.from('')), mkdirSync: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({ BacklogRepository: class {} }));
vi.mock('../../src/main/db/repositories/remote-item-cache-repository', () => ({
  RemoteItemCacheRepository: class {},
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
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
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({ withTaskLock: vi.fn() }));

interface FakeAdapter {
  prepareSource?: ReturnType<typeof vi.fn>;
  resolveLabel?: ReturnType<typeof vi.fn>;
  checkCli?: ReturnType<typeof vi.fn>;
}

let registeredAdapter: FakeAdapter | undefined;
const storeAdd = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/boards', () => ({
  boardRegistry: {
    requireStable: vi.fn(() => registeredAdapter),
    get: vi.fn(() => registeredAdapter),
  },
  ImportSourceStore: class {
    list = vi.fn(() => []);
    add = storeAdd;
    remove = vi.fn();
    updateLabel = vi.fn();
  },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/jira', () => ({ registerJiraIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/trello', () => ({ registerTrelloIpcHandlers: vi.fn() }));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { registerSourceUrlParser } from '../../src/main/boards/shared';
import { RefusalError } from '../../src/shared/refusal';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// Every adapter module is mocked above, so nothing registers a real parser for
// 'trello' here. This stand-in is the only one, so it cannot collide with an
// adapter's own registration.
registerSourceUrlParser('trello', {
  parse: (url) => ({ repository: url.replace(/^https?:\/\//, '') }),
  buildLabel: (repository) => `Trello: ${repository}`,
});

const context = {
  currentProjectId: 'proj-1',
  currentProjectPath: '/mock/proj',
  // The default branch every source is handed with its project (`SourceProject`).
  boardConfigManager: { getDefaultBaseBranch: () => null },
  configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
} as unknown as IpcContext;

/** What the handlers hand an adapter as the source's project. */
const SOURCE_PROJECT = { path: '/mock/proj', baseBranch: 'main' };

function handlerFor(channel: string) {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  registeredAdapter = {};
  registerBacklogHandlers(context);
});

describe('BACKLOG_IMPORT_CHECK_CLI repository forwarding', () => {
  it('forwards a string repository to the adapter checkCli', async () => {
    const checkCli = vi.fn(async () => ({ available: true, authenticated: true }));
    registeredAdapter = { checkCli };

    await handlerFor(IPC.BACKLOG_IMPORT_CHECK_CLI)(null, 'jira', 'https://acme.atlassian.net::project::ENG');

    expect(checkCli).toHaveBeenCalledWith('https://acme.atlassian.net::project::ENG');
  });

  it('passes undefined when the repository is absent or not a string', async () => {
    const checkCli = vi.fn(async () => ({ available: true, authenticated: true }));
    registeredAdapter = { checkCli };

    await handlerFor(IPC.BACKLOG_IMPORT_CHECK_CLI)(null, 'jira');
    await handlerFor(IPC.BACKLOG_IMPORT_CHECK_CLI)(null, 'jira', 42);

    expect(checkCli).toHaveBeenNthCalledWith(1, undefined);
    expect(checkCli).toHaveBeenNthCalledWith(2, undefined);
  });
});

describe('BACKLOG_IMPORT_SOURCES_ADD with a validating adapter', () => {
  const input = { source: 'trello', url: 'https://trello.com/b/abc123' };

  it('rejects with the adapter refusal and saves nothing', async () => {
    const refusal = new RefusalError('You cannot open that board');
    registeredAdapter = { prepareSource: vi.fn(async () => { throw refusal; }) };

    await expect(handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, input)).rejects.toBe(refusal);

    expect(registeredAdapter.prepareSource).toHaveBeenCalledWith('trello.com/b/abc123', SOURCE_PROJECT);
    expect(storeAdd).not.toHaveBeenCalled();
  });

  it('saves the prepared label and the completed repository', async () => {
    registeredAdapter = {
      prepareSource: vi.fn(async () => ({ label: 'Sprint board', repository: 'https://site.example|project = X' })),
    };
    storeAdd.mockReturnValue({ id: 'source-1' });

    const result = await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, input);

    expect(storeAdd).toHaveBeenCalledWith('trello', input.url, {
      label: 'Sprint board',
      repository: 'https://site.example|project = X',
    }, undefined);
    expect(result).toEqual({ id: 'source-1' });
  });

  it("passes the add form's Label on to the store", async () => {
    registeredAdapter = { prepareSource: vi.fn(async () => ({ label: 'Sprint board' })) };

    await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, { ...input, taskLabel: 'sprint' });

    expect(storeAdd).toHaveBeenCalledWith('trello', input.url, expect.objectContaining({ label: 'Sprint board' }), 'sprint');
  });

  it('keeps the parsed repository when the adapter does not complete it', async () => {
    registeredAdapter = { prepareSource: vi.fn(async () => ({ label: 'Sprint board' })) };

    await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, input);

    expect(storeAdd).toHaveBeenCalledWith('trello', input.url, {
      label: 'Sprint board',
      repository: 'trello.com/b/abc123',
    }, undefined);
  });
});

