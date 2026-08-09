/**
 * `handleListTasks`'s `position` field: it reports the ORDINAL slot
 * (`list()`'s loop index), never the raw stored `tasks.position`.
 *
 * This is the feature's stated premise for the MCP task-placement surface -
 * `kangentic_move_task`'s `position` and `kangentic_reorder_tasks` both speak
 * ordinal slots, so `kangentic_list_tasks` has to report in the same
 * vocabulary for a read-before-reorder call to make sense. Gaps in the raw
 * value are the normal state (`archive()` leaves `position` untouched), so the
 * only test that actually distinguishes "ordinal" from "raw" is one against a
 * gapped column.
 *
 * Mocking the repositories mirrors mcp-task-placement-handlers.test.ts: no
 * better-sqlite3 binary is needed (it is built for Electron's Node ABI and
 * will not load under vitest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTaskRepoList, mockSwimlaneRepoList } = vi.hoisted(() => ({
  mockTaskRepoList: vi.fn(),
  mockSwimlaneRepoList: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = mockTaskRepoList;
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = mockSwimlaneRepoList;
  },
}));

import { handleListTasks } from '../../src/main/agent/commands/inventory-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

const TODO_LANE = { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: false };
const REVIEW_LANE = { id: 'lane-review', name: 'Review', role: null, is_archived: false };

interface FixtureTask {
  id: string;
  display_id: number;
  title: string;
  description: string;
  swimlane_id: string;
  position: number;
}

/**
 * Live raw positions 0, 5, 9 - the shape archiving produces (`archive()`
 * leaves `position` untouched, and `create` takes MAX(position) + 1 over
 * archived rows). If `handleListTasks` reported the raw value, this column
 * would report positions 0, 5, 9; the whole point is that it reports the
 * ordinal 0, 1, 2 instead.
 */
const GAPPED_TODO_TASKS: FixtureTask[] = [
  { id: 'uuid-a', display_id: 11, title: 'Alpha', description: 'a', swimlane_id: TODO_LANE.id, position: 0 },
  { id: 'uuid-b', display_id: 12, title: 'Bravo', description: 'b', swimlane_id: TODO_LANE.id, position: 5 },
  { id: 'uuid-c', display_id: 13, title: 'Charlie', description: 'c', swimlane_id: TODO_LANE.id, position: 9 },
];

const GAPPED_REVIEW_TASKS: FixtureTask[] = [
  { id: 'uuid-r1', display_id: 21, title: 'Under review', description: 'r', swimlane_id: REVIEW_LANE.id, position: 2 },
  { id: 'uuid-r2', display_id: 22, title: 'Also reviewing', description: 's', swimlane_id: REVIEW_LANE.id, position: 7 },
];

function makeContext(): CommandContext {
  return { getProjectDb: vi.fn(() => ({}) as never) } as unknown as CommandContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleListTasks position reporting', () => {
  it('reports the ordinal slot, not the raw gapped tasks.position, for a filtered column', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE]);
    mockTaskRepoList.mockReturnValue(GAPPED_TODO_TASKS);

    const response = handleListTasks({ column: 'To Do' }, makeContext());

    expect(response.success).toBe(true);
    expect(response.data).toEqual([
      { id: 'uuid-a', displayId: 11, title: 'Alpha', description: 'a', column: 'To Do', position: 0 },
      { id: 'uuid-b', displayId: 12, title: 'Bravo', description: 'b', column: 'To Do', position: 1 },
      { id: 'uuid-c', displayId: 13, title: 'Charlie', description: 'c', column: 'To Do', position: 2 },
    ]);
  });

  it('resets the ordinal per column when listing every column at once', () => {
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, REVIEW_LANE]);
    mockTaskRepoList.mockImplementation((swimlaneId: string) => {
      if (swimlaneId === TODO_LANE.id) return GAPPED_TODO_TASKS;
      if (swimlaneId === REVIEW_LANE.id) return GAPPED_REVIEW_TASKS;
      return [];
    });

    const response = handleListTasks({ column: null }, makeContext());

    expect(response.success).toBe(true);
    const positions = (response.data as Array<{ column: string; position: number }>).map(
      (task) => `${task.column}:${task.position}`,
    );
    // Review's raw positions are [2, 7], not [0, 1] - a leaked raw value or a
    // running counter across columns would both fail this.
    expect(positions).toEqual(['To Do:0', 'To Do:1', 'To Do:2', 'Review:0', 'Review:1']);
  });
});
