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

/** The options `spawn` was called with. `env` is the child's whole environment. */
interface SpawnOptionsSeen {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
  detached?: boolean;
  stdio?: unknown;
}

/**
 * The last `spawn` call, split into its three arguments. The options carry a
 * copy of main's environment, so the tests below read single fields from them:
 * a failed `toHaveBeenCalledWith(..., objectContaining(...))` on the options
 * would print every variable on the machine (tokens included) into the log.
 */
function lastSpawnCall(): { file: string; args: string[]; options: SpawnOptionsSeen } {
  const lastCall = spawnMock.mock.calls.at(-1) as unknown as [string, string[], SpawnOptionsSeen] | undefined;
  if (!lastCall) throw new Error('spawn was never called');
  const [file, args, options] = lastCall;
  return { file, args, options };
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

    const { file, args, options } = lastSpawnCall();
    expect(file).toBe(process.execPath);
    expect(args).toEqual(['', '/bin/sh', '-c', 'npm run dev']);
    expect(options.cwd).toBe(projectDirectory);
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    // `ignore` matters: the helper opens stdin's terminal, which a detached
    // child would otherwise adopt as its controlling terminal.
    expect(options.stdio).toBe('ignore');
    // The helper execs in place, so this pid is the shell's.
    expect(result).toEqual({ pid: 4321 });
  });

  it.each(['win32', 'linux'] as const)('spawns the command string with shell: true on %s, as it always has', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    helperCandidatesMock.mockReturnValue([process.execPath]);

    invokeShellExec('npm run dev', projectDirectory);

    const { file, args, options } = lastSpawnCall();
    expect(file).toBe('npm run dev');
    expect(args).toEqual([]);
    expect(options.cwd).toBe(projectDirectory);
    expect(options.shell).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(helperCandidatesMock).not.toHaveBeenCalled();
  });

  describe('the shortcut\'s environment', () => {
    // Chromium's Crashpad puts its handler's pipe name in main's environment on
    // Windows (child-env.ts). A shortcut can start an Electron program, which
    // would register with our crash handler through it. The handler passes
    // `env: childProcessEnv()`; with no `env` key at all the child inherits
    // main's environment whole, pipe name included, and only this assertion on
    // the options the spawn received can tell.
    const PIPE_KEY = 'CHROME_CRASHPAD_PIPE_NAME';
    const PROBE_KEY = 'KANGENTIC_SHELL_EXEC_ENV_PROBE';
    const savedValues = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of [PIPE_KEY, PROBE_KEY]) savedValues.set(key, process.env[key]);
      process.env[PIPE_KEY] = '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP';
      process.env[PROBE_KEY] = 'present';
    });

    afterEach(() => {
      for (const [key, savedValue] of savedValues) {
        if (savedValue === undefined) delete process.env[key];
        else process.env[key] = savedValue;
      }
      savedValues.clear();
    });

    it.each(['win32', 'linux', 'darwin'] as const)('hands the child main\'s environment without the pipe name on %s', (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });

      invokeShellExec('npm run dev', projectDirectory);

      const { env } = lastSpawnCall().options;
      // Positive controls: an environment did reach the spawn and it is main's
      // own, so a missing pipe name is the strip's doing and not an empty env.
      expect(env).toBeDefined();
      expect(env![PROBE_KEY]).toBe('present');
      expect(PIPE_KEY in env!).toBe(false);
    });

    it('strips the pipe name on the macOS spawn-helper route too', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      helperCandidatesMock.mockReturnValue([process.execPath]);

      invokeShellExec('npm run dev', projectDirectory);

      const { file, options } = lastSpawnCall();
      // The helper route was taken, so this is the other branch of the handler.
      expect(file).toBe(process.execPath);
      expect(options.env).toBeDefined();
      expect(options.env![PROBE_KEY]).toBe('present');
      expect(PIPE_KEY in options.env!).toBe(false);
    });
  });
});
