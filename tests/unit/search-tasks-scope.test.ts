/**
 * Unit tests for handleSearchTasks scope behavior in
 * src/main/agent/commands/search-commands.ts.
 *
 * The handler unifies board + backlog search behind a single MCP tool
 * (kangentic_search_tasks). The `scope` parameter narrows which surface
 * is searched. Default = "both".
 *
 * Strategy: mock TaskRepository, BacklogRepository, and the column
 * resolver so no compiled better-sqlite3 binary is needed under vitest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before any import under test
// ---------------------------------------------------------------------------

const mockTaskRepoList = vi.fn();
const mockTaskRepoListArchived = vi.fn();
const mockBacklogRepoList = vi.fn();
const mockBacklogRepoGetById = vi.fn();
const mockListActiveSwimlanes = vi.fn();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = mockTaskRepoList;
    listArchived = mockTaskRepoListArchived;
  },
}));

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    list = mockBacklogRepoList;
    getById = mockBacklogRepoGetById;
  },
}));

vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  // Wrap in closure so the const declared below stays valid - vi.mock is hoisted above the const.
  listActiveSwimlanes: (...args: unknown[]) => mockListActiveSwimlanes(...args),
  resolveColumn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleSearchTasks, handleFindTask } from '../../src/main/agent/commands/search-commands';
import type { CommandContext, TaskKnowledgeRead } from '../../src/main/agent/commands/types';
import type { TaskKnowledge } from '../../src/main/retrieval/task-knowledge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => '/mock/project'),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
  };
}

const SWIMLANE_TODO = { id: 'lane-todo', name: 'To Do' };

const TASK_ALPHA_ACTIVE = {
  id: 'task-alpha',
  display_id: 1,
  title: 'alpha-search board task',
  description: 'on the board',
  swimlane_id: 'lane-todo',
  archived_at: null,
  labels: ['mcp', 'dx'],
};

const TASK_BETA_ARCHIVED = {
  id: 'task-beta',
  display_id: 2,
  title: 'beta unrelated',
  description: 'alpha-search shows up only in body',
  swimlane_id: 'lane-done',
  archived_at: '2026-04-15T00:00:00Z',
  labels: [],
};

const BACKLOG_GAMMA = {
  id: 'backlog-gamma',
  title: 'alpha-search backlog item',
  description: 'in the backlog',
  priority: 2,
  labels: [],
};

const BACKLOG_DELTA = {
  id: 'backlog-delta',
  title: 'unrelated title',
  description: 'unrelated body',
  priority: 1,
  labels: ['alpha-search'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveSwimlanes.mockReturnValue([SWIMLANE_TODO]);
  mockTaskRepoList.mockImplementation((swimlaneId: string) => {
    if (swimlaneId === SWIMLANE_TODO.id) return [TASK_ALPHA_ACTIVE];
    return [];
  });
  mockTaskRepoListArchived.mockReturnValue([TASK_BETA_ARCHIVED]);
  mockBacklogRepoList.mockReturnValue([BACKLOG_GAMMA, BACKLOG_DELTA]);
  mockBacklogRepoGetById.mockImplementation((id: string) => {
    if (id === BACKLOG_GAMMA.id) return BACKLOG_GAMMA;
    if (id === BACKLOG_DELTA.id) return BACKLOG_DELTA;
    return undefined;
  });
});

// ---------------------------------------------------------------------------
// scope behavior
// ---------------------------------------------------------------------------

describe('handleSearchTasks - scope', () => {
  it('rejects an empty query with a structured error', async () => {
    const result = handleSearchTasks({ query: '   ' }, makeContext());

    expect(result).toEqual({ success: false, error: 'Search query is required' });
    expect(mockTaskRepoList).not.toHaveBeenCalled();
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
  });

  it('default scope = "both" returns hits from both surfaces', async () => {
    const result = handleSearchTasks({ query: 'alpha-search' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
      totalActive: number;
      totalCompleted: number;
      totalBacklog: number;
      scope: string;
    };
    expect(data.scope).toBe('both');
    expect(data.tasks.map((task) => task.id).sort()).toEqual(['task-alpha', 'task-beta']);
    expect(data.backlog.map((item) => item.id).sort()).toEqual(['backlog-delta', 'backlog-gamma']);
    expect(data.totalActive).toBe(1);
    expect(data.totalCompleted).toBe(1);
    expect(data.totalBacklog).toBe(2);
  });

  it('scope = "board" skips the backlog repo entirely', async () => {
    const result = handleSearchTasks(
      { query: 'alpha-search', scope: 'board' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
      scope: string;
    };
    expect(data.scope).toBe('board');
    expect(data.tasks.map((task) => task.id).sort()).toEqual(['task-alpha', 'task-beta']);
    expect(data.backlog).toEqual([]);
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
  });

  it('scope = "backlog" skips the board repos entirely', async () => {
    const result = handleSearchTasks(
      { query: 'alpha-search', scope: 'backlog' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
      scope: string;
      totalActive: number;
      totalCompleted: number;
      totalBacklog: number;
    };
    expect(data.scope).toBe('backlog');
    expect(data.tasks).toEqual([]);
    expect(data.backlog.map((item) => item.id).sort()).toEqual(['backlog-delta', 'backlog-gamma']);
    expect(data.totalActive).toBe(0);
    expect(data.totalCompleted).toBe(0);
    expect(data.totalBacklog).toBe(2);
    expect(mockTaskRepoList).not.toHaveBeenCalled();
    expect(mockTaskRepoListArchived).not.toHaveBeenCalled();
    expect(mockListActiveSwimlanes).not.toHaveBeenCalled();
  });

  it('an unrecognized scope value is treated as "both"', async () => {
    const result = handleSearchTasks(
      { query: 'alpha-search', scope: 'nonsense' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { scope: string };
    expect(data.scope).toBe('both');
  });

  it('status filter still narrows the board side under scope "both"', async () => {
    const result = handleSearchTasks(
      { query: 'alpha-search', scope: 'both', status: 'active' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string; status: string }>;
      backlog: Array<{ id: string }>;
      totalActive: number;
      totalCompleted: number;
    };
    expect(data.tasks.map((task) => task.id)).toEqual(['task-alpha']);
    expect(data.totalActive).toBe(1);
    expect(data.totalCompleted).toBe(0);
    // Backlog still searched - status filter is board-only
    expect(data.backlog.map((item) => item.id).sort()).toEqual(['backlog-delta', 'backlog-gamma']);
    expect(mockTaskRepoListArchived).not.toHaveBeenCalled();
  });

  it('backlog hits include priority label and labels', async () => {
    const result = handleSearchTasks(
      { query: 'alpha-search', scope: 'backlog' },
      makeContext(),
    );

    const data = result.data as {
      backlog: Array<{ id: string; priority: number; priorityLabel: string; labels: string[] }>;
    };
    const gamma = data.backlog.find((item) => item.id === 'backlog-gamma');
    expect(gamma).toMatchObject({ priority: 2, priorityLabel: 'Medium', labels: [] });
    const delta = data.backlog.find((item) => item.id === 'backlog-delta');
    expect(delta).toMatchObject({ priority: 1, priorityLabel: 'Low', labels: ['alpha-search'] });
  });

  it('board hits carry labels too, closing the asymmetry with backlog hits', async () => {
    const result = handleSearchTasks({ query: 'alpha-search', scope: 'board' }, makeContext());

    const data = result.data as { tasks: Array<{ id: string; labels: string[] }> };
    expect(data.tasks.find((task) => task.id === 'task-alpha')?.labels).toEqual(['mcp', 'dx']);
    expect(data.tasks.find((task) => task.id === 'task-beta')?.labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #<number> ticket search
//
// A `#<digits>` query matches board tasks by display_id (prefix), not text,
// and never returns backlog items (they have no display_id). The fixture's
// display_ids are 1 (alpha, active) and 2 (beta, archived).
// ---------------------------------------------------------------------------

describe('handleSearchTasks - #<number> ticket search', () => {
  it('matches a board task by display_id and skips the backlog entirely', async () => {
    const result = handleSearchTasks({ query: '#1' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string; displayId: number }>;
      backlog: Array<{ id: string }>;
      scope: string;
    };
    // Only display_id 1 (alpha); display_id 2 (beta) does not start with "1".
    expect(data.tasks.map((task) => task.id)).toEqual(['task-alpha']);
    // Backlog is never returned for a ticket query, and is not even scanned.
    expect(data.backlog).toEqual([]);
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
  });

  it('does not match by text when the query is a ticket lookup', async () => {
    // The literal string "#1" appears in no title/description; a text search
    // would return nothing, but the ticket path still finds display_id 1.
    const result = handleSearchTasks({ query: '#1' }, makeContext());
    const data = result.data as { tasks: Array<{ id: string }> };
    expect(data.tasks.map((task) => task.id)).toEqual(['task-alpha']);
  });

  it('returns no tasks when no display_id matches the prefix', async () => {
    const result = handleSearchTasks({ query: '#9' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }>; backlog: Array<{ id: string }> };
    expect(data.tasks).toEqual([]);
    expect(data.backlog).toEqual([]);
  });

  it('a bare number (no "#") stays a text search', async () => {
    // "board" is in TASK_ALPHA_ACTIVE's title/description; a bare "1" is not a
    // ticket query, so the text path runs (and finds nothing for "1" here).
    const result = handleSearchTasks({ query: 'board' }, makeContext());
    const data = result.data as { tasks: Array<{ id: string }>; backlog: Array<{ id: string }> };
    expect(data.tasks.map((task) => task.id)).toEqual(['task-alpha']);
    // Backlog IS scanned for a normal text query (no ticket short-circuit).
    expect(mockBacklogRepoList).toHaveBeenCalled();
  });

  it('matches an archived task by display_id via the ticket path, not text', async () => {
    // TASK_BETA_ARCHIVED has display_id 2. Neither its title ('beta unrelated')
    // nor its description ('alpha-search shows up only in body') contains the
    // literal string "#2", so a regression that left the archived branch
    // (the `statusFilter === 'completed' || statusFilter === 'all'` loop) on
    // plain text matching instead of routing through matchesQuery's ticket path
    // would find nothing here, while the correct display_id-prefix matching
    // finds display_id 2. Every ticket test above queries '#1' or '#9' - neither
    // is a prefix of display_id 2 - so the archived branch's matching behavior
    // was never actually exercised by a hit before this test.
    const result = handleSearchTasks({ query: '#2' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string; displayId: number; status: string }>;
      backlog: Array<{ id: string }>;
      totalActive: number;
      totalCompleted: number;
    };
    // display_id 1 (alpha) does not start with "2"; display_id 2 (beta,
    // archived) does.
    expect(data.tasks.map((task) => task.id)).toEqual(['task-beta']);
    expect(data.tasks[0].displayId).toBe(2);
    expect(data.tasks[0].status).toBe('completed');
    expect(data.totalActive).toBe(0);
    expect(data.totalCompleted).toBe(1);
    expect(data.backlog).toEqual([]);
  });

  it('scope "backlog" + a ticket query returns nothing from either surface', async () => {
    // includeBoard is false (scope isn't 'board'/'both'), and includeBacklog
    // is also false because a ticket query forces ticketDigits !== null
    // regardless of scope. So an explicit backlog-scoped ticket query returns
    // an empty result from BOTH surfaces - it does not fall back to a text
    // search of the backlog, and it does not widen back to the board despite
    // the ticket digits matching display_id 1. This combination (scope
    // narrowing one gate, ticketDigits narrowing the other) is not exercised
    // by the "scope" tests above (text queries only) or the ticket tests
    // above (default scope only).
    const result = handleSearchTasks({ query: '#1', scope: 'backlog' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
      scope: string;
    };
    expect(data.scope).toBe('backlog');
    expect(data.tasks).toEqual([]);
    expect(data.backlog).toEqual([]);
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
    expect(mockTaskRepoList).not.toHaveBeenCalled();
    expect(mockTaskRepoListArchived).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleFindTask - backlog widening
//
// Backlog items only carry id (UUID) and title that are matchable by
// find_task. displayId/branch/prNumber are board-only fields.
// ---------------------------------------------------------------------------

describe('handleFindTask - backlog widening', () => {
  it('matches a backlog item by UUID via the `id` arg (uses indexed getById fast path)', async () => {
    const result = await handleFindTask({ id: 'backlog-gamma' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string; title: string; priorityLabel: string }>;
    };
    expect(data.tasks).toEqual([]);
    expect(data.backlog).toHaveLength(1);
    expect(data.backlog[0]).toMatchObject({
      id: 'backlog-gamma',
      title: 'alpha-search backlog item',
      priorityLabel: 'Medium',
    });
    // Fast path: O(1) getById, NOT a full list-and-filter
    expect(mockBacklogRepoGetById).toHaveBeenCalledWith('backlog-gamma');
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
  });

  it('matches both a board task and a backlog item by shared title keyword', async () => {
    const result = await handleFindTask({ title: 'alpha-search' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
    };
    expect(data.tasks.map((task) => task.id).sort()).toEqual(['task-alpha']);
    // BACKLOG_DELTA's title is 'unrelated title' - it only matches via labels in search_tasks,
    // and find_task does not look at backlog labels.
    expect(data.backlog.map((item) => item.id)).toEqual(['backlog-gamma']);
  });

  it('skips backlog when only board-only criteria (displayId / branch / prNumber) are given', async () => {
    mockBacklogRepoList.mockClear();

    const result = await handleFindTask({ displayId: 1 }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }>; backlog: Array<{ id: string }> };
    expect(data.tasks.map((task) => task.id)).toEqual(['task-alpha']);
    expect(data.backlog).toEqual([]);
    expect(mockBacklogRepoList).not.toHaveBeenCalled();
  });

  it('returns the unified empty shape (tasks + backlog arrays) when nothing matches', async () => {
    const result = await handleFindTask({ id: 'no-such-id-anywhere' }, makeContext());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tasks: [], backlog: [] });
    expect(result.message).toMatch(/^No tasks or backlog items found/);
  });

  it('does not match backlog labels (find_task is exact id / displayId / branch / prNumber + title only)', async () => {
    // BACKLOG_DELTA has labels: ['alpha-search'] but title 'unrelated title'.
    // find_task with title='alpha-search' must NOT pick it up - that is search_tasks territory.
    const result = await handleFindTask({ title: 'alpha-search' }, makeContext());
    const data = result.data as { backlog: Array<{ id: string }> };
    expect(data.backlog.map((item) => item.id)).not.toContain('backlog-delta');
  });

  it('matches by both id AND title simultaneously via the slow-path OR logic', async () => {
    // When BOTH `id` and `title` are provided, findBacklogMatchesForFindTask takes the
    // slow path (lines 50-55): it calls backlogRepo.list() and filters with OR logic so
    // an item matches if its UUID equals taskId OR its title contains titleQuery.
    //
    // Fixture state:
    //   BACKLOG_GAMMA: id='backlog-gamma', title='alpha-search backlog item' -> matches BOTH
    //   BACKLOG_DELTA: id='backlog-delta', title='unrelated title' -> matches only the id arm
    //
    // Providing { id: 'backlog-delta', title: 'alpha-search' } must return:
    //   - backlog-delta  (id match)
    //   - backlog-gamma  (title match)
    // And it must use list(), NOT getById(), because titleQuery is non-null.
    const result = await handleFindTask({ id: 'backlog-delta', title: 'alpha-search' }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      tasks: Array<{ id: string }>;
      backlog: Array<{ id: string }>;
    };

    // Both backlog items must be present (order is not guaranteed, so sort before comparing)
    expect(data.backlog.map((item) => item.id).sort()).toEqual(['backlog-delta', 'backlog-gamma']);

    // Slow path: list() must have been called; getById() must NOT have been called for backlog
    expect(mockBacklogRepoList).toHaveBeenCalled();
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleFindTask - Knowledge Graph lines
//
// The agent reads the message text, never the data object, so the summary, the
// linked commits and the changed files have to be printed under each task.
// ---------------------------------------------------------------------------

describe('handleFindTask - Knowledge Graph lines', () => {
  function emptyKnowledge(overrides: Partial<TaskKnowledge> = {}): TaskKnowledge {
    return { summary: null, commits: [], commitCount: 0, changedFiles: [], changedFileCount: 0, ...overrides };
  }

  function contextReading(byTask: Map<string, TaskKnowledge>, summariesOn = true) {
    const readTaskKnowledge = vi.fn((): TaskKnowledgeRead => ({ indexOn: true, summariesOn, byTask }));
    return { context: { ...makeContext(), readTaskKnowledge } as CommandContext, readTaskKnowledge };
  }

  it('prints each matched task\'s lines under its own task line', async () => {
    const { context, readTaskKnowledge } = contextReading(new Map([
      ['task-beta', emptyKnowledge({ summary: { text: 'Finished the beta work.', writtenAt: '2026-09-20T18:30:00.000Z' } })],
      ['task-alpha', emptyKnowledge({ changedFiles: ['src/alpha.ts'], changedFileCount: 1 })],
    ]));

    const result = await handleFindTask({ title: 'alpha-search' }, context);

    expect(readTaskKnowledge).toHaveBeenCalledWith(['task-alpha']);
    expect(result.message).toContain([
      '- "alpha-search board task" [To Do] | #1, id: task-alpha',
      '  changed files (1, most-changed first): src/alpha.ts',
    ].join('\n'));
    // The backlog item sits in its own section, with no knowledge under it.
    expect(result.message).toContain('Backlog (1):\n- "alpha-search backlog item" (Medium) (id: backlog-gamma)');
  });

  it('treats an archived task as finished, so it says whether it has a summary', async () => {
    const { context } = contextReading(new Map([
      ['task-beta', emptyKnowledge({ summary: { text: 'Finished the beta work.', writtenAt: '2026-09-20T18:30:00.000Z' } })],
    ]));

    const result = await handleFindTask({ displayId: 2 }, context);

    expect(result.message).toContain([
      '- "beta unrelated" [Done] | #2, id: task-beta',
      '  summary (2026-09-20): Finished the beta work.',
      '  commits: none linked to this task',
    ].join('\n'));
  });

  it('says why a finished task has no summary when the summaries switch is off', async () => {
    const { context } = contextReading(new Map([['task-beta', emptyKnowledge()]]), false);
    const result = await handleFindTask({ displayId: 2 }, context);
    expect(result.message).toContain('  summary: none written (Task summaries are switched off in Settings > Knowledge Graph)');
  });

  it('reads the first five matches only, and ends the message with how to look up the rest', async () => {
    const manyTasks = Array.from({ length: 6 }, (_unused, index) => ({
      id: `task-many-${index}`,
      display_id: 100 + index,
      title: `many-match task ${index}`,
      description: '',
      swimlane_id: 'lane-todo',
      archived_at: null,
      labels: [],
    }));
    mockTaskRepoList.mockImplementation((swimlaneId: string) => (swimlaneId === SWIMLANE_TODO.id ? manyTasks : []));
    mockTaskRepoListArchived.mockReturnValue([]);
    const { context, readTaskKnowledge } = contextReading(new Map(manyTasks.map((task) => [
      task.id,
      emptyKnowledge({ changedFiles: [`src/${task.id}.ts`], changedFileCount: 1 }),
    ])));

    const result = await handleFindTask({ title: 'many-match' }, context);

    expect(readTaskKnowledge).toHaveBeenCalledOnce();
    expect(readTaskKnowledge).toHaveBeenCalledWith(manyTasks.slice(0, 5).map((task) => task.id));
    expect(result.message).toContain('src/task-many-4.ts');
    expect(result.message).not.toContain('src/task-many-5.ts');
    // Every match is still listed; only the knowledge stops at five.
    expect(result.message).toContain('#105, id: task-many-5');
    const lines = (result.message ?? '').split('\n');
    expect(lines[lines.length - 1]).toBe(
      'Summaries, commits and changed files show for the first 5 matches. Look one up by displayId for its details.',
    );
  });

  it('says the index is off, and prints no lines, when the reader reports it off', async () => {
    const context = { ...makeContext(), readTaskKnowledge: vi.fn((): TaskKnowledgeRead => ({ indexOn: false })) } as CommandContext;

    const result = await handleFindTask({ displayId: 2 }, context);

    expect(result.message).toContain('- "beta unrelated" [Done] | #2, id: task-beta');
    expect(result.message).toContain('The Knowledge Graph index is off (Settings > Knowledge Graph), so no summary, linked commits or changed files are shown.');
    expect(result.message).not.toContain('  summary');
  });

  it('prints only the task line when the context has no reader', async () => {
    const result = await handleFindTask({ displayId: 2 }, makeContext());
    expect(result.message).toBe('Found 1 match(es):\n- "beta unrelated" [Done] | #2, id: task-beta');
  });

  it('does not read the index for a lookup that matches no board task', async () => {
    const { context, readTaskKnowledge } = contextReading(new Map());
    await handleFindTask({ id: 'backlog-gamma' }, context);
    expect(readTaskKnowledge).not.toHaveBeenCalled();
  });
});
