/**
 * deferBoardConfigReconcile (src/main/ipc/handlers/projects.ts) and what it
 * pushes to the renderer through boardConfigManager.sendOpenWarnings.
 *
 * Two contracts that project-open-lifecycle.test.ts does not pin:
 *
 *   1. When the reconcile returns warnings and the export that follows THEN
 *      throws, the renderer receives BOTH the earlier warnings and the
 *      "could not be applied" message. The catch spreads the warnings gathered
 *      so far; dropping the spread would hide the earlier ones.
 *   2. When the project-switch guard (`currentProjectId !== projectId`) skips
 *      the deferred work, nothing is pushed either. A push tagged with the old
 *      project would clear or raise a banner for a board the user has left.
 *
 * Harness copies project-open-lifecycle.test.ts (the same module mocks, driven
 * through the exported openProjectByPath) without editing it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const state = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
    unlinkSync: vi.fn(() => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
}));

vi.mock('../../src/main/ipc/handlers/project-relocate', () => ({
  relocateProject: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  pruneOrphanedWorktreeTasks: vi.fn(async () => 0),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = vi.fn();
  },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(),
    getOrThrow: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));

vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(async () => {}),
}));

vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/git/git-fetch-scheduler', () => ({
  gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

// The board_snapshot callback reads lanes and task counts directly; stubbing
// the repositories keeps it from touching the fake database object.
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = () => [] as Array<{ name: string }>;
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    countAll = () => 0;
  },
}));

import { openProjectByPath } from '../../src/main/ipc/handlers/projects';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-open-warnings-push'));

function makeProject(): Project {
  return {
    id: 'project-1',
    name: 'Test Project',
    path: PROJECT_PATH,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function createContext(project: Project) {
  return {
    projectRepo: {
      list: vi.fn(() => [project]),
      getById: vi.fn(),
      create: vi.fn(),
      updateLastOpened: vi.fn(),
    },
    sessionManager: {
      closeProjectInPtyHost: vi.fn(async () => undefined),
      listSessions: vi.fn(() => []),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })) },
    boardConfigManager: {
      attach: vi.fn(),
      exists: vi.fn(() => true),
      applyConfigOnOpen: vi.fn((): string[] => []),
      exportFromDb: vi.fn(),
      getBoardProfiles: vi.fn(() => []),
      sendOpenWarnings: vi.fn(),
    },
    currentProjectId: null as string | null,
    currentProjectPath: null as string | null,
    // Warm reopen: skips the (separately tested) cold-open recovery block.
    recoveredProjects: new Set<string>([project.id]),
    snapshottedProjects: new Set<string>(),
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    mcpServerHandle: null,
  };
}

function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.existingPaths.clear();
});

describe('deferBoardConfigReconcile warnings push', () => {
  it('pushes the reconcile warnings AND the could-not-be-applied message when the export throws afterwards', async () => {
    const project = makeProject();
    const context = createContext(project);
    state.existingPaths.add(project.path);
    context.boardConfigManager.applyConfigOnOpen.mockReturnValue(['earlier warning from the reconcile']);
    context.boardConfigManager.exportFromDb.mockImplementation(() => {
      throw new Error('disk full');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let loggedErrors: string[] = [];
    try {
      await openProjectByPath(context as unknown as IpcContext, project.path);
      await flushSetImmediate();
      loggedErrors = errorSpy.mock.calls.map((call) => call.map(String).join(' '));
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(context.boardConfigManager.sendOpenWarnings).toHaveBeenCalledTimes(1);
    const [projectId, warnings] = context.boardConfigManager.sendOpenWarnings.mock.calls[0] as [string, string[]];
    expect(projectId).toBe(project.id);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe('earlier warning from the reconcile');
    expect(warnings[1]).toContain('kangentic.json could not be applied');
    // The raw error is logged, never bannered: it can carry an absolute path.
    expect(warnings[1]).not.toContain('disk full');
    expect(loggedErrors.some((message) => message.includes('disk full'))).toBe(true);
  });

  it('pushes nothing when the user switched projects before the deferred callback ran', async () => {
    const project = makeProject();
    const context = createContext(project);
    state.existingPaths.add(project.path);
    context.boardConfigManager.applyConfigOnOpen.mockReturnValue(['a warning that must not be pushed']);

    await openProjectByPath(context as unknown as IpcContext, project.path);
    // Strictly before the setImmediate (check phase) callback runs.
    context.currentProjectId = 'a-different-project';
    await flushSetImmediate();

    expect(context.boardConfigManager.sendOpenWarnings).not.toHaveBeenCalled();
    expect(context.boardConfigManager.applyConfigOnOpen).not.toHaveBeenCalled();
  });

  it('pushes the warnings when the project is still current (control for the guard case)', async () => {
    const project = makeProject();
    const context = createContext(project);
    state.existingPaths.add(project.path);
    context.boardConfigManager.applyConfigOnOpen.mockReturnValue(['a warning that is pushed']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await openProjectByPath(context as unknown as IpcContext, project.path);
      await flushSetImmediate();
    } finally {
      warnSpy.mockRestore();
    }

    expect(context.boardConfigManager.sendOpenWarnings).toHaveBeenCalledWith(project.id, ['a warning that is pushed']);
  });
});
