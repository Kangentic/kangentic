/**
 * Unit tests for src/main/browser/browser-partition-cleanup.ts.
 *
 * Jars are keyed by task identity, so cleanup is a name-parse plus an existence
 * check. The load-bearing behavior: a jar is reclaimed iff its project or task is
 * gone (or it is from the abandoned pre-task-keying scheme), the sweep ABSTAINS
 * rather than over-deletes on a transient fault (globally on a project-list
 * failure, per-project on a task-read failure), it never touches the legacy
 * shared jar or a foreign directory, and the per-project task read uses a
 * throwaway read-only connection. The DB and project repo are mocked; the
 * partition-name helpers are the real pure implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import {
  browserPartitionForProjectIdentity,
  browserPartitionForTask,
  partitionDirName,
} from '../../src/shared/browser-partition';

const {
  mockExistsSync,
  mockReaddirSync,
  mockReaddir,
  mockStat,
  mockRemoveWithRetry,
  mockProjectList,
  mockTaskRows,
  mockDbThrows,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => true),
  mockReaddirSync: vi.fn((): { name: string; isDirectory: () => boolean }[] => []),
  mockReaddir: vi.fn((): Promise<{ name: string; isDirectory: () => boolean }[]> => Promise.resolve([])),
  mockStat: vi.fn((): Promise<{ mtimeMs: number }> => Promise.resolve({ mtimeMs: 0 })),
  mockRemoveWithRetry: vi.fn((): Promise<void> => Promise.resolve()),
  mockProjectList: vi.fn((): { id: string; path: string }[] => []),
  mockTaskRows: vi.fn((): { id: string }[] => []),
  mockDbThrows: vi.fn((): boolean => false),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    promises: {
      readdir: (...args: unknown[]) => mockReaddir(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      rm: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock('better-sqlite3', () => ({
  default: class {
    prepare() {
      return { all: () => { if (mockDbThrows()) throw new Error('db read failed'); return mockTaskRows(); } };
    }
    close() { /* no-op */ }
  },
}));

vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: (...args: unknown[]) => mockRemoveWithRetry(...args),
}));

vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class {
    list = () => mockProjectList();
  },
}));

import {
  assertRemovablePartitionPath,
  enumerateProjectPartitions,
  sweepOrphanedBrowserPartitions,
} from '../../src/main/browser/browser-partition-cleanup';

const USER_DATA = '/mock/userData';
const PARTITIONS_ROOT = path.join(USER_DATA, 'Partitions');

const PROJECT = '11111111-1111-1111-1111-111111111111';
const PROJECT_GONE = '99999999-9999-9999-9999-999999999999';
const TASK_LIVE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK_GONE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const identityDir = (p: string) => partitionDirName(browserPartitionForProjectIdentity(p));
const taskDir = (p: string, t: string) => partitionDirName(browserPartitionForTask(p, t));

function dirent(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true };
}

function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue([]);
  mockReaddir.mockResolvedValue([]);
  mockStat.mockResolvedValue({ mtimeMs: 0 }); // epoch: older than the grace period
  mockRemoveWithRetry.mockResolvedValue(undefined);
  mockProjectList.mockReturnValue([{ id: PROJECT, path: '/dev/project' }]);
  mockTaskRows.mockReturnValue([{ id: TASK_LIVE }]);
  mockDbThrows.mockReturnValue(false);
});

// ── enumerateProjectPartitions (clear-storage) ───────────────────────────────

describe('enumerateProjectPartitions', () => {
  it('returns legacy + identity + every on-disk task jar for the project', () => {
    mockReaddirSync.mockReturnValue([
      dirent(taskDir(PROJECT, TASK_LIVE)),
      dirent(identityDir(PROJECT)),
      dirent(taskDir(PROJECT_GONE, TASK_LIVE)), // a different project's jar
      dirent('kngbrowser-abcd1234'), // legacy scheme, not this project
    ]);
    const partitions = enumerateProjectPartitions(PROJECT, USER_DATA);
    expect(partitions).toContain('persist:kangentic-browser');
    expect(partitions).toContain(browserPartitionForProjectIdentity(PROJECT));
    expect(partitions).toContain(browserPartitionForTask(PROJECT, TASK_LIVE));
    expect(partitions).not.toContain(browserPartitionForTask(PROJECT_GONE, TASK_LIVE));
  });

  it('returns only the legacy jar when no project is open', () => {
    expect(enumerateProjectPartitions(null, USER_DATA)).toEqual(['persist:kangentic-browser']);
  });

  it('scans exactly <userDataPath>/Partitions, not a project-relative directory', () => {
    mockReaddirSync.mockReturnValue([]);
    enumerateProjectPartitions(PROJECT, USER_DATA);
    expect(mockReaddirSync).toHaveBeenCalledWith(
      path.join(USER_DATA, 'Partitions'),
      { withFileTypes: true },
    );
  });
});

// ── assertRemovablePartitionPath ─────────────────────────────────────────────

describe('assertRemovablePartitionPath', () => {
  it('accepts a task jar, an identity jar, and a legacy-scheme jar', () => {
    for (const name of [taskDir(PROJECT, TASK_LIVE), identityDir(PROJECT), 'kngbrowser-abcd1234']) {
      expect(() => assertRemovablePartitionPath(PARTITIONS_ROOT, path.join(PARTITIONS_ROOT, name))).not.toThrow();
    }
  });

  it('refuses the root, a traversal, a grandchild, the legacy shared jar, and a foreign dir', () => {
    const cases = [
      PARTITIONS_ROOT,
      path.join(PARTITIONS_ROOT, '..', 'evil'),
      path.join(PARTITIONS_ROOT, taskDir(PROJECT, TASK_LIVE), 'sub'),
      path.join(PARTITIONS_ROOT, 'kangentic-browser'),
      path.join(PARTITIONS_ROOT, 'some-other-consumer'),
    ];
    for (const target of cases) {
      expect(() => assertRemovablePartitionPath(PARTITIONS_ROOT, target)).toThrow();
    }
  });
});

// ── sweepOrphanedBrowserPartitions ───────────────────────────────────────────

describe('sweepOrphanedBrowserPartitions', () => {
  it('removes a task jar whose task is gone, keeps live task and identity jars', async () => {
    silenceConsole();
    mockReaddir.mockResolvedValue([
      dirent(taskDir(PROJECT, TASK_LIVE)),
      dirent(taskDir(PROJECT, TASK_GONE)),
      dirent(identityDir(PROJECT)),
    ]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([taskDir(PROJECT, TASK_GONE)]);
  });

  it('removes every jar of a project that is gone', async () => {
    silenceConsole();
    mockReaddir.mockResolvedValue([
      dirent(taskDir(PROJECT_GONE, TASK_LIVE)),
      dirent(identityDir(PROJECT_GONE)),
    ]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([taskDir(PROJECT_GONE, TASK_LIVE), identityDir(PROJECT_GONE)]);
  });

  it('reclaims an abandoned pre-task-keying jar', async () => {
    silenceConsole();
    mockReaddir.mockResolvedValue([dirent('kngbrowser-abcd1234')]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual(['kngbrowser-abcd1234']);
  });

  it('never touches the legacy shared jar or a foreign directory', async () => {
    silenceConsole();
    mockReaddir.mockResolvedValue([dirent('kangentic-browser'), dirent('some-other-consumer')]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([]);
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
  });

  it('treats a project with no DB file as having no tasks (task jars orphaned, identity kept)', async () => {
    silenceConsole();
    mockExistsSync.mockReturnValue(false); // no project DB file
    mockReaddir.mockResolvedValue([dirent(taskDir(PROJECT, TASK_LIVE)), dirent(identityDir(PROJECT))]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([taskDir(PROJECT, TASK_LIVE)]);
  });

  it('abstains per-project (keeps its task jars) when the task DB read fails', async () => {
    silenceConsole();
    mockDbThrows.mockReturnValue(true);
    mockReaddir.mockResolvedValue([dirent(taskDir(PROJECT, TASK_GONE))]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([]);
  });

  it('abstains entirely when the project list cannot be read', async () => {
    silenceConsole();
    mockProjectList.mockImplementation(() => { throw new Error('db locked'); });
    mockReaddir.mockResolvedValue([dirent(taskDir(PROJECT_GONE, TASK_GONE))]);
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.abstained).toBe(true);
    expect(summary.removed).toEqual([]);
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
  });

  it('skips a jar modified within the grace period', async () => {
    silenceConsole();
    mockReaddir.mockResolvedValue([dirent(taskDir(PROJECT, TASK_GONE))]);
    mockStat.mockResolvedValue({ mtimeMs: Date.now() });
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([]);
    expect(summary.skippedRecent).toBe(1);
  });

  it('skips a jar whose stat fails and keeps sweeping the rest', async () => {
    silenceConsole();
    const first = taskDir(PROJECT, TASK_GONE);
    const second = taskDir(PROJECT_GONE, TASK_LIVE);
    mockReaddir.mockResolvedValue([dirent(first), dirent(second)]);
    mockStat.mockImplementation((target: string) =>
      String(target).includes(first)
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve({ mtimeMs: 0 }),
    );
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([second]);
  });

  it('isolates a per-directory removal failure', async () => {
    silenceConsole();
    const a = taskDir(PROJECT, TASK_GONE);
    const b = taskDir(PROJECT_GONE, TASK_LIVE);
    mockReaddir.mockResolvedValue([dirent(a), dirent(b)]);
    mockRemoveWithRetry.mockRejectedValueOnce(new Error('EBUSY'));
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary.removed).toEqual([b]);
    expect(mockRemoveWithRetry).toHaveBeenCalledTimes(2);
  });

  it('returns an empty summary when the Partitions directory does not exist', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const summary = await sweepOrphanedBrowserPartitions(USER_DATA);
    expect(summary).toEqual({ removed: [], abstained: false, skippedRecent: 0 });
  });
});
