/**
 * Unit tests for the DIALOG_SELECT_FOLDER IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * The handler scopes two behaviors to callers that actually pass `options`
 * (today: only the Add Project flow):
 *   - `properties` includes 'createDirectory' ONLY when options is supplied.
 *   - `defaultPath` falls back to `app.getPath('home')` ONLY when options is
 *     supplied; a no-argument caller gets `undefined`, preserving whatever
 *     location the OS dialog itself remembers.
 * The no-argument callers (relocate a project, locate one whose folder
 * moved) point at a folder that already exists, so unconditionally jumping
 * to $HOME would discard the location the OS remembered, and offering "New
 * folder" there invites creating an empty directory that cannot be the thing
 * they were asked to find.
 *
 * Strategy mirrors agent-list-handler.test.ts / shell-open-external-handler.test.ts:
 * mock electron's dialog and ipcMain, capture the registered handler, invoke
 * it directly, and assert field-by-field on the object passed to
 * `dialog.showOpenDialog` (never a whole-object `toEqual`, since that would
 * silently ignore an `undefined`-valued `defaultPath` key and miss a
 * reverted scoping).
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SelectFolderOptions } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const getPathMock = vi.fn(() => '/mock/home');

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: (...args: unknown[]) => getPathMock(...args),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args) },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  globalShortcut: { isRegistered: vi.fn(() => false), register: vi.fn(() => true), unregister: vi.fn() },
  clipboard: { writeText: vi.fn(), readImage: vi.fn() },
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    getOrThrow: vi.fn(),
    has: vi.fn(() => false),
  },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('../../src/shared/object-utils', () => ({
  deepMergeConfig: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered).
// ---------------------------------------------------------------------------

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Test context factory (minimal - the dialog handler needs no project state).
// ---------------------------------------------------------------------------

function makeContext() {
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: { cliPaths: {}, maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
        mcpServer: { enabled: false },
        autoNameRateLimitPerHour: 60,
      })),
      getEffectiveConfig: vi.fn(() => ({
        agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
      })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    sessionManager: {
      setMaxConcurrent: vi.fn(),
      setShell: vi.fn(),
      setIdleTimeout: vi.fn(),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: { list: vi.fn(() => []) },
    shellResolver: { getAvailableShells: vi.fn(() => []), getDefaultShell: vi.fn(() => 'bash') },
    gitDetector: { detect: vi.fn(() => ({ found: false })) },
    mainWindow: {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false), close: vi.fn(), isFocused: vi.fn(() => true),
      flashFrame: vi.fn(), isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(),
      focus: vi.fn(), once: vi.fn(), webContents: { send: vi.fn() },
    },
    currentProjectPath: null,
    currentProjectId: null,
    mcpServerHandle: null,
  };
}

async function invokeSelectFolder(options?: SelectFolderOptions): Promise<string | null> {
  const handler = capturedHandlers.get(IPC.DIALOG_SELECT_FOLDER);
  if (!handler) throw new Error(`Handler not registered for ${IPC.DIALOG_SELECT_FOLDER}`);
  return handler(undefined, options) as Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DIALOG_SELECT_FOLDER IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    showOpenDialogMock.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
    getPathMock.mockClear();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('omits createDirectory and defaultPath entirely with no options (relocate / locate-moved-folder callers)', async () => {
    await invokeSelectFolder();

    expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    const dialogOptions = showOpenDialogMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dialogOptions.properties).toEqual(['openDirectory']);
    expect(dialogOptions.defaultPath).toBeUndefined();
    expect(getPathMock).not.toHaveBeenCalled();
  });

  it('includes createDirectory and falls back to home when options are passed with no defaultPath (Add project)', async () => {
    await invokeSelectFolder({ title: 'Pick a folder' });

    const dialogOptions = showOpenDialogMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dialogOptions.properties).toEqual(['openDirectory', 'createDirectory']);
    expect(dialogOptions.defaultPath).toBe('/mock/home');
    expect(getPathMock).toHaveBeenCalledWith('home');
  });

  it('prefers the caller-supplied defaultPath over the home fallback when both options and defaultPath are given', async () => {
    await invokeSelectFolder({ defaultPath: '/mock/some/remembered/path' });

    const dialogOptions = showOpenDialogMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dialogOptions.properties).toEqual(['openDirectory', 'createDirectory']);
    expect(dialogOptions.defaultPath).toBe('/mock/some/remembered/path');
  });

  it('returns null when the dialog is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await invokeSelectFolder({ title: 'Pick a folder' });

    expect(result).toBeNull();
  });

  it('returns the chosen path when a folder is selected', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/mock/chosen/folder'] });

    const result = await invokeSelectFolder();

    expect(result).toBe('/mock/chosen/folder');
  });
});
