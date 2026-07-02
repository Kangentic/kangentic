/**
 * Unit tests for the CLIPBOARD_WRITE_TEXT IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * The handler writes text to the native clipboard via Electron's synchronous,
 * focus-independent `clipboard.writeText`, guarded against non-string and
 * empty-string input:
 *
 *   ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, (_event, text: string): void => {
 *     if (typeof text !== 'string' || text.length === 0) return;
 *     clipboard.writeText(text);
 *   });
 *
 * This guard matters because both the OSC 52 terminal handler and the
 * context-menu / Ctrl+C copy path forward whatever `cleanSelection` /
 * `decodeOsc52Payload` produce, which can legitimately be an empty string
 * (nothing selected, a malformed OSC 52 payload) - the handler must not hand
 * an empty write to the OS clipboard, and must not throw on a caller sending
 * an unexpected non-string.
 *
 * Strategy mirrors keybindings-probe-handler.test.ts: mock electron's ipcMain
 * to capture registered handlers, then invoke the CLIPBOARD_WRITE_TEXT
 * handler directly with controlled inputs and assert against a mocked
 * `clipboard.writeText`.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

const { capturedHandlers, mockClipboard } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockClipboard = {
    writeText: vi.fn(),
    readImage: vi.fn(),
  };
  return { capturedHandlers, mockClipboard };
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
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  globalShortcut: { isRegistered: vi.fn(() => false), register: vi.fn(() => true), unregister: vi.fn() },
  clipboard: mockClipboard,
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

// ---------------------------------------------------------------------------
// Test context factory (minimal - the clipboard handler needs no project state).
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

function invokeClipboardWriteTextHandler(text: unknown): void {
  const handler = capturedHandlers.get(IPC.CLIPBOARD_WRITE_TEXT);
  if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_WRITE_TEXT}`);
  handler(undefined, text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLIPBOARD_WRITE_TEXT IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockClipboard.writeText.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('writes a valid non-empty string to the native clipboard', () => {
    invokeClipboardWriteTextHandler('copied-text');

    expect(mockClipboard.writeText).toHaveBeenCalledWith('copied-text');
  });

  it('is a no-op for an empty string', () => {
    invokeClipboardWriteTextHandler('');

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for null', () => {
    invokeClipboardWriteTextHandler(null);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for undefined', () => {
    invokeClipboardWriteTextHandler(undefined);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-string number', () => {
    invokeClipboardWriteTextHandler(42);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });
});
