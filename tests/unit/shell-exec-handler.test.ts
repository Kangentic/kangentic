/**
 * Unit tests for the SHELL_EXEC IPC handler in src/main/ipc/handlers/system.ts,
 * which runs a user's shortcut command detached and never kills it, so a dev
 * server started there can outlive the app.
 *
 * On macOS a child inherits Crashpad's mach exception port, so everything a
 * shortcut starts would write its crashes into our crash database. The handler
 * routes the command through node-pty's spawn-helper there
 * (src/main/pty/spawn/shell-launch.ts), which clears the port before exec.
 * Everywhere else the spawn is exactly what it always was.
 *
 * Strategy mirrors shell-open-path-handler.test.ts: mock electron's ipcMain to
 * capture registered handlers, then invoke SHELL_EXEC directly and assert
 * against a mocked `child_process.spawn`.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { IPC } from '../../src/shared/ipc-channels';

const { capturedHandlers, spawnMock, helperCandidatesMock } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawnMock: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
  helperCandidatesMock: vi.fn((): string[] => []),
}));

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
  spawn: spawnMock,
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));
// No spawn-helper unless a test hands one in: node-pty ships darwin helpers,
// and on Windows an execute check passes for any file that exists.
vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: helperCandidatesMock,
}));

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

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
    sessionManager: { setMaxConcurrent: vi.fn(), setShell: vi.fn(), setIdleTimeout: vi.fn() },
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

function invokeShellExec(command: string, cwd: string): { pid: number } {
  const handler = capturedHandlers.get(IPC.SHELL_EXEC);
  if (!handler) throw new Error(`Handler not registered for ${IPC.SHELL_EXEC}`);
  return handler(undefined, command, cwd) as { pid: number };
}

describe('SHELL_EXEC IPC handler', () => {
  const originalPlatform = process.platform;
  // A real directory, because the handler checks the cwd exists.
  const projectDirectory = os.tmpdir();

  beforeEach(() => {
    capturedHandlers.clear();
    spawnMock.mockClear();
    helperCandidatesMock.mockClear();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    helperCandidatesMock.mockReturnValue([]);
  });

  it('runs the shortcut through the spawn-helper on macOS, detached with stdin ignored', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    // Any file this process can execute stands in for the helper: spawn is
    // mocked, and the lookup only checks that the candidate is executable.
    helperCandidatesMock.mockReturnValue([process.execPath]);

    const result = invokeShellExec('npm run dev', projectDirectory);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['', '/bin/sh', '-c', 'npm run dev'],
      // `ignore` matters: the helper opens stdin's terminal, which a detached
      // child would otherwise adopt as its controlling terminal.
      expect.objectContaining({ cwd: projectDirectory, shell: false, detached: true, stdio: 'ignore' }),
    );
    // The helper execs in place, so this pid is the shell's.
    expect(result).toEqual({ pid: 4321 });
  });

  it.each(['win32', 'linux'] as const)('spawns the command string with shell: true on %s, as it always has', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    helperCandidatesMock.mockReturnValue([process.execPath]);

    invokeShellExec('npm run dev', projectDirectory);

    expect(spawnMock).toHaveBeenCalledWith(
      'npm run dev',
      [],
      expect.objectContaining({ cwd: projectDirectory, shell: true, detached: true, stdio: 'ignore' }),
    );
    expect(helperCandidatesMock).not.toHaveBeenCalled();
  });
});
