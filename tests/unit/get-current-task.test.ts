import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext, TaskKnowledgeRead } from '../../src/main/agent/commands/types';
import type { TaskKnowledge } from '../../src/main/retrieval/task-knowledge';
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
  };
}

function makeSwimlane(id: string, name: string, role: Swimlane['role'] = null): Swimlane {
  return {
    id,
    name,
    role,
    position: 0,
    color: '#000',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    created_at: '2026-01-01T00:00:00Z',
  };
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
  it('returns error when neither cwd nor branch is provided', async () => {
    const result = await handleGetCurrentTask({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cwd');
    expect(result.error).toContain('branch');
  });

  it('matches by exact worktree_path (forward slashes)', async () => {
    taskFixtures.push(makeTask({
      id: 'task-a',
      display_id: 42,
      title: 'Add MCP tool',
      worktree_path: '/projects/example/.kangentic/worktrees/add-mcp-tool',
    }));

    const result = await handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/add-mcp-tool' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect((result.data as { id: string }).id).toBe('task-a');
    expect((result.data as { displayId: number }).displayId).toBe(42);
  });

  it('matches by worktree slug when cwd is a subdirectory inside the worktree', async () => {
    taskFixtures.push(makeTask({
      id: 'task-b',
      display_id: 7,
      worktree_path: '/projects/example/.kangentic/worktrees/cool-feature-abc123',
    }));

    const result = await handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/cool-feature-abc123/src/main' },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-b');
  });

  it('normalizes Windows backslash paths', async () => {
    taskFixtures.push(makeTask({
      id: 'task-c',
      worktree_path: 'C:/Users/dev/repo/.kangentic/worktrees/branch-slug',
    }));

    const result = await handleGetCurrentTask(
      { cwd: 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\branch-slug' },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-c');
  });

  it('matches by branch name (case-insensitive)', async () => {
    taskFixtures.push(makeTask({
      id: 'task-d',
      branch_name: 'feature/MCP-Tool',
    }));

    const result = await handleGetCurrentTask({ branch: 'feature/mcp-tool' }, context);

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-d');
  });

  it('returns null data when no task matches', async () => {
    taskFixtures.push(makeTask({
      id: 'task-e',
      worktree_path: '/projects/example/.kangentic/worktrees/other-slug',
    }));

    const result = await handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/missing-slug' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
    expect(result.message).toContain('No task found');
  });

  it('returns array when multiple tasks match', async () => {
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

    const result = await handleGetCurrentTask({ branch: 'shared-branch' }, context);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
    expect(result.message).toContain('Ambiguous');
  });

  it('does not match when worktree_path is null even if branch matches partially', async () => {
    taskFixtures.push(makeTask({
      id: 'task-g',
      worktree_path: null,
      branch_name: 'main',
    }));

    const result = await handleGetCurrentTask(
      { cwd: '/projects/example/.kangentic/worktrees/something' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('finds archived tasks', async () => {
    taskFixtures.push(makeTask({
      id: 'task-h',
      branch_name: 'archived-branch',
      archived_at: '2026-03-01T00:00:00Z',
    }));

    const result = await handleGetCurrentTask({ branch: 'archived-branch' }, context);

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('task-h');
    expect((result.data as { status: string }).status).toBe('completed');
    expect((result.data as { column: string }).column).toBe('Done');
  });
});

describe('handleGetCurrentTask - the message the agent reads', () => {
  const WORKTREE = '/projects/example/.kangentic/worktrees/add-mcp-tool';
  const COMMIT_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

  function knowledge(overrides: Partial<TaskKnowledge> = {}): TaskKnowledge {
    return { summary: null, commits: [], commitCount: 0, changedFiles: [], changedFileCount: 0, ...overrides };
  }

  /** A context whose Knowledge Graph reader answers `byTask`, recording what it was asked. */
  function contextReading(byTask: Map<string, TaskKnowledge>, summariesOn = true) {
    const readTaskKnowledge = vi.fn((): TaskKnowledgeRead => ({ indexOn: true, summariesOn, byTask }));
    return { context: { ...context, readTaskKnowledge } as CommandContext, readTaskKnowledge };
  }

  function makeWorkingTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      id: 'task-a',
      display_id: 42,
      title: 'Add MCP tool',
      branch_name: 'feature/add-mcp-tool',
      base_branch: 'main',
      worktree_path: WORKTREE,
      ...overrides,
    });
  }

  it('prints the task line find_task prints, so the agent sees branch, base, worktree, PR and ids', async () => {
    taskFixtures.push(makeWorkingTask({ pr_url: 'https://example.com/pull/12' }));

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, context);

    expect(result.message).toBe([
      'Current task:',
      `- "Add MCP tool" [In Progress] | branch: feature/add-mcp-tool | base: main | worktree: ${WORKTREE} | PR: https://example.com/pull/12 | #42, id: task-a`,
    ].join('\n'));
  });

  it('names the pull request by number when it has no url, and leaves out what the task lacks', async () => {
    taskFixtures.push(makeTask({ id: 'task-a', display_id: 3, title: 'Bare task', branch_name: 'bare', pr_number: 12 }));

    const result = await handleGetCurrentTask({ branch: 'bare' }, context);

    expect(result.message).toBe('Current task:\n- "Bare task" [In Progress] | branch: bare | PR #12 | #3, id: task-a');
  });

  it('adds the commits and changed files under an unfinished task, and no summary line', async () => {
    taskFixtures.push(makeWorkingTask());
    const { context: reading, readTaskKnowledge } = contextReading(new Map([[
      'task-a',
      knowledge({
        summary: { text: 'A stale summary.', writtenAt: '2026-08-01T00:00:00.000Z' },
        commits: [{ sha: COMMIT_SHA, subject: 'fix(relay): back off (PR 812)', committedAt: '2026-09-19T10:00:00.000Z' }],
        commitCount: 1,
        changedFiles: ['src/a.ts', 'src/b.ts'],
        changedFileCount: 2,
      }),
    ]]));

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, reading);

    expect(readTaskKnowledge).toHaveBeenCalledWith(['task-a']);
    const lines = (result.message ?? '').split('\n');
    expect(lines.slice(2)).toEqual([
      '  commits linked by subject (1, newest first): a1b2c3d4e5 2026-09-19 fix(relay): back off (PR 812)',
      '  changed files (2, most-changed first): src/a.ts, src/b.ts',
    ]);
  });

  it('adds the summary, or says there is none, under a task in a Done column', async () => {
    swimlaneFixtures.push(makeSwimlane('swimlane-done', 'Done', 'done'));
    taskFixtures.push(makeWorkingTask({ swimlane_id: 'swimlane-done' }));
    const written = contextReading(new Map([[
      'task-a',
      knowledge({ summary: { text: 'Added the MCP tool.', writtenAt: '2026-09-20T18:30:00.000Z' } }),
    ]]));
    expect((await handleGetCurrentTask({ cwd: WORKTREE }, written.context)).message).toContain(
      '\n  summary (2026-09-20): Added the MCP tool.\n  commits: none linked to this task',
    );

    const notYet = contextReading(new Map([['task-a', knowledge()]]));
    expect((await handleGetCurrentTask({ cwd: WORKTREE }, notYet.context)).message).toContain('\n  summary: not written yet');

    const off = contextReading(new Map([['task-a', knowledge()]]), false);
    expect((await handleGetCurrentTask({ cwd: WORKTREE }, off.context)).message).toContain(
      '\n  summary: none written (Task summaries are switched off in Settings > Knowledge Graph)',
    );
  });

  it('counts an archived task as finished, and names its column Done', async () => {
    taskFixtures.push(makeWorkingTask({ archived_at: '2026-09-01T00:00:00.000Z' }));
    const { context: reading } = contextReading(new Map([['task-a', knowledge()]]));

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, reading);

    expect(result.message).toContain('- "Add MCP tool" [Done] |');
    expect(result.message).toContain('\n  summary: not written yet');
  });

  it('hands the same knowledge back in data, for a caller that reads the object', async () => {
    taskFixtures.push(makeWorkingTask());
    const taskKnowledge = knowledge({ changedFiles: ['src/a.ts'], changedFileCount: 1 });
    const { context: reading } = contextReading(new Map([['task-a', taskKnowledge]]));

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, reading);

    expect((result.data as { knowledge: TaskKnowledge | null }).knowledge).toBe(taskKnowledge);
  });

  it('says the index is off and prints no knowledge lines when the reader reports it off', async () => {
    taskFixtures.push(makeWorkingTask({ archived_at: '2026-09-01T00:00:00.000Z' }));
    const off = { ...context, readTaskKnowledge: vi.fn((): TaskKnowledgeRead => ({ indexOn: false })) } as CommandContext;

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, off);

    expect(result.message).toContain('Current task:\n- "Add MCP tool" [Done] |');
    expect(result.message).toContain(
      '\nThe Knowledge Graph index is off (Settings > Knowledge Graph), so no summary, linked commits or changed files are shown.',
    );
    expect(result.message).not.toContain('summary:');
    expect((result.data as { knowledge: unknown }).knowledge).toBeNull();
  });

  it('lists every candidate with its own block when the match is ambiguous', async () => {
    taskFixtures.push(makeTask({ id: 'task-f1', display_id: 1, title: 'First', branch_name: 'shared-branch' }));
    taskFixtures.push(makeTask({ id: 'task-f2', display_id: 2, title: 'Second', branch_name: 'shared-branch' }));
    const { context: reading, readTaskKnowledge } = contextReading(new Map([
      ['task-f1', knowledge({ changedFiles: ['src/one.ts'], changedFileCount: 1 })],
      ['task-f2', knowledge({ changedFiles: ['src/two.ts'], changedFileCount: 1 })],
    ]));

    const result = await handleGetCurrentTask({ branch: 'shared-branch' }, reading);

    expect(readTaskKnowledge).toHaveBeenCalledWith(['task-f1', 'task-f2']);
    expect(result.message).toBe([
      'Ambiguous: 2 tasks match the current context. Disambiguate with displayId.',
      '- "First" [In Progress] | branch: shared-branch | #1, id: task-f1',
      '  changed files (1, most-changed first): src/one.ts',
      '- "Second" [In Progress] | branch: shared-branch | #2, id: task-f2',
      '  changed files (1, most-changed first): src/two.ts',
    ].join('\n'));
    const data = result.data as Array<{ id: string; knowledge: TaskKnowledge | null }>;
    expect(data.map((entry) => [entry.id, entry.knowledge?.changedFiles])).toEqual([
      ['task-f1', ['src/one.ts']],
      ['task-f2', ['src/two.ts']],
    ]);
  });

  it('prints no knowledge lines and no notes when the context has no reader', async () => {
    swimlaneFixtures.push(makeSwimlane('swimlane-done', 'Done', 'done'));
    taskFixtures.push(makeWorkingTask({ swimlane_id: 'swimlane-done' }));

    const result = await handleGetCurrentTask({ cwd: WORKTREE }, context);

    expect((result.message ?? '').split('\n')).toHaveLength(2);
    expect(result.message).not.toContain('summary');
    expect(result.message).not.toContain('Knowledge Graph');
    expect((result.data as { knowledge: unknown }).knowledge).toBeNull();
  });
});
