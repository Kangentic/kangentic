/**
 * The `automationsDisabled` switch inside the MCP command handlers
 * (src/main/agent/commands/task-commands.ts and search-commands.ts), on a real
 * migrated database with real repositories.
 *
 * The tool layer (zod schema, the "at least one field" gate, forwarding) is in
 * mcp-task-tools-automations-disabled-wiring.test.ts. This file covers what the
 * handler does with the value:
 *
 * - **create** writes the row, and only a real boolean counts. The mobile bridge
 *   hands raw wire params straight to the handler, so a truthy string must be
 *   refused rather than disable a task's automations.
 * - **update** writes the row, refuses `true` on a workflow task (its workflow's
 *   Pause is the control), and allows `false` there. A write that names only the
 *   switch is a real change, and never restarts the running session: the live
 *   settings hook (`onTaskSettingsChanged`) is for model and effort moves only.
 * - **find_task** and **get_current_task** say so when a task is held, and carry
 *   a strict boolean in `data`, so an agent reading its own task learns the
 *   board will not advance it.
 *
 * The runMode row of the settings hook test is the control for "never calls
 * onTaskSettingsChanged": the same real handler does call it for a run mode
 * switch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';
import { AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL } from '../../src/shared/automation-manifest';
import type { Task, TaskWorkflowMembership } from '../../src/shared/types';

// Transitively imported by task-commands.ts; the PR linker is not under test.
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPRForTask: vi.fn() }));

import { handleCreateTask, handleUpdateTask } from '../../src/main/agent/commands/task-commands';
import { handleFindTask, handleGetCurrentTask } from '../../src/main/agent/commands/search-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

const PARAM_ERROR = 'automationsDisabled must be true or false.';

describe('automationsDisabled in the MCP command handlers', () => {
  let database: DatabaseType.Database;
  let tasks: TaskRepository;
  let todoLaneId: string;
  let columnAId: string;
  let columnBId: string;
  let context: CommandContext;
  let onTaskCreated: ReturnType<typeof vi.fn>;
  let onTaskUpdated: ReturnType<typeof vi.fn>;
  let onTaskSettingsChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const lanes = new SwimlaneRepository(database).list();
    todoLaneId = lanes.find((lane) => lane.role === 'todo')!.id;
    const ordinaryLanes = lanes.filter((lane) => lane.role === null);
    columnAId = ordinaryLanes[0].id;
    columnBId = ordinaryLanes[1].id;

    onTaskCreated = vi.fn();
    onTaskUpdated = vi.fn();
    onTaskSettingsChanged = vi.fn();
    context = {
      getProjectDb: () => database,
      getProjectPath: () => '/mock/project',
      getBoardProfiles: () => [],
      setBoardProfiles: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
      onTaskCreated,
      onTaskUpdated,
      onTaskSettingsChanged,
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn(async () => {}),
      onTasksReordered: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
    } as unknown as CommandContext;
  });

  afterEach(() => {
    database.close();
  });

  /** The value SQLite holds, read without the repository's row mapping. */
  function storedValue(taskId: string): unknown {
    const row = database.prepare('SELECT automations_disabled FROM tasks WHERE id = ?').get(taskId) as { automations_disabled: unknown };
    return row.automations_disabled;
  }

  function taskCount(): number {
    return (database.prepare('SELECT COUNT(*) AS total FROM tasks').get() as { total: number }).total;
  }

  /** The tool forwards every omitted field as null; the switch is passed explicitly per test. */
  function updateParams(taskId: string, overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      taskId,
      title: null,
      description: null,
      descriptionEdits: null,
      appendDescription: null,
      prUrl: null,
      prNumber: null,
      agent: null,
      priority: null,
      labels: null,
      baseBranch: null,
      useWorktree: null,
      attachments: null,
      ...overrides,
    };
  }

  function membership(): TaskWorkflowMembership {
    return {
      workflow_id: 'workflow-1',
      workflow_project_id: 'home',
      route_start_swimlane_id: columnAId,
      route_last_swimlane_id: columnBId,
      skipped_swimlane_ids: [],
      canvas_x: null,
      canvas_y: null,
    };
  }

  function ordinaryTask(options: { disabled?: boolean; customBranchName?: string } = {}): Task {
    return tasks.create({
      title: 'Wait on CI',
      description: '',
      swimlane_id: columnAId,
      ...(options.disabled ? { automations_disabled: true } : {}),
      ...(options.customBranchName ? { customBranchName: options.customBranchName } : {}),
    });
  }

  function workflowTask(): Task {
    return tasks.create({ title: 'Workflow step', description: '', swimlane_id: columnAId, workflow: membership() });
  }

  describe('create', () => {
    it('writes a disabled task and says so in the response', async () => {
      const result = await handleCreateTask({ title: 'Wait on CI', automationsDisabled: true }, context);

      expect(result.success).toBe(true);
      const created = result.data as { taskId: string; automationsDisabled: boolean };
      expect(created.automationsDisabled).toBe(true);
      expect(result.message).toContain('Its column automations are disabled.');
      expect(storedValue(created.taskId)).toBe(1);
      expect(tasks.getById(created.taskId)!.automations_disabled).toBe(true);
      expect(onTaskCreated).toHaveBeenCalledWith(expect.objectContaining({ id: created.taskId, automations_disabled: true }), expect.any(String), expect.any(String));
    });

    it.each([
      ['false', { automationsDisabled: false }],
      ['omitted', {}],
      ['null', { automationsDisabled: null }],
    ])('writes an enabled task when the switch is %s, and the response does not mention it', async (_label, extra) => {
      const result = await handleCreateTask({ title: 'Plain', ...extra }, context);

      expect(result.success).toBe(true);
      const created = result.data as { taskId: string; automationsDisabled: boolean };
      expect(created.automationsDisabled).toBe(false);
      expect(result.message).not.toContain('automations are disabled');
      expect(storedValue(created.taskId)).toBe(0);
    });

    it.each([
      ['the string "true"', 'true'],
      ['the string "false"', 'false'],
      ['the number 1', 1],
      ['the number 0', 0],
      ['an object', {}],
    ])('refuses %s and creates nothing', async (_label, value) => {
      const before = taskCount();

      const result = await handleCreateTask({ title: 'Wait on CI', automationsDisabled: value }, context);

      expect(result).toEqual({ success: false, error: PARAM_ERROR });
      expect(taskCount()).toBe(before);
      expect(onTaskCreated).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('disables an ordinary task with a write that names nothing else', async () => {
      const task = ordinaryTask();

      const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: true }), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('automationsDisabled');
      expect((result.data as { automationsDisabled: boolean }).automationsDisabled).toBe(true);
      expect(storedValue(task.id)).toBe(1);
      expect(tasks.getById(task.id)!.automations_disabled).toBe(true);
      expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, automations_disabled: true }));
    });

    it('enables a disabled task', async () => {
      const task = ordinaryTask({ disabled: true });

      const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: false }), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('automationsDisabled');
      expect((result.data as { automationsDisabled: boolean }).automationsDisabled).toBe(false);
      expect(storedValue(task.id)).toBe(0);
    });

    it('resolves the task by its display id as well', async () => {
      const task = ordinaryTask();

      const result = handleUpdateTask(updateParams(String(task.display_id), { automationsDisabled: true }), context);

      expect(result.success).toBe(true);
      expect(storedValue(task.id)).toBe(1);
    });

    it('leaves the switch alone when an update names other fields only', async () => {
      const task = ordinaryTask({ disabled: true });

      const result = handleUpdateTask(updateParams(task.id, { title: 'Renamed' }), context);

      expect(result.success).toBe(true);
      expect(result.message).not.toContain('automationsDisabled');
      expect(storedValue(task.id)).toBe(1);
      expect((result.data as { automationsDisabled: boolean }).automationsDisabled).toBe(true);
    });

    it('reports a write that names only a missing switch as nothing to update (the control)', async () => {
      const task = ordinaryTask();

      const result = handleUpdateTask(updateParams(task.id, {}), context);

      expect(result).toEqual({ success: false, error: 'No fields provided to update' });
    });

    it.each([
      ['the string "true"', 'true'],
      ['the number 1', 1],
      ['an object', {}],
    ])('refuses %s and changes nothing', async (_label, value) => {
      const task = ordinaryTask();

      const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: value, title: 'Should not apply' }), context);

      expect(result).toEqual({ success: false, error: PARAM_ERROR });
      expect(storedValue(task.id)).toBe(0);
      expect(tasks.getById(task.id)!.title).toBe('Wait on CI');
      expect(onTaskUpdated).not.toHaveBeenCalled();
    });

    describe('on a workflow task', () => {
      it('refuses disabling it with the workflow reason, and writes nothing', async () => {
        const task = workflowTask();

        const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: true, title: 'Should not apply' }), context);

        expect(result.success).toBe(false);
        expect(result.error).toContain(AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL);
        expect(result.error).toContain('The task was not updated.');
        expect(storedValue(task.id)).toBe(0);
        // The refusal comes before any write, so the other fields are not applied either.
        expect(tasks.getById(task.id)!.title).toBe('Workflow step');
        expect(onTaskUpdated).not.toHaveBeenCalled();
      });

      it('allows enabling it, since enabled is the only state a workflow task can be in', async () => {
        const task = workflowTask();

        const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: false }), context);

        expect(result.success).toBe(true);
        expect((result.data as { automationsDisabled: boolean }).automationsDisabled).toBe(false);
        expect(storedValue(task.id)).toBe(0);
        expect(onTaskUpdated).toHaveBeenCalledOnce();
      });

      it('disables the same task once it has left the workflow (the control)', async () => {
        const task = workflowTask();
        tasks.setWorkflowMembership(task.id, null);

        const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: true }), context);

        expect(result.success).toBe(true);
        expect(storedValue(task.id)).toBe(1);
      });
    });

    describe('the live session settings hook', () => {
      it.each([
        ['disabling', true],
        ['enabling', false],
      ])('is not called by a write that only names the switch, %s', async (_label, value) => {
        const task = ordinaryTask({ disabled: !value });

        const result = handleUpdateTask(updateParams(task.id, { automationsDisabled: value }), context);

        expect(result.success).toBe(true);
        expect(onTaskSettingsChanged).not.toHaveBeenCalled();
        // Nothing restarts, so the response must not claim it does.
        expect(result.message).not.toContain('restarts');
      });

      it('is not called when the switch rides along with a title change', async () => {
        const task = ordinaryTask();

        handleUpdateTask(updateParams(task.id, { automationsDisabled: true, title: 'Renamed' }), context);

        expect(onTaskSettingsChanged).not.toHaveBeenCalled();
      });

      it('is called for a run mode switch on the same real handler (the control)', async () => {
        const task = ordinaryTask();

        const result = handleUpdateTask(updateParams(task.id, { runMode: 'agent_override' }), context);

        expect(result.success).toBe(true);
        expect(onTaskSettingsChanged).toHaveBeenCalledOnce();
      });
    });
  });

  describe('find_task', () => {
    it('says "automations disabled" on the task line of a held task, and carries a true boolean in data', async () => {
      const task = ordinaryTask({ disabled: true });

      const result = await handleFindTask({ id: task.id }, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('automations disabled');
      // On the task's own line, ahead of the trailing "#N, id:" that ends it.
      const taskLine = result.message!.split('\n').find((line) => line.includes(task.id))!;
      expect(taskLine).toContain(' | automations disabled | ');
      const matched = (result.data as { tasks: Array<{ automationsDisabled: unknown }> }).tasks;
      expect(matched).toHaveLength(1);
      expect(matched[0].automationsDisabled).toBe(true);
    });

    it('says nothing of it for an enabled task, and carries a false boolean in data', async () => {
      const task = ordinaryTask({ disabled: false });

      const result = await handleFindTask({ id: task.id }, context);

      expect(result.success).toBe(true);
      expect(result.message).not.toContain('automations disabled');
      const matched = (result.data as { tasks: Array<{ automationsDisabled: unknown }> }).tasks;
      expect(matched[0].automationsDisabled).toBe(false);
    });

    it('marks only the held task when two tasks match', async () => {
      const held = tasks.create({ title: 'Wait on CI', description: '', swimlane_id: columnAId, automations_disabled: true });
      const free = tasks.create({ title: 'Wait on review', description: '', swimlane_id: columnBId });

      const result = await handleFindTask({ title: 'wait on' }, context);

      const lines = result.message!.split('\n');
      expect(lines.find((line) => line.includes(held.id))).toContain('automations disabled');
      expect(lines.find((line) => line.includes(free.id))).not.toContain('automations disabled');
    });

    it('reports the switch for a completed (archived) task too', async () => {
      const task = ordinaryTask({ disabled: true });
      const doneLaneId = new SwimlaneRepository(database).list().find((lane) => lane.role === 'done')!.id;
      tasks.move({ taskId: task.id, targetSwimlaneId: doneLaneId, targetPosition: 0 }, { origin: 'renderer' });
      tasks.archive(task.id);

      const result = await handleFindTask({ id: task.id }, context);

      const matched = (result.data as { tasks: Array<{ automationsDisabled: unknown; status: string }> }).tasks;
      expect(matched[0].status).toBe('completed');
      expect(matched[0].automationsDisabled).toBe(true);
      expect(result.message).toContain('automations disabled');
    });
  });

  describe('get_current_task', () => {
    it('says "automations disabled" in the message and data of a held task', async () => {
      const task = ordinaryTask({ disabled: true, customBranchName: 'task/wait-on-ci' });

      const result = await handleGetCurrentTask({ branch: 'task/wait-on-ci' }, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('automations disabled');
      const data = result.data as { id: string; automationsDisabled: unknown };
      expect(data.id).toBe(task.id);
      expect(data.automationsDisabled).toBe(true);
    });

    it('says nothing of it for an enabled task (the control)', async () => {
      ordinaryTask({ customBranchName: 'task/wait-on-ci' });

      const result = await handleGetCurrentTask({ branch: 'task/wait-on-ci' }, context);

      expect(result.message).not.toContain('automations disabled');
      expect((result.data as { automationsDisabled: unknown }).automationsDisabled).toBe(false);
    });
  });

  // Not asserted on a task in To Do: the To Do column is not special to the
  // switch (it is cleared by leaving Done, not by entering To Do).
  it('keeps the switch on a task created in To Do', async () => {
    const result = await handleCreateTask({ title: 'Parked', automationsDisabled: true, column: 'To Do' }, context);

    expect(result.success).toBe(true);
    const created = result.data as { taskId: string };
    expect(tasks.getById(created.taskId)!.swimlane_id).toBe(todoLaneId);
    expect(storedValue(created.taskId)).toBe(1);
  });
});
