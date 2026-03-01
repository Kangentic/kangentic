/**
 * Unit tests for the orphaned worktree directory cleanup in
 * pruneOrphanedWorktrees (second pass — stale directories on disk
 * not referenced by any task).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockExistsSync = vi.fn((): boolean => true);
const mockReaddirSync = vi.fn((): { name: string; isDirectory: () => boolean }[] => []);
const mockRmSync = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'mock-uuid') }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getLatestForTask = vi.fn(); updateStatus = vi.fn(); deleteByTaskId = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); delete = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { getTransitionsFor = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list = vi.fn(() => []); getById = vi.fn(); },
}));
vi.mock('../../src/main/pty/session-manager', () => {
  const { EventEmitter } = require('node:events');
  return {
    SessionManager: class extends EventEmitter {
      listSessions = vi.fn(() => []);
      spawn = vi.fn();
      kill = vi.fn();
    },
  };
});
vi.mock('../../src/main/agent/claude-detector', () => ({
  ClaudeDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/agent/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig = vi.fn(() => ({ claude: {}, git: {}, terminal: {} })); },
}));
vi.mock('../../src/main/agent/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(),
}));
vi.mock('../../src/main/agent/hook-manager', () => ({
  injectActivityHooks: vi.fn(),
  injectEventHooks: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { pruneOrphanedWorktrees } from '../../src/main/engine/session-recovery';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMockTaskRepo(tasks: { id: string; worktree_path: string | null }[]) {
  return {
    list: vi.fn(() => tasks),
    delete: vi.fn(),
  } as unknown as import('../../src/main/db/repositories/task-repository').TaskRepository;
}

function makeMockSessionRepo() {
  return {
    deleteByTaskId: vi.fn(),
  } as unknown as import('../../src/main/db/repositories/session-repository').SessionRepository;
}

function makeMockSessionManager() {
  const { EventEmitter } = require('node:events');
  const mgr = new EventEmitter();
  mgr.listSessions = vi.fn(() => []);
  return mgr as unknown as import('../../src/main/pty/session-manager').SessionManager;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pruneOrphanedWorktrees — stale directory cleanup', () => {
  const projectPath = '/dev/project';
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
  });

  it('removes directories not referenced by any task', () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    mockReaddirSync.mockReturnValue([
      { name: 'stale-dir-abcd1234', isDirectory: () => true },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    pruneOrphanedWorktrees(projectPath, taskRepo, sessionRepo, sessionMgr);

    expect(mockRmSync).toHaveBeenCalledWith(
      path.join(worktreesDir, 'stale-dir-abcd1234'),
      { recursive: true, force: true },
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removing orphaned worktree directory: stale-dir-abcd1234'),
    );
    consoleSpy.mockRestore();
  });

  it('skips directories still referenced by a task', () => {
    const referencedPath = path.join(worktreesDir, 'active-task-1234abcd');
    const taskRepo = makeMockTaskRepo([
      { id: 'task-1', worktree_path: referencedPath },
    ]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    mockReaddirSync.mockReturnValue([
      { name: 'active-task-1234abcd', isDirectory: () => true },
    ]);

    pruneOrphanedWorktrees(projectPath, taskRepo, sessionRepo, sessionMgr);

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('skips non-directory entries', () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    mockReaddirSync.mockReturnValue([
      { name: '.gitkeep', isDirectory: () => false },
    ]);

    pruneOrphanedWorktrees(projectPath, taskRepo, sessionRepo, sessionMgr);

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('logs warning when rmSync fails on stale directory', () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    mockReaddirSync.mockReturnValue([
      { name: 'locked-dir-abcd1234', isDirectory: () => true },
    ]);
    mockRmSync.mockImplementation(() => {
      throw new Error('EPERM: still locked');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    pruneOrphanedWorktrees(projectPath, taskRepo, sessionRepo, sessionMgr);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove orphaned worktree directory locked-dir-abcd1234'),
      'EPERM: still locked',
    );
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
