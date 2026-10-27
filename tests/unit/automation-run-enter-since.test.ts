/**
 * `AutomationRunRepository.hasEnterRunSince`, against a real project database.
 *
 * The startup pass hands a task that never had an agent to the board path, which
 * runs the column's enter automations before it starts the agent. That is right
 * for a move a quit cut short before its spawn step. It is wrong for a move
 * whose agent failed to start after the enter group ran (a missing CLI leaves no
 * session row): handing that task off at every launch would run its webhook,
 * notify, script and Move to column rows again each time. This query is how the
 * pass tells the two apart: has any enter row of the task's column recorded a
 * run on it since the task entered the column?
 *
 * Rows are written through the repository's own `start` and `recordSkipped`, at
 * a pinned clock, so the test reads what the runner writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { openTestDatabase } from './helpers/test-database';

const TASK_ID = 'task-first-agent';
const VISIT_STARTED_AT = '2026-10-27T18:20:08.000Z';
const BEFORE_THE_VISIT = '2026-10-27T18:00:00.000Z';
const DURING_THE_VISIT = '2026-10-27T18:20:09.000Z';

describe('hasEnterRunSince', () => {
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let laneId: string;
  let otherLaneId: string;
  let runCounter = 0;

  function automation(
    swimlaneId: string,
    trigger: ColumnAutomation['trigger'],
  ): Pick<ColumnAutomation, 'id' | 'name' | 'type' | 'swimlane_id' | 'trigger'> {
    return { id: `automation-${swimlaneId}-${trigger}`, name: 'Notify', type: 'notify', swimlane_id: swimlaneId, trigger };
  }

  function recordRunAt(at: string, swimlaneId: string, trigger: ColumnAutomation['trigger']): void {
    vi.setSystemTime(new Date(at));
    runCounter += 1;
    runs.start({ id: `run-${runCounter}`, automation: automation(swimlaneId, trigger), taskId: TASK_ID });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database).list();
    laneId = lanes[1].id;
    otherLaneId = lanes[2].id;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'Extract the settings strings', '', laneId, 0, BEFORE_THE_VISIT, BEFORE_THE_VISIT);
    runs = new AutomationRunRepository(database);
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it('is false when the column\'s enter group never ran on the task', () => {
    expect(runs.hasEnterRunSince(TASK_ID, laneId, VISIT_STARTED_AT)).toBe(false);
  });

  it('is true for an enter run since the task entered the column', () => {
    recordRunAt(DURING_THE_VISIT, laneId, 'enter');

    expect(runs.hasEnterRunSince(TASK_ID, laneId, VISIT_STARTED_AT)).toBe(true);
  });

  it('counts a skipped enter row: the group still ran', () => {
    vi.setSystemTime(new Date(DURING_THE_VISIT));
    runs.recordSkipped({ id: 'run-skipped', automation: automation(laneId, 'enter'), taskId: TASK_ID }, 'Needs an agent');

    expect(runs.hasEnterRunSince(TASK_ID, laneId, VISIT_STARTED_AT)).toBe(true);
  });

  it('ignores an enter run from an earlier visit to the column', () => {
    recordRunAt(BEFORE_THE_VISIT, laneId, 'enter');

    expect(runs.hasEnterRunSince(TASK_ID, laneId, VISIT_STARTED_AT)).toBe(false);
  });

  it('ignores another column\'s enter run, and this column\'s other triggers', () => {
    recordRunAt(DURING_THE_VISIT, otherLaneId, 'enter');
    recordRunAt(DURING_THE_VISIT, laneId, 'exit');
    recordRunAt(DURING_THE_VISIT, laneId, 'turn_end');

    expect(runs.hasEnterRunSince(TASK_ID, laneId, VISIT_STARTED_AT)).toBe(false);
  });

  it('counts every run when no visit boundary is known, as hasRunSince does', () => {
    recordRunAt(BEFORE_THE_VISIT, laneId, 'enter');

    expect(runs.hasEnterRunSince(TASK_ID, laneId, null)).toBe(true);
    expect(runs.hasEnterRunSince(TASK_ID, otherLaneId, null)).toBe(false);
  });
});
