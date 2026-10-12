/**
 * `TaskRepository.releaseAllWorkflowMembers` and `releaseMembersOfHome` on a
 * real migrated database.
 *
 * Both are for a project delete: a task released is an ordinary task again, as
 * `setWorkflowMembership(id, null)` leaves it. A release that missed one of the
 * seven workflow columns would leave a half-membership behind: a route for a
 * workflow nothing holds, or a canvas position on the auto layout. So each test
 * seeds a task with EVERY column set, releases, and reads the columns back with
 * a raw SELECT rather than through the repository's own row mapping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';
import type { TaskWorkflowMembership } from '../../src/shared/types';

const WORKFLOW_COLUMNS = [
  'workflow_id',
  'workflow_project_id',
  'route_start_swimlane_id',
  'route_last_swimlane_id',
  'skipped_swimlane_ids',
  'canvas_x',
  'canvas_y',
] as const;

type WorkflowColumns = Record<(typeof WORKFLOW_COLUMNS)[number], unknown>;

describe('releasing workflow members from a board (a project delete)', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let membershipFor: (homeProjectId: string) => TaskWorkflowMembership;
  let todoLaneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const lanes = new SwimlaneRepository(database).list();
    todoLaneId = lanes.find((lane) => lane.role === 'todo')!.id;
    const [, routeStart, skipped, routeLast] = lanes;
    // Every one of the seven columns non-null: a non-empty skipped list and a canvas position included.
    membershipFor = (homeProjectId) => ({
      workflow_id: `workflow-in-${homeProjectId}`,
      workflow_project_id: homeProjectId,
      route_start_swimlane_id: routeStart.id,
      route_last_swimlane_id: routeLast.id,
      skipped_swimlane_ids: [skipped.id],
      canvas_x: 40,
      canvas_y: 60,
    });
  });

  afterEach(() => {
    database.close();
  });

  /** A task in a workflow homed in `homeProjectId`, with all seven columns set. */
  function memberOf(homeProjectId: string, title: string, options: { archived?: boolean } = {}): string {
    const task = tasks.create({ title, description: '', swimlane_id: todoLaneId });
    tasks.setWorkflowMembership(task.id, membershipFor(homeProjectId));
    if (options.archived) {
      database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), task.id);
    }
    return task.id;
  }

  function ordinaryTask(title: string): string {
    return tasks.create({ title, description: '', swimlane_id: todoLaneId }).id;
  }

  /** The seven workflow columns of a row, as SQLite holds them. */
  function workflowColumns(taskId: string): WorkflowColumns {
    return database.prepare(`SELECT ${WORKFLOW_COLUMNS.join(', ')} FROM tasks WHERE id = ?`).get(taskId) as WorkflowColumns;
  }

  const ALL_NULL: WorkflowColumns = {
    workflow_id: null,
    workflow_project_id: null,
    route_start_swimlane_id: null,
    route_last_swimlane_id: null,
    skipped_swimlane_ids: null,
    canvas_x: null,
    canvas_y: null,
  };

  /** What `membershipFor` writes, as SQLite holds it (the skipped list is JSON text). */
  function storedMembership(homeProjectId: string): WorkflowColumns {
    const membership = membershipFor(homeProjectId);
    return { ...membership, skipped_swimlane_ids: JSON.stringify(membership.skipped_swimlane_ids) };
  }

  it('seeds a member with all seven workflow columns set, so a release has something to clear in each', () => {
    const taskId = memberOf('home', 'Budgets API');

    const columns = workflowColumns(taskId);

    expect(Object.keys(columns)).toEqual([...WORKFLOW_COLUMNS]);
    for (const column of WORKFLOW_COLUMNS) expect(columns[column], column).not.toBeNull();
    expect(columns).toEqual(storedMembership('home'));
  });

  describe('releaseAllWorkflowMembers', () => {
    it('sets all seven workflow columns to NULL on every member, whatever its home, archived ones included', () => {
      const inHome = memberOf('home', 'Budgets API');
      const inOther = memberOf('mobile', 'Budgets on the phone');
      const archived = memberOf('home', 'Budgets docs', { archived: true });

      const released = tasks.releaseAllWorkflowMembers();

      expect(released).toBe(3);
      expect(workflowColumns(inHome)).toEqual(ALL_NULL);
      expect(workflowColumns(inOther)).toEqual(ALL_NULL);
      expect(workflowColumns(archived)).toEqual(ALL_NULL);
    });

    it('leaves an ordinary task and every other column of a released one as they were, updated_at included', () => {
      const memberId = memberOf('home', 'Budgets API');
      const ordinaryId = ordinaryTask('Fix the typo');
      const memberBefore = tasks.getById(memberId)!;
      const ordinaryBefore = tasks.getById(ordinaryId)!;

      tasks.releaseAllWorkflowMembers();

      const memberAfter = tasks.getById(memberId)!;
      expect(memberAfter.title).toBe('Budgets API');
      expect(memberAfter.swimlane_id).toBe(memberBefore.swimlane_id);
      expect(memberAfter.updated_at).toBe(memberBefore.updated_at);
      expect(tasks.getById(ordinaryId)).toEqual(ordinaryBefore);
    });

    it('returns 0 and changes nothing when no task is in a workflow, and when called again', () => {
      const ordinaryId = ordinaryTask('Fix the typo');
      expect(tasks.releaseAllWorkflowMembers()).toBe(0);
      expect(workflowColumns(ordinaryId)).toEqual(ALL_NULL);

      memberOf('home', 'Budgets API');
      expect(tasks.releaseAllWorkflowMembers()).toBe(1);
      expect(tasks.releaseAllWorkflowMembers()).toBe(0);
    });
  });

  describe('releaseMembersOfHome', () => {
    it('sets all seven workflow columns to NULL on every task homed there, archived ones included, and returns how many', () => {
      const live = memberOf('mobile', 'Budgets on the phone');
      const archived = memberOf('mobile', 'Budgets docs', { archived: true });

      const released = tasks.releaseMembersOfHome('mobile');

      expect(released).toBe(2);
      expect(workflowColumns(live)).toEqual(ALL_NULL);
      expect(workflowColumns(archived)).toEqual(ALL_NULL);
    });

    it('leaves a task homed elsewhere, and an ordinary task, untouched in all seven columns', () => {
      const homedElsewhere = memberOf('home', 'Budgets API');
      const homedThere = memberOf('mobile', 'Budgets on the phone');
      const ordinaryId = ordinaryTask('Fix the typo');

      expect(tasks.releaseMembersOfHome('mobile')).toBe(1);

      expect(workflowColumns(homedThere)).toEqual(ALL_NULL);
      expect(workflowColumns(homedElsewhere)).toEqual(storedMembership('home'));
      expect(workflowColumns(ordinaryId)).toEqual(ALL_NULL);
    });

    it('returns 0 and changes nothing for a home no task names', () => {
      const member = memberOf('home', 'Budgets API');

      expect(tasks.releaseMembersOfHome('deleted-project')).toBe(0);

      expect(workflowColumns(member)).toEqual(storedMembership('home'));
    });
  });
});
