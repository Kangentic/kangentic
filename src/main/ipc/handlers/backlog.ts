import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { cleanupTaskResources, createTransitionEngine, getProjectRepos, ensureTaskWorktree, ensureTaskBranchCheckout } from '../helpers';
import { guardActiveNonWorktreeSessions } from './task-move';
import type { IpcContext } from '../ipc-context';
import type {
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
  BacklogPromoteInput,
  BacklogDemoteInput,
  Task,
} from '../../../shared/types';

function getBacklogRepo(context: IpcContext): BacklogRepository {
  if (!context.currentProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(context.currentProjectId);
  return new BacklogRepository(db);
}

export function registerBacklogHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.BACKLOG_LIST, () => {
    return getBacklogRepo(context).list();
  });

  ipcMain.handle(IPC.BACKLOG_CREATE, (_, input: BacklogItemCreateInput) => {
    return getBacklogRepo(context).create(input);
  });

  ipcMain.handle(IPC.BACKLOG_UPDATE, (_, input: BacklogItemUpdateInput) => {
    return getBacklogRepo(context).update(input);
  });

  ipcMain.handle(IPC.BACKLOG_DELETE, (_, id: string) => {
    getBacklogRepo(context).delete(id);
  });

  ipcMain.handle(IPC.BACKLOG_REORDER, (_, ids: string[]) => {
    getBacklogRepo(context).reorder(ids);
  });

  ipcMain.handle(IPC.BACKLOG_BULK_DELETE, (_, ids: string[]) => {
    getBacklogRepo(context).bulkDelete(ids);
  });

  ipcMain.handle(IPC.BACKLOG_PROMOTE, async (_, input: BacklogPromoteInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const projectId = context.currentProjectId;
    const projectPath = context.currentProjectPath;
    const db = getProjectDb(projectId);
    const backlogRepo = new BacklogRepository(db);
    const tasks = new TaskRepository(db);
    const swimlanes = new SwimlaneRepository(db);
    const actions = new ActionRepository(db);
    const attachments = new AttachmentRepository(db);

    const targetSwimlane = swimlanes.getById(input.targetSwimlaneId);
    if (!targetSwimlane) throw new Error(`Swimlane ${input.targetSwimlaneId} not found`);

    const createdTasks: Task[] = [];

    for (const backlogItemId of input.backlogItemIds) {
      const item = backlogRepo.getById(backlogItemId);
      if (!item) continue;

      // Create a task from the backlog item
      const task = tasks.create({
        title: item.title,
        description: item.description,
        swimlane_id: input.targetSwimlaneId,
      });

      // Remove from backlog
      backlogRepo.delete(backlogItemId);

      // Fire transition engine if target column auto-spawns
      if (targetSwimlane.auto_spawn) {
        try {
          await ensureTaskWorktree(context, task, tasks, projectPath);
        } catch (worktreeError) {
          console.error('[BACKLOG_PROMOTE] Worktree creation failed:', worktreeError);
          createdTasks.push(tasks.getById(task.id) ?? task);
          continue;
        }

        try {
          guardActiveNonWorktreeSessions(context, task, tasks);
          await ensureTaskBranchCheckout(task, projectPath);
        } catch (checkoutError) {
          console.error('[BACKLOG_PROMOTE] Branch checkout failed:', checkoutError);
          createdTasks.push(tasks.getById(task.id) ?? task);
          continue;
        }

        const sessionRepo = new SessionRepository(db);
        const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

        try {
          await engine.executeTransition(task, '*', input.targetSwimlaneId);
        } catch (transitionError) {
          console.error('[BACKLOG_PROMOTE] Transition failed:', transitionError);
        }
      }

      createdTasks.push(tasks.getById(task.id) ?? task);
    }

    return createdTasks;
  });

  ipcMain.handle(IPC.BACKLOG_DEMOTE, async (_, input: BacklogDemoteInput) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const { tasks, attachments } = getProjectRepos(context);

    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    // Cancel any pending auto_command injection before cleanup
    context.commandInjector.cancel(input.taskId);

    // Clean up session, worktree, and branch
    await cleanupTaskResources(context, task, tasks);

    // Create backlog item from task
    const backlogItem = backlogRepo.createFromTask(
      task.title,
      task.description,
      input.priority,
      input.labels,
    );

    // Remove attachment files from disk before deleting the task
    attachments.deleteByTaskId(task.id);

    // Delete the task from the board
    tasks.delete(task.id);

    return backlogItem;
  });

  ipcMain.handle(IPC.BACKLOG_REMAP_PRIORITIES, (_, mapping: Record<number, number>) => {
    return getBacklogRepo(context).remapPriorities(mapping);
  });

  ipcMain.handle(IPC.BACKLOG_RENAME_LABEL, (_, oldName: string, newName: string) => {
    return getBacklogRepo(context).renameLabel(oldName, newName);
  });

  ipcMain.handle(IPC.BACKLOG_DELETE_LABEL, (_, name: string) => {
    return getBacklogRepo(context).deleteLabel(name);
  });
}
