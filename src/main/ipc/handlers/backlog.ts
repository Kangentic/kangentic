import fs from 'node:fs';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { RemoteItemCacheRepository } from '../../db/repositories/remote-item-cache-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { cleanupTaskResources, createTransitionEngine, getProjectRepos, ensureTaskWorktree, ensureTaskBranchCheckout, notifySpawnBlocked, spawnAgent, openAttachmentFile } from '../helpers';
import { isAbortError } from '../../../shared/abort-utils';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { withTaskLock } from '../task-lifecycle-lock';
import type { IpcContext } from '../ipc-context';
import type {
  BacklogTaskCreateInput,
  BacklogTaskUpdateInput,
  BacklogPromoteInput,
  BacklogDemoteInput,
  ExternalIssue,
  ExternalSource,
  ImportCacheQuery,
  ImportReconcileInput,
  ImportReconcileResult,
  ImportExecuteInput,
  Task,
} from '../../../shared/types';
import { boardRegistry, ImportSourceStore } from '../../boards';
import { registerAsanaIpcHandlers } from '../../boards/adapters/asana';

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

/** Per-round-trip page size for the reconcile fetch (GitHub caps per_page at 100; ADO ignores it). */
const RECONCILE_PAGE_SIZE = 100;

/**
 * How stale a cache may get before a provider with no cheap id listing is forced
 * through a full, authoritative pass. Those providers only prune on a full
 * reconcile, and the only user action that asks for one is the all-imported
 * empty state's Refresh link, which a user who imports a subset never sees. Without
 * this, an item deleted on the remote would stay in their Import dialog forever.
 */
const FULL_RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * In-flight reconciles keyed by (project, source, repository). Two reconciles for
 * one key interleave destructively: the second's upsert can commit between the
 * first's keep-list snapshot and its prune, so the first deletes rows the second
 * just wrote. The renderer's own sequence token only orders one dialog's
 * responses, and a second window is a second renderer. Chaining is enough here
 * because a reconcile is idempotent, so the follower simply re-runs against
 * whatever state the leader left.
 */
const inFlightReconciles = new Map<string, Promise<ImportReconcileResult>>();

function serializeReconcile(
  key: string,
  run: () => Promise<ImportReconcileResult>,
): Promise<ImportReconcileResult> {
  const previous = inFlightReconciles.get(key);
  // Swallow the predecessor's rejection: a failed reconcile must not fail the
  // next one, it only has to finish first.
  const chained = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(run);
  inFlightReconciles.set(key, chained);
  void chained.catch(() => undefined).finally(() => {
    if (inFlightReconciles.get(key) === chained) inFlightReconciles.delete(key);
  });
  return chained;
}

/**
 * Re-stamp `alreadyImported` on cached issues from the live backlog. The flag is
 * never persisted (it goes stale as the user imports), so it is recomputed on
 * every read of the cache.
 */
function stampAlreadyImported(
  backlogRepo: BacklogRepository,
  source: ExternalSource,
  issues: ExternalIssue[],
): ExternalIssue[] {
  if (issues.length === 0) return issues;
  const imported = backlogRepo.findByExternalIds(source, issues.map((issue) => issue.externalId));
  return issues.map((issue) => ({ ...issue, alreadyImported: imported.has(issue.externalId) }));
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

    // Phase 1: Synchronous DB work - create tasks and return immediately
    const createdTasks: Task[] = [];
    const tasksToSpawn: Task[] = [];

    for (const backlogTaskId of input.backlogTaskIds) {
      const item = backlogRepo.getById(backlogTaskId);
      if (!item) continue;

      // Create a task from the backlog task, carrying over labels, priority, and
      // external origin (so import dedup still sees the issue after promotion).
      const task = tasks.create({
        title: item.title,
        description: item.description,
        swimlane_id: input.targetSwimlaneId,
        labels: item.labels,
        priority: item.priority,
        externalId: item.external_id ?? undefined,
        externalSource: item.external_source ?? undefined,
        externalUrl: item.external_url ?? undefined,
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

      const freshTask = tasks.getById(task.id) ?? task;
      createdTasks.push(freshTask);

      if (targetSwimlane.auto_spawn) {
        tasksToSpawn.push(freshTask);
      }
    }

    // Phase 2: Fire-and-forget async work - worktree setup + agent spawn
    // Runs in background so the UI updates instantly
    if (tasksToSpawn.length > 0) {
      void (async () => {
        try {
          for (const task of tasksToSpawn) {
            const promotionController = new AbortController();
            promotionControllers.set(task.id, promotionController);
            const { signal } = promotionController;

            // Serialize against any other lifecycle op (move/suspend/resume/etc)
            // for the same task. AbortController is wired up outside the lock so
            // a concurrent move can preempt this promotion before it acquires.
            await withTaskLock(task.id, async () => {
              // Promotion spawns used to be progress-silent; the card now shows
              // the same fetch/branch/worktree phases the drag path does. The
              // finally clears on every exit, including the abort path.
              const onProgress = createProgressCallback(context.mainWindow, task.id);
              try {
                try {
                  await ensureTaskWorktree(context, task, tasks, projectPath, { signal, onProgress, projectId });
                } catch (worktreeError) {
                  if (isAbortError(worktreeError)) throw worktreeError;
                  console.error('[BACKLOG_PROMOTE] Worktree creation failed:', worktreeError);
                  notifySpawnBlocked(context, task, 'worktree', worktreeError, projectId);
                  return;
                }

                try {
                  await ensureTaskBranchCheckout(context, task, projectPath, { signal, onProgress, projectId });
                } catch (checkoutError) {
                  if (isAbortError(checkoutError)) throw checkoutError;
                  console.error('[BACKLOG_PROMOTE] Branch checkout failed:', checkoutError);
                  notifySpawnBlocked(context, task, 'checkout', checkoutError, projectId);
                  return;
                }

                const sessionRepo = new SessionRepository(db);
                const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);
                // projectId/projectPath so the spawn preamble (override lock +
                // agent resolution) sees the project defaults instead of null.
                await spawnAgent({ context, engine, tasks, sessionRepo, task, fromSwimlaneId: '*', toLane: targetSwimlane, signal, projectId, projectPath, attachments });
              } catch (error) {
                if (isAbortError(error)) {
                  console.log(`[BACKLOG_PROMOTE] Aborted promotion for task ${task.id.slice(0, 8)}`);
                  context.sessionManager.removeByTaskId(task.id);
                  tasks.update({ id: task.id, session_id: null });
                  return;
                }
                throw error;
              } finally {
                clearSpawnProgress(context.mainWindow, task.id);
                if (promotionControllers.get(task.id) === promotionController) {
                  promotionControllers.delete(task.id);
                }
              }
            });
          }
        } catch (error) {
          console.error('[BACKLOG_PROMOTE] Background agent spawn failed:', error);
        }
      })();
    }

    return createdTasks;
  });

  ipcMain.handle(IPC.BACKLOG_DEMOTE, (_, input: BacklogDemoteInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const projectPath = context.currentProjectPath;
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
    const { tasks, attachments } = getProjectRepos(context);

    // Cancel any in-flight backlog promotion BEFORE queueing on the lock so
    // a stuck promotion can be aborted by this demote.
    abortBacklogPromotion(input.taskId);

    return withTaskLock(input.taskId, async () => {
      const task = tasks.getById(input.taskId);
      if (!task) throw new Error(`Task ${input.taskId} not found`);

      // Cancel any pending auto_command injection before cleanup
      context.terminalSubmitScheduler.cancel(input.taskId);

      // Clean up session, worktree, and branch
      await cleanupTaskResources(context, task, tasks);

      // Create backlog task from task, preserving labels/priority (input overrides
      // task values) and external origin so a demote->reimport stays deduplicated.
      const backlogTask = backlogRepo.createFromTask(
        task.title,
        task.description,
        input.priority ?? task.priority,
        input.labels ?? task.labels,
        { externalId: task.external_id, externalSource: task.external_source, externalUrl: task.external_url },
      );

      // Copy task attachments to backlog task before deleting
      const taskAttachments = attachments.list(task.id);
      for (const taskAttachment of taskAttachments) {
        try {
          const buffer = fs.readFileSync(taskAttachment.file_path);
          const base64Data = buffer.toString('base64');
          backlogAttachmentRepo.add(projectPath, backlogTask.id, taskAttachment.filename, base64Data, taskAttachment.media_type);
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
    return openAttachmentFile(attachment);
  });

  // --- Import handlers ---

  ipcMain.handle(IPC.BACKLOG_IMPORT_CHECK_CLI, async (_, source: ExternalSource) => {
    const adapter = boardRegistry.get(source);
    if (!adapter) {
      return { available: false, authenticated: false, error: `Unsupported source: ${source}` };
    }
    return adapter.checkCli();
  });

  // Paint instantly from the persistent cache, no network. alreadyImported is
  // re-stamped from the live backlog so a just-imported item shows imported offline.
  ipcMain.handle(IPC.BACKLOG_IMPORT_GET_CACHED, (_, input: ImportCacheQuery) => {
    const projectId = input.projectId ?? context.currentProjectId;
    if (!projectId) throw new Error('No project is currently open');
    const db = getProjectDb(projectId);
    const cacheRepo = new RemoteItemCacheRepository(db);
    const backlogRepo = new BacklogRepository(db);
    const issues = cacheRepo.getForSource(input.source, input.repository);
    return { issues: stampAlreadyImported(backlogRepo, input.source, issues) };
  });

  // Fetch items changed since the cache high-water mark, merge them in, prune
  // items the remote no longer has, and return the full merged set. A 'full' mode
  // (or an empty cache) re-fetches everything.
  ipcMain.handle(IPC.BACKLOG_IMPORT_RECONCILE, async (_, input: ImportReconcileInput) => {
    const projectId = input.projectId ?? context.currentProjectId;
    if (!projectId) throw new Error('No project is currently open');
    return serializeReconcile(
      `${projectId}::${input.source}::${input.repository}`,
      () => runReconcile(projectId, input),
    );
  });

  async function runReconcile(
    projectId: string,
    input: ImportReconcileInput,
  ): Promise<ImportReconcileResult> {
    const db = getProjectDb(projectId);
    const cacheRepo = new RemoteItemCacheRepository(db);
    const backlogRepo = new BacklogRepository(db);
    const adapter = boardRegistry.requireStable(input.source);
    const findAlreadyImported = (source: ExternalSource, externalIds: string[]) =>
      backlogRepo.findByExternalIds(source, externalIds);

    // A provider with a cheap id listing prunes on every reconcile, so its cache
    // never goes stale. The others prune only on a full pass, so escalate one when
    // the cache has gone too long without it (MIN(fetched_at) is the last time a
    // full pass stamped every row). An unparseable timestamp compares NaN and
    // simply does not escalate.
    const oldestFetchedAt = cacheRepo.getOldestFetchedAt(input.source, input.repository);
    const overdueForFullPass = !adapter.listExternalIds
      && oldestFetchedAt !== undefined
      && Date.now() - new Date(oldestFetchedAt).getTime() > FULL_RECONCILE_MAX_AGE_MS;

    const isFull = input.mode === 'full'
      || cacheRepo.count(input.source, input.repository) === 0
      || overdueForFullPass;
    const since = isFull ? undefined : cacheRepo.getWatermark(input.source, input.repository);

    // Fetch changed items across all states so the single cache bucket stays
    // complete. ADO returns everything in one page; GitHub loops real pages.
    const fetched: ExternalIssue[] = [];
    let page = 1;
    for (;;) {
      const result = await adapter.fetch(
        { source: input.source, repository: input.repository, page, perPage: RECONCILE_PAGE_SIZE, state: 'all', since },
        findAlreadyImported,
      );
      fetched.push(...result.issues);
      if (!result.hasNextPage) break;
      page += 1;
    }

    // A source can return the same item on two pages when its ordering shifts
    // between sequential fetches, so dedupe by externalId (keeping the last, freshest
    // copy) before the upsert. Without this the added/updated counts double-count a
    // duplicate and the same row is written twice.
    const dedupedById = new Map<string, ExternalIssue>();
    for (const issue of fetched) dedupedById.set(issue.externalId, issue);
    const toCache = [...dedupedById.values()];

    const syncTime = new Date().toISOString();
    const { added, updated } = cacheRepo.upsertMany(input.source, input.repository, toCache, syncTime);

    // Auto-prune: a cheap id listing (ADO) prunes on every reconcile; without one,
    // only a full fetch is authoritative enough to prune (its result IS the set). The
    // fetched items are already committed, so a prune failure (a transient CLI error on
    // the second call) must not fail the whole reconcile and hide the just-synced data;
    // degrade to no prune this round instead.
    // An EMPTY authoritative set never prunes. "The remote really has nothing" and
    // "the provider could not answer" arrive here as the same empty array, and
    // pruning against it deletes every cached row for the source - the whole cache,
    // silently, on a transient CLI hiccup. Skipping costs a stale row until the next
    // pass returns a real answer; not skipping costs the cache this feature exists to
    // keep. The asymmetry is what decides it, so an emptied remote clears its rows on
    // the first pass that can actually say so.
    let removed = 0;
    try {
      if (adapter.listExternalIds) {
        const keepIds = await adapter.listExternalIds({ source: input.source, repository: input.repository });
        if (keepIds.length > 0) {
          removed = cacheRepo.pruneMissing(input.source, input.repository, keepIds);
        }
      } else if (isFull && toCache.length > 0) {
        removed = cacheRepo.pruneMissing(input.source, input.repository, toCache.map((issue) => issue.externalId));
      }
    } catch (error) {
      console.warn('[BACKLOG_IMPORT_RECONCILE] prune step failed; skipping prune this round', error);
    }

    const all = cacheRepo.getForSource(input.source, input.repository);
    return { issues: stampAlreadyImported(backlogRepo, input.source, all), added, updated, removed };
  }

  ipcMain.handle(IPC.BACKLOG_IMPORT_EXECUTE, async (_, input: ImportExecuteInput) => {
    if (!context.currentProjectId || !context.currentProjectPath) {
      throw new Error('No project is currently open');
    }
    const db = getProjectDb(context.currentProjectId);
    const backlogRepo = new BacklogRepository(db);
    const adapter = boardRegistry.requireStable(input.source);

    const externalIds = input.issues.map((issue) => issue.externalId);
    const alreadyImportedIds = backlogRepo.findByExternalIds(input.source, externalIds);

    // Fetch deferred per-item detail (e.g. ADO comments) for the selected items
    // and fold it into each body, so the imported backlog item carries the same
    // content the pre-defer list fetch used to.
    const issuesToImport = adapter.hydrateForImport
      ? await adapter.hydrateForImport(input.repository, input.issues)
      : input.issues;

    const importedItems = [];
    let skippedDuplicates = 0;
    let totalSkippedAttachments = 0;

    for (const issue of issuesToImport) {
      if (alreadyImportedIds.has(issue.externalId)) {
        skippedDuplicates++;
        continue;
      }

      // Download inline images from the issue body (source-agnostic)
      const { attachments: inlineAttachments, skippedCount: inlineSkipped } =
        await adapter.downloadImages(issue.body);
      totalSkippedAttachments += inlineSkipped;

      // Download file attachments if the source supports them (e.g. Azure DevOps AttachedFile relations)
      const downloadedAttachments = [...inlineAttachments];
      if (adapter.downloadFileAttachments && issue.fileAttachments?.length) {
        const { attachments: fileAttachments, skippedCount: fileSkipped } =
          await adapter.downloadFileAttachments(issue.fileAttachments);
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

  ipcMain.handle(IPC.BACKLOG_IMPORT_SOURCES_ADD, async (_, input: { source: ExternalSource; url: string }) => {
    if (!context.currentProjectPath) throw new Error('No project is currently open');
    const store = new ImportSourceStore(context.currentProjectPath);
    const source = store.add(input.source, input.url);

    // Let the adapter enrich the label with a human-readable name if it can
    // (e.g. Asana: project GID -> project name). Best-effort; any failure
    // keeps the sync label produced by the URL parser.
    const adapter = boardRegistry.get(input.source);
    if (adapter?.resolveLabel) {
      try {
        const resolved = await adapter.resolveLabel(source.repository);
        if (resolved && resolved !== source.label) {
          const updated = store.updateLabel(source.id, resolved);
          if (updated) return updated;
        }
      } catch {
        /* keep the placeholder label */
      }
    }
    return source;
  });

  ipcMain.handle(IPC.BACKLOG_IMPORT_SOURCES_REMOVE, (_, id: string) => {
    if (!context.currentProjectPath) throw new Error('No project is currently open');
    new ImportSourceStore(context.currentProjectPath).remove(id);
  });

  // Asana board integration owns its own IPC surface under
  // src/main/boards/adapters/asana/ipc-handlers.ts so the adapter folder is
  // self-contained. Register it here because Asana auth is part of the
  // backlog import flow.
  registerAsanaIpcHandlers();
}
