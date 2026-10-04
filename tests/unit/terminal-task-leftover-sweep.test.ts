/**
 * The startup sweep for terminal tasks (`sweepTerminalTaskLeftovers` in
 * src/main/transition-engine/resource-cleanup.ts): it catches what a terminal
 * transition's own reap missed (a crash or quit between the move and the reap),
 * once per project per app launch, and only for task ids this project's
 * database shows as terminal. It honors the "Stop leftover processes" setting
 * and hands its result to the leftover-process toast under each task's title.
 *
 * It also pins where the sweep sits in the project-open cleanup
 * (`cleanupStaleResourcesAsync` runs it FIRST, because a process holding a
 * worktree as its cwd is what makes the later removal passes fail on Windows),
 * that a failed sweep releases its once-per-launch latch, and that the
 * `cleanupStaleResources` wrapper kills nothing unless its caller passes the
 * setting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sweepTerminalTaskLeftovers,
  cleanupStaleResources,
  cleanupStaleResourcesAsync,
  _resetTerminalTaskSweepForTests,
  type LeftoverSweepOptions,
} from '../../src/main/transition-engine/resource-cleanup';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { SessionManager } from '../../src/main/pty/session-manager';
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

/**
 * Everything `cleanupStaleResourcesAsync` and `cleanupStaleResources` touch, with
 * every pass AFTER the sweep left inert: the To Do lane is empty (a task there
 * would send the backlog pass into `fs` and a real `git rev-parse`) and the Done
 * lane has no tasks. Only the archived task reaches the sweep.
 *
 * The probes exposed here are calls the sweep never makes, so their order
 * against the reap says which pass ran first:
 *  - `list`: the sweep reads the To Do lane (call 0), the backlog pass reads it
 *    again (call 1), and the orphan-directory pass lists with no lane (call 2).
 *  - `listAllInSwimlane`: only the Done-retry pass.
 *  - `listAllSessionIds`: only the orphan-directory pass.
 *  - `markStaleRunsInterrupted`: only the automation-run sweep, the last step.
 */
function makeAsyncTail() {
  const reapTaskProcesses = vi.fn(async (): Promise<LeftoverProcessEntry[]> => []);
  const list = vi.fn((_swimlaneId?: string) => []);
  const listAllInSwimlane = vi.fn((_swimlaneId: string) => []);
  const listAllSessionIds = vi.fn(() => []);
  const markStaleRunsInterrupted = vi.fn(() => 0);
  return {
    reapTaskProcesses,
    list,
    listAllInSwimlane,
    listAllSessionIds,
    markStaleRunsInterrupted,
    taskRepo: {
      listArchived: vi.fn(() => [{ id: 'archived-1', title: 'Fix login', worktree_path: null }]),
      list,
      listAllInSwimlane,
    } as unknown as TaskRepository,
    swimlaneRepo: {
      list: vi.fn(() => [
        { id: 'lane-todo', role: 'todo' },
        { id: 'lane-done', role: 'done' },
      ]),
    } as unknown as SwimlaneRepository,
    sessionRepo: { listAllSessionIds, deleteByTaskId: vi.fn() } as unknown as SessionRepository,
    sessionManager: { reapTaskProcesses, listSessions: vi.fn(() => []) } as unknown as SessionManager,
    automationRunRepo: { markStaleRunsInterrupted, pruneTo: vi.fn() } as unknown as AutomationRunRepository,
  };
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

  it('does not scan, kill or report when stopping is turned off: every launch would repeat the toast', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const kept: LeftoverProcessEntry = { taskId: 'archived-1', pid: 4001, startKey: 'k', label: 'node (vite)', outcome: 'kept', reason: null, place: 'worktree' };
    const reapTaskProcesses = vi.fn(async () => [kept]);
    const options = leftovers(false);

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, options);

    expect(reapTaskProcesses).not.toHaveBeenCalled();
    expect(options.onReport).not.toHaveBeenCalled();

    // Turning stopping on later in the same launch still sweeps on the next open.
    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers(true));
    expect(reapTaskProcesses).toHaveBeenCalledTimes(1);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers())).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('releases its once-per-launch latch when the sweep fails, so the next open of the project sweeps again', async () => {
    const { taskRepo, swimlaneRepo } = makeRepos();
    const reapTaskProcesses = vi.fn(async () => []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(taskRepo.listArchived).mockImplementationOnce(() => { throw new Error('database is locked'); });

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());

    // The first attempt died reading the archive, before it reached the reap.
    expect(reapTaskProcesses).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Startup sweep failed'), expect.any(Error));

    await sweepTerminalTaskLeftovers(PROJECT_PATH, taskRepo, swimlaneRepo, { reapTaskProcesses }, leftovers());

    expect(reapTaskProcesses).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('cleanupStaleResourcesAsync: the sweep comes first', () => {
  it('reaps a terminal task\'s leftovers before the backlog, Done-retry, orphan-directory and automation passes touch anything', async () => {
    const tail = makeAsyncTail();

    await cleanupStaleResourcesAsync(
      PROJECT_PATH, tail.taskRepo, tail.swimlaneRepo, tail.sessionRepo, tail.sessionManager, tail.automationRunRepo, () => {}, leftovers(true),
    );

    expect(tail.reapTaskProcesses).toHaveBeenCalledTimes(1);
    expect(tail.reapTaskProcesses).toHaveBeenCalledWith(PROJECT_PATH, [{ id: 'archived-1', worktreePath: null }], { stop: true });
    const reapOrder = tail.reapTaskProcesses.mock.invocationCallOrder[0];

    // The backlog pass is the first to remove a worktree. Its read of the To Do
    // lane is the second one (the sweep made the first), see makeAsyncTail.
    expect(tail.list.mock.calls[1][0]).toBe('lane-todo');
    expect(reapOrder).toBeLessThan(tail.list.mock.invocationCallOrder[1]);
    // Each later pass makes a call only it makes. Asserting it ran at all keeps
    // the order checks from passing against a tail that never started.
    for (const laterPassCall of [tail.listAllInSwimlane, tail.listAllSessionIds, tail.markStaleRunsInterrupted]) {
      expect(laterPassCall).toHaveBeenCalled();
      expect(reapOrder).toBeLessThan(laterPassCall.mock.invocationCallOrder[0]);
    }
  });

  it('still runs every later pass when the sweep\'s reap throws: a failed sweep never aborts the project open', async () => {
    const tail = makeAsyncTail();
    tail.reapTaskProcesses.mockRejectedValueOnce(new Error('host gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(cleanupStaleResourcesAsync(
      PROJECT_PATH, tail.taskRepo, tail.swimlaneRepo, tail.sessionRepo, tail.sessionManager, tail.automationRunRepo, () => {}, leftovers(true),
    )).resolves.toBeUndefined();

    expect(tail.listAllInSwimlane).toHaveBeenCalled();
    expect(tail.listAllSessionIds).toHaveBeenCalled();
    expect(tail.markStaleRunsInterrupted).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('cleanupStaleResources without its leftovers argument', () => {
  it('never reaps: the default is stopping off, so a caller that forgot the setting kills nothing', async () => {
    const tail = makeAsyncTail();

    await cleanupStaleResources(PROJECT_PATH, tail.taskRepo, tail.swimlaneRepo, tail.sessionRepo, tail.sessionManager, tail.automationRunRepo);

    // The async tail did run (and an archived task was there to sweep), so the
    // missing reap is the default's doing and not a fixture that never got that far.
    expect(tail.listAllInSwimlane).toHaveBeenCalled();
    expect(tail.reapTaskProcesses).not.toHaveBeenCalled();
  });

  it('hands the leftovers it is given on to the sweep', async () => {
    const tail = makeAsyncTail();
    const options = leftovers(true);

    await cleanupStaleResources(PROJECT_PATH, tail.taskRepo, tail.swimlaneRepo, tail.sessionRepo, tail.sessionManager, tail.automationRunRepo, () => {}, options);

    expect(tail.reapTaskProcesses).toHaveBeenCalledTimes(1);
  });
});
