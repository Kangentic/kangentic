import { TaskRepository } from '../../db/repositories/task-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { resolveColumn } from './column-resolver';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleCreateTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const title = String(params.title ?? '').slice(0, 200);
  const description = String(params.description ?? '').slice(0, 10_000);
  const columnName = params.column as string | null;
  const branchName = params.branchName as string | null;
  const baseBranch = params.baseBranch as string | null;
  const useWorktree = params.useWorktree as boolean | null;
  const attachments = params.attachments as Array<{ filePath: string; filename?: string }> | null;

  if (!title.trim()) {
    return { success: false, error: 'Task title is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName);
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  const task = taskRepo.create({
    title,
    description,
    swimlane_id: targetSwimlane.id,
    ...(baseBranch ? { baseBranch } : {}),
    ...(useWorktree !== null ? { useWorktree } : {}),
    ...(branchName ? { customBranchName: branchName } : {}),
  });

  // Process file attachments if provided
  if (attachments && attachments.length > 0) {
    const attachmentRepo = new AttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of attachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        attachmentRepo.add(projectPath, task.id, fileData.filename, fileData.base64Data, fileData.mediaType);
      } catch (error) {
        console.error(`[create_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
  }

  context.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);

  return {
    success: true,
    data: { taskId: task.id, displayId: task.display_id, title: task.title, column: targetSwimlane.name },
    message: `Created task "${task.title}" in ${targetSwimlane.name} column (#${task.display_id}, id: ${task.id})`,
  };
};

export const handleUpdateTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;
  const newTitle = params.title as string | null;
  const newDescription = params.description as string | null;
  const newPrUrl = params.prUrl as string | null;
  const newPrNumber = params.prNumber as number | null;

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const updates: Record<string, unknown> = { id: task.id };
  if (newTitle !== null) updates.title = String(newTitle).slice(0, 200);
  if (newDescription !== null) updates.description = String(newDescription).slice(0, 10_000);
  if (newPrUrl !== null) updates.pr_url = String(newPrUrl);
  if (newPrNumber !== null) updates.pr_number = Number(newPrNumber);

  const updated = taskRepo.update(updates as { id: string; title?: string; description?: string; pr_url?: string; pr_number?: number });

  context.onTaskUpdated(updated);

  const changedFields: string[] = [];
  if (newTitle !== null) changedFields.push('title');
  if (newDescription !== null) changedFields.push('description');
  if (newPrUrl !== null) changedFields.push('prUrl');
  if (newPrNumber !== null) changedFields.push('prNumber');

  return {
    success: true,
    message: `Updated ${changedFields.join(' and ')} for "${updated.title}".`,
    data: { id: updated.id, title: updated.title, description: updated.description, prUrl: updated.pr_url, prNumber: updated.pr_number },
  };
};

export const handleDeleteTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const attachmentRepo = new AttachmentRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Delete attachments and session records before task (FK constraints)
  attachmentRepo.deleteByTaskId(task.id);
  sessionRepo.deleteByTaskId(task.id);

  // Fire-and-forget async cleanup (PTY kill, worktree removal, renderer notification)
  context.onTaskDeleted(task);

  // Delete the task from DB
  taskRepo.delete(task.id);

  return {
    success: true,
    message: `Deleted task "${task.title}" (#${task.display_id}).`,
    data: { id: task.id, displayId: task.display_id, title: task.title },
  };
};
