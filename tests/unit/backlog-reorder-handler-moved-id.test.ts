/**
 * BACKLOG_REORDER only trusts a string `movedId` (task #1137). An IPC payload is untyped at
 * runtime, so a number, an object or null must stamp no row's `updated_at` and must not throw,
 * while a real id still stamps its row. Real: `registerBacklogHandlers` and `BacklogRepository`
 * over an in-memory SQLite. Doubled: electron, the project database lookup, the IPC helpers and
 * the board registry.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  database: null as unknown,
}));

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        shared.ipcHandlers.set(channel, handler);
      }),
    },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  };
});

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => shared.database),
  getExistingProjectDb: vi.fn(() => shared.database),
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  cleanupTaskResources: vi.fn(),
  createTransitionEngine: vi.fn(),
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/boards', () => ({
  boardRegistry: { get: vi.fn(), requireStable: vi.fn() },
  ImportSourceStore: class {},
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BacklogRepository } from '../../src/main/db/repositories/backlog-repository';
import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { IPC } from '../../src/shared/ipc-channels';

const OLD_TIME = '2026-01-01T00:00:00.000Z';

let database: Database.Database;
let repository: BacklogRepository;
let ids: string[];

function invokeReorder(...args: unknown[]): void {
  const handler = shared.ipcHandlers.get(IPC.BACKLOG_REORDER);
  if (!handler) throw new Error('BACKLOG_REORDER handler not registered');
  handler(null, ...args);
}

function stampedIds(): string[] {
  return repository.list().filter((row) => row.updated_at !== OLD_TIME).map((row) => row.id);
}

beforeEach(() => {
  database = new Database(':memory:');
  shared.database = database;
  runProjectMigrations(database);
  repository = new BacklogRepository(database);
  ids = ['First', 'Second', 'Third'].map((title) => repository.create({ title }).id);
  database.prepare('UPDATE backlog_tasks SET updated_at = ?').run(OLD_TIME);
  shared.ipcHandlers.clear();
  registerBacklogHandlers({ currentProjectId: 'project-1' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

describe('BACKLOG_REORDER movedId normalization', () => {
  it.each([
    ['a number', 42],
    ['an object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('stamps nothing and does not throw when movedId is %s', (_label, movedId) => {
    const reversed = [...ids].reverse();
    const reorderSpy = vi.spyOn(BacklogRepository.prototype, 'reorder');
    expect(() => invokeReorder(reversed, movedId)).not.toThrow();
    // The repository's own guard would also stamp nothing for these, so pin what the handler hands it.
    expect(reorderSpy).toHaveBeenCalledWith(reversed, undefined);
    expect(repository.list().map((row) => row.id)).toEqual(reversed);
    expect(stampedIds()).toEqual([]);
  });

  it('stamps the row a string movedId names', () => {
    const [first, second, third] = ids;
    const reorderSpy = vi.spyOn(BacklogRepository.prototype, 'reorder');
    invokeReorder([third, first, second], third);
    expect(reorderSpy).toHaveBeenCalledWith([third, first, second], third);
    expect(stampedIds()).toEqual([third]);
  });
});
