/**
 * Unit tests for pruneStaleResources -- background async cleanup of
 * orphaned worktree, session, and task directories under .kangentic/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockExistsSync = vi.fn((): boolean => true);
const mockReaddir = vi.fn((): Promise<{ name: string; isDirectory: () => boolean }[]> => Promise.resolve([]));
const mockRm = vi.fn((): Promise<void> => Promise.resolve());

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      readdir: (...args: unknown[]) => mockReaddir(...args),
      rm: (...args: unknown[]) => mockRm(...args),
    },
  },
}));

vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'mock-uuid') }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getLatestForTask = vi.fn(); updateStatus = vi.fn(); deleteByTaskId = vi.fn(); listAllSessionIds = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); listArchived = vi.fn(() => []); delete = vi.fn(); },
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
vi.mock('../../src/main/agent/adapters/claude/detector', () => ({
  ClaudeDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig = vi.fn(() => ({ claude: {}, git: {}, terminal: {} })); },
}));
vi.mock('../../src/main/agent/adapters/claude/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(),
}));
vi.mock('../../src/main/agent/adapters/claude/hook-manager', () => ({
  buildHooks: vi.fn(),
  removeHooks: vi.fn(),
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  removeNodeModulesJunction: vi.fn(),
}));
vi.mock('../../src/main/git/node-modules-link', () => ({
  removeNodeModulesJunction: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { pruneOrphanedDirectories } from '../../src/main/engine/resource-cleanup';

// ── Helpers ───────────────────────────────────────────────────────────────

const PROJECT = '/dev/project';
const WORKTREES_DIR = path.join(PROJECT, '.kangentic', 'worktrees');
const SESSIONS_DIR = path.join(PROJECT, '.kangentic', 'sessions');
const TASKS_DIR = path.join(PROJECT, '.kangentic', 'tasks');

function makeMockTaskRepo(
  tasks: { id: string; worktree_path: string | null; session_id?: string | null }[],
  archived: { id: string; worktree_path: string | null; session_id?: string | null }[] = [],
) {
  return {
    list: vi.fn(() => tasks),
    listArchived: vi.fn(() => archived),
    delete: vi.fn(),
  } as unknown as import('../../src/main/db/repositories/task-repository').TaskRepository;
}

function makeMockSessionRepo(agentSessionIds: string[] = []) {
  return {
    deleteByTaskId: vi.fn(),
    listAllSessionIds: vi.fn(() => agentSessionIds),
  } as unknown as import('../../src/main/db/repositories/session-repository').SessionRepository;
}

function makeMockSessionManager() {
  const { EventEmitter } = require('node:events');
  const mgr = new EventEmitter();
  mgr.listSessions = vi.fn(() => []);
  return mgr as unknown as import('../../src/main/pty/session-manager').SessionManager;
}

function dirEntry(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true };
}

/** Configure readdir to return specific entries per directory path. */
function setupReaddir(map: Record<string, { name: string; isDirectory: () => boolean }[]>) {
  mockReaddir.mockImplementation((dir: string) => {
    return Promise.resolve(map[dir] || []);
  });
}

async function runWithTimers(): Promise<void> {
  // Flush microtasks + advance timers through retry delays
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pruneStaleResources -- async background cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([]);
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes orphaned worktree directories', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('stale-abcd1234')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);
    await runWithTimers();

    expect(mockRm).toHaveBeenCalledWith(
      path.join(WORKTREES_DIR, 'stale-abcd1234'),
      { recursive: true, force: true },
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removing orphaned worktree directory: stale-abcd1234'),
    );
    logSpy.mockRestore();
  });

  it('removes orphaned session directories', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('dead-session-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);
    await runWithTimers();

    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'dead-session-uuid'),
      { recursive: true, force: true },
    );
    logSpy.mockRestore();
  });

  it('removes orphaned task directories', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [TASKS_DIR]: [dirEntry('dead-task-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);
    await runWithTimers();

    expect(mockRm).toHaveBeenCalledWith(
      path.join(TASKS_DIR, 'dead-task-uuid'),
      { recursive: true, force: true },
    );
    logSpy.mockRestore();
  });

  it('preserves directories referenced by active tasks', async () => {
    const wtPath = path.join(WORKTREES_DIR, 'my-task-abcd1234');
    const taskRepo = makeMockTaskRepo([
      { id: 'task-uuid-1', worktree_path: wtPath, session_id: 'pty-session-1' },
    ]);
    const sessionRepo = makeMockSessionRepo(['claude-session-uuid']);
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('my-task-abcd1234')],
      [SESSIONS_DIR]: [dirEntry('task-uuid-1'), dirEntry('claude-session-uuid')],
      [TASKS_DIR]: [dirEntry('task-uuid-1')],
    });

    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);
    await runWithTimers();

    // None should be removed -- all referenced
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('preserves directories referenced by archived tasks', async () => {
    const taskRepo = makeMockTaskRepo(
      [], // no active tasks
      [{ id: 'archived-uuid', worktree_path: path.join(WORKTREES_DIR, 'archived-task'), session_id: null }],
    );
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('archived-task')],
      [TASKS_DIR]: [dirEntry('archived-uuid')],
    });

    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('retries rm on EPERM then succeeds', async () => {
    vi.useRealTimers(); // Retry delays need real timers since function is awaited
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('eperm-dir')],
    });

    let rmCount = 0;
    mockRm.mockImplementation(() => {
      rmCount++;
      if (rmCount < 2) return Promise.reject(new Error('EPERM'));
      return Promise.resolve();
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);

    expect(mockRm).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs warning when all retries fail', async () => {
    vi.useRealTimers(); // Retry delays need real timers since function is awaited
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionMgr = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('locked-dir')],
    });
    mockRm.mockRejectedValue(new Error('EPERM'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pruneOrphanedDirectories(PROJECT, taskRepo, sessionRepo, sessionMgr);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove orphaned worktree directory: locked-dir'),
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
