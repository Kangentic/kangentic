/**
 * BACKLOG_IMPORT_CHECK_CLI hands the saved source's folder on to the adapter.
 * Without that, the Import dialog would never learn that an Obsidian folder was
 * moved or deleted. Real: `registerBacklogHandlers` and the Obsidian adapter.
 * Doubled: electron, the database and repositories, the IPC helpers, and the
 * board registry (which hands back the real adapter).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
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
  getProjectDb: vi.fn(),
  getExistingProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../src/main/ipc/helpers', async () => {
  const projectRepos = await vi.importActual<typeof import('../../src/main/ipc/helpers/project-repos')>(
    '../../src/main/ipc/helpers/project-repos',
  );
  return {
    getProjectRepos: projectRepos.getProjectRepos,
    cleanupTaskResources: vi.fn(),
    createTransitionEngine: vi.fn(),
    ensureTaskWorktree: vi.fn(),
    ensureTaskBranchCheckout: vi.fn(),
    notifySpawnBlocked: vi.fn(),
    spawnAgent: vi.fn(),
    openAttachmentFile: vi.fn(),
  };
});
vi.mock('../../src/main/boards', async () => {
  const { ObsidianNotesAdapter } = await import('../../src/main/boards/adapters/obsidian');
  const adapter = new ObsidianNotesAdapter();
  return {
    boardRegistry: { get: vi.fn((source: string) => (source === 'obsidian_notes' ? adapter : null)), requireStable: vi.fn() },
    ImportSourceStore: class {},
  };
});
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { IPC } from '../../src/shared/ipc-channels';

let sandbox: string;
let vault: string;

function invokeCheckCli(...args: unknown[]): Promise<unknown> {
  const handler = shared.ipcHandlers.get(IPC.BACKLOG_IMPORT_CHECK_CLI);
  if (!handler) throw new Error('BACKLOG_IMPORT_CHECK_CLI handler not registered');
  return Promise.resolve(handler(null, ...args));
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-obsidian-ipc-'));
  vault = path.join(sandbox, 'Work');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  shared.ipcHandlers.clear();
  registerBacklogHandlers({} as never);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('BACKLOG_IMPORT_CHECK_CLI', () => {
  it('forwards the saved folder, so a missing one is reported', async () => {
    const missing = path.join(vault, 'Gone');
    expect(await invokeCheckCli('obsidian_notes', missing)).toMatchObject({
      available: false,
      error: `Folder not found: ${missing}`,
    });
  });

  it('passes for a folder that is in a vault', async () => {
    expect(await invokeCheckCli('obsidian_notes', vault)).toMatchObject({ available: true, authenticated: true });
  });

  it('treats a repository that is not a string as none named', async () => {
    expect(await invokeCheckCli('obsidian_notes', 42)).toEqual({ available: true, authenticated: true, error: undefined });
  });

  it('refuses a source no adapter handles', async () => {
    expect(await invokeCheckCli('nope', vault)).toMatchObject({ available: false, error: 'Unsupported source: nope' });
  });
});
