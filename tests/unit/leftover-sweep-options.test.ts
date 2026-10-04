/**
 * `leftoverSweepOptions` (src/main/ipc/helpers/task-cleanup.ts): how the startup
 * sweep reads the "Stop leftover processes" setting and hands its result to the
 * leftover-process toast. The sweep itself is pinned by
 * terminal-task-leftover-sweep.test.ts; this file pins the two closures it is
 * given at project open:
 *  - `stoppingEnabled` is the same reading a transition's reap makes
 *    (`!== false`, so an install that never wrote the key stops processes), and
 *    it is read when the sweep runs, not when the options were built;
 *  - `onReport` publishes to the main window under the project the sweep ran
 *    for, never the ambient current project.
 *
 * The collector module is mocked, so what is asserted is the call the sweep's
 * result becomes, not the timers behind it (leftover-process-reports.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';

const { publishLeftoverProcesses } = vi.hoisted(() => ({ publishLeftoverProcesses: vi.fn() }));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn() }));
vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: vi.fn(async () => ({ branch: null, sha: null })) }));
vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: vi.fn(async () => {}),
  WorktreeManager: class {},
}));
vi.mock('../../src/main/ipc/helpers/leftover-process-reports', () => ({
  leftoverProcessReports: { beginReap: vi.fn(() => () => {}) },
  publishLeftoverProcesses,
}));

import { leftoverSweepOptions } from '../../src/main/ipc/helpers/task-cleanup';
import { sweepTerminalTaskLeftovers, _resetTerminalTaskSweepForTests } from '../../src/main/transition-engine/resource-cleanup';

const SWEPT_PROJECT_PATH = '/mock/swept-project';
// A different project from the one the sweep ran for: the user may have switched
// projects while the sweep was still in flight.
const AMBIENT_PROJECT_PATH = '/mock/ambient-project';
const MAIN_WINDOW = { id: 'main-window' };

function makeContext(config: { stopLeftoverProcesses?: boolean }) {
  const load = vi.fn(() => config);
  const context = {
    configManager: { load },
    mainWindow: MAIN_WINDOW,
    currentProjectPath: AMBIENT_PROJECT_PATH,
  } as unknown as IpcContext;
  return { context, load };
}

function stoppedEntry(taskId: string): LeftoverProcessEntry {
  return { taskId, pid: 4001, startKey: 'k1', label: 'node (vite)', outcome: 'stopped', reason: null, place: 'worktree' };
}

beforeEach(() => {
  publishLeftoverProcesses.mockClear();
  _resetTerminalTaskSweepForTests();
});

describe('leftoverSweepOptions stoppingEnabled', () => {
  it('is false when the user turned "Stop leftover processes" off', () => {
    const { context } = makeContext({ stopLeftoverProcesses: false });
    expect(leftoverSweepOptions(context, SWEPT_PROJECT_PATH).stoppingEnabled()).toBe(false);
  });

  it('is true when the user left it on', () => {
    const { context } = makeContext({ stopLeftoverProcesses: true });
    expect(leftoverSweepOptions(context, SWEPT_PROJECT_PATH).stoppingEnabled()).toBe(true);
  });

  it('is true when the key was never written: an unset setting stops processes, as a transition\'s reap does', () => {
    const { context } = makeContext({});
    expect(leftoverSweepOptions(context, SWEPT_PROJECT_PATH).stoppingEnabled()).toBe(true);
  });

  it('is read when the sweep asks, not when the options were built', () => {
    const { context, load } = makeContext({ stopLeftoverProcesses: true });
    const options = leftoverSweepOptions(context, SWEPT_PROJECT_PATH);
    expect(load).not.toHaveBeenCalled();

    load.mockReturnValue({ stopLeftoverProcesses: false });

    expect(options.stoppingEnabled()).toBe(false);
  });
});

describe('leftoverSweepOptions onReport', () => {
  it('publishes to the main window under the project the sweep ran for, not the current one', () => {
    const { context } = makeContext({});
    const entries = [stoppedEntry('task-a')];
    const titles = new Map([['task-a', 'Fix login']]);

    leftoverSweepOptions(context, SWEPT_PROJECT_PATH).onReport(entries, titles, true);

    expect(publishLeftoverProcesses).toHaveBeenCalledTimes(1);
    expect(publishLeftoverProcesses).toHaveBeenCalledWith(MAIN_WINDOW, entries, titles, true, SWEPT_PROJECT_PATH);
  });

  it('carries the stopping flag the sweep reports with', () => {
    const { context } = makeContext({});

    leftoverSweepOptions(context, SWEPT_PROJECT_PATH).onReport([stoppedEntry('task-a')], new Map(), false);

    expect(publishLeftoverProcesses).toHaveBeenCalledWith(MAIN_WINDOW, expect.anything(), expect.anything(), false, SWEPT_PROJECT_PATH);
  });
});

describe('leftoverSweepOptions with the real startup sweep', () => {
  function makeRepos() {
    const taskRepo = {
      listArchived: vi.fn(() => [{ id: 'task-a', title: 'Fix login', worktree_path: null }]),
      list: vi.fn(() => []),
    } as unknown as TaskRepository;
    const swimlaneRepo = { list: vi.fn(() => [{ id: 'lane-todo', role: 'todo' }]) } as unknown as SwimlaneRepository;
    return { taskRepo, swimlaneRepo };
  }

  it('stops what it finds and publishes it under its task\'s title when the setting is on', async () => {
    const { context } = makeContext({});
    const { taskRepo, swimlaneRepo } = makeRepos();
    const stopped = stoppedEntry('task-a');
    const reapTaskProcesses = vi.fn(async () => [stopped]);

    await sweepTerminalTaskLeftovers(SWEPT_PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftoverSweepOptions(context, SWEPT_PROJECT_PATH));

    expect(reapTaskProcesses).toHaveBeenCalledWith(SWEPT_PROJECT_PATH, [{ id: 'task-a', worktreePath: null }], { stop: true });
    expect(publishLeftoverProcesses).toHaveBeenCalledWith(MAIN_WINDOW, [stopped], new Map([['task-a', 'Fix login']]), true, SWEPT_PROJECT_PATH);
  });

  it('scans nothing and publishes nothing when the setting is off', async () => {
    const { context } = makeContext({ stopLeftoverProcesses: false });
    const { taskRepo, swimlaneRepo } = makeRepos();
    const reapTaskProcesses = vi.fn(async () => [stoppedEntry('task-a')]);

    await sweepTerminalTaskLeftovers(SWEPT_PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftoverSweepOptions(context, SWEPT_PROJECT_PATH));

    expect(reapTaskProcesses).not.toHaveBeenCalled();
    expect(publishLeftoverProcesses).not.toHaveBeenCalled();
  });
});
