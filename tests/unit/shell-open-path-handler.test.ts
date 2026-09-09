/**
 * Unit tests for the SHELL_OPEN_PATH IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * Every "open folder" control in the app calls this channel (the sidebar's
 * Open in Explorer, both task-detail header entries, both Command Terminal
 * entries, the Changes file tree). It used to hand shell.openPath() straight
 * back to ipcMain.handle with nothing bounding it, so on Linux - where
 * openPath waits on xdg-open, which can wait on whatever viewer it launches -
 * the promise could outlive the renderer's ipcRenderer.invoke(). Electron then
 * tears down the reply channel and its ReplyChannel::EnsureReplySent
 * pre-finalizer raises "reply was never sent" as an unhandled rejection in the
 * renderer (Sentry DESKTOP-P). The handler now routes through openPathBounded,
 * which guarantees the invoke is answered.
 *
 * Strategy mirrors shell-open-external-handler.test.ts: mock electron's
 * ipcMain to capture registered handlers, then invoke the SHELL_OPEN_PATH
 * handler directly and assert against a mocked `shell.openPath`.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';
import { OPEN_PATH_TIMEOUT_MS } from '../../src/main/ipc/helpers/open-path';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

const { capturedHandlers, mockShell } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockShell = { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() };
  return { capturedHandlers, mockShell };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: mockShell,
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
  deepMergeConfig: vi.fn((base: unknown, overrides: unknown) => ({ ...(base as object), ...(overrides as object) })),
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

// ---------------------------------------------------------------------------
// Test context factory (minimal - the shell handler needs no project state).
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

function invokeShellOpenPathHandler(dirPath: string): Promise<string> {
  const handler = capturedHandlers.get(IPC.SHELL_OPEN_PATH);
  if (!handler) throw new Error(`Handler not registered for ${IPC.SHELL_OPEN_PATH}`);
  return handler(undefined, dirPath) as Promise<string>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SHELL_OPEN_PATH IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    // A bare vi.fn() returns undefined, and openPathBounded calls .then() on
    // whatever openPath hands back - so an unset mock throws a TypeError
    // instead of exercising the handler.
    mockShell.openPath.mockReset();
    mockShell.openPath.mockResolvedValue('');
    mockShell.showItemInFolder.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves "" when openPath never settles, at OPEN_PATH_TIMEOUT_MS (the DESKTOP-P regression case)', async () => {
    vi.useFakeTimers();
    mockShell.openPath.mockReturnValue(new Promise<string>(() => { /* never settles */ }));

    const resultPromise = invokeShellOpenPathHandler('/some/dir');
    let settled = false;
    void resultPromise.then(() => { settled = true; });

    // One tick short of the timeout: still pending.
    await vi.advanceTimersByTimeAsync(OPEN_PATH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // The final tick: the bounded race answers the invoke.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await resultPromise).toBe('');
  });

  it('stays quiet when a timed-out openPath rejects late, with no onLateOutcome to receive it', async () => {
    // This handler passes no onLateOutcome, so the timer's late .then() has an
    // undefined success handler and only its rejection handler to lean on. If
    // either were missing, the late rejection would surface as an unhandled
    // rejection in the main process - the failure class this whole change is
    // about, moved one layer down.
    vi.useFakeTimers();
    let rejectOpen: (reason: Error) => void = () => {};
    mockShell.openPath.mockReturnValue(new Promise<string>((_resolve, reject) => { rejectOpen = reject; }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const resultPromise = invokeShellOpenPathHandler('/some/dir');
      await vi.advanceTimersByTimeAsync(OPEN_PATH_TIMEOUT_MS);
      expect(await resultPromise).toBe('');

      rejectOpen(new Error('xdg-open died long after the timeout'));
      // Real timers: an unhandled rejection is reported on a later macrotask.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('resolves "" when openPath succeeds', async () => {
    mockShell.openPath.mockResolvedValue('');

    expect(await invokeShellOpenPathHandler('/some/dir')).toBe('');
  });

  it("resolves Electron's error string when openPath reports a failure", async () => {
    mockShell.openPath.mockResolvedValue('Failed to open path');

    expect(await invokeShellOpenPathHandler('/missing/dir')).toBe('Failed to open path');
  });

  it('resolves a non-empty string when openPath rejects, since "" is the success value', async () => {
    mockShell.openPath.mockRejectedValue(new Error('spawn xdg-open ENOENT'));

    expect(await invokeShellOpenPathHandler('/some/dir')).toBe('spawn xdg-open ENOENT');
  });

  it.each([
    ['a resolved success', ''],
    ['a resolved failure', 'Failed to open path'],
  ])('never reveals in the file manager on %s (the target is a directory)', async (_label, openResult) => {
    mockShell.openPath.mockResolvedValue(openResult);

    await invokeShellOpenPathHandler('/some/dir');

    expect(mockShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('normalizes a forward-slash path before opening it', async () => {
    const inputPath = 'project/sub/dir';

    await invokeShellOpenPathHandler(inputPath);

    // Computed, never a hardcoded separator: a literal would be green on
    // Windows and red on CI's Linux runner.
    expect(mockShell.openPath).toHaveBeenCalledWith(path.normalize(inputPath));
  });
});
