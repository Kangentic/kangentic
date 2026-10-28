/**
 * When a task's `automations_disabled` switch clears, and when it must not
 * (src/main/db/repositories/task-repository.ts), on a real migrated database.
 *
 * The switch is the user's hold on a task: no On task enter, On agent turn end
 * or On task exit row runs for it. It clears in exactly one situation: the task
 * joins a workflow. A task already in a workflow may carry it: there it is the
 * task's own hold out of the workflow (the workflow neither judges, moves nor
 * starts it), so create and update store it as written on a workflow task, and
 * only joining clears it, since a workflow's run starts fresh.
 *
 * Every move keeps it, by any mover, a move out of Done and a restore from the
 * archive included. Finishing a task is not the user changing their mind, so a
 * held task comes back from Done still held, even though its Frequency counts
 * start over there (`AutomationRunRepository.countRuns`). A reorder and an
 * unrelated update keep it too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';
import type { TaskMoveRecordOrigin, TaskWorkflowMembership } from '../../src/shared/types';

describe('the automations switch across moves, unarchive and workflow membership', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let todoLaneId: string;
  let doneLaneId: string;
  let columnAId: string;
  let columnBId: string;
  let membership: TaskWorkflowMembership;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const lanes = new SwimlaneRepository(database).list();
    todoLaneId = lanes.find((lane) => lane.role === 'todo')!.id;
    doneLaneId = lanes.find((lane) => lane.role === 'done')!.id;
    const ordinaryLanes = lanes.filter((lane) => lane.role === null);
    columnAId = ordinaryLanes[0].id;
    columnBId = ordinaryLanes[1].id;
    membership = {
      workflow_id: 'workflow-1',
      workflow_project_id: 'home',
      route_start_swimlane_id: columnAId,
      route_last_swimlane_id: columnBId,
      skipped_swimlane_ids: [],
      canvas_x: null,
      canvas_y: null,
    };
  });

  afterEach(() => {
    database.close();
  });

  /** The value SQLite holds, read without the repository's row mapping. */
  function storedValue(taskId: string): unknown {
    const row = database.prepare('SELECT automations_disabled FROM tasks WHERE id = ?').get(taskId) as { automations_disabled: unknown };
    return row.automations_disabled;
  }

  /** A task with its automations disabled, created in `laneId` (an ordinary column unless named). */
  function disabledTask(title: string, laneId: string = columnAId): string {
    return tasks.create({ title, description: '', swimlane_id: laneId, automations_disabled: true }).id;
  }

  function moveTo(taskId: string, laneId: string, origin: TaskMoveRecordOrigin = 'renderer', targetPosition = 0): void {
    tasks.move({ taskId, targetSwimlaneId: laneId, targetPosition }, { origin });
  }

  describe('leaving Done keeps it', () => {
    // Every mover: a drag, the agent moving its own task, a phone, a plan
    // approval, a workflow step, a Move to column row, and a rollback.
    it.each(['renderer', 'agent', 'mobile', 'auto-move', 'workflow', 'automation', 'rollback'] as const)(
      'keeps it when a %s move takes the task out of Done',
      (origin) => {
        const taskId = disabledTask('Held task');
        moveTo(taskId, doneLaneId);
        expect(storedValue(taskId)).toBe(1);

        moveTo(taskId, columnBId, origin);

        expect(storedValue(taskId)).toBe(1);
        expect(tasks.getById(taskId)!.automations_disabled).toBe(true);
      },
    );

    it('keeps it for a Done task that is archived the way a Done move archives it, once it is moved back out', () => {
      const taskId = disabledTask('Held task');
      moveTo(taskId, doneLaneId);
      tasks.archive(taskId);
      expect(tasks.getById(taskId)!.automations_disabled).toBe(true);

      moveTo(taskId, columnAId);

      expect(storedValue(taskId)).toBe(1);
      expect(tasks.getById(taskId)!.automations_disabled).toBe(true);
    });

    it('keeps it when the task leaves Done for To Do', () => {
      const taskId = disabledTask('Held task');
      moveTo(taskId, doneLaneId);

      moveTo(taskId, todoLaneId);

      expect(storedValue(taskId)).toBe(1);
    });

    it('leaves a task that was never disabled enabled', () => {
      const taskId = tasks.create({ title: 'Plain', description: '', swimlane_id: columnAId }).id;
      moveTo(taskId, doneLaneId);

      moveTo(taskId, columnBId);

      expect(storedValue(taskId)).toBe(0);
    });
  });

  describe('every other move keeps it', () => {
    it('keeps it on a move into Done', () => {
      const taskId = disabledTask('Held task');

      moveTo(taskId, doneLaneId);

      expect(storedValue(taskId)).toBe(1);
    });

    it('keeps it on a move into To Do from an ordinary column', () => {
      const taskId = disabledTask('Held task');

      moveTo(taskId, todoLaneId);

      expect(storedValue(taskId)).toBe(1);
    });

    it('keeps it on a move out of To Do', () => {
      const taskId = disabledTask('Held task', todoLaneId);

      moveTo(taskId, columnAId);

      expect(storedValue(taskId)).toBe(1);
    });

    it('keeps it on a move between ordinary columns', () => {
      const taskId = disabledTask('Held task');

      moveTo(taskId, columnBId);
      moveTo(taskId, columnAId, 'agent');

      expect(storedValue(taskId)).toBe(1);
      expect(tasks.getById(taskId)!.automations_disabled).toBe(true);
    });

    it('keeps it on a reorder inside Done, which is not a move out of it', () => {
      const first = disabledTask('First');
      const second = disabledTask('Second');
      moveTo(first, doneLaneId);
      moveTo(second, doneLaneId);

      moveTo(first, doneLaneId, 'renderer', 1);

      expect(storedValue(first)).toBe(1);
      expect(storedValue(second)).toBe(1);
    });
  });

  describe('unarchive', () => {
    /** A disabled task archived the way a move to Done archives it: in the Done column. */
    function archivedInDone(): string {
      const taskId = disabledTask('Held task');
      moveTo(taskId, doneLaneId);
      tasks.archive(taskId);
      return taskId;
    }

    it('keeps it when the task is brought back to an ordinary column', () => {
      const taskId = archivedInDone();
      expect(tasks.listArchived().map((task) => task.id)).toEqual([taskId]);
      expect(storedValue(taskId)).toBe(1);

      const restored = tasks.unarchive(taskId, columnAId, 0);

      expect(restored.automations_disabled).toBe(true);
      expect(restored.archived_at).toBeNull();
      expect(restored.swimlane_id).toBe(columnAId);
      expect(storedValue(taskId)).toBe(1);
    });

    it('keeps it when the task is brought back into To Do', () => {
      const taskId = archivedInDone();

      const restored = tasks.unarchive(taskId, todoLaneId, 0);

      expect(restored.automations_disabled).toBe(true);
      expect(storedValue(taskId)).toBe(1);
    });

    it('leaves a task that was never disabled alone', () => {
      const taskId = tasks.create({ title: 'Plain', description: '', swimlane_id: columnAId }).id;
      moveTo(taskId, doneLaneId);
      tasks.archive(taskId);

      const restored = tasks.unarchive(taskId, columnAId, 0);

      expect(restored.automations_disabled).toBe(false);
    });
  });

  describe('a workflow task may carry it, as its own hold', () => {
    it('create with a workflow stores true when the input says true', () => {
      const created = tasks.create({
        title: 'Workflow step',
        description: '',
        swimlane_id: columnAId,
        automations_disabled: true,
        workflow: membership,
      });

      expect(created.automations_disabled).toBe(true);
      expect(created.workflow_id).toBe('workflow-1');
      expect(storedValue(created.id)).toBe(1);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(true);
    });

    it('create with a workflow stores false when the input says nothing', () => {
      const created = tasks.create({ title: 'Workflow step', description: '', swimlane_id: columnAId, workflow: membership });

      expect(created.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
    });

    it('create without a workflow still honors true (the control)', () => {
      const created = tasks.create({
        title: 'Ordinary',
        description: '',
        swimlane_id: columnAId,
        automations_disabled: true,
      });

      expect(created.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
    });

    it('update to true on a workflow task stores true, in the returned row and in SQLite', () => {
      const created = tasks.create({ title: 'Workflow step', description: '', swimlane_id: columnAId, workflow: membership });

      const updated = tasks.update({ id: created.id, automations_disabled: true });

      expect(updated.automations_disabled).toBe(true);
      expect(updated.workflow_id).toBe('workflow-1');
      expect(storedValue(created.id)).toBe(1);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(true);
    });

    it('update to false on a held workflow task releases it, in the returned row and in SQLite', () => {
      const created = tasks.create({
        title: 'Workflow step',
        description: '',
        swimlane_id: columnAId,
        automations_disabled: true,
        workflow: membership,
      });

      const updated = tasks.update({ id: created.id, automations_disabled: false });

      expect(updated.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
      expect(tasks.getById(created.id)!.workflow_id).toBe('workflow-1');
    });

    it('update to true on an ordinary task stores true (the control)', () => {
      const created = tasks.create({ title: 'Ordinary', description: '', swimlane_id: columnAId });

      const updated = tasks.update({ id: created.id, automations_disabled: true });

      expect(updated.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
    });

    it('an unrelated update keeps a workflow task as it was: false when it was not held', () => {
      const created = tasks.create({ title: 'Workflow step', description: '', swimlane_id: columnAId, workflow: membership });

      const renamed = tasks.update({ id: created.id, title: 'Workflow step, renamed' });

      expect(renamed.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
    });

    it('an unrelated update keeps a held workflow task held', () => {
      const created = tasks.create({
        title: 'Workflow step',
        description: '',
        swimlane_id: columnAId,
        automations_disabled: true,
        workflow: membership,
      });

      const renamed = tasks.update({ id: created.id, title: 'Workflow step, renamed' });

      expect(renamed.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
    });

    it.each(['renderer', 'agent', 'workflow', 'auto-move'] as const)(
      'a %s move keeps a held workflow task held, into an ordinary column and into Done',
      (origin) => {
        const created = tasks.create({
          title: 'Workflow step',
          description: '',
          swimlane_id: columnAId,
          automations_disabled: true,
          workflow: membership,
        });

        moveTo(created.id, columnBId, origin);
        expect(storedValue(created.id)).toBe(1);

        moveTo(created.id, doneLaneId, origin);
        expect(storedValue(created.id)).toBe(1);
      },
    );

    it('joining a workflow clears a disabled task, in SQLite and on the next read', () => {
      const taskId = disabledTask('Held task');
      expect(storedValue(taskId)).toBe(1);

      tasks.setWorkflowMembership(taskId, membership);

      expect(storedValue(taskId)).toBe(0);
      const joined = tasks.getById(taskId)!;
      expect(joined.automations_disabled).toBe(false);
      expect(joined.workflow_id).toBe('workflow-1');
    });

    it('joining a workflow leaves an enabled task enabled', () => {
      const taskId = tasks.create({ title: 'Plain', description: '', swimlane_id: columnAId }).id;

      tasks.setWorkflowMembership(taskId, membership);

      expect(storedValue(taskId)).toBe(0);
    });

    it('releasing a task from a workflow does not touch the switch', () => {
      const taskId = disabledTask('Held task');

      tasks.setWorkflowMembership(taskId, null);

      expect(storedValue(taskId)).toBe(1);
    });

    it('a released task can be disabled again, because it is an ordinary task once more', () => {
      const created = tasks.create({ title: 'Workflow step', description: '', swimlane_id: columnAId, workflow: membership });
      tasks.setWorkflowMembership(created.id, null);

      const updated = tasks.update({ id: created.id, automations_disabled: true });

      expect(updated.workflow_id).toBeNull();
      expect(updated.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
    });
  });
});
