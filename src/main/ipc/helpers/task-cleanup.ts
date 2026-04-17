import fs from 'node:fs';
import path from 'node:path';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { getProjectDb } from '../../db/database';
import type { IpcContext } from '../ipc-context';

/**
 * Kill the PTY session and wipe session records for a task.
 * Preserves the worktree and branch so code is not lost.
 *
 * Used by TASK_MOVE -> Backlog ("shelve this task").
 */
export async function cleanupTaskSession(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  const resolvedProjectPath = projectPath ?? context.currentProjectPath;

  // Kill active PTY session and wait for process exit before proceeding.
  // The PTY process holds CWD + conpty handles on the worktree directory;
  // awaiting exit ensures those handles are released before cleanup.
  if (task.session_id) {
    try {
      context.sessionManager.kill(task.session_id);
      await context.sessionManager.awaitExit(task.session_id);
      context.sessionManager.remove(task.session_id);
    } catch { /* may already be dead */ }
    // Guard against concurrent delete: the task row may already be gone by
    // the time awaitExit resolves. Update is idempotent - skip when absent.
    if (tasks.getById(task.id)) {
      tasks.update({ id: task.id, session_id: null });
    }
  }

  // Safety net: kill any PTY session for this task that was spawned by a
  // concurrent move but not yet written to the task's session_id field.
  context.sessionManager.removeByTaskId(task.id);

  // Remove session DB records + directories from disk
  if (resolvedProjectId) {
    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    // Best-effort disk cleanup (non-fatal -- DB records are the source of truth).
    // Uses async fs.promises.rm so the event loop stays responsive during bulk
    // operations. The previous sync rmSync in a tight loop caused a multi-second
    // event-loop stall when many tasks with multiple session records each
    // landed in the bulk-delete handler concurrently - every IPC call from the
    // renderer (including the click that triggered delete) queued up behind
    // the sync work. Promise.all lets the kernel parallelize while keeping
    // the main thread free to service other handlers.
    if (resolvedProjectPath) {
      const records = db.prepare(
        'SELECT id FROM sessions WHERE task_id = ?'
      ).all(task.id) as Array<{ id: string }>;
      await Promise.all(records.map(({ id }) => {
        const sessionDir = path.join(resolvedProjectPath, '.kangentic', 'sessions', id);
        return fs.promises.rm(sessionDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }).catch((error: NodeJS.ErrnoException) => {
          // force: true already silences ENOENT, so anything surfacing here is
          // a genuine problem (EACCES, EPERM, EBUSY post-retry). Best-effort:
          // log and continue so the task DELETE still proceeds.
          if (error.code !== 'ENOENT') {
            console.warn(`[CLEANUP] Failed to remove session dir ${sessionDir}: ${error.message}`);
          }
        });
      }));
    }

    // Always delete DB records -- this must succeed for task DELETE to pass FK check
    sessionRepo.deleteByTaskId(task.id);
  }
}

/**
 * Full cleanup: kill session, remove worktree + branch, wipe session records.
 *
 * Used by TASK_DELETE (permanent removal) and TASK_MOVE -> Backlog (full reset).
 */
export async function cleanupTaskResources(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  await cleanupTaskSession(context, task, tasks, projectId, projectPath);

  const resolvedProjectPath = projectPath ?? context.currentProjectPath;

  // Remove worktree + branch
  if (task.worktree_path && resolvedProjectPath) {
    let removed = false;
    try {
      const worktreeManager = new WorktreeManager(resolvedProjectPath);
      await worktreeManager.withLock(async () => {
        removed = await worktreeManager.removeWorktree(task.worktree_path!);
        if (removed && task.branch_name) {
          const config = context.configManager.getEffectiveConfig(resolvedProjectPath);
          if (config.git.autoCleanup) {
            // Prune stale worktree metadata so git allows branch deletion
            // even if removeWorktree couldn't fully remove the directory
            try { await worktreeManager.pruneWorktrees(); } catch { /* best effort */ }
            await worktreeManager.removeBranch(task.branch_name);
          }
        }
      });
    } catch (err) {
      console.error(`[WORKTREE] Failed to clean up worktree for task ${task.id.slice(0, 8)}:`, err);
    }
    // Only clear DB fields if the directory was actually removed.
    // Keeping them set allows resource-cleanup to retry on next startup.
    // Guard against concurrent delete: the task row may already be gone
    // by the time removeWorktree resolves. Update is idempotent.
    if (removed && tasks.getById(task.id)) {
      tasks.update({ id: task.id, worktree_path: null, branch_name: null });
    }
  }
}

/**
 * Delete only the local worktree directory, preserving branch_name and
 * all session records. `worktree_path` is nulled on success so the task
 * reads as "deleted-but-resumable". Moving out of Done re-creates the
 * worktree from the preserved branch via ensureTaskWorktree().
 *
 * Returns true when the directory was actually removed and the DB field
 * was cleared, false when there was nothing to delete or the removal
 * failed. Callers use the return value for log classification; callers
 * that want to retry on failure rely on the preserved `worktree_path`.
 *
 * LOCK CONTRACT: callers MUST hold a `withTaskLock(taskId, ...)` for the
 * duration of this call. Crosses an await boundary and mutates per-task
 * state (`worktree_path`, plus filesystem state under the project's
 * worktrees directory). Without the lock, a concurrent ensureTaskWorktree
 * or cleanupTaskResources for the same task can interleave with the
 * removal and corrupt git's worktree metadata.
 *
 * Used by TASK_MOVE -> Done.
 */
export async function deleteTaskWorktree(
  context: IpcContext,
  task: { id: string; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
  projectPath?: string | null,
): Promise<boolean> {
  const resolvedProjectPath = projectPath ?? context.currentProjectPath;
  if (!task.worktree_path || !resolvedProjectPath) return false;

  let removed = false;
  try {
    const worktreeManager = new WorktreeManager(resolvedProjectPath);
    await worktreeManager.withLock(async () => {
      removed = await worktreeManager.removeWorktree(task.worktree_path!);
    });
  } catch (err) {
    console.error(`[WORKTREE] Failed to delete worktree for task ${task.id.slice(0, 8)}:`, err);
  }

  if (removed) {
    tasks.update({ id: task.id, worktree_path: null });
  }
  return removed;
}
