/**
 * Unit tests for pruneStaleResources -- background async cleanup of
 * orphaned worktree, session, and task directories under .kangentic/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const mockExistsSync = vi.fn((): boolean => true);
const mockReaddir = vi.fn((): Promise<{ name: string; isDirectory: () => boolean }[]> => Promise.resolve([]));
const mockRm = vi.fn((): Promise<void> => Promise.resolve());
const mockMoveIntoSetAside = vi.fn((): Promise<string | null> => Promise.resolve('/moved'));
const mockReportHandledError = vi.fn();
// Default to an old mtime so every existing deletion-asserting test still
// sweeps. Computed at call time because these suites use fake timers.
const mockStat = vi.fn((): Promise<{ mtimeMs: number }> => Promise.resolve({ mtimeMs: Date.now() - ONE_DAY_MS }));

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
      stat: (...args: unknown[]) => mockStat(...args),
    },
  },
}));

vi.mock('../../src/main/project-ownership/set-aside', () => ({
  moveIntoSetAside: (...args: unknown[]) => mockMoveIntoSetAside(...args),
  purgeExpiredSetAside: vi.fn(),
}));
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => mockReportHandledError(...args),
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
vi.mock('../../src/main/git/worktree-manager', () => ({}));
vi.mock('../../src/main/git/node-modules-link', () => ({
  removeNodeModulesPath: vi.fn(),
}));
vi.mock('../../src/main/git/node-modules-link', () => ({
  removeNodeModulesPath: vi.fn(),
}));
vi.mock('../../src/main/git/worktree-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/worktree-links')>();
  return { ...actual, clearWorktreeLinks: vi.fn(actual.clearWorktreeLinks) };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ simpleGit: vi.fn(() => ({})) }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { pruneOrphanedDirectories } from '../../src/main/transition-engine/resource-cleanup';
import { ownershipOf } from './helpers/verified-ownership';
import { runWorktreeCreation, isWorktreeCreationInFlight } from '../../src/main/git/worktree-creation-registry';
import { removeNodeModulesPath } from '../../src/main/git/node-modules-link';
import { clearWorktreeLinks } from '../../src/main/git/worktree-links';

// ── Helpers ───────────────────────────────────────────────────────────────

const PROJECT = '/dev/project';
const WORKTREES_DIR = path.join(PROJECT, '.kangentic', 'worktrees');
const SESSIONS_DIR = path.join(PROJECT, '.kangentic', 'sessions');
const TASKS_DIR = path.join(PROJECT, '.kangentic', 'tasks');

function makeMockTaskRepo(
  tasks: { id: string; worktree_path: string | null; worktree_folder?: string | null; session_id?: string | null }[],
  archived: { id: string; worktree_path: string | null; worktree_folder?: string | null; session_id?: string | null }[] = [],
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
    mockMoveIntoSetAside.mockResolvedValue('/moved');
    mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: Date.now() - ONE_DAY_MS }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets orphaned worktree directories aside and deletes nothing', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('stale-abcd1234')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'stale-abcd1234'));
    expect(mockRm).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removing orphaned worktree directory: stale-abcd1234'),
    );
    logSpy.mockRestore();
  });

  it('removes orphaned session directories', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('dead-session-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'dead-session-uuid'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    logSpy.mockRestore();
  });

  it('sets orphaned task directories aside, since their attachments have no other copy', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [TASKS_DIR]: [dirEntry('dead-task-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'tasks', path.join(TASKS_DIR, 'dead-task-uuid'));
    expect(mockRm).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('keeps a folder whose move aside failed: there is no fallback delete', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    mockMoveIntoSetAside.mockResolvedValue(null);
    setupReaddir({ [WORKTREES_DIR]: [dirEntry('held-open')] });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('refuses a sweep of most of a folder, and clears nothing in it', async () => {
    // The shape of a wrong database that got past the ownership check: it names
    // one entry of a populated folder. Two more folders still clear as usual.
    const keptTask = { id: 'kept-task', worktree_path: path.join(WORKTREES_DIR, 'kept'), session_id: null };
    const taskRepo = makeMockTaskRepo([keptTask]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    setupReaddir({
      [TASKS_DIR]: [dirEntry('kept-task'), ...['a', 'b', 'c', 'd', 'e'].map(dirEntry)],
      [SESSIONS_DIR]: [dirEntry('dead-session')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Refused to clear 5 of 6 task directories'));
    expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    expect(mockRm).toHaveBeenCalledWith(path.join(SESSIONS_DIR, 'dead-session'), expect.anything());
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('clears a majority of a small folder: a few stragglers are what a sweep is for', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    setupReaddir({ [TASKS_DIR]: ['a', 'b', 'c', 'd'].map(dirEntry) });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).toHaveBeenCalledTimes(4);
    expect(mockReportHandledError).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('clears a large folder when the orphans are the smaller half', async () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, worktree_path: null, session_id: null }));
    const taskRepo = makeMockTaskRepo(tasks);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    setupReaddir({ [TASKS_DIR]: ['a', 'b', 'c', 'd', 'e', 'x', 'y', 'z', 'v', 'w'].map(dirEntry) });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).toHaveBeenCalledTimes(5);
    expect(mockReportHandledError).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('preserves directories referenced by active tasks', async () => {
    const wtPath = path.join(WORKTREES_DIR, 'my-task-abcd1234');
    const taskRepo = makeMockTaskRepo([
      { id: 'task-uuid-1', worktree_path: wtPath, session_id: 'pty-session-1' },
    ]);
    const sessionRepo = makeMockSessionRepo(['claude-session-uuid']);
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('my-task-abcd1234')],
      [SESSIONS_DIR]: [dirEntry('task-uuid-1'), dirEntry('claude-session-uuid')],
      [TASKS_DIR]: [dirEntry('task-uuid-1')],
    });

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    // None should be removed -- all referenced
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('keeps a worktree folder whose task spells the project path another way', async () => {
    // Matched by the folder name in worktree_path, not the exact string: a row written
    // with other separators or another case still names its folder.
    const taskRepo = makeMockTaskRepo([
      { id: 'task-uuid-1', worktree_path: '\\DEV\\Project\\.kangentic\\worktrees\\spelled-differently', session_id: null },
    ]);
    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('spelled-differently'), dirEntry('stale-abcd1234')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, makeMockSessionRepo(), makeMockSessionManager());
    await runWithTimers();

    expect(mockMoveIntoSetAside).not.toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'spelled-differently'));
    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'stale-abcd1234'));
    logSpy.mockRestore();
  });

  it('sets aside the folder of a task that records only worktree_folder: a Done round trip leaves it no keeper', async () => {
    const taskRepo = makeMockTaskRepo([
      { id: 'task-uuid-1', worktree_path: null, worktree_folder: 'left-behind', session_id: null },
    ]);
    setupReaddir({ [WORKTREES_DIR]: [dirEntry('left-behind')] });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, makeMockSessionRepo(), makeMockSessionManager());
    await runWithTimers();

    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'left-behind'));
    logSpy.mockRestore();
  });

  it('preserves a worktree directory a creation is still setting up, which no task records yet', async () => {
    // A worktree is recorded on its task only once its setup (the
    // Post-Worktree Script) ends, and the script runs outside the git queue,
    // so for the whole script the directory looks orphaned to this sweep.
    // Without the `isWorktreeCreationInFlight` check in
    // `pruneOrphanedDirectories` this directory is removed: the mtime defaults
    // to a day old here, so the grace period does not save it.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    const settingUpPath = path.join(WORKTREES_DIR, '42');
    let finishCreation: () => void = () => undefined;
    const creation = runWorktreeCreation(settingUpPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('42'), dirEntry('stale-abcd1234')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).not.toHaveBeenCalledWith(PROJECT, 'worktrees', settingUpPath);
    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'stale-abcd1234'));
    finishCreation();
    await creation;
    logSpy.mockRestore();
  });

  it('preserves a worktree directory a creation claims during the node_modules removal, after the sweep began', async () => {
    // The sweep asks `isReferenced` once up front, then again after the awaits
    // (the stat, the slow node_modules removal) because a creation can claim the
    // path while they run. Without the second ask, `removeWithRetry` deletes a
    // directory whose setup script has just started. The hold is started from
    // inside the node_modules removal, so it did not exist at the first ask.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    const lateClaimedPath = path.join(WORKTREES_DIR, 'stale-abcd1234');
    const otherOrphanPath = path.join(WORKTREES_DIR, 'other-orphan-5678');
    let finishCreation: () => void = () => undefined;
    let creation: Promise<void> = Promise.resolve();
    vi.mocked(removeNodeModulesPath).mockImplementationOnce(async (targetPath: string) => {
      if (targetPath !== path.join(lateClaimedPath, 'node_modules')) return;
      creation = runWorktreeCreation(lateClaimedPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));
    });

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('stale-abcd1234'), dirEntry('other-orphan-5678')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Nothing holds the path when the sweep starts.
      expect(isWorktreeCreationInFlight(lateClaimedPath)).toBe(false);
      await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
      await runWithTimers();

      // The sweep reached the removal stage for the claimed directory, so the
      // skip below is the second ask and not an earlier guard.
      expect(removeNodeModulesPath).toHaveBeenCalledWith(path.join(lateClaimedPath, 'node_modules'), undefined);
      expect(isWorktreeCreationInFlight(lateClaimedPath)).toBe(true);
      expect(mockMoveIntoSetAside).not.toHaveBeenCalledWith(PROJECT, 'worktrees', lateClaimedPath);
      // The sweep carried on: the next orphan, which nothing claimed, is removed.
      expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', otherOrphanPath);
    } finally {
      finishCreation();
      await creation;
      vi.mocked(removeNodeModulesPath).mockReset();
      logSpy.mockRestore();
    }
  });

  it('keeps an orphan whose link will not come out, because a project delete\'s rmSync would follow it', async () => {
    const stuckPath = path.join(WORKTREES_DIR, 'stuck-abcd1234');
    vi.mocked(clearWorktreeLinks).mockResolvedValueOnce(false);
    setupReaddir({ [WORKTREES_DIR]: [dirEntry('stuck-abcd1234')] });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await pruneOrphanedDirectories(ownershipOf(PROJECT), makeMockTaskRepo([]), makeMockSessionRepo(), makeMockSessionManager());
      await runWithTimers();
      // The orphan was reached and its links were asked about, so the refusal below is the
      // link check and not the fixture ceasing to read as an orphan.
      expect(clearWorktreeLinks).toHaveBeenCalledWith(stuckPath);
      expect(mockMoveIntoSetAside).not.toHaveBeenCalledWith(PROJECT, 'worktrees', stuckPath);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('sets the same orphan aside once its links come out', async () => {
    const stuckPath = path.join(WORKTREES_DIR, 'stuck-abcd1234');
    vi.mocked(clearWorktreeLinks).mockResolvedValueOnce(true);
    setupReaddir({ [WORKTREES_DIR]: [dirEntry('stuck-abcd1234')] });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneOrphanedDirectories(ownershipOf(PROJECT), makeMockTaskRepo([]), makeMockSessionRepo(), makeMockSessionManager());
      await runWithTimers();
      expect(clearWorktreeLinks).toHaveBeenCalledWith(stuckPath);
      expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', stuckPath);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('preserves directories referenced by archived tasks', async () => {
    const taskRepo = makeMockTaskRepo(
      [], // no active tasks
      [{ id: 'archived-uuid', worktree_path: path.join(WORKTREES_DIR, 'archived-task'), session_id: null }],
    );
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('archived-task')],
      [TASKS_DIR]: [dirEntry('archived-uuid')],
    });

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('preserves a spare worktree, which no task records, and still removes a real orphan', async () => {
    // A spare worktree (`spare_<8 hex>`) is no task's until one adopts it, and
    // its own startup pass decides whether it stays. Without the spare-name
    // check this sweep deletes the one pre-installed worktree a project keeps
    // (the mtime defaults to a day old, so the grace period does not save it).
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [WORKTREES_DIR]: [dirEntry('spare_0a1b2c3d'), dirEntry('stale-abcd1234')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockMoveIntoSetAside).not.toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'spare_0a1b2c3d'));
    expect(mockMoveIntoSetAside).toHaveBeenCalledWith(PROJECT, 'worktrees', path.join(WORKTREES_DIR, 'stale-abcd1234'));
    logSpy.mockRestore();
  });

  it('preserves a session directory whose id is live in the session manager (regression)', async () => {
    // task-cleanup's live-session guard may delete a live session's DB record
    // while sparing its on-disk dir. The orphan prune must keep that dir alive
    // until the session actually exits - it protects every id from
    // sessionManager.listSessions(). This locks that guarantee.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo(); // no DB-referenced ids
    const sessionManager = makeMockSessionManager();
    (sessionManager as unknown as { listSessions: ReturnType<typeof vi.fn> })
      .listSessions.mockReturnValue([{ id: 'live-session-uuid', status: 'running' }]);

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('live-session-uuid'), dirEntry('dead-session-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    // The genuinely-dead dir is removed...
    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'dead-session-uuid'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    // ...but the live session's dir is never touched.
    expect(mockRm).not.toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'live-session-uuid'),
      expect.anything(),
    );
    logSpy.mockRestore();
  });

  it('preserves a live Command Terminal\'s directory, which is named by its session id', async () => {
    // A terminal has no task row, and a phone can start one in a project the
    // desktop cold-opens later. It is not named by the terminal's tag: a
    // restored terminal keeps its tag, and this sweep runs during the same cold
    // open, with last run's directory unreferenced and days old.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    (sessionManager as unknown as { listSessions: ReturnType<typeof vi.fn> })
      .listSessions.mockReturnValue([{ id: 'terminal-session-uuid', taskId: 'terminal-tag-uuid', status: 'running', transient: true }]);

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('terminal-session-uuid')],
    });

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('preserves a live workflow agent\'s directory, which is named by its workflow id', async () => {
    // Red without the live sessions' task ids in the referenced set.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();
    (sessionManager as unknown as { listSessions: ReturnType<typeof vi.fn> })
      .listSessions.mockReturnValue([{ id: 'agent-session-uuid', taskId: 'workflow-uuid', status: 'running', transient: true, workflowId: 'workflow-uuid' }]);

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('workflow-uuid')],
    });

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('preserves a session directory whose id is only in listAllSessionIds (DB regression)', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo(['db-only-session-uuid']);
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('db-only-session-uuid')],
    });

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('preserves an unreferenced session directory modified within the grace period (cold-open spawn race regression)', async () => {
    // A recovery/auto-spawn writes sessions/<uuid>/ (settings.json + mcp.json)
    // before the id is visible in the DB or PTY registry. A concurrent sweep at
    // cold open sees it as orphaned. The grace period keeps freshly modified
    // dirs alive so the sweep can never race a spawn path in flight.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    mockStat.mockImplementation((dirPath: string) =>
      Promise.resolve({
        mtimeMs: String(dirPath).includes('freshly-spawned-uuid') ? Date.now() : Date.now() - ONE_DAY_MS,
      }),
    );
    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('freshly-spawned-uuid'), dirEntry('stale-session-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    // The genuinely-stale dir is removed...
    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'stale-session-uuid'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    // ...but the freshly written dir is never touched.
    expect(mockRm).not.toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'freshly-spawned-uuid'),
      expect.anything(),
    );
    logSpy.mockRestore();
  });

  it('still deletes an unreferenced session directory older than the grace period', async () => {
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    // mtime defaults to one day old (beforeEach), so this orphan is past the grace period.
    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('old-orphan-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'old-orphan-uuid'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    logSpy.mockRestore();
  });

  it('skips a directory whose stat fails (removed between readdir and stat) and keeps sweeping the rest of the batch', async () => {
    // A single-entry batch would pass this test identically whether the catch
    // block does `continue` (correct) or aborts the whole sweep (a
    // regression), since there'd be nothing left afterward to prove the loop
    // kept going. Put a genuine, stat-resolvable orphan AFTER the
    // stat-failing entry so an early return/break would leave it un-removed
    // and fail the second assertion below.
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    mockStat.mockImplementation((dirPath: string) =>
      String(dirPath).includes('vanished-uuid')
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve({ mtimeMs: Date.now() - ONE_DAY_MS }),
    );
    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('vanished-uuid'), dirEntry('surviving-orphan-uuid')],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);
    await runWithTimers();

    // The vanished dir is never removed and the failure is logged...
    expect(mockRm).not.toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'vanished-uuid'),
      expect.anything(),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stat failed'));
    // ...but the sweep keeps going and still removes the later genuine orphan.
    expect(mockRm).toHaveBeenCalledWith(
      path.join(SESSIONS_DIR, 'surviving-orphan-uuid'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('retries rm on EPERM then succeeds', async () => {
    vi.useRealTimers(); // Retry delays need real timers since function is awaited
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('eperm-dir')],
    });

    let rmCount = 0;
    mockRm.mockImplementation(() => {
      rmCount++;
      if (rmCount < 2) return Promise.reject(new Error('EPERM'));
      return Promise.resolve();
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);

    expect(mockRm).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs warning when all retries fail', async () => {
    vi.useRealTimers(); // Retry delays need real timers since function is awaited
    const taskRepo = makeMockTaskRepo([]);
    const sessionRepo = makeMockSessionRepo();
    const sessionManager = makeMockSessionManager();

    setupReaddir({
      [SESSIONS_DIR]: [dirEntry('locked-dir')],
    });
    mockRm.mockRejectedValue(new Error('EPERM'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pruneOrphanedDirectories(ownershipOf(PROJECT), taskRepo, sessionRepo, sessionManager);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove orphaned session directory: locked-dir'),
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
