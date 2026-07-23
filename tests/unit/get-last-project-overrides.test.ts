/**
 * Unit tests for the getLastProjectOverrides orchestration in
 * src/main/ipc/handlers/projects.ts.
 *
 * getLastProjectOverrides is a module-private function; this file exercises
 * it through the PROJECT_CREATE IPC handler, mirroring the capture pattern
 * used by config-handler-wiring.test.ts and task-create-handler.test.ts:
 * mock electron's ipcMain, capture the registered handler, invoke it
 * directly, then assert on the saved overrides.
 *
 * Covered scenarios:
 *   (i)  Returns the picked overridable subset (no importSources / browser)
 *        from the most-recently-opened qualifying project.
 *   (ii) Skips the excludePath (the newly-created project's own path).
 *   (iii)Falls through to the next project when a project's picked subset
 *        is empty (only non-overridable keys in its config).
 *   (iv) Falls back to getProjectOverridableDefaults() when no project
 *        has any overridable settings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must appear before any imports that trigger side effects
// ---------------------------------------------------------------------------

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

// Heavy sub-system mocks: none of these are exercised by the create path
// in the tests below (no open project, no PTY, no git, no analytics).
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => ['claude']),
    get: vi.fn(() => null),
    getOrThrow: vi.fn(),
    has: vi.fn(() => false),
  },
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
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/transcript-repository', () => ({
  TranscriptRepository: class {},
}));
vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));
vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  pruneOrphanedWorktreeTasks: vi.fn(),
}));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: { projectDb: vi.fn((id: string) => `/tmp/${id}.db`) },
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(async () => ({ entries: [], truncated: false })),
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));
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

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerProjectHandlers } from '../../src/main/ipc/handlers/projects';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProject {
  id: string;
  name: string;
  path: string;
  default_agent: string;
  position: number;
  last_opened: string | null;
  created_at: string;
}

function makeProject(overrides: Partial<MockProject>): MockProject {
  return {
    id: 'proj-' + Math.random().toString(36).slice(2),
    name: 'Test Project',
    path: '/mock/projects/test',
    default_agent: 'claude',
    position: 0,
    last_opened: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface MockProjectRepo {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  updateLastOpened: ReturnType<typeof vi.fn>;
  setDefaultAgent: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
  setGroup: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  getLastOpened: ReturnType<typeof vi.fn>;
}

function makeProjectRepo(projects: MockProject[]): MockProjectRepo {
  const createdProject = makeProject({ id: 'proj-new', path: '/mock/projects/new-project', name: 'New Project' });
  return {
    list: vi.fn(() => projects),
    create: vi.fn((_input: unknown) => createdProject),
    getById: vi.fn((id: string) => projects.find((p) => p.id === id) ?? null),
    delete: vi.fn(),
    updateLastOpened: vi.fn(),
    setDefaultAgent: vi.fn(),
    reorder: vi.fn(),
    setGroup: vi.fn(),
    rename: vi.fn(),
    getLastOpened: vi.fn(() => null),
  };
}

interface MockConfigManager {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  loadProjectOverrides: ReturnType<typeof vi.fn>;
  saveProjectOverrides: ReturnType<typeof vi.fn>;
  getProjectOverridableDefaults: ReturnType<typeof vi.fn>;
  getEffectiveConfig: ReturnType<typeof vi.fn>;
}

function makeConfigManager(
  overridesMap: Record<string, Record<string, unknown> | null>,
  defaults: Record<string, unknown> = { theme: 'dark' },
): MockConfigManager {
  return {
    load: vi.fn(() => ({ agent: { cliPaths: {} } })),
    save: vi.fn(),
    loadProjectOverrides: vi.fn((projectPath: string) => overridesMap[projectPath] ?? null),
    saveProjectOverrides: vi.fn(),
    getProjectOverridableDefaults: vi.fn(() => defaults),
    getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })),
  };
}

interface MockContext {
  projectRepo: MockProjectRepo;
  projectGroupRepo: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    reorder: ReturnType<typeof vi.fn>;
    setCollapsed: ReturnType<typeof vi.fn>;
  };
  configManager: MockConfigManager;
  sessionManager: { listSessions: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    applyConfigOnOpen: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
    getDefaultBaseBranch: ReturnType<typeof vi.fn>;
  };
  mainWindow: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  };
  currentProjectId: string | null;
  currentProjectPath: string | null;
  mcpServerHandle: null;
  recoveredProjects: Set<string>;
}

function makeContext(
  projects: MockProject[],
  overridesMap: Record<string, Record<string, unknown> | null>,
  globalDefaults: Record<string, unknown> = { theme: 'dark' },
): MockContext {
  return {
    projectRepo: makeProjectRepo(projects),
    projectGroupRepo: {
      list: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      reorder: vi.fn(),
      setCollapsed: vi.fn(),
    },
    configManager: makeConfigManager(overridesMap, globalDefaults),
    sessionManager: { listSessions: vi.fn(() => []) },
    boardConfigManager: {
      attach: vi.fn(),
      detach: vi.fn(),
      exists: vi.fn(() => false),
      applyConfigOnOpen: vi.fn(() => []),
      exportFromDb: vi.fn(),
      getDefaultBaseBranch: vi.fn(() => null),
    },
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    currentProjectId: null,
    currentProjectPath: null,
    mcpServerHandle: null,
    recoveredProjects: new Set(),
  };
}

async function invokeProjectCreate(
  context: MockContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const handler = capturedHandlers.get(IPC.PROJECT_CREATE);
  if (!handler) throw new Error(`Handler for ${IPC.PROJECT_CREATE} was not registered`);
  return handler(undefined, input);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('getLastProjectOverrides (via PROJECT_CREATE handler)', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
  });

  it('(i) seeds new project with the overridable subset from the most-recently-opened project', async () => {
    // The previous project has a full config that also contains importSources and
    // browser - mimicking the real TWC-Website leak scenario.
    const previousProject = makeProject({
      id: 'proj-previous',
      path: '/mock/projects/previous',
      last_opened: '2026-05-01T10:00:00.000Z',
    });

    const previousConfig: Record<string, unknown> = {
      theme: 'forest',
      // terminal.* is global-only (see pickOverridableSubset in
      // config-manager.ts) - included here specifically to assert it is
      // dropped, not carried over like theme/agent/git below.
      terminal: { shell: 'pwsh.exe', fontSize: 14 },
      agent: { permissionMode: 'acceptEdits' },
      git: { worktreesEnabled: true, defaultBaseBranch: 'develop' },
      // Non-overridable keys that must be dropped:
      importSources: [{ id: 'e83c7746', source: 'azure_devops', label: 'OCC / 2026-06' }],
      browser: { defaultUrl: 'http://troyweb.com/' },
    };

    const context = makeContext(
      [previousProject],
      { '/mock/projects/previous': previousConfig },
    );
    registerProjectHandlers(context as never);

    await invokeProjectCreate(context, {
      name: 'New Project',
      path: '/mock/projects/new-project',
    });

    // saveProjectOverrides must have been called for the new project
    expect(context.configManager.saveProjectOverrides).toHaveBeenCalledTimes(1);

    const savedPath = context.configManager.saveProjectOverrides.mock.calls[0][0];
    const savedOverrides = context.configManager.saveProjectOverrides.mock.calls[0][1] as Record<string, unknown>;

    expect(savedPath).toBe('/mock/projects/new-project');

    // The overridable settings are carried over
    expect(savedOverrides.theme).toBe('forest');
    expect(savedOverrides.agent).toEqual({ permissionMode: 'acceptEdits' });
    expect(savedOverrides.git).toMatchObject({ worktreesEnabled: true, defaultBaseBranch: 'develop' });

    // Non-overridable keys must be absent
    expect(savedOverrides).not.toHaveProperty('importSources');
    expect(savedOverrides).not.toHaveProperty('browser');
    // terminal.* is global-only now - must never be cloned into a new project.
    expect(savedOverrides).not.toHaveProperty('terminal');
  });

  it('(ii) skips the new project path (excludePath) when scanning for the previous project', async () => {
    // The new project already has an entry in the repo list (shouldn't happen in
    // production, but exercises the guard path). Its config contains settings that
    // must NOT bleed into itself.
    const newProjectPath = '/mock/projects/new-project';
    const newProjectAsExisting = makeProject({
      id: 'proj-new-existing',
      path: newProjectPath,
      last_opened: '2026-05-10T00:00:00.000Z', // most recent by date
    });
    const olderProject = makeProject({
      id: 'proj-older',
      path: '/mock/projects/older',
      last_opened: '2026-04-01T00:00:00.000Z',
    });

    const overridesMap: Record<string, Record<string, unknown>> = {
      [newProjectPath]: { theme: 'should-not-bleed', importSources: [{ id: 'x' }] },
      '/mock/projects/older': { theme: 'ocean' },
    };

    const context = makeContext(
      [newProjectAsExisting, olderProject],
      overridesMap,
    );
    // Override the created project path to match newProjectPath so the exclude triggers
    (context.projectRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
      makeProject({ id: 'proj-new', path: newProjectPath, name: 'New Project' }),
    );

    registerProjectHandlers(context as never);

    await invokeProjectCreate(context, {
      name: 'New Project',
      path: newProjectPath,
    });

    const savedOverrides = context.configManager.saveProjectOverrides.mock.calls[0][1] as Record<string, unknown>;

    // Must have taken the seed from olderProject (theme: 'ocean'), not the new project itself
    expect(savedOverrides.theme).toBe('ocean');
    expect(savedOverrides).not.toHaveProperty('importSources');
  });

  it('(iii) falls through when a project\'s picked subset is empty (only non-overridable keys)', async () => {
    // Project A (most recent) has only importSources - pickOverridableSubset returns {}.
    // Project B (older) has a real setting - its subset must be used instead.
    const projectA = makeProject({
      id: 'proj-a',
      path: '/mock/projects/a',
      last_opened: '2026-05-10T00:00:00.000Z',
    });
    const projectB = makeProject({
      id: 'proj-b',
      path: '/mock/projects/b',
      last_opened: '2026-04-01T00:00:00.000Z',
    });

    const overridesMap: Record<string, Record<string, unknown>> = {
      '/mock/projects/a': {
        importSources: [{ id: 'gh-abc', source: 'github_issues', label: 'Kangentic/kangentic' }],
      },
      '/mock/projects/b': {
        theme: 'ember',
        agent: { permissionMode: 'plan' },
      },
    };

    const context = makeContext([projectA, projectB], overridesMap);
    registerProjectHandlers(context as never);

    await invokeProjectCreate(context, {
      name: 'New Project',
      path: '/mock/projects/new-project',
    });

    const savedOverrides = context.configManager.saveProjectOverrides.mock.calls[0][1] as Record<string, unknown>;

    // Project A's non-overridable-only config was skipped; project B's settings applied
    expect(savedOverrides.theme).toBe('ember');
    expect(savedOverrides.agent).toEqual({ permissionMode: 'plan' });
    expect(savedOverrides).not.toHaveProperty('importSources');
  });

  it('(iv) falls back to getProjectOverridableDefaults() when no project has overridable settings', async () => {
    // No projects with any config at all -> loadProjectOverrides returns null for all.
    const projects = [
      makeProject({ id: 'proj-empty-a', path: '/mock/projects/empty-a', last_opened: '2026-05-01T00:00:00.000Z' }),
    ];

    const globalDefaults = {
      theme: 'dark',
      agent: { permissionMode: 'acceptEdits' },
    };

    const context = makeContext(
      projects,
      { '/mock/projects/empty-a': null },
      globalDefaults,
    );
    registerProjectHandlers(context as never);

    await invokeProjectCreate(context, {
      name: 'New Project',
      path: '/mock/projects/new-project',
    });

    // getProjectOverridableDefaults() must have been called as the fallback
    expect(context.configManager.getProjectOverridableDefaults).toHaveBeenCalledTimes(1);

    const savedOverrides = context.configManager.saveProjectOverrides.mock.calls[0][1] as Record<string, unknown>;

    // The saved overrides should match what getProjectOverridableDefaults returned
    // (this test mocks that function directly, so it does not exercise
    // pickOverridableSubset's real terminal.* filtering - see test (i) for that).
    expect(savedOverrides.theme).toBe('dark');
    expect(savedOverrides.agent).toEqual({ permissionMode: 'acceptEdits' });
  });
});
