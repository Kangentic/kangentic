/**
 * The four read channels a workflow's planned task on ANOTHER board reads that
 * board's facts through (#732): `swimlane:list`, `config:get`,
 * `git:listBranches` and `boardConfig:getBoardProfiles`. Each takes an
 * optional trailing `projectId`. Omitted (or naming the open project), it
 * keeps the open project's behavior; naming another registered project, it
 * routes by that project's path or database; naming an unknown one, it never
 * opens or creates a database.
 *
 * Pattern: capture the functions registered via ipcMain.handle and invoke them
 * directly (as board-config-last-warnings-handler.test.ts and
 * config-handler-wiring.test.ts do). The modules both handler files import for
 * their other channels are mocked so registration stays light.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  worktreeManagerPaths: [] as string[],
  lockedPaths: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn() },
}));

// board.ts
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/automation-run-again', () => ({ runAutomationAgain: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateStrategyToLiveSessions: vi.fn(),
  propagateBoardProfileChange: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

// system.ts
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { list: vi.fn(() => []), get: vi.fn(() => null), getOrThrow: vi.fn(), has: vi.fn(() => false) },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    constructor(projectPath: string) {
      harness.worktreeManagerPaths.push(projectPath);
    }

    async listBranchChoices(): Promise<Array<{ name: string; local: boolean }>> {
      return [{ name: 'main', local: false }];
    }

    static async withGitLock<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
      harness.lockedPaths.push(projectPath);
      return operation();
    }
  },
}));
vi.mock('../../src/main/git/base-ref', () => ({ resolveRefForDisplay: vi.fn() }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => true), isProjectGitRepo: vi.fn(() => true) }));
vi.mock('../../src/main/git/git-fetch-scheduler', () => ({ gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })), exec: vi.fn(), execFile: vi.fn() }));
vi.mock('../../src/main/config/apply-runtime-config', () => ({ applyRuntimeConfig: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/projects', () => ({ syncProjectMcpConfig: vi.fn() }));
vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({ prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), attach: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

import { registerBoardHandlers } from '../../src/main/ipc/handlers/board';
import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';
import { getProjectRepos } from '../../src/main/ipc/helpers';
import { resolveRefForDisplay } from '../../src/main/git/base-ref';
import { IPC } from '../../src/shared/ipc-channels';

const PROJECTS = [
  { id: 'current', name: 'kangentic', path: '/repo/current' },
  { id: 'other', name: 'kangentic-mobile', path: '/repo/other' },
];
const OPEN_BOARD_LANES = [{ id: 'lane-open', role: 'todo' }];
const OTHER_BOARD_LANES = [{ id: 'lane-other', role: 'todo', agent_override: 'codex' }];

function makeContext() {
  return {
    currentProjectId: 'current',
    currentProjectPath: '/repo/current',
    projectRepo: {
      list: vi.fn(() => PROJECTS),
      getById: vi.fn((id: string) => PROJECTS.find((project) => project.id === id)),
    },
    configManager: {
      getEffectiveConfig: vi.fn((projectPath?: string) => ({ git: { defaultBaseBranch: 'main', worktreesEnabled: projectPath !== '/repo/other' } })),
      load: vi.fn(() => ({})),
    },
    boardConfigManager: {
      getBoardProfiles: vi.fn((projectPath?: string) => (projectPath === '/repo/other' ? [{ id: 'profile-phone', name: 'Phone' }] : [{ id: 'profile-heavy', name: 'Heavy' }])),
      getDefaultBaseBranch: vi.fn(() => 'develop'),
      getDefaultBaseBranchForPath: vi.fn((projectPath: string) => (projectPath === '/repo/other' ? 'trunk' : undefined)),
      getStopScriptForPath: vi.fn((projectPath: string) => (projectPath === '/repo/other' ? 'npm run stop:other' : null)),
    },
  };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`Handler for ${channel} was not registered`);
  return handler(undefined, ...args);
}

describe('the read channels a planned task on another board reads through', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    harness.handlers.clear();
    harness.worktreeManagerPaths.length = 0;
    vi.mocked(getProjectRepos).mockReset();
    vi.mocked(getProjectRepos).mockImplementation(((_context: unknown, projectId?: string | null) => ({
      swimlanes: { list: () => (projectId === 'other' ? OTHER_BOARD_LANES : OPEN_BOARD_LANES) },
    })) as unknown as typeof getProjectRepos);
    context = makeContext();
    registerBoardHandlers(context as never);
    registerSystemHandlers(context as never);
  });

  it('swimlane:list reads the open board by default, another registered board by id, and opens nothing for an unknown one', () => {
    expect(invoke(IPC.SWIMLANE_LIST, null)).toEqual(OPEN_BOARD_LANES);
    expect(invoke(IPC.SWIMLANE_LIST, 'current')).toEqual(OPEN_BOARD_LANES);
    expect(invoke(IPC.SWIMLANE_LIST, 'other')).toEqual(OTHER_BOARD_LANES);
    expect(getProjectRepos).toHaveBeenLastCalledWith(context, 'other');

    vi.mocked(getProjectRepos).mockClear();
    expect(invoke(IPC.SWIMLANE_LIST, 'unregistered')).toEqual([]);
    expect(getProjectRepos).not.toHaveBeenCalled();
  });

  it('boardConfig:getBoardProfiles reads the open board by default and another board by its path', () => {
    expect(invoke(IPC.BOARD_CONFIG_GET_BOARD_PROFILES, null)).toEqual([{ id: 'profile-heavy', name: 'Heavy' }]);
    expect(context.boardConfigManager.getBoardProfiles).toHaveBeenLastCalledWith();
    expect(invoke(IPC.BOARD_CONFIG_GET_BOARD_PROFILES, 'current')).toEqual([{ id: 'profile-heavy', name: 'Heavy' }]);
    expect(invoke(IPC.BOARD_CONFIG_GET_BOARD_PROFILES, 'other')).toEqual([{ id: 'profile-phone', name: 'Phone' }]);
    expect(context.boardConfigManager.getBoardProfiles).toHaveBeenLastCalledWith('/repo/other');

    context.boardConfigManager.getBoardProfiles.mockClear();
    expect(invoke(IPC.BOARD_CONFIG_GET_BOARD_PROFILES, 'unregistered')).toEqual([]);
    expect(context.boardConfigManager.getBoardProfiles).not.toHaveBeenCalled();
  });

  it('config:get overlays each board\'s own team-shared base branch and Stop script, and refuses an unknown project', () => {
    expect(invoke(IPC.CONFIG_GET, null)).toEqual({ git: { defaultBaseBranch: 'develop', worktreesEnabled: true, stopScript: null } });
    expect(context.configManager.getEffectiveConfig).toHaveBeenLastCalledWith('/repo/current');
    expect(context.boardConfigManager.getStopScriptForPath).toHaveBeenLastCalledWith('/repo/current');

    expect(invoke(IPC.CONFIG_GET, 'other')).toEqual({ git: { defaultBaseBranch: 'trunk', worktreesEnabled: false, stopScript: 'npm run stop:other' } });
    expect(context.configManager.getEffectiveConfig).toHaveBeenLastCalledWith('/repo/other');
    expect(context.boardConfigManager.getDefaultBaseBranchForPath).toHaveBeenCalledWith('/repo/other');
    expect(context.boardConfigManager.getStopScriptForPath).toHaveBeenLastCalledWith('/repo/other');

    expect(() => invoke(IPC.CONFIG_GET, 'unregistered')).toThrow('Unknown project');
  });

  it('git:listBranches lists the open repository by default and another project\'s by its path', async () => {
    await expect(invoke(IPC.GIT_LIST_BRANCHES, null)).resolves.toEqual([{ name: 'main', local: false }]);
    await expect(invoke(IPC.GIT_LIST_BRANCHES, 'other')).resolves.toEqual([{ name: 'main', local: false }]);
    expect(harness.worktreeManagerPaths).toEqual(['/repo/current', '/repo/other']);

    await expect(invoke(IPC.GIT_LIST_BRANCHES, 'unregistered')).resolves.toEqual([]);
    expect(harness.worktreeManagerPaths).toHaveLength(2);
  });

  describe('git:resolveRef', () => {
    const resolved = { ok: true, kind: 'tag', sha: 'abc1234' } as const;

    beforeEach(() => {
      harness.lockedPaths.length = 0;
      vi.mocked(resolveRefForDisplay).mockReset();
      vi.mocked(resolveRefForDisplay).mockResolvedValue(resolved);
    });

    it('resolves against the open project when no project id is given', async () => {
      await expect(invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', null)).resolves.toEqual(resolved);
      expect(resolveRefForDisplay).toHaveBeenCalledWith('/repo/current', 'v1.0.0');
    });

    it('resolves against another registered project\'s path by its id', async () => {
      await invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'other');
      expect(resolveRefForDisplay).toHaveBeenCalledWith('/repo/other', 'v1.0.0');
    });

    it('answers not-a-repo for an unregistered project without resolving anything', async () => {
      await expect(invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'unregistered')).resolves.toMatchObject({ ok: false, reason: 'not-a-repo' });
      expect(resolveRefForDisplay).not.toHaveBeenCalled();
    });

    it('answers empty for a non-string or blank ref', async () => {
      await expect(invoke(IPC.GIT_RESOLVE_REF, 42, null)).resolves.toMatchObject({ ok: false, reason: 'empty' });
      await expect(invoke(IPC.GIT_RESOLVE_REF, '   ', null)).resolves.toMatchObject({ ok: false, reason: 'empty' });
      expect(resolveRefForDisplay).not.toHaveBeenCalled();
    });

    it('answers not-a-base for a ref longer than any real branch, tag or SHA', async () => {
      await expect(invoke(IPC.GIT_RESOLVE_REF, 'a'.repeat(1025), null)).resolves.toMatchObject({ ok: false, reason: 'not-a-base' });
      expect(resolveRefForDisplay).not.toHaveBeenCalled();
    });

    it('passes fetchTag through under the git lock only when the caller set it to true', async () => {
      await invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'other', { fetchTag: true });
      expect(resolveRefForDisplay).toHaveBeenLastCalledWith('/repo/other', 'v1.0.0', { fetchTag: true });
      expect(harness.lockedPaths).toEqual(['/repo/other']);

      await invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'other', {});
      await invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'other', { fetchTag: 'yes' });
      await invoke(IPC.GIT_RESOLVE_REF, 'v1.0.0', 'other');
      expect(vi.mocked(resolveRefForDisplay).mock.calls.slice(1)).toEqual([
        ['/repo/other', 'v1.0.0'],
        ['/repo/other', 'v1.0.0'],
        ['/repo/other', 'v1.0.0'],
      ]);
      expect(harness.lockedPaths).toEqual(['/repo/other']);
    });
  });
});
