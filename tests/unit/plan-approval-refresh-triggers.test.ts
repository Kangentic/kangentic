/**
 * The IPC handlers that call `refreshPlanApprovals` (plan-approval-writer.ts).
 *
 * Who approves a session's next plan is decided from the board's columns and
 * profiles, the agent, and the permission mode. The board event bus carries a
 * column edit, so the writer re-reads on its own for that. It does not carry
 * the changes below, and each one has to ask for the refresh itself, or a live
 * session keeps a stale decision file until some unrelated event happens by:
 *
 *   - BOARD_CONFIG_APPLY: a teammate's kangentic.json changed a column. The
 *     watcher fires it for the project that changed, which may not be the one
 *     in focus, so the refresh names THAT project (its workflows reload too).
 *   - BOARD_CONFIG_SET_BOARD_PROFILES: a profile can re-point a column's mode,
 *     agent or plan exit target. It names the open project.
 *   - CONFIG_SET: the saved global config has an `agent` key (the permission
 *     mode an approved plan continues in).
 *   - CONFIG_SET_PROJECT and CONFIG_SET_PROJECT_BY_PATH: the overrides carry an
 *     `agent` key. BY_PATH refreshes for a background project too, because
 *     every project's live sessions keep a decision file.
 *
 * The settings calls pass NO argument: a settings change is not tied to one
 * board, so no workflow reload is scoped to a project. That is asserted with
 * `toHaveBeenCalledWith()`, since an argument would quietly change which
 * workflows reload. A save without the `agent` key must not refresh at all,
 * so the no-call cases are pinned too.
 *
 * Pattern: capture the functions registered via ipcMain.handle and invoke them
 * directly (config-handler-wiring.test.ts for the system handlers,
 * board-config-last-warnings-handler.test.ts for the board ones). The writer
 * module is replaced outright, with no importOriginal, so its graph never loads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

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
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn() },
}));

vi.mock('../../src/main/plan-approval/plan-approval-writer', () => ({
  refreshPlanApprovals: vi.fn(),
}));

// --- what board.ts pulls in for its other channels ---
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/automation-run-again', () => ({
  runAutomationAgain: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateStrategyToLiveSessions: vi.fn(),
  propagateBoardProfileChange: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, run: () => unknown) => run()),
}));

// --- what system.ts pulls in, as in config-handler-wiring.test.ts ---
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
vi.mock('../../src/main/config/apply-runtime-config', () => ({ applyRuntimeConfig: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/projects', () => ({ syncProjectMcpConfig: vi.fn() }));
// CONFIG_SET_PROJECT_BY_PATH for the open project restarts these schedulers and
// sweeps. Stubbed so none of their real runtime loads or throws after the test.
vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));
vi.mock('../../src/main/git/git-fetch-scheduler', () => ({
  gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), attach: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

import { registerBoardHandlers } from '../../src/main/ipc/handlers/board';
import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';
import { refreshPlanApprovals } from '../../src/main/plan-approval/plan-approval-writer';
import { IPC } from '../../src/shared/ipc-channels';

function invokeHandler(channel: string, ...args: unknown[]): unknown {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered for channel: ${channel}`);
  return handler(undefined, ...args);
}

beforeEach(() => {
  capturedHandlers.clear();
  vi.mocked(refreshPlanApprovals).mockClear();
});

describe('board handlers that refresh plan approvals', () => {
  const focusedProject = { id: 'project-focused', name: 'Focused', path: '/repo/focused' };
  const namedProject = { id: 'project-named', name: 'Named', path: '/repo/named' };

  function registerBoard() {
    const boardConfigManager = {
      applyFileChange: vi.fn(() => ({ warnings: ['kangentic.json had a bad column'] })),
      getBoardProfiles: vi.fn(() => []),
      setBoardProfiles: vi.fn(),
    };
    const projects = [focusedProject, namedProject];
    const context = {
      currentProjectId: focusedProject.id,
      currentProjectPath: focusedProject.path,
      projectRepo: { getById: vi.fn((projectId: string) => projects.find((project) => project.id === projectId)) },
      boardConfigManager,
    };
    registerBoardHandlers(context as never);
    return { context, boardConfigManager };
  }

  it('BOARD_CONFIG_APPLY refreshes for the project whose file changed, not the focused one', () => {
    const { boardConfigManager } = registerBoard();

    const warnings = invokeHandler(IPC.BOARD_CONFIG_APPLY, namedProject.id);

    expect(boardConfigManager.applyFileChange).toHaveBeenCalledWith(namedProject.id, namedProject.path);
    expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
    expect(refreshPlanApprovals).toHaveBeenCalledWith(namedProject.id);
    // The refresh does not change what the handler hands back to the renderer.
    expect(warnings).toEqual(['kangentic.json had a bad column']);
  });

  it('BOARD_CONFIG_APPLY refreshes nothing for a project that is not registered', () => {
    registerBoard();

    expect(() => invokeHandler(IPC.BOARD_CONFIG_APPLY, 'project-unknown')).toThrow('not found');

    expect(refreshPlanApprovals).not.toHaveBeenCalled();
  });

  it('BOARD_CONFIG_SET_BOARD_PROFILES refreshes for the open project', () => {
    const { boardConfigManager } = registerBoard();
    const profiles = [{ id: 'profile-fast', name: 'Fast', entries: [] }];

    invokeHandler(IPC.BOARD_CONFIG_SET_BOARD_PROFILES, profiles);

    expect(boardConfigManager.setBoardProfiles).toHaveBeenCalledWith(profiles);
    expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
    expect(refreshPlanApprovals).toHaveBeenCalledWith(focusedProject.id);
  });
});

describe('settings handlers that refresh plan approvals', () => {
  const openProjectPath = '/repo/active';
  const backgroundProjectPath = '/repo/other';

  function registerSystem() {
    const context = {
      configManager: {
        load: vi.fn(() => ({ agent: {}, terminal: { shell: null }, mcpServer: { enabled: false } })),
        getEffectiveConfig: vi.fn(() => ({ agent: {}, terminal: { shell: null } })),
        save: vi.fn(() => true),
        saveProjectOverrides: vi.fn(() => true),
        loadProjectOverrides: vi.fn(() => null),
      },
      sessionManager: { setMaxConcurrent: vi.fn(), setShell: vi.fn(), setIdleTimeout: vi.fn() },
      boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
      projectRepo: {
        list: vi.fn(() => [openProjectPath, backgroundProjectPath].map((projectPath) => ({ id: `id-${projectPath}`, path: projectPath }))),
      },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      currentProjectPath: openProjectPath,
      currentProjectId: `id-${openProjectPath}`,
      mcpServerHandle: null,
      mobileBridgeService: { reconcile: vi.fn() },
    };
    registerSystemHandlers(context as never);
    return context;
  }

  describe('CONFIG_SET', () => {
    it('refreshes, with no argument, when the saved config has an agent key', () => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET, { agent: { permissionMode: 'plan' } });

      expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
      expect(refreshPlanApprovals).toHaveBeenCalledWith();
    });

    it('does not refresh for a config without an agent key', () => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET, { terminal: { shell: '/usr/bin/zsh' } });

      expect(refreshPlanApprovals).not.toHaveBeenCalled();
    });
  });

  describe('CONFIG_SET_PROJECT', () => {
    it('refreshes, with no argument, when the overrides carry an agent key', () => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET_PROJECT, { agent: { permissionMode: 'plan' } });

      expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
      expect(refreshPlanApprovals).toHaveBeenCalledWith();
    });

    it.each([
      ['overrides without an agent key', { terminal: { shell: '/usr/bin/fish' } }],
      ['empty overrides', {}],
    ])('does not refresh for %s', (_label, overrides) => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET_PROJECT, overrides);

      expect(refreshPlanApprovals).not.toHaveBeenCalled();
    });
  });

  describe('CONFIG_SET_PROJECT_BY_PATH', () => {
    it('refreshes, with no argument, for the open project when the overrides carry an agent key', () => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET_PROJECT_BY_PATH, openProjectPath, { agent: { permissionMode: 'plan' } });

      expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
      expect(refreshPlanApprovals).toHaveBeenCalledWith();
    });

    it('refreshes, with no argument, for a background project too', () => {
      // Every project's live sessions keep a decision file, so this does not
      // wait for the project to be opened.
      const context = registerSystem();

      invokeHandler(IPC.CONFIG_SET_PROJECT_BY_PATH, backgroundProjectPath, { agent: { permissionMode: 'plan' } });

      expect(context.configManager.saveProjectOverrides).toHaveBeenCalledWith(backgroundProjectPath, { agent: { permissionMode: 'plan' } });
      expect(refreshPlanApprovals).toHaveBeenCalledTimes(1);
      expect(refreshPlanApprovals).toHaveBeenCalledWith();
    });

    it.each([
      ['the open project', openProjectPath],
      ['a background project', backgroundProjectPath],
    ])('does not refresh for %s when the overrides have no agent key', (_label, projectPath) => {
      registerSystem();

      invokeHandler(IPC.CONFIG_SET_PROJECT_BY_PATH, projectPath, { terminal: { shell: 'pwsh' } });

      expect(refreshPlanApprovals).not.toHaveBeenCalled();
    });
  });
});
