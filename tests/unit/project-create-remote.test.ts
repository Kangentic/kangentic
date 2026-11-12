/**
 * The remote branch of the PROJECT_CREATE IPC handler (#913): a project on a host is prepared by the
 * SSH admin (folder checked on the host, shell folder made here) before its row is created, so the
 * row records the shell folder and not the host's path. With no admin the handler refuses with a
 * sentence instead of creating a row that points nowhere.
 *
 * Strategy mirrors get-last-project-overrides.test.ts: capture the handlers through a fake ipcMain
 * and invoke PROJECT_CREATE directly.
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
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { list: vi.fn(() => ['claude']), get: vi.fn(() => null), getOrThrow: vi.fn(), has: vi.fn(() => false) },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class { static clearQueue = vi.fn(); },
}));
vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class { list = vi.fn(() => []); } }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/transcript-repository', () => ({ TranscriptRepository: class {} }));
vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));
vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  pruneOrphanedWorktreeTasks: vi.fn(),
}));
vi.mock('../../src/main/config/paths', () => ({ PATHS: { projectDb: vi.fn((id: string) => `/tmp/${id}.db`) } }));
vi.mock('../../src/main/config/apply-runtime-config', () => ({ applyRuntimeConfig: vi.fn() }));
vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(),
  leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => false, onReport: () => {} })),
  reapTaskLeftovers: vi.fn(async () => {}),
}));
vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(async () => ({ entries: [], truncated: false })),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));
vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    promises: { stat: vi.fn(async () => ({ isDirectory: () => true })) },
  },
}));

import { registerProjectHandlers } from '../../src/main/ipc/handlers/projects';
import { IPC } from '../../src/shared/ipc-channels';

const SHELL_FOLDER = '/mock/shells/remote-app';

function makeContext(remoteHosting: unknown) {
  const createdProject = { id: 'proj-new', name: 'App', path: SHELL_FOLDER, default_agent: 'claude' };
  return {
    projectRepo: {
      list: vi.fn(() => []),
      create: vi.fn((_input: unknown) => createdProject),
      getById: vi.fn(() => null),
      getLastOpened: vi.fn(() => null),
    },
    configManager: {
      load: vi.fn(() => ({ agent: { cliPaths: {} } })),
      loadProjectOverrides: vi.fn(() => null),
      saveProjectOverrides: vi.fn(),
      getProjectOverridableDefaults: vi.fn(() => ({ theme: 'dark' })),
      getEffectiveConfig: vi.fn(() => ({})),
    },
    remoteHosting,
  };
}

async function invokeProjectCreate(context: unknown, input: Record<string, unknown>): Promise<unknown> {
  registerProjectHandlers(context as never);
  const handler = capturedHandlers.get(IPC.PROJECT_CREATE);
  if (!handler) throw new Error(`Handler for ${IPC.PROJECT_CREATE} was not registered`);
  return handler(undefined, input);
}

describe('PROJECT_CREATE with a remote', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
  });

  it('prepares the project through the SSH admin and creates the row from the prepared input', async () => {
    const remote = { hostId: 'host-1', path: '/home/dev/app' };
    const requested = { name: 'App', path: '/home/dev/app', remote };
    const prepared = { name: 'App', path: SHELL_FOLDER, remote };
    const prepareRemoteProject = vi.fn(async (_input: unknown) => prepared);
    const context = makeContext({ admin: { prepareRemoteProject } });

    await invokeProjectCreate(context, requested);

    expect(prepareRemoteProject).toHaveBeenCalledTimes(1);
    expect(prepareRemoteProject.mock.calls[0][0]).toBe(requested);
    expect(context.projectRepo.create).toHaveBeenCalledTimes(1);
    expect(context.projectRepo.create.mock.calls[0][0]).toMatchObject({ path: SHELL_FOLDER, remote });
    expect(context.projectRepo.create.mock.calls[0][0]).not.toMatchObject({ path: '/home/dev/app' });
  });

  it('refuses with a sentence and creates no row when remote hosting has no admin', async () => {
    const context = makeContext({ admin: null });

    await expect(invokeProjectCreate(context, { name: 'App', path: '/home/dev/app', remote: { hostId: 'host-1', path: '/home/dev/app' } }))
      .rejects.toThrow('Remote projects are not available.');
    expect(context.projectRepo.create).not.toHaveBeenCalled();
  });

  it('never consults the SSH admin for a local project', async () => {
    const prepareRemoteProject = vi.fn();
    const context = makeContext({ admin: { prepareRemoteProject } });

    await invokeProjectCreate(context, { name: 'Local', path: '/mock/projects/local' });

    expect(prepareRemoteProject).not.toHaveBeenCalled();
    expect(context.projectRepo.create.mock.calls[0][0]).toMatchObject({ path: '/mock/projects/local' });
  });
});
