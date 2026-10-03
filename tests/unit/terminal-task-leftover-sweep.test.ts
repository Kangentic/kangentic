/**
 * The startup sweep for terminal tasks (`sweepTerminalTaskLeftovers` in
 * src/main/transition-engine/resource-cleanup.ts): it catches what a terminal
 * transition's own reap missed (a crash or quit between the move and the reap),
 * once per project per app launch, and only for task ids this project's
 * database shows as terminal. It honors the "Stop leftover processes" setting
 * and hands its result to the leftover-process toast under each task's title.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sweepTerminalTaskLeftovers,
  _resetTerminalTaskSweepForTests,
  type LeftoverSweepOptions,
} from '../../src/main/transition-engine/resource-cleanup';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';

const PROJECT_PATH = '/mock/project';

function makeRepos() {
  const taskRepo = {
    // archived-1's Done-move removal failed, so its worktree is still there.
    listArchived: vi.fn(() => [
      { id: 'archived-1', title: 'Fix login', worktree_path: '/mock/project/.kangentic/worktrees/archived-1' },
      { id: 'archived-2', title: 'Update deps', worktree_path: null },
    ]),
    list: vi.fn((swimlaneId?: string) => (swimlaneId === 'lane-todo' ? [{ id: 'todo-1', title: 'Add search' }] : [{ id: 'mid-board-1', title: 'Parked' }])),
  } as unknown as TaskRepository;
  const swimlaneRepo = {
    list: vi.fn(() => [
      { id: 'lane-todo', role: 'todo' },
      { id: 'lane-doing', role: null },
      { id: 'lane-done', role: 'done' },
    ]),
  } as unknown as SwimlaneRepository;
  return { taskRepo, swimlaneRepo };
}

function leftovers(stoppingEnabled = true): LeftoverSweepOptions & { onReport: ReturnType<typeof vi.fn> } {
  return { stoppingEnabled: () => stoppingEnabled, onReport: vi.fn() };
}

beforeEach(() => {
  _resetTerminalTaskSweepForTests();
});

describe('sweepTerminalTaskLeftovers', () => {
  it('reaps archived and To Do tasks, never a task parked mid-board', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const reapTaskProcesses = vi.fn(async () => []);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());

    expect(reapTaskProcesses).toHaveBeenCalledTimes(1);
    const [projectPath, reaped, options] = reapTaskProcesses.mock.calls[0] as unknown as [string, Array<{ id: string; worktreePath: string | null }>, { stop: boolean }];
    expect(projectPath).toBe(PROJECT_PATH);
    const taskIds = reaped.map((task) => task.id);
    expect([...taskIds].sort()).toEqual(['archived-1', 'archived-2', 'todo-1']);
    expect(taskIds).not.toContain('mid-board-1');
    expect(reaped).toContainEqual({ id: 'archived-1', worktreePath: '/mock/project/.kangentic/worktrees/archived-1' });
    expect(options).toEqual({ stop: true });
  });

  it('reports only what it stopped or failed to stop, under each task\'s title', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const stopped: LeftoverProcessEntry = { taskId: 'archived-1', pid: 4001, startKey: 'k1', label: 'node (vite)', outcome: 'stopped', reason: null, place: 'worktree' };
    const failed: LeftoverProcessEntry = { ...stopped, taskId: 'todo-1', pid: 4002, startKey: 'k2', outcome: 'failed' };
    // Reported when its task ended, and still there at every launch.
    const kept: LeftoverProcessEntry = { ...stopped, pid: 4003, startKey: 'k3', label: 'chrome', outcome: 'kept', reason: 'window' };
    const reapTaskProcesses = vi.fn(async () => [stopped, failed, kept]);
    const options = leftovers(true);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, options);

    expect(options.onReport).toHaveBeenCalledTimes(1);
    const [entries, titles, stoppingEnabled] = options.onReport.mock.calls[0] as [LeftoverProcessEntry[], ReadonlyMap<string, string>, boolean];
    expect(entries).toEqual([stopped, failed]);
    expect(titles.get('archived-1')).toBe('Fix login');
    expect(titles.get('todo-1')).toBe('Add search');
    expect(stoppingEnabled).toBe(true);
  });

  it('kills nothing and says nothing when stopping is turned off: every launch would repeat the toast', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const kept: LeftoverProcessEntry = { taskId: 'archived-1', pid: 4001, startKey: 'k', label: 'node (vite)', outcome: 'kept', reason: null, place: 'worktree' };
    const reapTaskProcesses = vi.fn(async () => [kept]);
    const options = leftovers(false);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, options);

    expect((reapTaskProcesses.mock.calls[0] as unknown as [string, unknown, { stop: boolean }])[2]).toEqual({ stop: false });
    expect(options.onReport).not.toHaveBeenCalled();
  });

  it('says nothing when all it found was left running on purpose', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const kept: LeftoverProcessEntry = { taskId: 'archived-1', pid: 4001, startKey: 'k', label: 'tmux', outcome: 'kept', reason: 'multiplexer', place: 'worktree' };
    const reapTaskProcesses = vi.fn(async () => [kept]);
    const options = leftovers(true);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, options);

    expect(options.onReport).not.toHaveBeenCalled();
  });

  it('runs once per project per app launch, not on every project switch', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const reapTaskProcesses = vi.fn(async () => []);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());
    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());
    await sweepTerminalTaskLeftovers('/mock/other-project', taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());

    expect(reapTaskProcesses).toHaveBeenCalledTimes(2);
  });

  it('scans nothing when the project has no terminal task', async () => {
    const taskRepo = { listArchived: vi.fn(() => []), list: vi.fn(() => []) } as unknown as TaskRepository;
    const swimlaneRepo = { list: vi.fn(() => [{ id: 'lane-todo', role: 'todo' }]) } as unknown as SwimlaneRepository;
    const reapTaskProcesses = vi.fn(async () => []);
    const options = leftovers();

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, options);

    expect(reapTaskProcesses).not.toHaveBeenCalled();
    expect(options.onReport).not.toHaveBeenCalled();
  });

  it('never fails the project open when the reap throws', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const reapTaskProcesses = vi.fn(async () => { throw new Error('host gone'); });
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});

    await expect(sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers())).resolves.toBeUndefined();
  });
});
