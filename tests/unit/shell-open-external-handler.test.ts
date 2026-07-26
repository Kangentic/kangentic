/**
 * Unit tests for the SHELL_OPEN_EXTERNAL IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * shell.openExternal is ShellExecute on Windows and will launch any
 * registered protocol handler, so the handler gates the URL against
 * EXTERNAL_OPEN_SCHEMES (http/https/mailto) before calling out. A rejected
 * URL warns and returns without throwing - several renderer call sites
 * invoke shell:openExternal as a bare `void` with no .catch (e.g.
 * MarkdownRenderer's link handler on agent-authored markdown), so a thrown
 * rejection would surface as an unhandled promise rejection.
 *
 * Strategy mirrors clipboard-write-text-handler.test.ts: mock electron's
 * ipcMain to capture registered handlers, then invoke the SHELL_OPEN_EXTERNAL
 * handler directly and assert against a mocked `shell.openExternal`.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

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

function invokeShellOpenExternalHandler(url: unknown): unknown {
  const handler = capturedHandlers.get(IPC.SHELL_OPEN_EXTERNAL);
  if (!handler) throw new Error(`Handler not registered for ${IPC.SHELL_OPEN_EXTERNAL}`);
  return handler(undefined, url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SHELL_OPEN_EXTERNAL IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockShell.openExternal.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
    ['mailto', 'mailto:someone@example.com'],
  ])('opens %s URLs', (_label, url) => {
    invokeShellOpenExternalHandler(url);

    expect(mockShell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('does not open %s and does not throw', (_label, url) => {
    expect(() => invokeShellOpenExternalHandler(url)).not.toThrow();
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('warns with the [SHELL_OPEN_EXTERNAL] prefix for a blocked URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    invokeShellOpenExternalHandler('file:///etc/passwd');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SHELL_OPEN_EXTERNAL] Blocked disallowed URL: file:///etc/passwd'),
    );

    warnSpy.mockRestore();
  });
});
