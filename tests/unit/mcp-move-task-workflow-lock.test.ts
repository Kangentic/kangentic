/**
 * `kangentic_move_task` (handleMoveTask) on a task that belongs to a RUNNING
 * workflow, against real, migrated SQLite.
 *
 * Real databases are the point. The workflow lock is asked through
 * `checkWorkflowMoveForAgent`, which reads the workflow and the destination
 * column through the module-level `getProjectDb`, not through
 * `context.getProjectDb`. With mocked repositories that lookup throws inside its
 * own try and returns null, so the lock would silently allow every move and a
 * "refused" assertion could never go red for the right reason. Here the mocked
 * `getProjectDb` hands back the same migrated database the handler reads.
 *
 * Covers the handler's own contract, not the lock's pure predicate
 * (`workflowMoveRefusal`, exercised in workflow-core.test.ts):
 *   - the lock's sentence is the refusal, and `onTaskMove` never fires
 *   - only `CommandContext.callerTaskId` identifies the task's own agent; a
 *     `callerTaskId` smuggled into the tool params is ignored
 *   - `column: "next"` follows the task's workflow route, and the board for an
 *     ordinary task
 *   - `message` is validated before any move fires
 *   - the task's own live session is named to the move (`moverSessionId`), and
 *     its repeat of a move already made is a plain "already in" answer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const database = harness.dbs.get(projectId);
    if (!database) throw new Error(`No database for ${projectId}`);
    return database;
  },
}));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import { handleMoveTask, handleMoveTaskToProject } from '../../src/main/agent/commands/task-commands';
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Task } from '../../src/shared/types';

import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const WORKFLOW_TITLE = 'Usage budgets';

/** The handler's cap on a hand-off message. The constant is not exported, so the boundary is pinned by value. */
const MESSAGE_CAP = 20_000;

describe('handleMoveTask: workflow lock, caller identity, "next" and message validation', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let context: CommandContext;
  let onTaskMove: ReturnType<typeof vi.fn>;
  let onTasksReordered: ReturnType<typeof vi.fn>;
  let laneIds: Record<string, string>;
  let workflowId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    harness.dbs.set(PROJECT_ID, database);
    tasks = new TaskRepository(database);

    laneIds = {};
    for (const lane of new SwimlaneRepository(database).list()) laneIds[lane.name] = lane.id;

    const workflows = new WorkflowRepository(database);
    workflowId = workflows.create({ title: WORKFLOW_TITLE }).id;
    workflows.markStarted(workflowId);

    onTaskMove = vi.fn(async () => {});
    onTasksReordered = vi.fn();
    context = {
      projectId: PROJECT_ID,
      getProjectDb: () => database,
      getProjectPath: () => '/mock/project',
      getBoardProfiles: () => [],
      setBoardProfiles: vi.fn(),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove,
      onTasksReordered,
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
    } as unknown as CommandContext;
  });

  afterEach(() => {
    harness.dbs.clear();
    database.close();
  });

  /** A started workflow's task in Planning, whose route skips Executing. */
  function workflowTask(): Task {
    return tasks.create({
      title: 'Budgets API',
      description: '',
      swimlane_id: laneIds['Planning'],
      workflow: {
        workflow_id: workflowId,
        workflow_project_id: PROJECT_ID,
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [laneIds['Executing']],
        canvas_x: null,
        canvas_y: null,
      },
    });
  }

  /** An ordinary task in Planning: no workflow, so no lock and no route. */
  function ordinaryTask(): Task {
    return tasks.create({ title: 'Plain task', description: '', swimlane_id: laneIds['Planning'] });
  }

  describe('a task in a running workflow', () => {
    it('refuses a caller with no task, with the lock sentence, and never fires the move', () => {
      const task = workflowTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Executing' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toBe(WORKFLOW_REFUSALS.locked(`#${task.display_id}`, WORKFLOW_TITLE));
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('refuses a different task\'s agent', () => {
      const task = workflowTask();
      const other = ordinaryTask();
      context.callerTaskId = other.id;

      const response = handleMoveTask({ taskId: task.id, column: 'Executing' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toBe(WORKFLOW_REFUSALS.locked(`#${task.display_id}`, WORKFLOW_TITLE));
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('lets the task\'s own agent move it, and tells the move who is moving', () => {
      const task = workflowTask();
      context.callerTaskId = task.id;

      const response = handleMoveTask({ taskId: task.id, column: 'Executing' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledTimes(1);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Executing'] }),
        { moverIsTaskAgent: true },
      );
    });

    it('ignores a callerTaskId passed in the tool params: only the CommandContext counts', () => {
      const task = workflowTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Executing', callerTaskId: task.id }, context);

      expect(response.success).toBe(false);
      expect(response.error).toBe(WORKFLOW_REFUSALS.locked(`#${task.display_id}`, WORKFLOW_TITLE));
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('resolves "next" to the next column on the task\'s route, passing over a skipped column', () => {
      const task = workflowTask();
      context.callerTaskId = task.id;

      const response = handleMoveTask({ taskId: task.id, column: 'next' }, context);

      // The board's next column after Planning is Executing, which this route
      // skips. Landing there would be the bug.
      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Code Review'] }),
        { moverIsTaskAgent: true },
      );
    });
  });

  // #916. A move that ends the caller's own session waits for its turn to end,
  // so the call reaches the agent's conversation; the move learns which session
  // to wait for from here. A repeat of a move already made is harmless.
  describe('the task\'s own agent session', () => {
    const OWN_SESSION_ID = 'session-own-1';

    function ownTask(): Task {
      const task = ordinaryTask();
      tasks.update({ id: task.id, session_id: OWN_SESSION_ID });
      context.callerTaskId = task.id;
      context.callerSessionId = OWN_SESSION_ID;
      return task;
    }

    it('names the mover session when the caller is the task\'s live session', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Code Review' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Code Review'] }),
        { moverIsTaskAgent: true, moverSessionId: OWN_SESSION_ID },
      );
      expect(response.message).toContain('If Code Review starts a session of its own, yours ends when this turn does.');
    });

    it('says outright that a move to Done ends the session', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Done' }, context);

      expect(response.success).toBe(true);
      expect(response.message).toContain('Your session ends when this turn does.');
    });

    it('names no mover session, and says nothing of it, when the caller is not the task\'s live session', () => {
      const task = ownTask();
      context.callerSessionId = 'session-some-other';

      const response = handleMoveTask({ taskId: task.id, column: 'Code Review' }, context);

      expect(onTaskMove).toHaveBeenCalledWith(expect.anything(), { moverIsTaskAgent: true });
      expect(response.message).not.toContain('this turn does');
    });

    it('names no mover session for another task\'s agent', () => {
      const task = ownTask();
      context.callerTaskId = ordinaryTask().id;

      handleMoveTask({ taskId: task.id, column: 'Code Review' }, context);

      expect(onTaskMove).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id }));
      expect(onTaskMove.mock.calls[0]).toHaveLength(1);
    });

    it('answers a repeated move into the current column as already there, and moves nothing', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Planning' }, context);

      expect(response).toMatchObject({ success: true, message: `Task "${task.title}" is already in Planning.` });
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('answers the same repeat carrying a message as already there, and says the message was not sent', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Planning', message: 'Back from review.' }, context);

      expect(response).toMatchObject({
        success: true,
        message: `Task "${task.title}" is already in Planning. Nothing moved, so the message was not sent.`,
      });
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).not.toHaveBeenCalled();
    });
  });

  describe('an ordinary task', () => {
    it('resolves "next" to the next column on the board', () => {
      const task = ordinaryTask();

      const response = handleMoveTask({ taskId: task.id, column: 'next' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Executing'] }),
      );
    });
  });

  describe('message validation', () => {
    const notStrings: Array<[string, unknown]> = [
      ['a number', 42],
      ['a boolean', true],
      ['an object', { text: 'hello' }],
      ['an array', ['hello']],
    ];

    it.each(notStrings)('refuses %s before any move fires', (_label, message) => {
      const task = ordinaryTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Executing', message }, context);

      expect(response).toMatchObject({ success: false, error: 'message must be a string.' });
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).not.toHaveBeenCalled();
    });

    it('refuses a message one character over the cap before any move fires', () => {
      const task = ordinaryTask();

      const response = handleMoveTask(
        { taskId: task.id, column: 'Executing', message: 'x'.repeat(MESSAGE_CAP + 1) },
        context,
      );

      expect(response).toMatchObject({
        success: false,
        error: `message is ${MESSAGE_CAP + 1} characters; the limit is ${MESSAGE_CAP}.`,
      });
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).not.toHaveBeenCalled();
    });

    it('hands on a message of exactly the cap', () => {
      const task = ordinaryTask();
      const message = 'x'.repeat(MESSAGE_CAP);

      const response = handleMoveTask({ taskId: task.id, column: 'Executing', message }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Executing'] }),
        { message },
      );
    });

    it('refuses a message on a move that stays in its column, pointing at kangentic_send_session_message', () => {
      const task = ordinaryTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Planning', message: 'hello' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('kangentic_send_session_message');
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).not.toHaveBeenCalled();
      expect(tasks.getById(task.id)?.swimlane_id).toBe(laneIds['Planning']);
    });
  });

  // kangentic_move_task_to_project refuses a workflow task, since the relocated
  // copy would leave the workflow's links naming a task that is gone. A deleted
  // workflow's Done tasks keep their membership, and one moved back to To Do
  // has no workflow left to protect.
  describe('kangentic_move_task_to_project and a task\'s workflow', () => {
    const TARGET_PROJECT_ID = 'project-2';
    let targetDatabase: Database.Database;
    let target: CommandContext;

    beforeEach(() => {
      targetDatabase = openTestDatabase();
      runProjectMigrations(targetDatabase);
      harness.dbs.set(TARGET_PROJECT_ID, targetDatabase);
      target = { ...context, projectId: TARGET_PROJECT_ID, getProjectDb: () => targetDatabase, getProjectPath: () => '/mock/project-2' } as unknown as CommandContext;
    });

    afterEach(() => {
      targetDatabase.close();
    });

    function toDoTaskIn(memberOf: string): Task {
      return tasks.create({
        title: 'Budgets API',
        description: '',
        swimlane_id: laneIds['To Do'],
        workflow: {
          workflow_id: memberOf,
          workflow_project_id: PROJECT_ID,
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
        },
      });
    }

    it('refuses a task in a workflow that exists', () => {
      const task = toDoTaskIn(workflowId);

      const response = handleMoveTaskToProject({ taskId: task.id }, context, target);

      expect(response.success).toBe(false);
      expect(response.error).toContain('is in a workflow and cannot be moved to another project');
      expect(tasks.getById(task.id)).toBeDefined();
    });

    it('moves a task whose workflow was deleted', () => {
      const workflows = new WorkflowRepository(database);
      const deleted = workflows.create({ title: 'Deleted plan' }).id;
      workflows.markStarted(deleted);
      workflows.delete(deleted);
      const task = toDoTaskIn(deleted);

      const response = handleMoveTaskToProject({ taskId: task.id }, context, target);

      expect(response.success).toBe(true);
      expect(tasks.getById(task.id)).toBeUndefined();
      expect(new TaskRepository(targetDatabase).list().map((moved) => moved.title)).toEqual(['Budgets API']);
    });
  });
});
