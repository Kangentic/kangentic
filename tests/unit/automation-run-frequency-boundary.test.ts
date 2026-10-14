/**
 * Where a row's Frequency starts counting (`AutomationRunRepository.countRuns`).
 *
 * A task taken back out of Done goes through the board again as if for the
 * first time. #803 came back from Done for more work, and its second Code
 * Review pass ended Ready with the card left where it was: "On to Testing"
 * (`maxRuns: 1`) had spent its one run on the first pass. "On to Merge" and
 * "Finish" would have stalled the same way one column later. So the count runs
 * from the task's newest move OUT of a Done column, by either way out (a drag,
 * or a restore from the Completed list), and a rollback that undoes a failed
 * move into Done is not a return.
 *
 * Real better-sqlite3 with the real migrations, and the moves written by the
 * real `TaskRepository`, so the boundary is read from the rows production writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { AutomationRunStatus, ColumnAutomation, Swimlane } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { frequencyLimitReason } from '../../src/main/automations/automation-runner';
import { openTestDatabase } from './helpers/test-database';

const TASK_ID = 'task-reopened';
const EARLIER = '2026-01-01T00:00:00.000Z';

describe('where Frequency starts counting', () => {
  const openDatabases: DatabaseType.Database[] = [];
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let tasks: TaskRepository;
  let doneLane: Swimlane;
  let executingLane: Swimlane;
  let codeReviewLane: Swimlane;
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

  /** One run of the row, stamped `startedAt` (by default, now). */
  function recordRun(status: AutomationRunStatus, startedAt?: string): void {
    runCounter += 1;
    const id = `run-${runCounter}`;
    const started = { id, automation: onToTesting(), taskId: TASK_ID };
    if (status === 'skipped') runs.recordSkipped(started, 'Condition not met.');
    else {
      runs.start(started);
      runs.finish(id, status, 'Moved to Testing.');
    }
    if (startedAt) database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(startedAt, id);
  }

  it('counts every run of a task that never left Done (the control)', () => {
    placeTask(codeReviewLane);
    recordRun('succeeded', EARLIER);
    recordRun('failed', EARLIER);

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(2);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe('Already ran once on this task, its limit.');
  });

  it('starts over when the task is dragged out of Done, and counts the runs after it', () => {
    placeTask(doneLane);
    recordRun('succeeded', EARLIER);

    tasks.move({ taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 }, { origin: 'renderer' });

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBeNull();
    recordRun('succeeded');
    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe('Already ran once on this task, its limit.');
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
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('move-first-return', TASK_ID, doneLane.id, executingLane.id, 'renderer', null, '2026-01-02T00:00:00.000Z');
    // The run of the second life, before the task went back to Done and out again.
    recordRun('succeeded', '2026-01-03T00:00:00.000Z');
    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);

    tasks.move({ taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 }, { origin: 'renderer' });

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
  });

  it('does not start over on a rollback out of Done: the move into Done failed, so the task never finished', () => {
    placeTask(doneLane);
    recordRun('succeeded', EARLIER);

    tasks.move({ taskId: TASK_ID, targetSwimlaneId: codeReviewLane.id, targetPosition: 0 }, { origin: 'rollback', reason: 'The move into the column failed.' });

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
  });

  it('does not start over on a move INTO Done (the control)', () => {
    placeTask(codeReviewLane);
    recordRun('succeeded', EARLIER);

    tasks.move({ taskId: TASK_ID, targetSwimlaneId: doneLane.id, targetPosition: 0 }, { origin: 'automation' });

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
  });

  it('still never counts a skip, before or after a return', () => {
    placeTask(doneLane);
    recordRun('skipped', EARLIER);
    tasks.move({ taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 }, { origin: 'renderer' });
    recordRun('skipped');

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
  });

  it('counts a run stamped at the same instant as the return: the boundary is inclusive', () => {
    // The destination column's enter rows, and a Done column's own exit rows,
    // can land in the same millisecond as the move row that sets the boundary.
    const returnedAt = '2026-01-02T00:00:00.000Z';
    placeTask(doneLane);
    recordRun('succeeded', EARLIER);
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('move-same-instant-return', TASK_ID, doneLane.id, executingLane.id, 'renderer', null, returnedAt);
    recordRun('succeeded', returnedAt);

    // The run from before the return is out of the count, the one at its own instant is in.
    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
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
    const spentReason = 'Already ran once on this task, its limit.';
    // A fixed instant for the first return, so the run that follows is exactly
    // as old as the move that sets the boundary, the way production writes them.
    const firstReturnedAt = '2026-01-02T00:00:00.000Z';

    // Production order: the move out of Done is written first, then the exit row runs.
    placeTask(doneLane);
    tasks.move({ taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 }, { origin: 'renderer' });
    database.prepare('UPDATE task_moves SET at = ? WHERE task_id = ?').run(firstReturnedAt, TASK_ID);
    runs.start({ id: 'run-done-exit-first', automation: doneExitRow, taskId: TASK_ID });
    runs.finish('run-done-exit-first', 'succeeded', 'Notified.');
    database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(firstReturnedAt, 'run-done-exit-first');

    // Right after its run the row is spent, which is what the return must undo.
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(1);
    expect(frequencyLimitReason(doneExitRow, runs, TASK_ID)).toBe(spentReason);

    // Back into Done is not a return: the row is still spent while the task sits there.
    tasks.move({ taskId: TASK_ID, targetSwimlaneId: doneLane.id, targetPosition: 0 }, { origin: 'automation' });
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(1);

    // Out again. The exit group that runs after this move starts at zero, so the row is not stopped.
    tasks.move({ taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 }, { origin: 'renderer' });
    expect(runs.countRuns(doneExitRow.id, TASK_ID)).toBe(0);
    expect(frequencyLimitReason(doneExitRow, runs, TASK_ID)).toBeNull();
  });
});
