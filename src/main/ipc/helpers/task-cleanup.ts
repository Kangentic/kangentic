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
    tasks.update({ id: task.id, session_id: null });
  }

  // Safety net: kill any PTY session for this task that was spawned by a
  // concurrent move but not yet written to the task's session_id field.
  context.sessionManager.removeByTaskId(task.id);

  // Remove session DB records + directories from disk
  if (resolvedProjectId) {
    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    // Best-effort disk cleanup (non-fatal -- DB records are the source of truth)
    if (resolvedProjectPath) {
      const records = db.prepare(
        'SELECT claude_session_id FROM sessions WHERE task_id = ? AND claude_session_id IS NOT NULL'
      ).all(task.id) as Array<{ claude_session_id: string }>;
      for (const { claude_session_id } of records) {
        const sessionDir = path.join(resolvedProjectPath, '.kangentic', 'sessions', claude_session_id);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* may not exist */ }
      }
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
    if (removed) {
      tasks.update({ id: task.id, worktree_path: null, branch_name: null });
    }
  }
}
