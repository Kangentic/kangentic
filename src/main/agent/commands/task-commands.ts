import { TaskRepository } from '../../db/repositories/task-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { resolveColumn } from './column-resolver';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { TaskUpdateInput } from '../../../shared/types';

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
  const newAgent = params.agent as string | null;
  const newPriority = params.priority as number | null;
  const newLabels = params.labels as string[] | null;
  const newBaseBranch = params.baseBranch as string | null;
  const newUseWorktree = params.useWorktree as boolean | null;

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
  if (newAgent !== null) updates.agent = newAgent;
  if (newPriority !== null) updates.priority = Number(newPriority);
  if (newLabels !== null) updates.labels = newLabels;
  if (newBaseBranch !== null) updates.base_branch = newBaseBranch;
  if (newUseWorktree !== null) updates.use_worktree = newUseWorktree ? 1 : 0;

  const updated = taskRepo.update(updates as unknown as TaskUpdateInput);

  context.onTaskUpdated(updated);

  const changedFields: string[] = [];
  if (newTitle !== null) changedFields.push('title');
  if (newDescription !== null) changedFields.push('description');
  if (newPrUrl !== null) changedFields.push('prUrl');
  if (newPrNumber !== null) changedFields.push('prNumber');
  if (newAgent !== null) changedFields.push('agent');
  if (newPriority !== null) changedFields.push('priority');
  if (newLabels !== null) changedFields.push('labels');
  if (newBaseBranch !== null) changedFields.push('baseBranch');
  if (newUseWorktree !== null) changedFields.push('useWorktree');

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for "${updated.title}".`,
    data: {
      id: updated.id,
      displayId: updated.display_id,
      title: updated.title,
      description: updated.description,
      prUrl: updated.pr_url,
      prNumber: updated.pr_number,
      agent: updated.agent,
      priority: updated.priority,
      labels: updated.labels,
      baseBranch: updated.base_branch,
      useWorktree: updated.use_worktree,
    },
  };
};

export const handleMoveTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskIdParam = params.taskId as string | null;
  const columnName = params.column as string | null;

  if (!taskIdParam) {
    return { success: false, error: 'taskId is required' };
  }
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) {
    return { success: false, error: `Task "${taskIdParam}" not found` };
  }

  const resolution = resolveColumn(db, columnName);
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  if (task.swimlane_id === targetSwimlane.id) {
    return {
      success: true,
      message: `Task "${task.title}" is already in ${targetSwimlane.name}.`,
      data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name },
    };
  }

  // Position at end of target column
  const targetTasks = taskRepo.list(targetSwimlane.id);
  const targetPosition = targetTasks.length;

  // Fire-and-forget the async move (transition engine, agent spawn/suspend, worktree management).
  // The MCP response confirms intent; the LLM should re-query to verify state if needed.
  void context.onTaskMove({
    taskId: task.id,
    targetSwimlaneId: targetSwimlane.id,
    targetPosition,
  }).catch((error) => {
    console.error(`[move_task] Failed for task ${task.id.slice(0, 8)}:`, error);
  });

  return {
    success: true,
    message: `Moving "${task.title}" (#${task.display_id}) to ${targetSwimlane.name}.`,
    data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name },
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
