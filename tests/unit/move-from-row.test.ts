/**
 * `moveTaskFromRow` (src/main/automations/turn-end/move-from-row.ts): a Move to
 * column row's move, shared by the turn-end runner and Run again.
 *
 * Both callers run the row outside the task lock, because `handleTaskMove` takes
 * it and the lock is not reentrant. So the helper reads the task again, refuses
 * when it has left the row's column, and hands the move the same column as the
 * `expectedFromSwimlaneId` the move checks again inside its lock.
 *
 * `handleTaskMove` and the message delivery are replaced; the target resolution
 * (`resolveMoveTarget`) is the real, pure one, fed fake columns. The tasks
 * repository is a single stateful row, so a test decides where the task is when
 * the helper reads it, and the mocked move puts it where a real one would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane, Task } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  handleTaskMove: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
  /** The column the stored task row is in right now. Undefined: the row is gone. */
  storedColumnId: undefined as string | undefined,
  /** How many tasks the repository lists per column, for the move's target position. */
  tasksPerColumn: {} as Record<string, number>,
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: hoisted.handleTaskMove }));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageAfterMove: hoisted.deliverMessageAfterMove,
}));

function column(id: string, name: string, position: number): Swimlane {
  return { id, name, position, role: null, is_archived: false, is_ghost: false } as unknown as Swimlane;
}

const REVIEW = column('lane-review', 'Code Review', 3);
const TESTING = column('lane-testing', 'Testing', 4);
const MERGE = column('lane-merge', 'Merge', 5);
const COLUMNS = [REVIEW, TESTING, MERGE];

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: {
      getById: vi.fn(() => (hoisted.storedColumnId === undefined ? undefined : { id: TASK_ID, swimlane_id: hoisted.storedColumnId })),
      list: vi.fn((swimlaneId: string) => Array.from({ length: hoisted.tasksPerColumn[swimlaneId] ?? 0 }, (_unused, index) => ({ id: `task-${index}` }))),
    },
    swimlanes: { list: vi.fn(() => COLUMNS) },
  })),
}));

const { moveTaskFromRow } = await import('../../src/main/automations/turn-end/move-from-row');

const PROJECT_ID = 'proj-move-from-row';
const PROJECT_PATH = '/mock/project';
const TASK_ID = 'task-move-from-row-1';

/**
 * The task as the caller read it BEFORE the move: still in the row's column. It
 * is a stale snapshot whenever the repository says otherwise, which is the case
 * the re-read exists for.
 */
const TASK = { id: TASK_ID, title: 'Document the board', swimlane_id: REVIEW.id, workflow_id: null } as unknown as Task;

const context = { projectRepo: {} } as never;

function moveInput(overrides: Partial<{ column: string | null; message: string | null; reason: string }> = {}) {
  return { column: 'Testing', message: null, reason: 'On to Testing', ...overrides };
}

function run(input: { fromTurnEndGroup?: boolean; move?: ReturnType<typeof moveInput> } = {}) {
  return moveTaskFromRow(context, {
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    task: TASK,
    fromColumn: REVIEW,
    move: input.move ?? moveInput(),
    fromTurnEndGroup: input.fromTurnEndGroup ?? true,
  });
}

describe('moveTaskFromRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.storedColumnId = REVIEW.id;
    hoisted.tasksPerColumn = {};
    // A real move puts the task in its target column.
    hoisted.handleTaskMove.mockImplementation(async (_context: unknown, input: { targetSwimlaneId: string }) => {
      hoisted.storedColumnId = input.targetSwimlaneId;
    });
  });

  describe('when the task has left the row\'s column before the move', () => {
    it('refuses, naming the column, and never calls the move or delivers the message', async () => {
      // The caller's snapshot still says Code Review; the repository says the
      // task is in Merge now. Only a fresh read tells them apart.
      hoisted.storedColumnId = MERGE.id;

      await expect(run({ move: moveInput({ message: 'Run the tests.' }) })).rejects.toThrow(
        'The task left Code Review before it could be moved.',
      );

      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(hoisted.deliverMessageAfterMove).not.toHaveBeenCalled();
    });

    it('refuses the same way when the task row is gone', async () => {
      hoisted.storedColumnId = undefined;

      await expect(run()).rejects.toThrow('The task left Code Review before it could be moved.');

      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
    });
  });

  describe('the move it hands to handleTaskMove', () => {
    it.each([true, false])('is the automation origin, the target column, and the options with fromTurnEndGroup %s', async (fromTurnEndGroup) => {
      hoisted.tasksPerColumn = { [TESTING.id]: 2, [REVIEW.id]: 7 };

      const result = await run({ fromTurnEndGroup });

      expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        // Appended to the target column, which holds two tasks.
        { taskId: TASK_ID, targetSwimlaneId: TESTING.id, targetPosition: 2 },
        'automation',
        PROJECT_ID,
        PROJECT_PATH,
        // The caller's own flag passes through untouched, and the move is told
        // which column to expect the task in once it holds the lock.
        { moveReason: 'On to Testing', fromTurnEndGroup, expectedFromSwimlaneId: REVIEW.id },
      );
      expect(result).toEqual({ columnName: 'Testing' });
    });

    it('resolves Next column from the row\'s column and expects the task there', async () => {
      await run({ move: moveInput({ column: null }) });

      expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ targetSwimlaneId: TESTING.id }),
        'automation',
        PROJECT_ID,
        PROJECT_PATH,
        expect.objectContaining({ expectedFromSwimlaneId: REVIEW.id }),
      );
    });

    it('is never made when the row names a column the board does not have', async () => {
      await expect(run({ move: moveInput({ column: 'Nowhere' }) })).rejects.toThrow('No column named "Nowhere" on this board.');

      expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
      expect(hoisted.deliverMessageAfterMove).not.toHaveBeenCalled();
    });
  });

  describe('when the move returns without the task reaching the target', () => {
    it.each([
      ['stays where it was', REVIEW.id],
      ['is in a different column', MERGE.id],
      ['is gone', undefined],
    ] as const)('throws that the move did not complete, and delivers nothing, when the task %s', async (_label, columnAfterMove) => {
      // A move a newer one superseded resolves without moving the task.
      hoisted.handleTaskMove.mockImplementation(async () => {
        hoisted.storedColumnId = columnAfterMove;
      });

      await expect(run({ move: moveInput({ message: 'Run the tests.' }) })).rejects.toThrow('The move to Testing did not complete.');

      expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
      expect(hoisted.deliverMessageAfterMove).not.toHaveBeenCalled();
    });

    it('lets a rejection from the move itself through, and delivers nothing', async () => {
      hoisted.handleTaskMove.mockRejectedValueOnce(new Error('The task left Code Review before it could be moved.'));

      await expect(run({ move: moveInput({ message: 'Run the tests.' }) })).rejects.toThrow('The task left Code Review before it could be moved.');

      expect(hoisted.deliverMessageAfterMove).not.toHaveBeenCalled();
    });
  });

  describe('the message that follows the task', () => {
    it('is delivered trimmed, to the column the task landed in', async () => {
      await run({ move: moveInput({ message: '  Run the tests.\n' }) });

      expect(hoisted.deliverMessageAfterMove).toHaveBeenCalledTimes(1);
      expect(hoisted.deliverMessageAfterMove).toHaveBeenCalledWith(context, PROJECT_ID, TASK_ID, 'Testing', 'Run the tests.');
    });

    it('is delivered only after the move has landed', async () => {
      await run({ move: moveInput({ message: 'Run the tests.' }) });

      expect(hoisted.deliverMessageAfterMove.mock.invocationCallOrder[0])
        .toBeGreaterThan(hoisted.handleTaskMove.mock.invocationCallOrder[0]);
    });

    it.each([
      ['empty', ''],
      ['blank', '   \n\t '],
      ['absent', null],
    ] as const)('is not delivered when it is %s, though the move still happens', async (_label, message) => {
      const result = await run({ move: moveInput({ message }) });

      expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
      expect(hoisted.deliverMessageAfterMove).not.toHaveBeenCalled();
      expect(result).toEqual({ columnName: 'Testing' });
    });
  });
});
