/**
 * `handleListColumns` reports the board a human sees, which includes the Done
 * column.
 *
 * Done is persisted `is_archived = 1` by construction (the board renders it as
 * the collapsed DoneSwimlane, not a normal column). `handleListColumns` used to
 * list only non-archived lanes, so Done never appeared - and an agent asking
 * "where does finished work go" picked the last column it could see, which on
 * the default board is Merge, an auto_spawn column running
 * `/merge-pull-request`. That misroute happened for real on task #642.
 *
 * The carve-out is the `done` ROLE, not "any archived lane": a lane a user
 * archived deliberately must stay hidden. The first test below is the one that
 * makes this file non-vacuous - without it, deleting the archived filter
 * outright still passes.
 *
 * Mocking the repositories mirrors inventory-commands-list-tasks.test.ts: no
 * better-sqlite3 binary is needed (it is built for Electron's Node ABI and will
 * not load under vitest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTaskRepoList, mockTaskRepoCountArchived, mockSwimlaneRepoList } = vi.hoisted(() => ({
  mockTaskRepoList: vi.fn(),
  mockTaskRepoCountArchived: vi.fn(),
  mockSwimlaneRepoList: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = mockTaskRepoList;
    countArchived = mockTaskRepoCountArchived;
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = mockSwimlaneRepoList;
  },
}));

import { handleListColumns, handleListTasks } from '../../src/main/agent/commands/inventory-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

const TODO_LANE = { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: false };
const MERGE_LANE = { id: 'lane-merge', name: 'Merge', role: null, is_archived: false };
/** Persisted archived by construction. This is the lane the bug hid. */
const DONE_LANE = { id: 'lane-done', name: 'Done', role: 'done', is_archived: true };
/** Archived by a USER, to hide it. Must never surface. */
const HIDDEN_LANE = { id: 'lane-hidden', name: 'Icebox', role: null, is_archived: true };

interface ListedColumn {
  name: string;
  role: string | null;
  taskCount: number;
  completedCount?: number;
}

function makeContext(): CommandContext {
  return { getProjectDb: vi.fn(() => ({}) as never) } as unknown as CommandContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskRepoList.mockReturnValue([]);
  mockTaskRepoCountArchived.mockReturnValue(0);
});

describe('handleListColumns archived-lane handling', () => {
  it('excludes a lane a user archived, while including the done-role lane', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE, HIDDEN_LANE]);

    const response = handleListColumns({}, makeContext());

    expect(response.success).toBe(true);
    const names = (response.data as ListedColumn[]).map((column) => column.name);
    // Both halves matter. Dropping the filter entirely would leak "Icebox";
    // keeping the old filter would drop "Done".
    expect(names).toEqual(['To Do', 'Merge', 'Done']);
  });

  it('tags the done column with its role, so an agent can find it without guessing', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);

    const response = handleListColumns({}, makeContext());

    const done = (response.data as ListedColumn[]).find((column) => column.name === 'Done');
    expect(done?.role).toBe('done');
  });

  it('lists every column when the board has no done lane at all', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE]);

    const response = handleListColumns({}, makeContext());

    expect((response.data as ListedColumn[]).map((column) => column.name)).toEqual(['To Do', 'Merge']);
    // No done lane means nothing to count, so the archive query is never run.
    expect(mockTaskRepoCountArchived).not.toHaveBeenCalled();
  });
});

describe('handleListColumns counts', () => {
  it('keeps taskCount as live cards and carries the archive in completedCount', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, DONE_LANE]);
    mockTaskRepoList.mockImplementation((swimlaneId: string) =>
      swimlaneId === TODO_LANE.id ? [{ id: 'a' }, { id: 'b' }] : []);
    mockTaskRepoCountArchived.mockReturnValue(584);

    const response = handleListColumns({}, makeContext());

    expect(response.data).toEqual([
      { name: 'To Do', role: 'todo', taskCount: 2 },
      { name: 'Done', role: 'done', taskCount: 0, completedCount: 584 },
    ]);
  });

  it('does not put completedCount on a non-done column', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);
    mockTaskRepoCountArchived.mockReturnValue(7);

    const response = handleListColumns({}, makeContext());

    const withCount = (response.data as ListedColumn[]).filter(
      (column) => column.completedCount !== undefined,
    );
    expect(withCount.map((column) => column.name)).toEqual(['Done']);
  });

  it('counts the archive once, not once per column', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);

    handleListColumns({}, makeContext());

    expect(mockTaskRepoCountArchived).toHaveBeenCalledTimes(1);
  });
});

/**
 * The sibling read tool has to agree. Shipping the fix in `list_columns` alone
 * would advertise "Done (done)" and then answer `Column "Done" not found` for
 * the very name it just printed.
 */
describe('handleListTasks resolves the done column', () => {
  it('returns an empty list rather than a not-found error for Done', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);

    const response = handleListTasks({ column: 'Done' }, makeContext());

    expect(response.success).toBe(true);
    expect(response.data).toEqual([]);
  });

  it('returns only live tasks when no column is named, even though Done is now walked', () => {
    // The unfiltered branch iterates every lane this tool resolves, so adding
    // Done widened it from six lanes to seven. It contributes nothing only
    // because TaskRepository.list() filters archived rows; if that ever stops
    // being true, a plain listing would start carrying the whole archive.
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);
    mockTaskRepoList.mockImplementation((swimlaneId: string) =>
      swimlaneId === TODO_LANE.id
        ? [{ id: 'uuid-a', display_id: 1, title: 'Live', description: '', swimlane_id: TODO_LANE.id, position: 0, labels: [] }]
        : []);

    const response = handleListTasks({ column: null }, makeContext());

    expect(response.success).toBe(true);
    expect(response.data).toEqual([
      { id: 'uuid-a', displayId: 1, title: 'Live', description: '', column: 'To Do', position: 0, labels: [] },
    ]);
  });

  it('still rejects a lane a user archived', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, DONE_LANE, HIDDEN_LANE]);

    const response = handleListTasks({ column: 'Icebox' }, makeContext());

    expect(response.success).toBe(false);
    // The suggestion list names Done (so a caller that mistyped can retry) and
    // never names the lane the user hid.
    const available = (response.error ?? '').split('Available columns: ')[1];
    expect(available).toBe('To Do, Done');
  });
});
