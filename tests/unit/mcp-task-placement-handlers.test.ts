/**
 * Handler behaviour for the MCP task-placement surface: `kangentic_move_task`'s
 * `position` argument and the `kangentic_reorder_tasks` tool.
 *
 * The load-bearing assertions here are about which WRITE PATH each case takes,
 * because the two are not interchangeable:
 *
 *   - A within-column placement must go through the dense rewrite and must NOT
 *     dispatch `onTaskMove`. `handleTaskMove` aborts any in-flight move for the
 *     task before it takes the per-task lock, so routing a reorder through it
 *     would kill a user's concurrent cross-column drag of that same card and
 *     the agent spawn it was about to run.
 *   - A cross-column move must still dispatch `onTaskMove` (the full lifecycle),
 *     with the ordinal slot already translated into a RAW `tasks.position`.
 *
 * Strategy mirrors mcp-update-task-description-edits.test.ts: mock the
 * repositories so no better-sqlite3 binary is needed (it is built for Electron's
 * Node ABI and will not load under vitest), and assert on captured calls. The
 * slot arithmetic itself is covered separately and exhaustively in
 * task-ordering.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const {
  mockTaskRepoList,
  mockTaskRepoGetById,
  mockTaskRepoGetByDisplayId,
  mockTaskRepoReorderWithinSwimlane,
  mockTaskRepoNextPositionInSwimlane,
  mockSwimlaneRepoList,
} = vi.hoisted(() => ({
  mockTaskRepoList: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
  mockTaskRepoReorderWithinSwimlane: vi.fn(),
  mockTaskRepoNextPositionInSwimlane: vi.fn(),
  mockSwimlaneRepoList: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = mockTaskRepoList;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
    reorderWithinSwimlane = mockTaskRepoReorderWithinSwimlane;
    nextPositionInSwimlane = mockTaskRepoNextPositionInSwimlane;
    update = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = mockSwimlaneRepoList;
  },
}));

// Defensive: transitively imported by task-commands.ts, unused by the handlers
// under test here.
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {},
}));
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {},
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleMoveTask, handleReorderTasks } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Board fixture
// ---------------------------------------------------------------------------

const TODO_LANE = { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: false };
const REVIEW_LANE = { id: 'lane-review', name: 'Review', role: null, is_archived: false };

interface FixtureTask {
  id: string;
  display_id: number;
  title: string;
  swimlane_id: string;
  position: number;
}

/**
 * To Do holds four tasks at GAPPED raw positions. Gaps are the normal state,
 * not a contrived one: `archive()` leaves `position` untouched and `create`
 * takes MAX(position) + 1 over archived rows, so an ordinal slot and a raw
 * position routinely disagree.
 */
const TODO_TASKS: FixtureTask[] = [
  { id: 'uuid-a', display_id: 11, title: 'Alpha', swimlane_id: TODO_LANE.id, position: 0 },
  { id: 'uuid-b', display_id: 12, title: 'Bravo', swimlane_id: TODO_LANE.id, position: 5 },
  { id: 'uuid-c', display_id: 13, title: 'Charlie', swimlane_id: TODO_LANE.id, position: 9 },
  { id: 'uuid-d', display_id: 14, title: 'Delta', swimlane_id: TODO_LANE.id, position: 10 },
];

const REVIEW_TASKS: FixtureTask[] = [
  { id: 'uuid-r1', display_id: 21, title: 'Under review', swimlane_id: REVIEW_LANE.id, position: 2 },
  { id: 'uuid-r2', display_id: 22, title: 'Also reviewing', swimlane_id: REVIEW_LANE.id, position: 7 },
];

const ALL_TASKS = [...TODO_TASKS, ...REVIEW_TASKS];

function makeContext(): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => '/mock/project'),
    getBoardProfiles: vi.fn(() => []),
    setBoardProfiles: vi.fn(),
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

let context: CommandContext;

beforeEach(() => {
  vi.clearAllMocks();
  mockSwimlaneRepoList.mockReturnValue([TODO_LANE, REVIEW_LANE]);
  mockTaskRepoList.mockImplementation((swimlaneId: string) =>
    ALL_TASKS.filter((task) => task.swimlane_id === swimlaneId));
  mockTaskRepoGetById.mockImplementation((id: string) => ALL_TASKS.find((task) => task.id === id));
  mockTaskRepoGetByDisplayId.mockImplementation((displayId: number) =>
    ALL_TASKS.find((task) => task.display_id === displayId));
  // Review's raw positions are 2 and 7, so appending lands at 8.
  mockTaskRepoNextPositionInSwimlane.mockImplementation((swimlaneId: string) => {
    const positions = ALL_TASKS.filter((task) => task.swimlane_id === swimlaneId).map((task) => task.position);
    return positions.length === 0 ? 0 : Math.max(...positions) + 1;
  });
  context = makeContext();
});

// ---------------------------------------------------------------------------
// move_task: repositioning inside the task's current column
// ---------------------------------------------------------------------------

describe('handleMoveTask within the task\'s current column', () => {
  it('places the task at the requested slot via the dense rewrite', () => {
    const response = handleMoveTask({ taskId: 'uuid-c', column: 'To Do', position: 0 }, context);

    expect(response.success).toBe(true);
    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-c', 'uuid-a', 'uuid-b', 'uuid-d'],
    );
  });

  it('never dispatches onTaskMove for a same-column placement', () => {
    // The whole point of the split path: onTaskMove reaches handleTaskMove,
    // which aborts any in-flight move for this task before taking the lock.
    handleMoveTask({ taskId: 'uuid-c', column: 'To Do', position: 0 }, context);

    expect(context.onTaskMove).not.toHaveBeenCalled();
  });

  it('notifies the renderer with the column and the resulting order', () => {
    handleMoveTask({ taskId: 'uuid-d', column: 'To Do', position: 1 }, context);

    expect(context.onTasksReordered).toHaveBeenCalledWith(
      TODO_LANE,
      ['uuid-a', 'uuid-d', 'uuid-b', 'uuid-c'],
    );
  });

  it('counts slots among the OTHER tasks, so the last slot is length - 1', () => {
    handleMoveTask({ taskId: 'uuid-a', column: 'To Do', position: 3 }, context);

    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-b', 'uuid-c', 'uuid-d', 'uuid-a'],
    );
  });

  it('clamps a slot past the end to last rather than erroring', () => {
    const response = handleMoveTask({ taskId: 'uuid-a', column: 'To Do', position: 999 }, context);

    expect(response.success).toBe(true);
    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-b', 'uuid-c', 'uuid-d', 'uuid-a'],
    );
  });

  it('resolves a numeric display ID the same as a UUID', () => {
    handleMoveTask({ taskId: '13', column: 'To Do', position: 0 }, context);

    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-c', 'uuid-a', 'uuid-b', 'uuid-d'],
    );
  });

  it('stays the long-standing no-op when no position is given', () => {
    const response = handleMoveTask({ taskId: 'uuid-c', column: 'To Do' }, context);

    expect(response.success).toBe(true);
    expect(response.message).toContain('already in To Do');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
    expect(context.onTasksReordered).not.toHaveBeenCalled();
    expect(context.onTaskMove).not.toHaveBeenCalled();
  });

  it('reports data.position for an MCP caller to read', () => {
    const response = handleMoveTask({ taskId: 'uuid-c', column: 'To Do', position: 0 }, context);

    expect(response.data).toMatchObject({ position: 0 });
  });

  it('reports the "to position N of" message for an MCP caller to read', () => {
    const response = handleMoveTask({ taskId: 'uuid-c', column: 'To Do', position: 0 }, context);

    expect(response.message).toBe('Moved "Charlie" (#13) to position 0 of To Do.');
  });
});

// ---------------------------------------------------------------------------
// move_task: crossing columns
// ---------------------------------------------------------------------------

describe('handleMoveTask across columns', () => {
  it('translates the ordinal slot into the RAW position of the task holding it', () => {
    // Review's raw positions are [2, 7]. Slot 1 must resolve to 7, NOT to 1 -
    // passing the ordinal through would land the card a slot early.
    handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 1 }, context);

    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: 'uuid-a',
      targetSwimlaneId: REVIEW_LANE.id,
      targetPosition: 7,
    });
  });

  it('sends the top slot to the first task\'s raw position', () => {
    handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 0 }, context);

    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: 'uuid-a',
      targetSwimlaneId: REVIEW_LANE.id,
      targetPosition: 2,
    });
  });

  it('treats the target column\'s length as the appending slot', () => {
    handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 2 }, context);

    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: 'uuid-a',
      targetSwimlaneId: REVIEW_LANE.id,
      targetPosition: 8,
    });
  });

  it('appends past the gapped tail when no position is given', () => {
    // The pre-existing default sent the column's LENGTH as a raw position, which
    // on a gapped column (here: 2, 7) lands mid-column instead of appending.
    handleMoveTask({ taskId: 'uuid-a', column: 'Review' }, context);

    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: 'uuid-a',
      targetSwimlaneId: REVIEW_LANE.id,
      targetPosition: 8,
    });
  });

  it('does not touch the dense-rewrite path', () => {
    handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 0 }, context);

    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
    expect(context.onTasksReordered).not.toHaveBeenCalled();
  });

  it('reports data.position for an MCP caller to read', () => {
    const response = handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 1 }, context);

    expect(response.data).toMatchObject({ position: 1 });
  });

  it('reports the "Moving ... at position N." message for an MCP caller to read', () => {
    const response = handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: 1 }, context);

    expect(response.message).toBe('Moving "Alpha" (#11) to Review at position 1.');
  });
});

describe('handleMoveTask position validation', () => {
  // `parseSlotParam` deliberately does not use `Number(value)`, because that
  // coerces junk into a real slot instead of an error: '', [], and '   ' all
  // become 0, and `true` becomes 1. The devtools proxy forwards raw JSON
  // straight into `commandHandlers` with no schema in front of it, so these
  // are the exact inputs that guard is for - not just the already-numeric
  // out-of-range cases above.
  const junkPositions: Array<[string, unknown]> = [
    ['a negative slot', -1],
    ['a fractional slot', 1.5],
    ['a boolean, which Number() would coerce to 1', true],
    ['an empty string, which Number() would coerce to 0', ''],
    ['an empty array, which Number() would coerce to 0', []],
    ['a whitespace-only string, which Number() would coerce to 0', '   '],
  ];

  it.each(junkPositions)('rejects %s without writing anything', (_label, position) => {
    const response = handleMoveTask({ taskId: 'uuid-a', column: 'Review', position }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Invalid position');
    expect(context.onTaskMove).not.toHaveBeenCalled();
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('treats an explicit null as omitted, since the tool layer forwards it that way', () => {
    const response = handleMoveTask({ taskId: 'uuid-a', column: 'Review', position: null }, context);

    expect(response.success).toBe(true);
    expect(context.onTaskMove).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reorder_tasks
// ---------------------------------------------------------------------------

describe('handleReorderTasks', () => {
  it('sets the full column order when every task is listed', () => {
    const response = handleReorderTasks(
      { column: 'To Do', taskIds: ['uuid-d', 'uuid-c', 'uuid-b', 'uuid-a'] },
      context,
    );

    expect(response.success).toBe(true);
    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-d', 'uuid-c', 'uuid-b', 'uuid-a'],
    );
  });

  it('pins a subset to the top and leaves the rest in relative order', () => {
    handleReorderTasks({ column: 'To Do', taskIds: ['uuid-c', 'uuid-a'] }, context);

    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-c', 'uuid-a', 'uuid-b', 'uuid-d'],
    );
  });

  it('accepts numeric display IDs, resolving them before the column check', () => {
    // The trap: the column holds UUIDs, so comparing raw "#13"-style input would
    // reject every id an agent is most likely to send.
    const response = handleReorderTasks({ column: 'To Do', taskIds: ['13', '11'] }, context);

    expect(response.success).toBe(true);
    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      TODO_LANE.id,
      ['uuid-c', 'uuid-a', 'uuid-b', 'uuid-d'],
    );
  });

  it('resolves the column case-insensitively', () => {
    expect(handleReorderTasks({ column: 'to do', taskIds: ['uuid-c'] }, context).success).toBe(true);
  });

  it('never spawns, suspends, or otherwise runs the move lifecycle', () => {
    handleReorderTasks({ column: 'To Do', taskIds: ['uuid-d'] }, context);

    expect(context.onTaskMove).not.toHaveBeenCalled();
  });

  it('notifies the renderer with the column and the resulting order', () => {
    handleReorderTasks({ column: 'To Do', taskIds: ['uuid-d'] }, context);

    expect(context.onTasksReordered).toHaveBeenCalledWith(
      TODO_LANE,
      ['uuid-d', 'uuid-a', 'uuid-b', 'uuid-c'],
    );
  });

  it('reports the resulting order as ordinal slots', () => {
    const response = handleReorderTasks({ column: 'To Do', taskIds: ['uuid-d'] }, context);

    expect(response.data).toEqual({
      column: 'To Do',
      order: [
        { id: 'uuid-d', displayId: 14, position: 0 },
        { id: 'uuid-a', displayId: 11, position: 1 },
        { id: 'uuid-b', displayId: 12, position: 2 },
        { id: 'uuid-c', displayId: 13, position: 3 },
      ],
    });
  });

  it('rejects a task that lives in another column, rather than moving it', () => {
    const response = handleReorderTasks({ column: 'To Do', taskIds: ['uuid-r1'] }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('is not in To Do');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('rejects an archived task with the archived message, not the wrong-column message', () => {
    // `archive()` leaves swimlane_id alone, so an archived To Do task still
    // resolves to To Do via getById/getByDisplayId while `list()` (which
    // filters archived rows) no longer contains it. That is a DIFFERENT
    // situation from "lives in another column" and must say so - saying "is
    // not in To Do" about a task whose swimlane_id IS To Do would be flatly
    // false. Mirrors the same guard already covered on handleMoveTask's
    // reposition path in task-ordering-sql.test.ts.
    //
    // Override just the two lookups (not the shared ALL_TASKS fixture, which
    // other tests in this file depend on for their exact position math) so
    // getById/getByDisplayId can resolve an id that mockTaskRepoList's To Do
    // filter still excludes.
    const archivedTodoTask: FixtureTask = {
      id: 'uuid-archived',
      display_id: 15,
      title: 'Echo',
      swimlane_id: TODO_LANE.id,
      position: 3,
    };
    mockTaskRepoGetById.mockImplementation((id: string) =>
      [...ALL_TASKS, archivedTodoTask].find((task) => task.id === id));
    mockTaskRepoGetByDisplayId.mockImplementation((displayId: number) =>
      [...ALL_TASKS, archivedTodoTask].find((task) => task.display_id === displayId));

    const response = handleReorderTasks({ column: 'To Do', taskIds: ['uuid-archived'] }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('is archived, so it has no position in To Do');
    expect(response.error).not.toContain('is not in To Do');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('rejects a duplicated task id', () => {
    const response = handleReorderTasks({ column: 'To Do', taskIds: ['uuid-a', 'uuid-a'] }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('more than once');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('rejects an unknown task id', () => {
    const response = handleReorderTasks({ column: 'To Do', taskIds: ['uuid-nope'] }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('rejects an unknown column', () => {
    const response = handleReorderTasks({ column: 'Nowhere', taskIds: ['uuid-a'] }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Column "Nowhere" not found');
  });

  it.each([
    ['an empty list', []],
    ['a missing list', undefined],
  ])('rejects %s', (_label, taskIds) => {
    const response = handleReorderTasks({ column: 'To Do', taskIds }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('taskIds is required');
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
  });

  it('writes nothing when any id in the batch is invalid', () => {
    // All-or-nothing: a partially-applied reorder would be worse than none.
    const response = handleReorderTasks(
      { column: 'To Do', taskIds: ['uuid-a', 'uuid-r1', 'uuid-b'] },
      context,
    );

    expect(response.success).toBe(false);
    expect(mockTaskRepoReorderWithinSwimlane).not.toHaveBeenCalled();
    expect(context.onTasksReordered).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reorder_tasks: REORDER_ECHO_LIMIT
//
// The write always applies the full requested order (see the "sets the full
// column order" test above); only the CONFIRMATION MESSAGE truncates, so a
// large reorder does not swamp the tool response. No fixture elsewhere in this
// file exceeds 4 tasks, so the truncation itself has never been exercised.
// ---------------------------------------------------------------------------

describe('handleReorderTasks REORDER_ECHO_LIMIT', () => {
  const BULK_LANE = { id: 'lane-bulk', name: 'Bulk', role: null, is_archived: false };
  const BULK_TASKS: FixtureTask[] = Array.from({ length: 30 }, (_unused, index) => ({
    id: `bulk-${index}`,
    display_id: 200 + index,
    title: `Bulk ${index}`,
    swimlane_id: BULK_LANE.id,
    position: index,
  }));

  beforeEach(() => {
    mockSwimlaneRepoList.mockReturnValue([BULK_LANE]);
    mockTaskRepoList.mockImplementation((swimlaneId: string) =>
      BULK_TASKS.filter((task) => task.swimlane_id === swimlaneId));
    mockTaskRepoGetById.mockImplementation((id: string) => BULK_TASKS.find((task) => task.id === id));
    mockTaskRepoGetByDisplayId.mockImplementation((displayId: number) =>
      BULK_TASKS.find((task) => task.display_id === displayId));
  });

  it('echoes at most 25 tasks in the message, with a ", and N more" suffix for the rest', () => {
    const response = handleReorderTasks(
      { column: 'Bulk', taskIds: BULK_TASKS.map((task) => task.id) },
      context,
    );

    expect(response.success).toBe(true);
    // The full order is still written and returned in data - only the message
    // text is capped.
    expect(mockTaskRepoReorderWithinSwimlane).toHaveBeenCalledWith(
      BULK_LANE.id,
      BULK_TASKS.map((task) => task.id),
    );
    expect(response.message).toContain('#200,');
    expect(response.message).toContain(', and 5 more.');
    expect(response.message).not.toContain('#229');
  });
});
