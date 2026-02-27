import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock functions we need to control and assert on
const { mockList, mockDelete, mockExistsSync, mockCloseProjectDb } = vi.hoisted(() => ({
  mockList: vi.fn((): any[] => []),
  mockDelete: vi.fn(),
  mockExistsSync: vi.fn((): boolean => true),
  mockCloseProjectDb: vi.fn(),
}));

// --- Mock leaf-level native modules ---
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})), simpleGit: vi.fn(() => ({})) }));

// --- Mock fs (keep path real) ---
vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
  },
}));

// --- Mock internal dependencies using class-based constructors ---
vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class {
    list = mockList;
    delete = mockDelete;
    create = vi.fn();
    getById = vi.fn();
    updateLastOpened = vi.fn();
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(),
  closeProjectDb: mockCloseProjectDb,
  closeAll: vi.fn(),
}));

vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    configDir: '/tmp/kangentic',
    globalDb: '/tmp/kangentic/index.db',
    projectsDir: '/tmp/kangentic/projects',
    projectDb: (id: string) => `/tmp/kangentic/projects/${id}.db`,
  },
  ensureDirs: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); getById = vi.fn(); create = vi.fn(); update = vi.fn(); delete = vi.fn(); move = vi.fn(); archive = vi.fn(); unarchive = vi.fn(); listArchived = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list = vi.fn(() => []); getById = vi.fn(); create = vi.fn(); update = vi.fn(); delete = vi.fn(); reorder = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list = vi.fn(() => []); create = vi.fn(); update = vi.fn(); delete = vi.fn(); listTransitions = vi.fn(() => []); setTransitions = vi.fn(); getTransitionsFor = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getLatestForTask = vi.fn(); updateStatus = vi.fn(); deleteByTaskId = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { list = vi.fn(() => []); add = vi.fn(); remove = vi.fn(); getDataUrl = vi.fn(); deleteByTaskId = vi.fn(); },
}));
vi.mock('../../src/main/pty/session-manager', () => {
  const { EventEmitter } = require('node:events');
  return {
    SessionManager: class extends EventEmitter {
      spawn = vi.fn();
      kill = vi.fn();
      killAll = vi.fn();
      remove = vi.fn();
      suspend = vi.fn();
      suspendAll = vi.fn();
      write = vi.fn();
      resize = vi.fn();
      listSessions = vi.fn(() => []);
      getSession = vi.fn();
      getScrollback = vi.fn();
      getUsageCache = vi.fn(() => ({}));
      getActivityCache = vi.fn(() => ({}));
      getEventsForSession = vi.fn(() => []);
      setMaxConcurrent = vi.fn();
      setShell = vi.fn();
    },
  };
});
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { load = vi.fn(() => ({})); save = vi.fn(); getEffectiveConfig = vi.fn(() => ({ claude: {}, git: {}, terminal: {} })); loadProjectOverrides = vi.fn(); saveProjectOverrides = vi.fn(); },
}));
vi.mock('../../src/main/agent/claude-detector', () => ({
  ClaudeDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/pty/shell-resolver', () => ({
  ShellResolver: class { getAvailableShells = vi.fn(() => []); getDefaultShell = vi.fn(); },
}));
vi.mock('../../src/main/engine/transition-engine', () => ({
  TransitionEngine: class { executeTransition = vi.fn(); resumeSuspendedSession = vi.fn(); },
}));
vi.mock('../../src/main/agent/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
vi.mock('../../src/main/engine/session-recovery', () => ({
  recoverSessions: vi.fn(),
  reconcileSessions: vi.fn(),
  pruneOrphanedWorktrees: vi.fn(),
}));
vi.mock('../../src/main/git/worktree-manager', () => {
  class MockWorktreeManager {
    createWorktree = vi.fn();
    removeWorktree = vi.fn();
    removeBranch = vi.fn();
    renameBranch = vi.fn();
    static isGitRepo = vi.fn(() => false);
  }
  return { WorktreeManager: MockWorktreeManager };
});
vi.mock('../../src/main/agent/hook-manager', () => ({
  stripActivityHooks: vi.fn(),
}));
vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
}));
vi.mock('../../src/main/db/migrations', () => ({
  runGlobalMigrations: vi.fn(),
  runProjectMigrations: vi.fn(),
}));

// --- Import the function under test ---
import { pruneStaleWorktreeProjects } from '../../src/main/ipc/register-all';

describe('pruneStaleWorktreeProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockList.mockReturnValue([]);
  });

  it('prunes worktree projects whose paths no longer exist', async () => {
    mockList.mockReturnValue([
      { id: 'proj-1', name: 'stale-preview', path: 'C:\\repo\\.kangentic\\worktrees\\my-feature-abc123' },
    ]);
    mockExistsSync.mockReturnValue(false);

    await pruneStaleWorktreeProjects();

    expect(mockCloseProjectDb).toHaveBeenCalledWith('proj-1');
    expect(mockDelete).toHaveBeenCalledWith('proj-1');
  });

  it('preserves worktree projects whose paths still exist', async () => {
    mockList.mockReturnValue([
      { id: 'proj-2', name: 'active-preview', path: '/repo/.kangentic/worktrees/active-feature' },
    ]);
    mockExistsSync.mockReturnValue(true);

    await pruneStaleWorktreeProjects();

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('skips non-worktree projects even if path is missing', async () => {
    mockList.mockReturnValue([
      { id: 'proj-3', name: 'normal-project', path: 'C:\\Users\\dev\\my-app' },
    ]);
    mockExistsSync.mockReturnValue(false);

    await pruneStaleWorktreeProjects();

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('handles empty project list without errors', async () => {
    mockList.mockReturnValue([]);

    await pruneStaleWorktreeProjects();

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('prunes only stale worktree projects in a mixed list', async () => {
    mockList.mockReturnValue([
      { id: 'normal', name: 'normal', path: '/home/user/project' },
      { id: 'stale', name: 'stale', path: '/repo/.kangentic/worktrees/gone-feature' },
      { id: 'alive', name: 'alive', path: '/repo/.kangentic/worktrees/still-here' },
    ]);
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('gone-feature')) return false;
      return true;
    });

    await pruneStaleWorktreeProjects();

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('stale');
  });
});
