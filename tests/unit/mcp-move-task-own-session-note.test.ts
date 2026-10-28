/**
 * `kangentic_move_task` (handleMoveTask) and what it tells the task's own agent
 * about its own session (`ownSessionNote`), against real, migrated SQLite.
 *
 * When the caller is the task's own live session (`callerTaskId` is the task and
 * `callerSessionId` is the task's `session_id`), the reply says what the move
 * does to that session, so the agent ends its turn rather than start work the
 * session will not live to finish. The cases `mcp-move-task-workflow-lock.test.ts`
 * does not reach:
 *   - To Do says nothing: its reset ends the session at once and the next run is
 *     fresh, so "yours ends when this turn does" would be a promise about a turn
 *     that never gets to finish.
 *   - A non-Done column that starts no agent (`auto_spawn` off) says outright
 *     that the session ends, where a column that does start one only says it
 *     might.
 *   - A move into the task's current column, with a position and a message,
 *     repositions in place and says the message went nowhere. From the task's
 *     own agent it is a harmless repeat, so it succeeds; from anyone else it is
 *     still refused.
 *
 * Real databases, for the reason the workflow-lock file gives: the lock reads
 * through the module-level `getProjectDb`, so the mocked one hands back the same
 * migrated database the handler reads.
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
import { handleMoveTask } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Task } from '../../src/shared/types';

import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const OWN_SESSION_ID = 'session-own-1';

/** The sentence that says the session is over, with no "if" about it. */
const SESSION_ENDS_SENTENCE = 'Your session ends when this turn does.';

describe('handleMoveTask: the note a task\'s own agent gets about its own session', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let swimlanes: SwimlaneRepository;
  let context: CommandContext;
  let onTaskMove: ReturnType<typeof vi.fn>;
  let onTasksReordered: ReturnType<typeof vi.fn>;
  let laneIds: Record<string, string>;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    harness.dbs.set(PROJECT_ID, database);
    tasks = new TaskRepository(database);
    swimlanes = new SwimlaneRepository(database);

    laneIds = {};
    for (const lane of swimlanes.list()) laneIds[lane.name] = lane.id;

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

  /** An ordinary task in Planning: no workflow, so no lock and no route. */
  function ordinaryTask(title: string): Task {
    return tasks.create({ title, description: '', swimlane_id: laneIds['Planning'] });
  }

  /** A task in Planning whose live session is the calling agent's own. */
  function ownTask(): Task {
    const task = ordinaryTask('Own task');
    tasks.update({ id: task.id, session_id: OWN_SESSION_ID });
    context.callerTaskId = task.id;
    context.callerSessionId = OWN_SESSION_ID;
    return task;
  }

  describe('a move to To Do', () => {
    it('is recognised as the own session and carries no session note', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'To Do' }, context);

      expect(response.success).toBe(true);
      // The mover session was named, so the empty note below is the To Do rule
      // and not a caller that was never recognised as the task's own session.
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['To Do'] }),
        { moverIsTaskAgent: true, moverSessionId: OWN_SESSION_ID },
      );
      expect(response.message).toBe(`Moving "${task.title}" (#${task.display_id}) to To Do.`);
      expect(response.message).not.toContain('this turn does');
    });
  });

  describe('a move to a column that starts no agent', () => {
    it('says outright that the session ends with this turn', () => {
      swimlanes.update({ id: laneIds['Executing'], auto_spawn: false });
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Executing' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Executing'] }),
        { moverIsTaskAgent: true, moverSessionId: OWN_SESSION_ID },
      );
      expect(response.message).toContain(SESSION_ENDS_SENTENCE);
      // The hedged sentence is what a column that DOES start an agent gets.
      expect(response.message).not.toContain('starts a session of its own');
    });

    it('hedges for the same column once it starts an agent, so the flag is what changes the note', () => {
      const task = ownTask();

      const response = handleMoveTask({ taskId: task.id, column: 'Executing' }, context);

      expect(response.success).toBe(true);
      expect(response.message).toContain('If Executing starts a session of its own, yours ends when this turn does.');
      expect(response.message).not.toContain(SESSION_ENDS_SENTENCE);
    });
  });

  describe('a move into the task\'s current column with a position and a message', () => {
    it('repositions in place and says the message was not sent, for the task\'s own agent', () => {
      const task = ownTask();
      const sibling = ordinaryTask('Sibling');

      const response = handleMoveTask(
        { taskId: task.id, column: 'Planning', position: 1, message: 'Back from review.' },
        context,
      );

      expect(response.success).toBe(true);
      expect(response.message).toBe(
        `Moved "${task.title}" (#${task.display_id}) to position 1 of Planning. Nothing moved, so the message was not sent.`,
      );
      // A reposition, not a move: the lifecycle never fires.
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).toHaveBeenCalledTimes(1);
      expect(onTasksReordered.mock.calls[0][1]).toEqual([sibling.id, task.id]);
    });

    it('is still refused for an agent that is not the task\'s own', () => {
      const task = ordinaryTask('Someone else\'s task');
      context.callerTaskId = ordinaryTask('The caller\'s own task').id;

      const response = handleMoveTask(
        { taskId: task.id, column: 'Planning', position: 1, message: 'Back from review.' },
        context,
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain('kangentic_send_session_message');
      expect(onTaskMove).not.toHaveBeenCalled();
      expect(onTasksReordered).not.toHaveBeenCalled();
    });
  });
});
