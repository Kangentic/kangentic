import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { cleanupTaskResources, createTransitionEngine, getProjectRepos, ensureTaskWorktree, ensureTaskBranchCheckout } from '../helpers';
import { guardActiveNonWorktreeSessions } from './task-move';
import { isAbortError } from '../../../shared/abort-utils';
import type { IpcContext } from '../ipc-context';
import type {
  BacklogTaskCreateInput,
  BacklogTaskUpdateInput,
  BacklogPromoteInput,
  BacklogDemoteInput,
  ExternalSource,
  ImportFetchInput,
  ImportExecuteInput,
  Task,
} from '../../../shared/types';
import { createImporterRegistry, getImporter } from '../../import/importer-registry';
import { ImportSourceStore } from '../../import/import-source-store';

/**
 * Per-task AbortControllers for in-flight backlog promotions.
 * When a promoted task is moved before the async chain completes,
 * handleTaskMove aborts the controller to prevent orphaned sessions.
 */
const promotionControllers = new Map<string, AbortController>();

/** Abort an in-flight backlog promotion for the given task. */
export function abortBacklogPromotion(taskId: string): void {
  promotionControllers.get(taskId)?.abort();
  promotionControllers.delete(taskId);
}

function getBacklogRepo(context: IpcContext): BacklogRepository {
  if (!context.currentProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(context.currentProjectId);
  return new BacklogRepository(db);
}

/** Save pending attachments for a backlog task and return the task with updated attachment_count. */
function savePendingAttachments(
  db: ReturnType<typeof getProjectDb>,
  projectPath: string,
  backlogTaskId: string,
  pendingAttachments?: Array<{ filename: string; data: string; media_type: string }>,
): void {
  if (!pendingAttachments?.length) return;
  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
  for (const attachment of pendingAttachments) {
    backlogAttachmentRepo.add(projectPath, backlogTaskId, attachment.filename, attachment.data, attachment.media_type);
  }
}

export function registerBacklogHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.BACKLOG_LIST, () => {
    return getBacklogRepo(context).list();
  });

  ipcMain.handle(IPC.BACKLOG_CREATE, (_, input: BacklogTaskCreateInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const item = backlogRepo.create(input);
    savePendingAttachments(db, context.currentProjectPath, item.id, input.pendingAttachments);
    return backlogRepo.getById(item.id) ?? item;
  });

  ipcMain.handle(IPC.BACKLOG_UPDATE, (_, input: BacklogTaskUpdateInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const item = backlogRepo.update(input);
    savePendingAttachments(db, context.currentProjectPath, item.id, input.pendingAttachments);
    return backlogRepo.getById(item.id) ?? item;
  });

  ipcMain.handle(IPC.BACKLOG_DELETE, (_, id: string) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    // Clean up backlog attachments before deleting the task
    new BacklogAttachmentRepository(db).deleteByTaskId(id);
    new BacklogRepository(db).delete(id);
  });

  ipcMain.handle(IPC.BACKLOG_REORDER, (_, ids: string[]) => {
    getBacklogRepo(context).reorder(ids);
  });

  ipcMain.handle(IPC.BACKLOG_BULK_DELETE, (_, ids: string[]) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
    // Clean up backlog attachments before bulk delete
    for (const id of ids) {
      backlogAttachmentRepo.deleteByTaskId(id);
    }
    new BacklogRepository(db).bulkDelete(ids);
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

    const backlogAttachments = new BacklogAttachmentRepository(db);

    const targetSwimlane = swimlanes.getById(input.targetSwimlaneId);
    if (!targetSwimlane) throw new Error(`Swimlane ${input.targetSwimlaneId} not found`);

    const createdTasks: Task[] = [];

    for (const backlogTaskId of input.backlogTaskIds) {
      const item = backlogRepo.getById(backlogTaskId);
      if (!item) continue;

      // Create a task from the backlog task, carrying over labels and priority
      const task = tasks.create({
        title: item.title,
        description: item.description,
        swimlane_id: input.targetSwimlaneId,
        labels: item.labels,
        priority: item.priority,
      });

      // Copy backlog attachments to task attachments
      const itemAttachments = backlogAttachments.list(backlogTaskId);
      for (const backlogAttachment of itemAttachments) {
        try {
          const buffer = fs.readFileSync(backlogAttachment.file_path);
          const base64Data = buffer.toString('base64');
          attachments.add(projectPath, task.id, backlogAttachment.filename, base64Data, backlogAttachment.media_type);
        } catch (error) {
          console.error(`[BACKLOG_PROMOTE] Failed to copy attachment "${backlogAttachment.filename}":`, error);
        }
      }
      // Clean up backlog attachment files
      backlogAttachments.deleteByTaskId(backlogTaskId);

      // Remove from backlog
      backlogRepo.delete(backlogTaskId);

      // Fire transition engine if target column auto-spawns
      if (targetSwimlane.auto_spawn) {
        const promotionController = new AbortController();
        promotionControllers.set(task.id, promotionController);
        const { signal } = promotionController;

        try {
          try {
            await ensureTaskWorktree(context, task, tasks, projectPath, { signal });
          } catch (worktreeError) {
            if (isAbortError(worktreeError)) throw worktreeError;
            console.error('[BACKLOG_PROMOTE] Worktree creation failed:', worktreeError);
            createdTasks.push(tasks.getById(task.id) ?? task);
            continue;
          }

          try {
            guardActiveNonWorktreeSessions(context, task, tasks);
            await ensureTaskBranchCheckout(task, projectPath, { signal });
          } catch (checkoutError) {
            if (isAbortError(checkoutError)) throw checkoutError;
            console.error('[BACKLOG_PROMOTE] Branch checkout failed:', checkoutError);
            createdTasks.push(tasks.getById(task.id) ?? task);
            continue;
          }

          const sessionRepo = new SessionRepository(db);
          const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

          try {
            await engine.executeTransition(task, '*', input.targetSwimlaneId, undefined, undefined, signal);
          } catch (transitionError) {
            if (isAbortError(transitionError)) throw transitionError;
            console.error('[BACKLOG_PROMOTE] Transition failed:', transitionError);
          }
        } catch (error) {
          if (isAbortError(error)) {
            console.log(`[BACKLOG_PROMOTE] Aborted promotion for task ${task.id.slice(0, 8)}`);
            context.sessionManager.removeByTaskId(task.id);
            tasks.update({ id: task.id, session_id: null });
            createdTasks.push(tasks.getById(task.id) ?? task);
            continue;
          }
          throw error;
        } finally {
          if (promotionControllers.get(task.id) === promotionController) {
            promotionControllers.delete(task.id);
          }
        }
      }

      createdTasks.push(tasks.getById(task.id) ?? task);
    }

    return createdTasks;
  });

  ipcMain.handle(IPC.BACKLOG_DEMOTE, async (_, input: BacklogDemoteInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
    const { tasks, attachments } = getProjectRepos(context);

    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    // Cancel any pending auto_command injection before cleanup
    context.commandInjector.cancel(input.taskId);

    // Clean up session, worktree, and branch
    await cleanupTaskResources(context, task, tasks);

    // Create backlog task from task, preserving labels/priority (input overrides task values)
    const backlogTask = backlogRepo.createFromTask(
      task.title,
      task.description,
      input.priority ?? task.priority,
      input.labels ?? task.labels,
    );

    // Copy task attachments to backlog task before deleting
    const taskAttachments = attachments.list(task.id);
    for (const taskAttachment of taskAttachments) {
      try {
        const buffer = fs.readFileSync(taskAttachment.file_path);
        const base64Data = buffer.toString('base64');
        backlogAttachmentRepo.add(context.currentProjectPath, backlogTask.id, taskAttachment.filename, base64Data, taskAttachment.media_type);
      } catch (error) {
        console.error(`[BACKLOG_DEMOTE] Failed to copy attachment "${taskAttachment.filename}":`, error);
      }
    }

    // Remove task attachment files from disk before deleting the task
    attachments.deleteByTaskId(task.id);

    // Delete the task from the board
    tasks.delete(task.id);

    // Re-fetch to get updated attachment_count
    return backlogRepo.getById(backlogTask.id) ?? backlogTask;
  });

  ipcMain.handle(IPC.BACKLOG_REMAP_PRIORITIES, (_, mapping: Record<number, number>) => {
    return getBacklogRepo(context).remapPriorities(mapping);
  });

  ipcMain.handle(IPC.BACKLOG_RENAME_LABEL, (_, oldName: string, newName: string) => {
    const backlogCount = getBacklogRepo(context).renameLabel(oldName, newName);
    const { tasks } = getProjectRepos(context);
    const taskCount = tasks.renameLabel(oldName, newName);
    return backlogCount + taskCount;
  });

  ipcMain.handle(IPC.BACKLOG_DELETE_LABEL, (_, name: string) => {
    const backlogCount = getBacklogRepo(context).deleteLabel(name);
    const { tasks } = getProjectRepos(context);
    const taskCount = tasks.deleteLabel(name);
    return backlogCount + taskCount;
  });

  // === Backlog Attachments ===

  ipcMain.handle(IPC.BACKLOG_ATTACHMENT_LIST, (_, backlogTaskId: string) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    return new BacklogAttachmentRepository(db).list(backlogTaskId);
  });

  ipcMain.handle(IPC.BACKLOG_ATTACHMENT_ADD, (_, input: { backlog_task_id: string; filename: string; data: string; media_type: string }) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const maxSize = 10 * 1024 * 1024; // 10MB
    const dataSize = Buffer.byteLength(input.data, 'base64');
    if (dataSize > maxSize) throw new Error(`Attachment exceeds 10MB limit (${(dataSize / 1024 / 1024).toFixed(1)}MB)`);
    const db = getProjectDb(context.currentProjectId);
    return new BacklogAttachmentRepository(db).add(context.currentProjectPath, input.backlog_task_id, input.filename, input.data, input.media_type);
  });

  ipcMain.handle(IPC.BACKLOG_ATTACHMENT_REMOVE, (_, id: string) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    new BacklogAttachmentRepository(db).remove(id);
  });

  ipcMain.handle(IPC.BACKLOG_ATTACHMENT_GET_DATA_URL, (_, id: string) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    return new BacklogAttachmentRepository(db).getDataUrl(id);
  });

  ipcMain.handle(IPC.BACKLOG_ATTACHMENT_OPEN, async (_, id: string) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    const attachment = new BacklogAttachmentRepository(db).getById(id);
    if (!attachment) throw new Error(`Backlog attachment ${id} not found`);
    const tempDir = path.join(os.tmpdir(), 'kangentic-attachments');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, attachment.id + '_' + attachment.filename);
    fs.copyFileSync(attachment.file_path, tempPath);
    const errorMessage = await shell.openPath(tempPath);
    if (errorMessage) {
      // File format unsupported or no default app - fall back to showing in file explorer
      shell.showItemInFolder(tempPath);
    }
    return errorMessage;
  });

  // --- Import handlers ---

  const importers = createImporterRegistry();

  ipcMain.handle(IPC.BACKLOG_IMPORT_CHECK_CLI, async (_, source: ExternalSource) => {
    const importer = importers[source];
    if (!importer) {
      return { available: false, authenticated: false, error: `Unsupported source: ${source}` };
    }
    return importer.checkCli();
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_FETCH, async (_, input: ImportFetchInput) => {
    if (!context.currentProjectId) throw new Error('No project is currently open');
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const importer = getImporter(importers, input.source);

    return importer.fetch(input, (source, externalIds) => backlogRepo.findByExternalIds(source, externalIds));
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_EXECUTE, async (_, input: ImportExecuteInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const importer = getImporter(importers, input.source);

    const externalIds = input.issues.map((issue) => issue.externalId);
    const alreadyImportedIds = backlogRepo.findByExternalIds(input.source, externalIds);

    const importedItems = [];
    let skippedDuplicates = 0;
    let totalSkippedAttachments = 0;

    for (const issue of input.issues) {
      if (alreadyImportedIds.has(issue.externalId)) {
        skippedDuplicates++;
        continue;
      }

      // Download inline images from the issue body (source-agnostic)
      const { attachments: inlineAttachments, skippedCount: inlineSkipped } =
        await importer.downloadImages(issue.body);
      totalSkippedAttachments += inlineSkipped;

      // Download file attachments if the source supports them (e.g. Azure DevOps AttachedFile relations)
      const downloadedAttachments = [...inlineAttachments];
      if (importer.downloadFileAttachments && issue.fileAttachments?.length) {
        const { attachments: fileAttachments, skippedCount: fileSkipped } =
          await importer.downloadFileAttachments(issue.fileAttachments);
        downloadedAttachments.push(...fileAttachments);
        totalSkippedAttachments += fileSkipped;
      }

      const attachmentMetadata = downloadedAttachments.map((attachment) => ({
        originalUrl: attachment.sourceUrl,
        filename: attachment.filename,
      }));

      const item = backlogRepo.create({
        title: issue.title,
        description: issue.body,
        priority: 0,
        labels: issue.labels,
        assignee: issue.assignee ?? undefined,
        externalId: issue.externalId,
        externalSource: input.source,
        externalUrl: issue.externalUrl,
        syncStatus: 'imported',
        externalMetadata: attachmentMetadata.length > 0 ? { attachments: attachmentMetadata } : undefined,
      });

      // Save downloaded images as backlog attachments
      if (downloadedAttachments.length > 0) {
        const pendingAttachments = downloadedAttachments.map((attachment) => ({
          filename: attachment.filename,
          data: attachment.data,
          media_type: attachment.mediaType,
        }));
        savePendingAttachments(db, context.currentProjectPath, item.id, pendingAttachments);
      }

      const refreshedItem = backlogRepo.getById(item.id) ?? item;
      importedItems.push(refreshedItem);
    }

    return {
      imported: importedItems.length,
      skippedDuplicates,
      skippedAttachments: totalSkippedAttachments,
      items: importedItems,
    };
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_SOURCES_LIST, () => {
    if (!context.currentProjectPath) throw new Error('No project is currently open');
    return new ImportSourceStore(context.currentProjectPath).list();
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_SOURCES_ADD, (_, input: { source: ExternalSource; url: string }) => {
    if (!context.currentProjectPath) throw new Error('No project is currently open');
    return new ImportSourceStore(context.currentProjectPath).add(input.source, input.url);
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_SOURCES_REMOVE, (_, id: string) => {
    if (!context.currentProjectPath) throw new Error('No project is currently open');
    new ImportSourceStore(context.currentProjectPath).remove(id);
  });
}
