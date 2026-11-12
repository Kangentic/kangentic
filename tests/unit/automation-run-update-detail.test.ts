/**
 * `AutomationRunRepository.updateDetail`, against a real project database.
 *
 * A Move to column run finishes when its move does; its message's fate is
 * written afterwards (#804). That write must replace the detail only: the run's
 * status, finish time and attempts are the move's outcome and stay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { openTestDatabase } from './helpers/test-database';

const TASK_ID = 'task-detail';
const RUN_ID = 'run-detail';
const STARTED_AT = '2026-10-27T18:20:08.000Z';
const FINISHED_AT = '2026-10-27T18:20:09.000Z';

describe('updateDetail', () => {
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let laneId: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    laneId = new SwimlaneRepository(database).list()[1].id;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'Review the change', '', laneId, 0, STARTED_AT, STARTED_AT);
    runs = new AutomationRunRepository(database);
    vi.setSystemTime(new Date(STARTED_AT));
    runs.start({
      id: RUN_ID,
      automation: { id: 'automation-move', name: 'Move on', type: 'move_to_column', swimlane_id: laneId, trigger: 'turn_end' },
      taskId: TASK_ID,
    });
    vi.setSystemTime(new Date(FINISHED_AT));
    runs.finish(RUN_ID, 'succeeded', 'Moved to Testing; its message waits for the agent there.', 1);
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  function readRun(): { status: string; detail: string | null; attempts: number; finished_at: string | null } {
    return database
      .prepare('SELECT status, detail, attempts, finished_at FROM automation_runs WHERE id = ?')
      .get(RUN_ID) as { status: string; detail: string | null; attempts: number; finished_at: string | null };
  }

  it('replaces the detail and leaves the finished run\'s status, finish time and attempts alone', () => {
    // Red if the UPDATE also set status, attempts or finished_at: the move's outcome would change.
    vi.setSystemTime(new Date('2026-10-27T19:00:00.000Z'));
    runs.updateDetail(RUN_ID, 'Moved to Testing, with a message the agent there received.');

    expect(readRun()).toEqual({
      status: 'succeeded',
      detail: 'Moved to Testing, with a message the agent there received.',
      attempts: 1,
      finished_at: FINISHED_AT,
    });
  });

  it('does nothing, and does not throw, for an unknown run id', () => {
    expect(() => runs.updateDetail('run-gone', 'anything')).not.toThrow();

    expect(readRun().detail).toBe('Moved to Testing; its message waits for the agent there.');
    expect(database.prepare('SELECT COUNT(*) AS total FROM automation_runs').get()).toEqual({ total: 1 });
  });
});
