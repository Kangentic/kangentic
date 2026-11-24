/**
 * The orphan sweep refuses to clear most of a folder, and reports that refusal to
 * Sentry. The sweep runs at every project open, and a refusal repeats on each one
 * until the folder changes, so the report goes out once per folder kind per run.
 * Without that latch one wrong-database folder files an event on every open.
 *
 * Runs the real sweep on a real folder. Only the reporter is replaced.
 *
 * Tier: Unit. Nothing Electron-specific is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockReportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mockReportHandledError,
}));

import { pruneOrphanedDirectories, resetSweepRefusalReports } from '../../src/main/transition-engine/resource-cleanup';
import { ownershipOf } from './helpers/verified-ownership';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_NAMES = ['a', 'b', 'c', 'd', 'e'];

let workspace: string;
let projectPath: string;

/** Five old folders under `.kangentic/<kind>`: no row names any, so all five are orphans of five. */
function populate(kind: 'tasks' | 'worktrees' | 'sessions', ageMs = ONE_DAY_MS): void {
  for (const name of ORPHAN_NAMES) {
    const folder = path.join(projectPath, '.kangentic', kind, name);
    fs.mkdirSync(folder, { recursive: true });
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(folder, past, past);
  }
}

/** Rows that name nothing on disk, as many as asked for, half of them archived. */
function sweep(taskCount = 0): Promise<void> {
  const rows = Array.from({ length: taskCount }, (_value, index) => ({ id: `row-${index}`, worktree_path: null, session_id: null }));
  const archivedCount = Math.floor(taskCount / 2);
  const noTasks = { list: () => rows.slice(archivedCount), listArchived: () => rows.slice(0, archivedCount) };
  const noSessions = { listAllSessionIds: () => [] };
  const noLiveSessions = { listSessions: () => [] };
  return pruneOrphanedDirectories(
    ownershipOf(projectPath),
    noTasks as never,
    noSessions as never,
    noLiveSessions as never,
  );
}

function reportedFolders(): string[] {
  return mockReportHandledError.mock.calls.map((call) => (call[1] as { folder: string }).folder);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-sweep-report-'));
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(path.join(projectPath, '.kangentic'), { recursive: true });
  mockReportHandledError.mockClear();
  resetSweepRefusalReports();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the refused orphan sweep report', () => {
  it('reports a refused folder once, however many project opens repeat the refusal', async () => {
    populate('tasks');

    await sweep();
    await sweep();
    await sweep();

    expect(reportedFolders()).toEqual(['task']);
    for (const name of ORPHAN_NAMES) expect(fs.existsSync(path.join(projectPath, '.kangentic', 'tasks', name))).toBe(true);
  });

  it('keeps one report per folder kind, so a second refused kind is not swallowed by the first', async () => {
    populate('tasks');
    populate('worktrees');

    await sweep();
    await sweep();

    expect([...reportedFolders()].sort()).toEqual(['task', 'worktree']);
  });

  it('reports again after the latch is reset, which is a new run', async () => {
    populate('tasks');

    await sweep();
    resetSweepRefusalReports();
    await sweep();

    expect(reportedFolders()).toEqual(['task', 'task']);
  });

  // Sentry DESKTOP-50 could not say which: a wrong database that passed the
  // ownership check, or leftovers of the right one.
  describe('what separates a wrong database from leftovers', () => {
    const HOUR_MS = 60 * 60 * 1000;

    function reportedSweep(): Record<string, unknown> {
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      return (mockReportHandledError.mock.calls[0][2] as { orphan_sweep: Record<string, unknown> }).orphan_sweep;
    }

    it.each<[number, string]>([
      [0.5 * HOUR_MS, '<1h'],
      [2 * HOUR_MS, '1-24h'],
      [23 * HOUR_MS, '1-24h'],
      [25 * HOUR_MS, '1-7d'],
      [8 * ONE_DAY_MS, '7-30d'],
      [31 * ONE_DAY_MS, '>30d'],
    ])('buckets orphans %d ms old', async (ageMs, bucket) => {
      populate('tasks', ageMs);
      await sweep();
      expect(reportedSweep()).toEqual({ orphans: 5, directories: 5, newest_orphan_age: bucket, tasks: '0' });
    });

    it('takes the age from the newest orphan, not the oldest', async () => {
      populate('tasks', 40 * ONE_DAY_MS);
      const newer = new Date(Date.now() - 2 * HOUR_MS);
      fs.utimesSync(path.join(projectPath, '.kangentic', 'tasks', 'c'), newer, newer);
      await sweep();
      expect(reportedSweep().newest_orphan_age).toBe('1-24h');
    });

    it.each<[number, string]>([
      [0, '0'], [1, '1-4'], [4, '1-4'], [5, '5-19'], [19, '5-19'], [20, '20-99'], [99, '20-99'], [100, '>=100'],
    ])('buckets a database of %d tasks, archived ones included', async (taskCount, bucket) => {
      populate('tasks');
      await sweep(taskCount);
      expect(reportedSweep().tasks).toBe(bucket);
    });

    // Each folder kind reads the same count, archived rows included.
    it.each<['tasks' | 'worktrees' | 'sessions', string]>([
      ['worktrees', 'worktree'],
      ['sessions', 'session'],
      ['tasks', 'task'],
    ])('buckets the %s folder by the database\'s tasks too', async (kind, folder) => {
      populate(kind);
      await sweep(7);
      expect(reportedFolders()).toEqual([folder]);
      expect(reportedSweep().tasks).toBe('5-19');
    });

    it('keeps both out of the tags and the grouping', async () => {
      populate('tasks');
      await sweep(3);
      const [, tags, , fingerprint] = mockReportHandledError.mock.calls[0];
      expect(tags).toEqual({ source: 'orphan_sweep_refused', folder: 'task' });
      expect(fingerprint).toEqual(['orphan-sweep-refused', 'task']);
    });
  });
});
