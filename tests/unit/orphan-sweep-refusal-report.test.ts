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
function populate(kind: 'tasks' | 'worktrees'): void {
  for (const name of ORPHAN_NAMES) {
    const folder = path.join(projectPath, '.kangentic', kind, name);
    fs.mkdirSync(folder, { recursive: true });
    const past = new Date(Date.now() - ONE_DAY_MS);
    fs.utimesSync(folder, past, past);
  }
}

function sweep(): Promise<void> {
  const noTasks = { list: () => [], listArchived: () => [] };
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
});
