/**
 * The guard that keeps an agent from ending another task's running work
 * (`running-work-guard.ts`), through the real handlers over real, migrated
 * SQLite, with the read of the task's work injected. The read itself is pinned
 * in `task-running-work.test.ts`, and the tools that set `callerKind` in
 * `mcp-running-work-guard-wiring.test.ts`.
 *
 * Real databases for the reason `mcp-move-task-own-session-note.test.ts` gives:
 * the workflow lock reads through the module-level `getProjectDb`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
import { handleDeleteTask, handleMoveTask } from '../../src/main/agent/commands/task-commands';
import { handleRunAutomation, handleSetAutomations } from '../../src/main/agent/commands/automation-commands';
import { runningWorkRefusal } from '../../src/main/agent/commands/running-work-guard';
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';
import type { CommandContext, CommandResponse, TaskRunningWork } from '../../src/main/agent/commands/types';
import type { Task } from '../../src/shared/types';

import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const CALLER_TASK_ID = 'task-of-the-calling-agent';
const CALLER_SESSION_ID = 'session-of-the-calling-agent';

const NOTHING: TaskRunningWork = { liveAgent: false, worktree: null };
const LIVE_AGENT: TaskRunningWork = { liveAgent: true, worktree: null };
const UNMERGED_COMMITS: TaskRunningWork = {
  liveAgent: false,
  worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: 3, uncommittedFiles: 0 },
};
const UNCOMMITTED_FILES: TaskRunningWork = {
  liveAgent: false,
  worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: 0, uncommittedFiles: 2 },
};
const UNREADABLE_WORKTREE: TaskRunningWork = { liveAgent: false, worktree: { readable: false } };
// A readable worktree whose commits could not be counted: its base resolves on no ref form.
const UNCOUNTED_COMMITS: TaskRunningWork = {
  liveAgent: false,
  worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: null, uncommittedFiles: 0 },
};
const CLEAN_WORKTREE: TaskRunningWork = {
  liveAgent: false,
  worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: 0, uncommittedFiles: 0 },
};

describe('the running-work guard', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let context: CommandContext;
  let onTaskMove: ReturnType<typeof vi.fn>;
  let onTaskDeleted: ReturnType<typeof vi.fn>;
  let onRunAutomation: ReturnType<typeof vi.fn>;
  let readTaskRunningWork: ReturnType<typeof vi.fn>;
  let laneIds: Record<string, string>;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    harness.dbs.set(PROJECT_ID, database);
    tasks = new TaskRepository(database);

    laneIds = {};
    for (const lane of new SwimlaneRepository(database).list()) laneIds[lane.name] = lane.id;

    onTaskMove = vi.fn(async () => {});
    onTaskDeleted = vi.fn();
    onRunAutomation = vi.fn(async () => ({ ok: true, automationName: 'Reset', columnName: 'Planning', status: 'succeeded' }));
    readTaskRunningWork = vi.fn(async () => NOTHING);
    context = {
      projectId: PROJECT_ID,
      getProjectDb: () => database,
      getProjectPath: () => '/mock/project',
      getBoardProfiles: () => [],
      setBoardProfiles: vi.fn(),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted,
      onTaskMove,
      onTasksReordered: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
      onRunAutomation,
      readTaskRunningWork,
      callerKind: 'agent',
      callerTaskId: CALLER_TASK_ID,
      callerSessionId: CALLER_SESSION_ID,
    } as unknown as CommandContext;
  });

  afterEach(() => {
    harness.dbs.clear();
    database.close();
  });

  function otherTask(title = 'Filed follow-up'): Task {
    return tasks.create({ title, description: '', swimlane_id: laneIds['Planning'] });
  }

  function expectRefused(response: CommandResponse, loss: string): void {
    expect(response.success).toBe(false);
    expect(response.error).toContain(loss);
    // What the agent does next, and that it cannot do it itself.
    expect(response.error).toContain('nothing was changed');
    expect(response.error).toContain('Ask the user what to do');
    expect(response.error).toContain('Do not retry');
  }

  const REFUSED_WORK: Array<[string, TaskRunningWork, string]> = [
    ['a live session', LIVE_AGENT, 'a live agent'],
    ['unmerged commits', UNMERGED_COMMITS, '3 commits on task/importer not on main'],
    ['uncommitted files', UNCOMMITTED_FILES, '2 uncommitted files'],
    ['a worktree git cannot read', UNREADABLE_WORKTREE, 'a worktree that could not be read'],
    ['commits git could not count', UNCOUNTED_COMMITS, 'a worktree that could not be read'],
  ];
  // Done keeps the branch, so a move there is not held up by commits, counted or not.
  const REFUSED_WORK_ON_DONE = REFUSED_WORK.filter(([name]) => name !== 'unmerged commits' && name !== 'commits git could not count');

  describe('kangentic_delete_task', () => {
    it.each(REFUSED_WORK)('refuses a task with %s, and deletes nothing', async (_name, work, loss) => {
      readTaskRunningWork.mockResolvedValue(work);
      const task = otherTask();

      const response = await handleDeleteTask({ taskId: task.id }, context);

      expectRefused(response, loss);
      expect(response.error).toContain(`#${task.display_id} "${task.title}"`);
      expect(onTaskDeleted).not.toHaveBeenCalled();
      expect(tasks.getById(task.id)).toBeTruthy();
    });

    it('names everything that would be lost', async () => {
      readTaskRunningWork.mockResolvedValue({
        liveAgent: true,
        worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: 1, uncommittedFiles: 1 },
      });

      const response = await handleDeleteTask({ taskId: otherTask().id }, context);

      expect(response.error).toContain('a live agent, 1 commit on task/importer not on main and 1 uncommitted file.');
    });

    it('refuses when the read itself fails, because a delete cannot be undone', async () => {
      readTaskRunningWork.mockRejectedValue(new Error('git is gone'));
      const task = otherTask();

      const response = await handleDeleteTask({ taskId: task.id }, context);

      // Names the failed read, not a worktree: this task has none.
      expectRefused(response, 'its running work, which could not be read');
      expect(response.error).not.toContain('worktree');
      expect(tasks.getById(task.id)).toBeTruthy();
    });

    it('refuses on a context with no read, so a missing callback cannot switch the guard off', async () => {
      const task = otherTask();

      const response = await handleDeleteTask({ taskId: task.id }, { ...context, readTaskRunningWork: undefined });

      expectRefused(response, 'its running work, which could not be read');
      expect(tasks.getById(task.id)).toBeTruthy();
    });

    it('deletes a task with no running work', async () => {
      const task = otherTask();

      const response = await handleDeleteTask({ taskId: task.id }, context);

      expect(response.success).toBe(true);
      expect(onTaskDeleted).toHaveBeenCalledOnce();
      expect(tasks.getById(task.id)).toBeFalsy();
    });

    it('deletes a task whose clean worktree holds nothing', async () => {
      readTaskRunningWork.mockResolvedValue(CLEAN_WORKTREE);

      const response = await handleDeleteTask({ taskId: otherTask().id }, context);

      expect(response.success).toBe(true);
    });

    it('leaves the caller\'s own task alone, and reads nothing for it', async () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = otherTask('Own task');
      context.callerTaskId = task.id;

      const response = await handleDeleteTask({ taskId: task.id }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });

    it('leaves a person\'s call from the phone alone: no marker, synchronously', () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = otherTask();
      const phoneContext = { ...context, callerKind: undefined, callerTaskId: undefined, callerSessionId: undefined, via: 'phone' as const };

      const response = handleDeleteTask({ taskId: task.id }, phoneContext) as CommandResponse;

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });

    it('refuses a caller with no task: a Command Terminal is still an agent', async () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      context.callerTaskId = null;

      const response = await handleDeleteTask({ taskId: otherTask().id }, context);

      expectRefused(response, 'a live agent');
    });

    it('takes nothing from its parameters: no confirmation or marker there changes the answer', async () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = otherTask();

      const response = await handleDeleteTask({ taskId: task.id, confirm: true, callerKind: undefined, callerTaskId: task.id, via: 'phone' }, context);

      expectRefused(response, 'a live agent');
    });

    it('answers not found when the task went during the read', async () => {
      const task = otherTask();
      readTaskRunningWork.mockImplementation(async () => {
        tasks.delete(task.id);
        return NOTHING;
      });

      const response = await handleDeleteTask({ taskId: task.id }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
      expect(onTaskDeleted).not.toHaveBeenCalled();
    });
  });

  describe('kangentic_move_task to To Do', () => {
    it.each(REFUSED_WORK)('refuses a task with %s, and moves nothing', async (_name, work, loss) => {
      readTaskRunningWork.mockResolvedValue(work);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'To Do' }, context);

      expectRefused(response, loss);
      expect(response.error).toContain('Moving it to To Do');
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('goes by role, so a renamed To Do counts and the refusal uses its name', async () => {
      new SwimlaneRepository(database).update({ id: laneIds['To Do'], name: 'Queue' });
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'Queue' }, context);

      expectRefused(response, 'a live agent');
      expect(response.error).toContain('Moving it to Queue');
    });

    it('moves a task with no running work', async () => {
      const task = otherTask();

      const response = await handleMoveTask({ taskId: task.id, column: 'To Do' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['To Do'] }));
    });

    it('leaves the caller\'s own task alone, and stays synchronous for it', () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = otherTask('Own task');
      context.callerTaskId = task.id;

      const response = handleMoveTask({ taskId: task.id, column: 'To Do' }, context) as CommandResponse;

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });

    it('leaves a same-column reposition alone', () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = tasks.create({ title: 'Queued', description: '', swimlane_id: laneIds['To Do'] });

      const response = handleMoveTask({ taskId: task.id, column: 'To Do', position: 0 }, context) as CommandResponse;

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });

    it('has no Backlog to reach: "Backlog" is not a column', () => {
      const response = handleMoveTask({ taskId: otherTask().id, column: 'Backlog' }, context) as CommandResponse;

      expect(response.success).toBe(false);
      expect(response.error).toContain('Backlog is not a board column');
      expect(onTaskMove).not.toHaveBeenCalled();
    });
  });

  describe('kangentic_move_task to Done', () => {
    it.each(REFUSED_WORK_ON_DONE)('refuses a task with %s', async (_name, work, loss) => {
      readTaskRunningWork.mockResolvedValue(work);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'Done' }, context);

      expectRefused(response, loss);
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('allows commits alone, because Done keeps the branch', async () => {
      readTaskRunningWork.mockResolvedValue(UNMERGED_COMMITS);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'Done' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledOnce();
    });

    it('allows commits git could not count, because Done keeps the branch and nothing else is at risk', async () => {
      readTaskRunningWork.mockResolvedValue(UNCOUNTED_COMMITS);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'Done' }, context);

      expect(response.success).toBe(true);
      expect(onTaskMove).toHaveBeenCalledOnce();
    });

    it('refuses a move with column "next" from another task\'s agent when the next column is Done', async () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = tasks.create({ title: 'Last step', description: '', swimlane_id: laneIds['Merge'] });

      const response = await handleMoveTask({ taskId: task.id, column: 'next' }, context);

      expectRefused(response, 'a live agent');
      expect(response.error).toContain('Moving it to Done');
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('lets "next" from another task\'s agent through when the next column keeps the work', async () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = await handleMoveTask({ taskId: otherTask().id, column: 'next' }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
      expect(onTaskMove).toHaveBeenCalledOnce();
    });
  });

  describe('a move that the task\'s state changes under during the guard\'s read', () => {
    it('answers not found when the task went during the read, and moves nothing', async () => {
      const task = otherTask();
      readTaskRunningWork.mockImplementation(async () => {
        tasks.delete(task.id);
        return NOTHING;
      });

      const response = await handleMoveTask({ taskId: task.id, column: 'To Do' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
      expect(onTaskMove).not.toHaveBeenCalled();
    });

    it('asks the workflow lock again after the read, so a workflow that took the task during it refuses the move', async () => {
      const task = otherTask();
      const workflows = new WorkflowRepository(database);
      const workflow = workflows.create({ title: 'Usage budgets' });
      workflows.markStarted(workflow.id);
      readTaskRunningWork.mockImplementation(async () => {
        tasks.setWorkflowMembership(task.id, {
          workflow_id: workflow.id,
          workflow_project_id: PROJECT_ID,
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
          plan_approval: null,
        });
        return NOTHING;
      });

      const response = await handleMoveTask({ taskId: task.id, column: 'Done' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toBe(WORKFLOW_REFUSALS.locked(`#${task.display_id}`, 'Usage budgets'));
      expect(onTaskMove).not.toHaveBeenCalled();
    });
  });

  describe('a move to any other column', () => {
    it('reads nothing: that move keeps the work', () => {
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = handleMoveTask({ taskId: otherTask().id, column: 'Executing' }, context) as CommandResponse;

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });
  });

  describe('kangentic_run_automation', () => {
    function addMoveRow(targetColumn: string): void {
      const response = handleSetAutomations({
        column: 'Planning',
        automations: [{ name: 'Send it', type: 'move_to_column', on: 'turn_end', targetColumn }],
      }, context) as CommandResponse;
      expect(response.success).toBe(true);
    }

    it('refuses a Move to column row aimed at To Do on a task with running work', async () => {
      addMoveRow('To Do');
      readTaskRunningWork.mockResolvedValue(UNMERGED_COMMITS);
      const task = otherTask();

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: task.id }, context);

      expectRefused(response, '3 commits on task/importer not on main');
      expect(onRunAutomation).not.toHaveBeenCalled();
    });

    it('allows that row on the caller\'s own task', async () => {
      addMoveRow('To Do');
      readTaskRunningWork.mockResolvedValue(UNMERGED_COMMITS);
      const task = otherTask('Own task');
      context.callerTaskId = task.id;

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: task.id }, context);

      expect(response.success).toBe(true);
      expect(onRunAutomation).toHaveBeenCalledOnce();
    });

    it('allows a Move to column row aimed at a column that keeps the work', async () => {
      addMoveRow('Executing');
      readTaskRunningWork.mockResolvedValue(UNMERGED_COMMITS);

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
    });

    it('answers a task that left the row\'s column with that, and reads no running work', async () => {
      // Aimed at To Do while the task has a live agent: it must not read as a
      // running-work refusal, because the row would move nothing.
      addMoveRow('To Do');
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
      const task = tasks.create({ title: 'Moved on', description: '', swimlane_id: laneIds['Executing'] });

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: task.id }, context);

      expect(response.success).toBe(false);
      expect(response.error).toBe(`#${task.display_id} "${task.title}" is no longer in Planning, so this row cannot move it.`);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
      expect(onRunAutomation).not.toHaveBeenCalled();
    });

    it.each(['No Such Column', 'Planning'])('runs a row whose target "%s" cannot be resolved, without reading anything', async (targetColumn) => {
      addMoveRow(targetColumn);
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
      expect(onRunAutomation).toHaveBeenCalledOnce();
    });

    it('refuses a row aimed at Done for a live agent', async () => {
      addMoveRow('Done');
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

      expectRefused(response, 'a live agent');
      expect(response.error).toContain('Moving it to Done');
      expect(onRunAutomation).not.toHaveBeenCalled();
    });

    it('allows a row aimed at Done for commits alone, because Done keeps the branch', async () => {
      addMoveRow('Done');
      readTaskRunningWork.mockResolvedValue(UNMERGED_COMMITS);

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).toHaveBeenCalledOnce();
      expect(onRunAutomation).toHaveBeenCalledOnce();
    });

    it('does not guard a Send message row on another task, and reads nothing', async () => {
      const added = handleSetAutomations({
        column: 'Planning',
        automations: [{ name: 'Nudge', type: 'send_message', on: 'enter', message: 'Keep going' }],
      }, context) as CommandResponse;
      expect(added.success).toBe(true);
      readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

      const response = await handleRunAutomation({ column: 'Planning', automation: 'Nudge', task: otherTask().id }, context);

      expect(response.success).toBe(true);
      expect(readTaskRunningWork).not.toHaveBeenCalled();
      expect(onRunAutomation).toHaveBeenCalledOnce();
    });

    describe('a row with no target column, which moves the task to the next one', () => {
      function addNextRow(columnName: string): void {
        const response = handleSetAutomations({
          column: columnName,
          automations: [{ name: 'Send it', type: 'move_to_column', on: 'turn_end' }],
        }, context) as CommandResponse;
        expect(response.success).toBe(true);
      }

      it('resolves the next column from the row\'s column, and refuses when that is Done', async () => {
        addNextRow('Merge');
        readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
        const task = tasks.create({ title: 'Last step', description: '', swimlane_id: laneIds['Merge'] });

        const response = await handleRunAutomation({ column: 'Merge', automation: 'Send it', task: task.id }, context);

        expectRefused(response, 'a live agent');
        expect(response.error).toContain('Moving it to Done');
        expect(onRunAutomation).not.toHaveBeenCalled();
      });

      it('refuses when the next column is To Do', async () => {
        // The default board never puts a column before To Do, so the order is
        // rewritten to make To Do the next column after Planning.
        new SwimlaneRepository(database).update({ id: laneIds['Planning'], position: -1 });
        addNextRow('Planning');
        readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

        const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

        expectRefused(response, 'a live agent');
        expect(response.error).toContain('Moving it to To Do');
        expect(onRunAutomation).not.toHaveBeenCalled();
      });

      it('reads nothing when the next column keeps the work', async () => {
        addNextRow('Planning');
        readTaskRunningWork.mockResolvedValue(LIVE_AGENT);

        const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: otherTask().id }, context);

        expect(response.success).toBe(true);
        expect(readTaskRunningWork).not.toHaveBeenCalled();
      });

      it('follows the task\'s own route, where the next column after Planning is Done', async () => {
        const workflows = new WorkflowRepository(database);
        const workflow = workflows.create({ title: 'Usage budgets' });
        addNextRow('Planning');
        readTaskRunningWork.mockResolvedValue(LIVE_AGENT);
        const task = tasks.create({
          title: 'Routed',
          description: '',
          swimlane_id: laneIds['Planning'],
          workflow: {
            workflow_id: workflow.id,
            workflow_project_id: PROJECT_ID,
            route_start_swimlane_id: null,
            route_last_swimlane_id: laneIds['Planning'],
            skipped_swimlane_ids: [],
            canvas_x: null,
            canvas_y: null,
          },
        });

        const response = await handleRunAutomation({ column: 'Planning', automation: 'Send it', task: task.id }, context);

        expectRefused(response, 'a live agent');
        expect(response.error).toContain('Moving it to Done');
        expect(onRunAutomation).not.toHaveBeenCalled();
      });
    });
  });

  describe('the refusal\'s wording', () => {
    const REFUSED_TASK = { display_id: 7, title: 'Importer' } as unknown as Task;
    const withWorktree = (branch: string | null, commitsNotOnBase: number | null, uncommittedFiles: number): TaskRunningWork => ({
      liveAgent: false,
      worktree: { readable: true, branch, baseBranch: 'main', commitsNotOnBase, uncommittedFiles },
    });

    it('says "in its worktree" for commits on a detached HEAD', () => {
      const refusal = runningWorkRefusal(REFUSED_TASK, withWorktree(null, 3, 0), { kind: 'delete' });

      expect(refusal).toContain('has running work: 3 commits in its worktree not on main.');
    });

    it('names only the files for a move to Done that has commits and uncommitted files', () => {
      const refusal = runningWorkRefusal(REFUSED_TASK, withWorktree('task/importer', 3, 2), { kind: 'done', columnName: 'Done' });

      expect(refusal).toContain('has running work: 2 uncommitted files. Moving it to Done');
      expect(refusal).not.toMatch(/\d+ commits? (on|in)\b/);
    });

    it('names both for a move to To Do that has commits and uncommitted files', () => {
      const refusal = runningWorkRefusal(REFUSED_TASK, withWorktree('task/importer', 3, 2), { kind: 'todo', columnName: 'To Do' });

      expect(refusal).toContain('has running work: 3 commits on task/importer not on main and 2 uncommitted files.');
    });
  });

  describe('where the guard can be reached from', () => {
    const SOURCE_ROOT = path.resolve(__dirname, '../../src');

    function sourceFilesUnder(directory: string): string[] {
      return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFilesUnder(entryPath);
        return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
      });
    }

    it('is imported only by the command handlers, so the app\'s own delete and drag never meet it', () => {
      const importers = sourceFilesUnder(SOURCE_ROOT)
        .filter((file) => /from '[^']*running-work-guard'/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/'))
        .sort();

      expect(importers).toEqual([
        'main/agent/commands/automation-commands.ts',
        'main/agent/commands/task-commands.ts',
      ]);
    });

    it('marks an agent only where an MCP tool builds the context', () => {
      const setters = sourceFilesUnder(SOURCE_ROOT)
        .filter((file) => /callerKind: 'agent'/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/'))
        .sort();

      expect(setters).toEqual([
        'main/agent/mcp-http/automation-tools.ts',
        'main/agent/mcp-http/task-tools.ts',
      ]);
    });

    it('hands the automation tools the caller\'s task, so an agent can run a row on its own task', () => {
      // Without it every agent's run_automation reads as another task's and is guarded.
      const serverSource = fs.readFileSync(path.join(SOURCE_ROOT, 'main/agent/mcp-http-server.ts'), 'utf8');

      expect(serverSource).toMatch(/registerAutomationTools\(\s*mcpServer,\s*resolver,\s*callerTaskId \?\? null\s*\)/);
    });
  });
});
