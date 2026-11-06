/**
 * What `kangentic_get_current_task` and `kangentic_find_task` tell an agent working on a host. The row holds this
 * computer's stand-in, and `message` is the only text the agent reads (`callHandler`), so the host's path has to
 * be in it, and a host `cwd` has to find its task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Swimlane, Task } from '../../src/shared/types';
import { HOST_PROJECT, HOST_WORKTREE, remoteContextFields, SHELL_FOLDER, STAND_IN_WORKTREE } from './helpers/remote-project-fixture';

const taskFixtures: Task[] = [];

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class TaskRepository {
    list() {
      return taskFixtures.filter((task) => !task.archived_at);
    }
    listArchived() {
      return taskFixtures.filter((task) => task.archived_at !== null);
    }
  }
  return { TaskRepository };
});
vi.mock('../../src/main/db/repositories/backlog-repository', () => {
  class BacklogRepository {
    list() { return []; }
    getById() { return undefined; }
  }
  return { BacklogRepository };
});
vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  listActiveSwimlanes: () => [{ id: 'lane', name: 'Executing', role: null } as Swimlane],
}));

import { handleFindTask, handleGetCurrentTask } from '../../src/main/agent/commands/search-commands';

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-12', display_id: 12, title: 'Remote task', description: '', swimlane_id: 'lane', position: 0, agent: null,
    session_id: null, worktree_path: STAND_IN_WORKTREE, branch_name: 'feature/remote', pr_number: null, pr_url: null,
    base_branch: 'main', use_worktree: null, labels: [], priority: 0, archived_at: null, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', attachment_count: 0, ...overrides,
  } as Task;
}

const context = { getProjectDb: () => ({}) as never, ...remoteContextFields } as unknown as CommandContext;

function dataOf(result: { data?: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

beforeEach(() => {
  taskFixtures.length = 0;
});

describe('kangentic_get_current_task on a remote project', () => {
  it('tells the agent the host path in the text it reads, never the stand-in', async () => {
    taskFixtures.push(task({}));

    const result = await handleGetCurrentTask({ cwd: HOST_WORKTREE }, context);

    expect(result.message).toContain(`worktree: ${HOST_WORKTREE} (on the host)`);
    expect(result.message).not.toContain(SHELL_FOLDER);
    expect(result.message).not.toContain('remote-projects');
  });

  it('labels the values in data, with the stand-in under a local field', async () => {
    taskFixtures.push(task({}));

    const data = dataOf(await handleGetCurrentTask({ cwd: HOST_WORKTREE }, context));

    expect(data).toMatchObject({ worktreePath: HOST_WORKTREE, localWorktreePath: STAND_IN_WORKTREE, location: 'host' });
  });

  it('finds the task from a host cwd by its full path, not the slug fallback', async () => {
    // A folder name no slug compare can match: only the mapped full path finds it.
    taskFixtures.push(task({ worktree_path: `${SHELL_FOLDER}/not-under-kangentic` }));

    const result = await handleGetCurrentTask({ cwd: `${HOST_PROJECT}/not-under-kangentic` }, context);

    expect(result.message).toContain('Remote task');
  });

  it('still finds a task from a cwd that a symlinked home spells differently', async () => {
    taskFixtures.push(task({}));

    const result = await handleGetCurrentTask({ cwd: '/data/home/dev/proj/.kangentic/worktrees/12' }, context);

    expect(result.message).toContain('Remote task');
  });

  it('finds a task with no worktree from the project folder when it is the only one with a session', async () => {
    taskFixtures.push(task({ id: 'no-worktree', worktree_path: null, branch_name: null, session_id: 'session-1' }));
    taskFixtures.push(task({ id: 'idle', worktree_path: null, branch_name: null }));

    const result = await handleGetCurrentTask({ cwd: HOST_PROJECT }, context);

    expect(dataOf(result).id).toBe('no-worktree');
  });

  it('answers nothing from the project folder when two tasks there have sessions and no caller says which', async () => {
    taskFixtures.push(task({ id: 'one', worktree_path: null, branch_name: null, session_id: 'session-1' }));
    taskFixtures.push(task({ id: 'two', worktree_path: null, branch_name: null, session_id: 'session-2' }));

    const result = await handleGetCurrentTask({ cwd: HOST_PROJECT }, context);

    expect(result.message).toBe('No task found for current context.');
  });

  it('settles two such tasks by the caller', async () => {
    taskFixtures.push(task({ id: 'one', worktree_path: null, branch_name: null, session_id: 'session-1' }));
    taskFixtures.push(task({ id: 'two', worktree_path: null, branch_name: null, session_id: 'session-2' }));

    const result = await handleGetCurrentTask({ cwd: HOST_PROJECT }, { ...context, callerTaskId: 'two' });

    expect(dataOf(result).id).toBe('two');
    // The project folder was named and is where the caller works, so nothing was missed to explain.
    expect(result.message).not.toContain('No task matches');
  });

  describe('a name that matches no task', () => {
    const NOTE = 'No task matches the cwd or branch you named, so this is your own task.';

    it('answers with the caller\'s own task and says the name matched nothing, for a branch', async () => {
      taskFixtures.push(task({}));

      const result = await handleGetCurrentTask({ branch: 'no/such-branch' }, { ...context, callerTaskId: 'task-12' });

      expect(dataOf(result).id).toBe('task-12');
      expect(result.message?.startsWith(NOTE)).toBe(true);
    });

    it('says so for a cwd too', async () => {
      taskFixtures.push(task({}));

      const result = await handleGetCurrentTask({ cwd: '/somewhere/else/entirely' }, { ...context, callerTaskId: 'task-12' });

      expect(dataOf(result).id).toBe('task-12');
      expect(result.message?.startsWith(NOTE)).toBe(true);
    });

    it('says nothing when the caller named nothing', async () => {
      taskFixtures.push(task({}));

      const result = await handleGetCurrentTask({}, { ...context, callerTaskId: 'task-12' });

      expect(dataOf(result).id).toBe('task-12');
      expect(result.message).not.toContain('No task matches');
    });

    it('stays "No task found" for an unmatched name with no caller', async () => {
      taskFixtures.push(task({}));

      const byCwd = await handleGetCurrentTask({ cwd: '/somewhere/else/entirely' }, context);
      const byBranch = await handleGetCurrentTask({ branch: 'no/such-branch' }, context);

      expect(byCwd.message).toBe('No task found for current context.');
      expect(byBranch.message).toBe('No task found for current context.');
    });
  });

  it('answers with the caller\'s own task when asked nothing', async () => {
    taskFixtures.push(task({}));

    const result = await handleGetCurrentTask({}, { ...context, callerTaskId: 'task-12' });

    expect(dataOf(result).id).toBe('task-12');
  });

  it('lets a named cwd beat the caller, so an agent can ask about another task\'s worktree', async () => {
    taskFixtures.push(task({}));
    taskFixtures.push(task({ id: 'mine', worktree_path: `${SHELL_FOLDER}/.kangentic/worktrees/13`, branch_name: 'mine' }));

    const result = await handleGetCurrentTask({ cwd: HOST_WORKTREE }, { ...context, callerTaskId: 'mine' });

    expect(dataOf(result).id).toBe('task-12');
  });
});

describe('kangentic_find_task on a remote project', () => {
  it('prints and returns the host path', async () => {
    taskFixtures.push(task({}));

    const result = await handleFindTask({ displayId: 12 }, context);
    const data = result.data as { tasks: Array<Record<string, unknown>> };

    expect(result.message).toContain(`worktree: ${HOST_WORKTREE} (on the host)`);
    expect(result.message).not.toContain(SHELL_FOLDER);
    expect(data.tasks[0]).toMatchObject({ worktreePath: HOST_WORKTREE, localWorktreePath: STAND_IN_WORKTREE, location: 'host' });
  });
});

describe('a project on this computer', () => {
  const localContext = { getProjectDb: () => ({}) as never, getProjectPath: () => '/projects/example' } as unknown as CommandContext;

  it('keeps its message byte for byte, says local in data, and adds no local field', async () => {
    taskFixtures.push(task({ worktree_path: '/projects/example/.kangentic/worktrees/12' }));

    const result = await handleGetCurrentTask({ cwd: '/projects/example/.kangentic/worktrees/12' }, localContext);

    expect(result.message).toContain('worktree: /projects/example/.kangentic/worktrees/12 | ');
    expect(result.message).not.toContain('on the host');
    const data = dataOf(result);
    expect(data).toMatchObject({ worktreePath: '/projects/example/.kangentic/worktrees/12', location: 'local' });
    expect(data).not.toHaveProperty('localWorktreePath');
  });
});
