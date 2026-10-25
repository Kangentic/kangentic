/**
 * Where a row's Frequency starts counting (`AutomationRunRepository.countRuns`):
 * at the newer of the task's last move by a person to another column and its
 * last move out of Done.
 *
 * A person who sends a card back means it to go through those columns again.
 * Code Review's "On to Merge" (`maxRuns: 1`) ran on the first review, the
 * deploy failed, and the user dragged the card back through Executing to Code
 * Review. The second review ended `Verdict: Ship`, and the
 * row skipped with its one run spent, so the card sat in Code Review.
 *
 * A task taken back out of Done goes through the board again as if for the
 * first time, whoever moved it. #803 came back from Done for more work, and its
 * second Code Review pass ended Ready with the card left where it was: "On to
 * Testing" had spent its one run on the first pass. A rollback that undoes a
 * failed move into Done is not a return.
 *
 * The board's own moves never start it over (an agent's, an automation's, an
 * auto-move's, a workflow's), so a review loop keeps its round-trip limit and
 * an agent cannot reset its own with `kangentic_move_task`.
 *
 * Real better-sqlite3 with the real migrations, and the moves written by the
 * real `TaskRepository`, so the boundary is read from the rows production writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { AutomationRunStatus, ColumnAutomation, Swimlane, TaskMoveRecordOrigin } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskMoveRepository } from '../../src/main/db/repositories/task-move-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { frequencyLimitReason } from '../../src/main/automations/automation-runner';
import { openTestDatabase } from './helpers/test-database';

const TASK_ID = 'task-reopened';
const EARLIER = '2026-01-01T00:00:00.000Z';
const SPENT_REASON = 'Already ran once on this task, its limit.';

describe('where Frequency starts counting', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let tasks: TaskRepository;
  let doneLane: Swimlane;
  let executingLane: Swimlane;
  let codeReviewLane: Swimlane;
  let mergeLane: Swimlane;
  let runCounter = 0;

  beforeEach(() => {
    database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database).list();
    doneLane = lanes.find((lane) => lane.role === 'done')!;
    executingLane = lanes.find((lane) => lane.name === 'Executing')!;
    codeReviewLane = lanes.find((lane) => lane.name === 'Code Review')!;
    mergeLane = lanes.find((lane) => lane.name === 'Merge')!;
    runs = new AutomationRunRepository(database);
    tasks = new TaskRepository(database);
  });

  afterEach(() => {
    for (const opened of openDatabases.splice(0)) opened.close();
  });

  const onToTesting = (): ColumnAutomation => ({
    id: 'row-on-to-testing',
    swimlane_id: codeReviewLane.id,
    name: 'On to Testing',
    type: 'move_to_column',
    trigger: 'turn_end',
    position: 0,
    enabled: true,
    config: { targetColumn: 'Testing' },
    condition: null,
    max_runs: 1,
    created_at: EARLIER,
    updated_at: EARLIER,
  });

  /** A task sitting in `lane`, archived when the lane is Done, as `handleTaskMove` leaves it. */
  function placeTask(lane: Swimlane): void {
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'A reopened task', '', lane.id, 0, lane.role === 'done' ? EARLIER : null, EARLIER, EARLIER);
  }

  /** One run of `automation` (by default, On to Testing), stamped `startedAt` (by default, now). */
  function recordRun(status: AutomationRunStatus, startedAt?: string, automation: ColumnAutomation = onToTesting()): void {
    runCounter += 1;
    const id = `run-${runCounter}`;
    const started = { id, automation, taskId: TASK_ID };
    if (status === 'skipped') runs.recordSkipped(started, 'Condition not met.');
    else {
      runs.start(started);
      runs.finish(id, status, 'Moved to Testing.');
    }
    if (startedAt) database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(startedAt, id);
  }

  /** A `task_moves` row written by hand: at a fixed instant, or in a shape `TaskRepository` never writes. */
  function insertMove(id: string, from: Swimlane | null, to: Swimlane, origin: TaskMoveRecordOrigin, at: string): void {
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, TASK_ID, from?.id ?? null, to.id, origin, null, at);
  }

  function moveTask(lane: Swimlane, origin: TaskMoveRecordOrigin): void {
    tasks.move({ taskId: TASK_ID, targetSwimlaneId: lane.id, targetPosition: 0 }, { origin });
  }

  it('counts every run of a task nobody moved (the control)', () => {
    placeTask(codeReviewLane);
    recordRun('succeeded', EARLIER);
    recordRun('failed', EARLIER);

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(2);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);
  });

  describe('a move a person makes', () => {
    it('starts over when the user drags a card back for another pass', () => {
      // The row ran on the first review, and the board moved the task on.
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);
      moveTask(mergeLane, 'automation');
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);

      // The deploy failed, and the user dragged the card back through Executing to Code Review.
      moveTask(executingLane, 'renderer');
      moveTask(codeReviewLane, 'renderer');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBeNull();
      // The second review's run is the one that counts now, and it spends the limit again.
      recordRun('succeeded');
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);
    });

    // Only the person's half of the boundary has a row here, and only the Done
    // half in the agent case below, so a boundary that went NULL whenever one
    // half had no row would count every run and fail both.
    it.each(['renderer', 'mobile'] as const)('starts over on a %s move between two columns, with no move out of Done', (origin) => {
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);

      moveTask(executingLane, origin);

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBeNull();
    });

    it('does not start over on a reorder inside the column, which records no move', () => {
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      moveTask(codeReviewLane, 'renderer');

      expect(new TaskMoveRepository(database).listForTask(TASK_ID)).toEqual([]);
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });

    it('does not start over on a person\'s row that stayed in its column', () => {
      // `TaskRepository` never writes one, but a row whose two columns are the same is not a move.
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      insertMove('move-same-column', codeReviewLane, codeReviewLane, 'renderer', '2026-01-02T00:00:00.000Z');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });

    it('does not start over on a row with no column it came from, since the task was born there', () => {
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      insertMove('move-born-into-column', null, codeReviewLane, 'renderer', '2026-01-02T00:00:00.000Z');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });
  });

  describe('a move no person made', () => {
    // Back for revisions keeps its round-trip limit, and an agent's own
    // `kangentic_move_task` cannot reset it, even when a person asked for it in chat.
    it.each(['agent', 'automation', 'auto-move', 'workflow', 'rollback'] as const)('keeps the count on a %s move between two columns', (origin) => {
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      moveTask(executingLane, origin);

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);
    });
  });

  describe('a move out of Done', () => {
    it('starts over when the task is dragged out of Done, and counts the runs after it', () => {
      placeTask(doneLane);
      recordRun('succeeded', EARLIER);

      moveTask(executingLane, 'renderer');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBeNull();
      recordRun('succeeded');
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
      expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);
    });

    it('starts over on an agent\'s move out of Done: leaving Done resets the count whoever moved the task', () => {
      placeTask(doneLane);
      recordRun('succeeded', EARLIER);

      moveTask(executingLane, 'agent');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    });

    it('starts over when the task is restored from the Completed list', () => {
      placeTask(doneLane);
      recordRun('succeeded', EARLIER);

      tasks.unarchive(TASK_ID, executingLane.id, 0);

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    });

    it('counts from the newest return when a task leaves Done twice', () => {
      placeTask(doneLane);
      recordRun('succeeded', EARLIER);
      insertMove('move-first-return', doneLane, executingLane, 'renderer', '2026-01-02T00:00:00.000Z');
      // The run of the second life, before the task went back to Done and out again.
      recordRun('succeeded', '2026-01-03T00:00:00.000Z');
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);

      moveTask(executingLane, 'renderer');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    });

    it('does not start over on a rollback out of Done: the move into Done failed, so the task never finished', () => {
      placeTask(doneLane);
      recordRun('succeeded', EARLIER);

      tasks.move({ taskId: TASK_ID, targetSwimlaneId: codeReviewLane.id, targetPosition: 0 }, { origin: 'rollback', reason: 'The move into the column failed.' });

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });

    // A person's drag into Done that fails writes its own row, then a rollback row
    // out of Done. The drag starts the count over, and the rollback neither resets
    // it nor undoes the reset. Every instant is fixed: `moveTask` stamps now, so a
    // run could tie the rollback's instant and be counted even by a rollback that
    // set the boundary, and the test could not go red.
    it.each(['renderer', 'mobile'] as const)('starts over at a failed %s drag into Done, and its rollback leaves the count alone', (origin) => {
      const dragAt = '2026-01-02T00:00:00.000Z';
      const runAfterDragAt = '2026-01-03T00:00:00.000Z';
      const rollbackAt = '2026-01-04T00:00:00.000Z';
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      insertMove('move-failed-drag', codeReviewLane, doneLane, origin, dragAt);
      // The drag is a person's move to another column, so the earlier run is out of the count.
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);

      recordRun('succeeded', runAfterDragAt);
      insertMove('move-rollback', doneLane, codeReviewLane, 'rollback', rollbackAt);

      // The run after the drag still counts, and the one before it does not.
      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });

    it('does not start over on a move INTO Done by the board (the control)', () => {
      placeTask(codeReviewLane);
      recordRun('succeeded', EARLIER);

      moveTask(doneLane, 'automation');

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    });
  });

  describe('the newer of the two moves', () => {
    const FIRST_MOVE_AT = '2026-01-02T00:00:00.000Z';
    const BETWEEN_THE_MOVES = '2026-01-03T00:00:00.000Z';
    const SECOND_MOVE_AT = '2026-01-04T00:00:00.000Z';

    it('counts from a person\'s move that came after the task left Done', () => {
      placeTask(codeReviewLane);
      insertMove('move-out-of-done', doneLane, executingLane, 'agent', FIRST_MOVE_AT);
      recordRun('succeeded', BETWEEN_THE_MOVES);
      insertMove('move-by-hand', executingLane, codeReviewLane, 'renderer', SECOND_MOVE_AT);

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    });

    it('counts from a move out of Done that came after a person\'s move', () => {
      placeTask(executingLane);
      insertMove('move-by-hand', codeReviewLane, doneLane, 'mobile', FIRST_MOVE_AT);
      recordRun('succeeded', BETWEEN_THE_MOVES);
      insertMove('move-out-of-done', doneLane, executingLane, 'automation', SECOND_MOVE_AT);

      expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    });
  });

  it('still never counts a skip, before or after a return', () => {
    placeTask(doneLane);
    recordRun('skipped', EARLIER);
    moveTask(executingLane, 'renderer');
    recordRun('skipped');

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
  });

  it('counts a run stamped at the same instant as the return: the boundary is inclusive', () => {
    // The destination column's enter rows, and a Done column's own exit rows,
    // can land in the same millisecond as the move row that sets the boundary.
    const returnedAt = '2026-01-02T00:00:00.000Z';
    placeTask(doneLane);
    recordRun('succeeded', EARLIER);
    insertMove('move-same-instant-return', doneLane, executingLane, 'renderer', returnedAt);
    recordRun('succeeded', returnedAt);

    // The run from before the return is out of the count, the one at its own instant is in.
    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
  });

  // One rule for every trigger. The move is written before the groups it fires
  // run, so a person's move starts an enter row's count at zero: on enter and
  // exit, Frequency limits only the moves the board makes.
  it('starts an enter row over at every move a person makes into its column, and keeps it across the board\'s', () => {
    const enterOnce: ColumnAutomation = {
      id: 'row-enter-once',
      swimlane_id: executingLane.id,
      name: 'Tell me it started',
      type: 'notify',
      trigger: 'enter',
      position: 0,
      enabled: true,
      config: { title: '{{title}}', body: '{{toColumn}}' },
      condition: null,
      max_runs: 1,
      created_at: EARLIER,
      updated_at: EARLIER,
    };
    placeTask(codeReviewLane);

    // Back for revisions sends the task into the column, and the enter row runs.
    moveTask(executingLane, 'automation');
    // Stamped before every move that follows, which are stamped now.
    recordRun('succeeded', EARLIER, enterOnce);
    expect(frequencyLimitReason(enterOnce, runs, TASK_ID)).toBe(SPENT_REASON);

    // Another round of the loop, all of it the board's: still spent.
    moveTask(codeReviewLane, 'automation');
    moveTask(executingLane, 'automation');
    expect(runs.countRuns(enterOnce.id, TASK_ID)).toBe(1);
    expect(frequencyLimitReason(enterOnce, runs, TASK_ID)).toBe(SPENT_REASON);

    // The user drags it back into the column. The enter group that follows starts at zero.
    moveTask(codeReviewLane, 'automation');
    moveTask(executingLane, 'renderer');
    expect(runs.countRuns(enterOnce.id, TASK_ID)).toBe(0);
    expect(frequencyLimitReason(enterOnce, runs, TASK_ID)).toBeNull();
  });

  it('starts a Done column\'s own exit row at zero at every return, so its Frequency never stops it', () => {
    const doneExitRow: ColumnAutomation = {
      id: 'row-done-exit',
      swimlane_id: doneLane.id,
      name: 'Tell me it finished',
      type: 'notify',
      trigger: 'exit',
      position: 0,
      enabled: true,
      config: { title: '{{title}}', body: '{{toColumn}}' },
      condition: null,
      max_runs: 1,
      created_at: EARLIER,
      updated_at: EARLIER,
    };
    // A fixed instant for the first return, so the run that follows is exactly
    // as old as the move that sets the boundary, the way production writes them.
    const firstReturnedAt = '2026-01-02T00:00:00.000Z';

    // Production order: the move out of Done is written first, then the exit row runs.
    placeTask(doneLane);
    moveTask(executingLane, 'renderer');
    database.prepare('UPDATE task_moves SET at = ? WHERE task_id = ?').run(firstReturnedAt, TASK_ID);
    runs.start({ id: 'run-done-exit-first', automation: doneExitRow, taskId: TASK_ID });
    runs.finish('run-done-exit-first', 'succeeded', 'Notified.');
    database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(firstReturnedAt, 'run-done-exit-first');

    // Right after its run the row is spent, which is what the return must undo.
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(1);
    expect(frequencyLimitReason(doneExitRow, runs, TASK_ID)).toBe(SPENT_REASON);

    // Back into Done is not a return: the row is still spent while the task sits there.
    moveTask(doneLane, 'automation');
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(1);

    // Out again. The exit group that runs after this move starts at zero, so the row is not stopped.
    moveTask(executingLane, 'renderer');
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(0);
    expect(frequencyLimitReason(doneExitRow, runs, TASK_ID)).toBeNull();
  });
});
