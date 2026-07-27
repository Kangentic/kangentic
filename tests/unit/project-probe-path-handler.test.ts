/**
 * Unit tests for the PROJECT_PROBE_PATH and PROJECT_ENSURE_GIT IPC handlers
 * in src/main/ipc/handlers/projects.ts.
 *
 * PROJECT_PROBE_PATH wraps the module-private `probeFolder` helper: it
 * resolves the candidate folder, checks existence/directory-ness, git-repo-
 * ness, worktree-ness, reads the current branch (only when it IS a git repo),
 * derives a suggested project name from the basename, and looks up whether a
 * project is already registered at this exact resolved path. It drives the
 * Add Project dialog's git verdict and already-registered banner BEFORE any
 * project row is created.
 *
 * PROJECT_ENSURE_GIT is a thin passthrough to ensureGitRepo() - the handler
 * must forward its result verbatim, never reshaping or swallowing an
 * `ok: false` failure.
 *
 * Strategy mirrors get-last-project-overrides.test.ts: mock electron's
 * ipcMain to capture registered handlers (plus every other heavy
 * sub-system projects.ts imports), then invoke the captured PROJECT_PROBE_PATH
 * / PROJECT_ENSURE_GIT handlers directly - no real git, no real filesystem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { ProjectPathProbe, ProjectEnsureGitResult } from '../../src/shared/types';

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

// probeFolder's own dependencies - each test controls these directly.
const isGitRepoMock = vi.fn().mockReturnValue(false);
const isInsideWorktreeMock = vi.fn().mockReturnValue(false);
const isKangenticWorktreeMock = vi.fn().mockReturnValue(false);
const ensureGitRepoMock = vi.fn();

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: (...args: unknown[]) => isGitRepoMock(...args),
  isInsideWorktree: (...args: unknown[]) => isInsideWorktreeMock(...args),
  isKangenticWorktree: (...args: unknown[]) => isKangenticWorktreeMock(...args),
  ensureGitRepo: (...args: unknown[]) => ensureGitRepoMock(...args),
}));

const readWorktreeHeadUnqueuedMock = vi.fn().mockResolvedValue({ branch: null, sha: null });
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHeadUnqueued: (...args: unknown[]) => readWorktreeHeadUnqueuedMock(...args),
}));

const existsSyncMock = vi.fn().mockReturnValue(true);
const statSyncMock = vi.fn().mockReturnValue({ isDirectory: () => true });

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    promises: { stat: vi.fn(async () => ({ isDirectory: () => true })) },
  },
}));

// Heavy sub-system mocks not exercised by PROJECT_PROBE_PATH / PROJECT_ENSURE_GIT,
// carried over from get-last-project-overrides.test.ts so the module import succeeds.
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
  path: string;
}

function makeContext(registeredProjects: MockProject[] = []): { projectRepo: { list: () => MockProject[] } } {
  return {
    projectRepo: { list: () => registeredProjects },
  };
}

async function invokeProbePath(context: unknown, folderPath: string): Promise<ProjectPathProbe> {
  const handler = capturedHandlers.get(IPC.PROJECT_PROBE_PATH);
  if (!handler) throw new Error(`Handler for ${IPC.PROJECT_PROBE_PATH} was not registered`);
  return handler(undefined, folderPath) as Promise<ProjectPathProbe>;
}

async function invokeEnsureGit(context: unknown, folderPath: string): Promise<ProjectEnsureGitResult> {
  const handler = capturedHandlers.get(IPC.PROJECT_ENSURE_GIT);
  if (!handler) throw new Error(`Handler for ${IPC.PROJECT_ENSURE_GIT} was not registered`);
  return handler(undefined, folderPath) as Promise<ProjectEnsureGitResult>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PROJECT_PROBE_PATH IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    isGitRepoMock.mockReset().mockReturnValue(false);
    isInsideWorktreeMock.mockReset().mockReturnValue(false);
    isKangenticWorktreeMock.mockReset().mockReturnValue(false);
    ensureGitRepoMock.mockReset();
    readWorktreeHeadUnqueuedMock.mockReset().mockResolvedValue({ branch: null, sha: null });
    existsSyncMock.mockReset().mockReturnValue(true);
    statSyncMock.mockReset().mockReturnValue({ isDirectory: () => true });
  });

  it('populates isGitRepo and currentBranch for an existing repo folder', async () => {
    isGitRepoMock.mockReturnValue(true);
    readWorktreeHeadUnqueuedMock.mockResolvedValue({ branch: 'feature-x', sha: 'abc123' });
    const context = makeContext();
    registerProjectHandlers(context as never);

    const result = await invokeProbePath(context, path.join('mock', 'existing-repo'));

    expect(result.exists).toBe(true);
    expect(result.isDirectory).toBe(true);
    expect(result.isGitRepo).toBe(true);
    expect(result.currentBranch).toBe('feature-x');
    expect(result.suggestedName).toBe('existing-repo');
  });

  it('does not call readWorktreeHeadUnqueued and leaves currentBranch null when the folder is not a git repo', async () => {
    isGitRepoMock.mockReturnValue(false);
    const context = makeContext();
    registerProjectHandlers(context as never);

    const result = await invokeProbePath(context, path.join('mock', 'plain-folder'));

    expect(result.isGitRepo).toBe(false);
    expect(result.currentBranch).toBeNull();
    expect(readWorktreeHeadUnqueuedMock).not.toHaveBeenCalled();
  });

  it('reports exists:false for a folder that does not exist, without probing git at all', async () => {
    existsSyncMock.mockReturnValue(false);
    const context = makeContext();
    registerProjectHandlers(context as never);

    const result = await invokeProbePath(context, path.join('mock', 'does-not-exist'));

    expect(result.exists).toBe(false);
    expect(result.isDirectory).toBe(false);
    expect(result.isGitRepo).toBe(false);
    expect(result.currentBranch).toBeNull();
    expect(isGitRepoMock).not.toHaveBeenCalled();
  });

  it('reports the matching project id when a project is already registered at this exact resolved path', async () => {
    const folderPath = path.join('mock', 'projects', 'already-open');
    const resolvedPath = path.resolve(folderPath);
    const context = makeContext([{ id: 'proj-existing', path: resolvedPath }]);
    registerProjectHandlers(context as never);

    const result = await invokeProbePath(context, folderPath);

    expect(result.alreadyRegisteredProjectId).toBe('proj-existing');
  });

  it('reports null when no registered project matches this resolved path', async () => {
    const context = makeContext([{ id: 'proj-other', path: path.resolve(path.join('mock', 'projects', 'unrelated')) }]);
    registerProjectHandlers(context as never);

    const result = await invokeProbePath(context, path.join('mock', 'projects', 'different-folder'));

    expect(result.alreadyRegisteredProjectId).toBeNull();
  });
});

describe('PROJECT_ENSURE_GIT IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    ensureGitRepoMock.mockReset();
  });

  it('passes an ok:false failure result through unchanged, without reshaping or swallowing it', async () => {
    const failure: ProjectEnsureGitResult = {
      ok: false,
      created: false,
      error: 'That folder could not be read.',
    };
    ensureGitRepoMock.mockResolvedValue(failure);
    const context = makeContext();
    registerProjectHandlers(context as never);

    const result = await invokeEnsureGit(context, path.join('mock', 'unreadable'));

    expect(result).toEqual(failure);
  });

  it('passes an ok:true success result through unchanged', async () => {
    const success: ProjectEnsureGitResult = { ok: true, created: true, error: null };
    ensureGitRepoMock.mockResolvedValue(success);
    const context = makeContext();
    registerProjectHandlers(context as never);

    const result = await invokeEnsureGit(context, path.join('mock', 'brand-new'));

    expect(result).toEqual(success);
  });

  it('forwards the resolved (absolute) folder path to ensureGitRepo', async () => {
    ensureGitRepoMock.mockResolvedValue({ ok: true, created: false, error: null });
    const context = makeContext();
    registerProjectHandlers(context as never);
    const relativeLikeInput = path.join('mock', 'relative-ish');

    await invokeEnsureGit(context, relativeLikeInput);

    expect(ensureGitRepoMock).toHaveBeenCalledWith(path.resolve(relativeLikeInput));
  });
});
