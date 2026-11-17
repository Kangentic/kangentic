/**
 * Board import IPC handlers that had no coverage:
 *
 * - BACKLOG_IMPORT_SOURCES_ADD with an adapter that validates sources
 *   (`prepareSource`, Jira): a refusal saves nothing, and a resolved label and
 *   repository reach `ImportSourceStore.add`.
 * - BOARDS_AUTH_STATUS: the unknown-source, no-getAuthStatus and target
 *   pass-through answers.
 * - The Asana adapter's own getAuthStatus.
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
  getAuthStatus?: ReturnType<typeof vi.fn>;
  resolveLabel?: ReturnType<typeof vi.fn>;
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

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { registerSourceUrlParser } from '../../src/main/boards/shared';
import { AsanaAdapter } from '../../src/main/boards/adapters/asana/adapter';
import type { AsanaClient } from '../../src/main/boards/adapters/asana/client';
import { RefusalError } from '../../src/shared/refusal';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// 'trello' is a stub board type with no real parser, so this cannot collide
// with an adapter's own registration.
registerSourceUrlParser('trello', {
  parse: (url) => ({ repository: url.replace(/^https?:\/\//, '') }),
  buildLabel: (repository) => `Trello: ${repository}`,
});

const context = {
  currentProjectId: 'proj-1',
  currentProjectPath: '/mock/proj',
} as unknown as IpcContext;

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

describe('BACKLOG_IMPORT_SOURCES_ADD with a validating adapter', () => {
  const input = { source: 'trello', url: 'https://trello.com/b/abc123' };

  it('rejects with the adapter refusal and saves nothing', async () => {
    const refusal = new RefusalError('You cannot open that board');
    registeredAdapter = { prepareSource: vi.fn(async () => { throw refusal; }) };

    await expect(handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, input)).rejects.toBe(refusal);

    expect(registeredAdapter.prepareSource).toHaveBeenCalledWith('trello.com/b/abc123');
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
    });
    expect(result).toEqual({ id: 'source-1' });
  });

  it('keeps the parsed repository when the adapter does not complete it', async () => {
    registeredAdapter = { prepareSource: vi.fn(async () => ({ label: 'Sprint board' })) };

    await handlerFor(IPC.BACKLOG_IMPORT_SOURCES_ADD)(null, input);

    expect(storeAdd).toHaveBeenCalledWith('trello', input.url, {
      label: 'Sprint board',
      repository: 'trello.com/b/abc123',
    });
  });
});

describe('BOARDS_AUTH_STATUS', () => {
  it('answers not connected, reason none, for a source with no registered adapter', async () => {
    registeredAdapter = undefined;
    expect(await handlerFor(IPC.BOARDS_AUTH_STATUS)(null, 'nope')).toEqual({ connected: false, reason: 'none' });
  });

  it('answers connected for an adapter that has no getAuthStatus', async () => {
    registeredAdapter = {};
    expect(await handlerFor(IPC.BOARDS_AUTH_STATUS)(null, 'trello')).toEqual({ connected: true });
  });

  it('passes a string target through to getAuthStatus', async () => {
    const getAuthStatus = vi.fn(async () => ({ connected: true, account: 'a@example.com' }));
    registeredAdapter = { getAuthStatus };

    const result = await handlerFor(IPC.BOARDS_AUTH_STATUS)(null, 'trello', 'https://site.example');

    expect(getAuthStatus).toHaveBeenCalledWith('https://site.example');
    expect(result).toEqual({ connected: true, account: 'a@example.com' });
  });

  it('passes a non-string target to getAuthStatus as undefined', async () => {
    const getAuthStatus = vi.fn(async () => ({ connected: true }));
    registeredAdapter = { getAuthStatus };

    await handlerFor(IPC.BOARDS_AUTH_STATUS)(null, 'trello', { site: 'https://site.example' });

    expect(getAuthStatus).toHaveBeenCalledWith(undefined);
  });
});

describe('AsanaAdapter.getAuthStatus', () => {
  function adapterWith(hasCredential: boolean, email: string | null): AsanaAdapter {
    const client = {
      hasCredential: vi.fn(async () => hasCredential),
      getCredentialEmail: vi.fn(async () => email),
    } as unknown as AsanaClient;
    return new AsanaAdapter(client);
  }

  it('is not connected, reason none, with no credential', async () => {
    expect(await adapterWith(false, null).getAuthStatus()).toEqual({ connected: false, reason: 'none' });
  });

  it('is connected and names the credential email', async () => {
    expect(await adapterWith(true, 'dev@example.com').getAuthStatus()).toEqual({
      connected: true,
      account: 'dev@example.com',
    });
  });
});
