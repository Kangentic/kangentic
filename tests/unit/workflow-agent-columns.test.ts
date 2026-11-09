/**
 * `{{columns}}` on real, migrated SQLite: one line per column a task can visit,
 * with how many of the last finished tasks went through it once any has
 * finished. The counts come from `task_moves`, which every move writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
const { describeColumnsForPlanning, PERSON_GATE_LINE } = await import('../../src/main/workflows/workflow-agent-prompt');

import { openTestDatabase } from './helpers/test-database';

describe('{{columns}}', () => {
  let db: Database.Database;

  beforeEach(() => {
    harness.dbs.clear();
    db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
  });

  function lane(name: string): string {
    const found = new SwimlaneRepository(db).list().find((candidate) => candidate.name === name || candidate.role === name);
    if (!found) throw new Error(`No column ${name}`);
    return found.id;
  }

  it('names each column a task can visit, and no counts before any task has finished', () => {
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines[0]).toMatch(/^1\. Planning: An agent in plan mode, whose plan the user approves unless a task sets its own planApproval\.$/);
    expect(lines.some((line) => line.includes('finished tasks'))).toBe(false);
  });

  it('says when Kangentic approves a plan column\'s plans', () => {
    new SwimlaneRepository(db).update({ id: lane('Planning'), plan_approval: 'automatic' });
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines[0]).toMatch(/^1\. Planning: An agent in plan mode, whose plan Kangentic approves unless a task sets its own planApproval\.$/);
  });

  it('counts how many of the last finished tasks went through each column', () => {
    const tasks = new TaskRepository(db);
    for (const title of ['One', 'Two']) {
      const task = tasks.create({ title, description: '', swimlane_id: lane('todo') });
      tasks.move({ taskId: task.id, targetSwimlaneId: lane('Executing'), targetPosition: 0 }, { origin: 'workflow' });
      tasks.move({ taskId: task.id, targetSwimlaneId: lane('done'), targetPosition: 0 }, { origin: 'workflow' });
    }
    // Done is the archive lane (`is_archived`), which the counts must still find.
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines.find((line) => line.startsWith('2. Executing'))).toContain('2 of the last 2 finished tasks went through it.');
    expect(lines.find((line) => line.startsWith('1. Planning'))).toContain('0 of the last 2 finished tasks went through it.');
  });

  /**
   * A column whose only exit rows send a task back is a person's gate: the
   * workflow step never moves a card out of it. The planner has to know that,
   * or it puts a sign-off column on a route and the run stops there unplanned.
   */
  describe("a person's gate", () => {
    function setTurnEndRows(
      columnName: string,
      rows: Array<{ name: string; finalLine: string; targetColumn: string; enabled?: boolean; trigger?: 'turn_end' | 'exit' }>,
    ): void {
      new AutomationRepository(db).replaceForColumn(lane(columnName), rows.map((row) => ({
        name: row.name,
        type: 'move_to_column',
        trigger: row.trigger ?? 'turn_end',
        enabled: row.enabled ?? true,
        config: { targetColumn: row.targetColumn },
        final_line: row.finalLine,
      })));
    }

    function lineOf(columnName: string): string {
      const line = describeColumnsForPlanning('home').split('\n').find((candidate) => candidate.includes(`. ${columnName}: `));
      if (!line) throw new Error(`No line for ${columnName}`);
      return line;
    }

    it('says only a person moves a card out of a column whose rows only send it back', () => {
      setTurnEndRows('Code Review', [{ name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing' }]);
      expect(lineOf('Code Review')).toMatch(/^3\. Code Review: An agent\. Only a person moves a card out of it\. /);
    });

    it('says nothing of the kind once a row moves the card forward', () => {
      setTurnEndRows('Code Review', [
        { name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing' },
        { name: 'On', finalLine: 'Verdict: Ready', targetColumn: 'Testing' },
      ]);
      expect(lineOf('Code Review')).not.toContain(PERSON_GATE_LINE);
    });

    it('says nothing of the kind on a column with no exit rows', () => {
      expect(describeColumnsForPlanning('home')).not.toContain(PERSON_GATE_LINE);
    });

    it('ignores a disabled forward row, so an enabled send-back row still makes a gate', () => {
      setTurnEndRows('Code Review', [
        { name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing' },
        { name: 'On', finalLine: 'Verdict: Ready', targetColumn: 'Testing', enabled: false },
      ]);
      expect(lineOf('Code Review')).toContain(PERSON_GATE_LINE);
    });

    it('is not a gate when its only send-back row is disabled', () => {
      setTurnEndRows('Code Review', [{ name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing', enabled: false }]);
      expect(lineOf('Code Review')).not.toContain(PERSON_GATE_LINE);
    });

    it('is not a gate from a send-back row on the exit trigger', () => {
      setTurnEndRows('Code Review', [{ name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing', trigger: 'exit' }]);
      expect(lineOf('Code Review')).not.toContain(PERSON_GATE_LINE);
    });

    it('prints a description with line breaks as one line, adding no line to the output', () => {
      new SwimlaneRepository(db).update({ id: lane('Code Review'), description: 'Reviews the branch.\r\nFixes what it verifies.' });
      const lines = describeColumnsForPlanning('home').split('\n');
      const routeColumnCount = new SwimlaneRepository(db).list()
        .filter((candidate) => !candidate.is_ghost && !candidate.is_archived && candidate.role !== 'todo' && candidate.role !== 'done').length;
      expect(lineOf('Code Review')).toContain('Its purpose: Reviews the branch. Fixes what it verifies.');
      expect(lines).toHaveLength(routeColumnCount);
    });

    it('prints the column\'s purpose beside it', () => {
      new SwimlaneRepository(db).update({ id: lane('Code Review'), description: 'Reviews the branch.' });
      setTurnEndRows('Code Review', [{ name: 'Back', finalLine: 'Verdict: Blocked', targetColumn: 'Executing' }]);
      expect(lineOf('Code Review')).toContain(`${PERSON_GATE_LINE} Its purpose: Reviews the branch.`);
    });
  });
});
