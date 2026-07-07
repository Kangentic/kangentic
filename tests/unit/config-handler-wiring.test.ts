/**
 * Regression guard: the four config IPC handlers that mutate config on disk
 * must all call applyRuntimeConfig() so the running app's in-memory state
 * (shell, concurrency, idle timeout) stays in sync with the saved file.
 *
 * History: CONFIG_SET_PROJECT used to save overrides but skip the apply
 * step entirely. Changing the terminal shell in project settings silently
 * required a project reopen to take effect. This test file pins the wiring
 * so the regression cannot recur.
 *
 * Covered handlers (all in src/main/ipc/handlers/system.ts):
 *   CONFIG_SET                   - always applies for currentProjectPath
 *   CONFIG_SET_PROJECT           - always applies (currentProjectPath must be set)
 *   CONFIG_SET_PROJECT_BY_PATH   - applies only when projectPath === currentProjectPath
 *   CONFIG_SYNC_DEFAULT_TO_PROJECTS - applies when currentProjectPath is set
 *
 * Strategy: mirrors agent-list-handler.test.ts - mock electron's ipcMain to
 * capture registered handlers, then invoke them directly. Spy on
 * applyRuntimeConfig to confirm it is called with the right arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
const capturedOnHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedOnHandlers.set(channel, handler);
    }),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
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

// Spy on applyRuntimeConfig - this is the key assertion for every test.
const applyRuntimeConfigSpy = vi.fn();
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: (...args: unknown[]) => applyRuntimeConfigSpy(...args),
}));

// syncProjectMcpConfig is a sibling dependency - stub it out
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));

// Stub out the lazily-imported PR-refresh scheduler so the dynamic import
// inside CONFIG_SET_PROJECT_BY_PATH resolves to a controllable spy, not the
// real scheduler (which pulls in gh-backed runtime code).
// vitest hoists vi.mock() calls, so this mock intercepts the
// `void import('../../pr/pr-refresh-scheduler')` inside system.ts even though
// that import is dynamic. The spy is reset in each relevant beforeEach.
const startForProjectSpy = vi.fn();
vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: {
    startForProject: (...args: unknown[]) => startForProjectSpy(...args),
    stop: vi.fn(),
  },
}));

// Same treatment for the sibling lazy import inside CONFIG_SET_PROJECT_BY_PATH:
// system.ts re-runs the conversation-memory sweep via
// `void import('../../retrieval/retrieval-service')`. Left unmocked, the real
// retrievalService.startForProject().attach() subscribes to
// context.sessionManager.on(...), which this file's lightweight sessionManager
// mock does not implement - the resulting throw surfaces as an unhandled
// rejection on a later microtask (after the test has passed) and fails the
// whole shard. Stubbing it isolates this config-wiring test from the retrieval
// subsystem entirely.
const retrievalStartForProjectSpy = vi.fn();
const reconcileEmbedWorkerSpy = vi.fn();
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: {
    startForProject: (...args: unknown[]) => retrievalStartForProjectSpy(...args),
    attach: vi.fn(),
    reconcileEmbedWorker: (...args: unknown[]) => reconcileEmbedWorkerSpy(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionManager() {
  return {
    setMaxConcurrent: vi.fn(),
    setShell: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
}

function makeConfigManager(overrides?: {
  currentProjectPath?: string;
}) {
  return {
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
    currentProjectPath: overrides?.currentProjectPath ?? null,
  };
}

function makeContext(overrides?: {
  currentProjectPath?: string | null;
  currentProjectId?: string | null;
  projectPaths?: string[];
}) {
  const sessionManager = makeSessionManager();
  const configManager = makeConfigManager();
  return {
    configManager,
    sessionManager,
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: {
      list: vi.fn(() => (overrides?.projectPaths ?? []).map((p) => ({ id: `id-${p}`, path: p }))),
    },
    shellResolver: { getAvailableShells: vi.fn(() => []), getDefaultShell: vi.fn(() => 'bash') },
    gitDetector: { detect: vi.fn(() => ({ found: false })) },
    mainWindow: {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false), close: vi.fn(), isFocused: vi.fn(() => true),
      flashFrame: vi.fn(), isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(),
      focus: vi.fn(), once: vi.fn(), webContents: { send: vi.fn() },
    },
    currentProjectPath: overrides?.currentProjectPath ?? null,
    currentProjectId: overrides?.currentProjectId ?? null,
    mcpServerHandle: null,
  };
}

function invokeHandler(channel: string, ...args: unknown[]): unknown {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered for channel: ${channel}`);
  return handler(undefined, ...args);
}

function invokeOnHandler(channel: string, event: Record<string, unknown>, ...args: unknown[]): void {
  const handler = capturedOnHandlers.get(channel);
  if (!handler) throw new Error(`On-handler not registered for channel: ${channel}`);
  handler(event, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CONFIG_SET IPC handler - applyRuntimeConfig wiring', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
  });

  it('calls applyRuntimeConfig after saving the config', () => {
    const context = makeContext({ currentProjectPath: '/repo/main' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:set', { terminal: { shell: '/usr/bin/zsh' } });

    expect(applyRuntimeConfigSpy).toHaveBeenCalledTimes(1);
    expect(applyRuntimeConfigSpy).toHaveBeenCalledWith(
      context.sessionManager,
      context.configManager,
      '/repo/main',
    );
  });

  it('passes currentProjectPath as-is (may be null when no project is open)', () => {
    const context = makeContext({ currentProjectPath: null });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:set', { agent: { maxConcurrentSessions: 3 } });

    expect(applyRuntimeConfigSpy).toHaveBeenCalledTimes(1);
    expect(applyRuntimeConfigSpy).toHaveBeenCalledWith(
      context.sessionManager,
      context.configManager,
      null,
    );
  });
});

describe('CONFIG_SET IPC handler - retrieval-service reconcileEmbedWorker wiring', () => {
  // Regression guard: toggling memory settings (semanticEnabled off, etc.) must
  // release/re-hold the resident embed worker promptly rather than waiting for
  // its next idle-recycle window. Mirrors the CONFIG_SET_PROJECT_BY_PATH
  // prRefreshScheduler wiring tests below - the call is behind a lazy dynamic
  // import (`void import('../../retrieval/retrieval-service').then(...)`) that
  // resolves on a microtask, so assertions poll via vi.waitFor.
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
    reconcileEmbedWorkerSpy.mockClear();
  });

  it('calls reconcileEmbedWorker when the saved config includes a memory key', async () => {
    const context = makeContext({ currentProjectPath: '/repo/main' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:set', { memory: { semanticEnabled: false } });

    await vi.waitFor(() => expect(reconcileEmbedWorkerSpy).toHaveBeenCalledTimes(1));
    expect(reconcileEmbedWorkerSpy).toHaveBeenCalledWith(context);
  });

  it('does NOT call reconcileEmbedWorker when the saved config has no memory key', async () => {
    const context = makeContext({ currentProjectPath: '/repo/main' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:set', { terminal: { shell: '/usr/bin/zsh' } });

    // Drain the microtask queue. The dynamic import is behind the `if (config.memory)`
    // branch, so it is never queued when the key is absent.
    // (Intentional fixed budget - we cannot poll for non-occurrence.)
    await Promise.resolve();

    expect(reconcileEmbedWorkerSpy).not.toHaveBeenCalled();
  });
});

describe('CONFIG_SET_PROJECT IPC handler - applyRuntimeConfig wiring', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
  });

  it('calls applyRuntimeConfig with the current project path', () => {
    const context = makeContext({ currentProjectPath: '/repo/proj' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:setProject', { terminal: { shell: '/usr/bin/fish' } });

    expect(applyRuntimeConfigSpy).toHaveBeenCalledTimes(1);
    expect(applyRuntimeConfigSpy).toHaveBeenCalledWith(
      context.sessionManager,
      context.configManager,
      '/repo/proj',
    );
  });

  it('throws when no project is open (currentProjectPath is null)', () => {
    const context = makeContext({ currentProjectPath: null });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    expect(() => invokeHandler('config:setProject', {})).toThrow('No project open');
    expect(applyRuntimeConfigSpy).not.toHaveBeenCalled();
  });
});

describe('CONFIG_SET_PROJECT_BY_PATH IPC handler - applyRuntimeConfig wiring', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
  });

  it('calls applyRuntimeConfig when the target path is the currently-open project', () => {
    const projectPath = '/repo/active';
    const context = makeContext({
      currentProjectPath: projectPath,
      projectPaths: [projectPath],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:setProjectByPath', projectPath, { terminal: { shell: 'pwsh' } });

    expect(applyRuntimeConfigSpy).toHaveBeenCalledTimes(1);
    expect(applyRuntimeConfigSpy).toHaveBeenCalledWith(
      context.sessionManager,
      context.configManager,
      projectPath,
    );
  });

  it('does NOT call applyRuntimeConfig for a background (non-current) project', () => {
    const backgroundPath = '/repo/other';
    const currentPath = '/repo/active';
    const context = makeContext({
      currentProjectPath: currentPath,
      projectPaths: [backgroundPath, currentPath],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:setProjectByPath', backgroundPath, { terminal: { shell: 'pwsh' } });

    expect(applyRuntimeConfigSpy).not.toHaveBeenCalled();
  });

  it('throws for unknown project paths (not in projectRepo)', () => {
    const context = makeContext({ currentProjectPath: '/repo/active', projectPaths: [] });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    expect(() =>
      invokeHandler('config:setProjectByPath', '/unknown/path', {}),
    ).toThrow('Unknown project path');
    expect(applyRuntimeConfigSpy).not.toHaveBeenCalled();
  });
});

describe('CONFIG_SET_PROJECT_BY_PATH IPC handler - prRefreshScheduler wiring', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
    startForProjectSpy.mockClear();
  });

  it('calls startForProject with (context, project) when path is the currently-open project', async () => {
    const projectPath = '/repo/active';
    const context = makeContext({
      currentProjectPath: projectPath,
      projectPaths: [projectPath],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:setProjectByPath', projectPath, { git: { prRefreshIntervalMinutes: 10 } });

    // The call is behind a lazy dynamic import that resolves on a microtask.
    // vi.waitFor polls until the assertion passes (or times out at 1 second).
    await vi.waitFor(() => expect(startForProjectSpy).toHaveBeenCalledTimes(1));

    // The project arg must be the entry from projectRepo.list() matching the path.
    const [_contextArg, projectArg] = startForProjectSpy.mock.calls[0] as [unknown, { path: string }];
    expect(projectArg.path).toBe(projectPath);
  });

  it('does NOT call startForProject for a background (non-current) project', async () => {
    const backgroundPath = '/repo/other';
    const currentPath = '/repo/active';
    const context = makeContext({
      currentProjectPath: currentPath,
      projectPaths: [backgroundPath, currentPath],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:setProjectByPath', backgroundPath, { git: { prRefreshIntervalMinutes: 10 } });

    // Drain the microtask queue. The dynamic import is behind the if-branch that
    // only fires when projectPath === currentProjectPath, so it is never queued.
    // A single microtask flush is sufficient to confirm no-call for the negative case.
    // (Intentional fixed budget - we cannot poll for non-occurrence.)
    await Promise.resolve();

    expect(startForProjectSpy).not.toHaveBeenCalled();
    // saveProjectOverrides is still called for background projects.
    expect(context.configManager.saveProjectOverrides).toHaveBeenCalledWith(
      backgroundPath,
      { git: { prRefreshIntervalMinutes: 10 } },
    );
  });

  it('does NOT call startForProject when the project path is unknown (throws before scheduler)', () => {
    const context = makeContext({ currentProjectPath: '/repo/active', projectPaths: [] });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    expect(() =>
      invokeHandler('config:setProjectByPath', '/unknown/path', {}),
    ).toThrow('Unknown project path');
    expect(startForProjectSpy).not.toHaveBeenCalled();
  });
});

describe('CONFIG_SYNC_DEFAULT_TO_PROJECTS IPC handler - applyRuntimeConfig wiring', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
  });

  it('calls applyRuntimeConfig for the currently-open project after syncing', () => {
    const currentPath = '/repo/current';
    const context = makeContext({
      currentProjectPath: currentPath,
      projectPaths: ['/repo/other1', '/repo/other2', currentPath],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:syncDefaultToProjects', { terminal: { shell: '/bin/zsh' } });

    expect(applyRuntimeConfigSpy).toHaveBeenCalledTimes(1);
    expect(applyRuntimeConfigSpy).toHaveBeenCalledWith(
      context.sessionManager,
      context.configManager,
      currentPath,
    );
  });

  it('does NOT call applyRuntimeConfig when no project is open', () => {
    const context = makeContext({
      currentProjectPath: null,
      projectPaths: ['/repo/p1', '/repo/p2'],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    invokeHandler('config:syncDefaultToProjects', { terminal: { shell: '/bin/zsh' } });

    expect(applyRuntimeConfigSpy).not.toHaveBeenCalled();
  });

  it('returns the count of updated projects', () => {
    const context = makeContext({
      currentProjectPath: '/repo/current',
      projectPaths: ['/repo/a', '/repo/b', '/repo/current'],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = invokeHandler('config:syncDefaultToProjects', { agent: { maxConcurrentSessions: 2 } });

    expect(result).toBe(3);
  });
});

describe('CONFIG_SET_SYNC IPC handler - synchronous quit-flush wiring', () => {
  // Regression guard for the intentionally-minimal design of the sync flush handler:
  // it must persist the layout to disk AND set event.returnValue (so sendSync unblocks
  // the renderer), but must NOT call applyRuntimeConfig (irrelevant during shutdown and
  // would run synchronously at an unsafe time). If someone copies the CONFIG_SET body
  // and adds applyRuntimeConfig here, this test catches it.
  beforeEach(() => {
    capturedHandlers.clear();
    capturedOnHandlers.clear();
    applyRuntimeConfigSpy.mockClear();
  });

  it('saves the config to disk synchronously and sets event.returnValue to true', () => {
    const context = makeContext({ currentProjectPath: '/repo/main' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const fakeEvent: Record<string, unknown> = {};
    const payload = { workspaceByProject: { 'proj-a': { version: 1, windows: [], tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 }, focusedTaskId: null } } };
    invokeOnHandler('config:setSync', fakeEvent, payload);

    expect(context.configManager.save).toHaveBeenCalledTimes(1);
    expect(context.configManager.save).toHaveBeenCalledWith(payload);
    expect(fakeEvent.returnValue).toBe(true);
  });

  it('does NOT call applyRuntimeConfig (intentionally minimal - shutdown path)', () => {
    const context = makeContext({ currentProjectPath: '/repo/main' });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const fakeEvent: Record<string, unknown> = {};
    invokeOnHandler('config:setSync', fakeEvent, { workspaceByProject: {} });

    expect(applyRuntimeConfigSpy).not.toHaveBeenCalled();
  });

  it('is registered as a synchronous on-handler (not an async handle), so it is present in capturedOnHandlers', () => {
    const context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    // Confirm it is NOT in the async handler map (which sendSync cannot reach).
    expect(capturedHandlers.has('config:setSync')).toBe(false);
    // Confirm it IS in the sync on-handler map.
    expect(capturedOnHandlers.has('config:setSync')).toBe(true);
  });
});
