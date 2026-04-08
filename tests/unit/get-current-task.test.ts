import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Task, Swimlane } from '../../src/shared/types';

const taskFixtures: Task[] = [];
const swimlaneFixtures: Swimlane[] = [];

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class TaskRepository {
    list(swimlaneId: string) {
      return taskFixtures.filter((task) => task.swimlane_id === swimlaneId && !task.archived_at);
    }
    listArchived() {
      return taskFixtures.filter((task) => task.archived_at !== null);
    }
  }
  return { TaskRepository };
});

vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  listActiveSwimlanes: () => swimlaneFixtures,
}));

import { handleGetCurrentTask } from '../../src/main/agent/commands/search-commands';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-uuid',
    display_id: 1,
    title: 'Test task',
    description: '',
    swimlane_id: 'swimlane-1',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    attachment_count: 0,
    ...overrides,
  } as Task;
}

function makeSwimlane(id: string, name: string): Swimlane {
  return {
    id,
    name,
    position: 0,
    color: '#000',
    icon: null,
    role: 'custom',
    is_archived: false,
    auto_spawn: false,
    auto_command: null,
    agent_override: null,
    permission_mode: null,
    handoff_context: null,
    plan_exit_target_column: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Swimlane;
}

const context: CommandContext = {
  getProjectDb: () => ({}) as never,
  getProjectPath: () => '/projects/example',
  onTaskCreated: vi.fn(),
  onTaskUpdated: vi.fn(),
  onTaskDeleted: vi.fn(),
  onBacklogChanged: vi.fn(),
  onLabelColorsChanged: vi.fn(),
};

beforeEach(() => {
  taskFixtures.length = 0;
  swimlaneFixtures.length = 0;
  swimlaneFixtures.push(makeSwimlane('swimlane-1', 'In Progress'));
});

describe('handleGetCurrentTask', () => {
  it('returns error when neither cwd nor branch is provided', () => {
    const result = handleGetCurrentTask({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cwd');
    expect(result.error).toContain('branch');
  });

  it('matches by exact worktree_path (forward slashes)', () => {
    taskFixtures.push(makeTask({
      id: 'task-a',
      display_id: 42,
      title: 'Add MCP tool',
      worktree_path: '/projects/example/.kangentic/worktrees/add-mcp-tool',
    }));

    const result = handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/add-mcp-tool' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect((result.data as { id: string }).id).toBe('task-a');
    expect((result.data as { displayId: number }).displayId).toBe(42);
  });

  it('matches by worktree slug when cwd is a subdirectory inside the worktree', () => {
    taskFixtures.push(makeTask({
      id: 'task-b',
      display_id: 7,
      worktree_path: '/projects/example/.kangentic/worktrees/cool-feature-abc123',
    }));

    const result = handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/cool-feature-abc123/src/main' },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-b');
  });

  it('normalizes Windows backslash paths', () => {
    taskFixtures.push(makeTask({
      id: 'task-c',
      worktree_path: 'C:/Users/dev/repo/.kangentic/worktrees/branch-slug',
    }));

    const result = handleGetCurrentTask(
      { cwd: 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\branch-slug' },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-c');
  });

  it('matches by branch name (case-insensitive)', () => {
    taskFixtures.push(makeTask({
      id: 'task-d',
      branch_name: 'feature/MCP-Tool',
    }));

    const result = handleGetCurrentTask({ branch: 'feature/mcp-tool' }, context);

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-d');
  });

  it('returns null data when no task matches', () => {
    taskFixtures.push(makeTask({
      id: 'task-e',
      worktree_path: '/projects/example/.kangentic/worktrees/other-slug',
    }));

    const result = handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/missing-slug' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
    expect(result.message).toContain('No task found');
  });

  it('returns array when multiple tasks match', () => {
    taskFixtures.push(makeTask({
      id: 'task-f1',
      branch_name: 'shared-branch',
      worktree_path: '/projects/example/.kangentic/worktrees/slug-one',
    }));
    taskFixtures.push(makeTask({
      id: 'task-f2',
      display_id: 2,
      branch_name: 'shared-branch',
      worktree_path: '/projects/example/.kangentic/worktrees/slug-two',
    }));

    const result = handleGetCurrentTask({ branch: 'shared-branch' }, context);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
    expect(result.message).toContain('Ambiguous');
  });

  it('does not match when worktree_path is null even if branch matches partially', () => {
    taskFixtures.push(makeTask({
      id: 'task-g',
      worktree_path: null,
      branch_name: 'main',
    }));

    const result = handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/something' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('finds archived tasks', () => {
    taskFixtures.push(makeTask({
      id: 'task-h',
      branch_name: 'archived-branch',
      archived_at: '2026-03-01T00:00:00Z',
    }));

    const result = handleGetCurrentTask({ branch: 'archived-branch' }, context);

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-h');
    expect((result.data as { status: string }).status).toBe('completed');
    expect((result.data as { column: string }).column).toBe('Done');
  });
});
