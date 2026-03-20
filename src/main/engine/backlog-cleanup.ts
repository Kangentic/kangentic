import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SessionManager } from '../pty/session-manager';
import { slugify } from '../../shared/slugify';

/**
 * Remove stale worktree directories, branches, and session records for tasks
 * that are in the Backlog column. Backlog is the "reset everything" column -
 * tasks there should have zero resources.
 *
 * Runs synchronously on project open, before session recovery. Uses
 * `execFileSync` (not async simple-git) because this must complete before
 * any concurrent git operations begin.
 *
 * Checks BOTH DB fields and disk state: the core failure mode is that DB
 * fields were cleared (by the revert to backlog) but stale directories or
 * branches remain on disk, blocking future worktree creation.
 *
 * This is error recovery, not normal workflow - it does NOT respect the
 * `autoCleanup` config setting.
 */
export function cleanBacklogTaskResources(
  projectPath: string,
  taskRepo: TaskRepository,
  swimlaneRepo: SwimlaneRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): number {
  const backlogLane = swimlaneRepo.list().find(lane => lane.role === 'backlog');
  if (!backlogLane) return 0;

  const backlogTasks = taskRepo.list(backlogLane.id);
  let cleaned = 0;

  // Collect branches to delete after a single `git worktree prune`
  const branchesToDelete: string[] = [];

  for (const task of backlogTasks) {
    // Derive the expected worktree path and branch from the task title/id
    // (same slug logic as WorktreeManager.createWorktree). This catches
    // stale resources even when DB fields were already cleared to null.
    const shortId = task.id.slice(0, 8);
    const expectedSlug = slugify(task.title) || 'task';
    const expectedFolder = `${expectedSlug}-${shortId}`;
    const expectedWorktreePath = path.join(projectPath, '.kangentic', 'worktrees', expectedFolder);
    const expectedBranch = expectedFolder;

    // Check DB fields AND disk state for stale resources
    const hasStaleDbFields = task.worktree_path || task.branch_name || task.session_id;
    const hasStaleDirectory = fs.existsSync(task.worktree_path || expectedWorktreePath);
    const hasStaleBranch = task.branch_name || branchExistsSync(expectedBranch, projectPath);

    if (!hasStaleDbFields && !hasStaleDirectory && !hasStaleBranch) continue;

    console.log(`[BACKLOG_CLEANUP] Cleaning stale resources for task "${task.title}" (${shortId})`);

    // Kill PTY session if alive
    if (task.session_id) {
      try {
        sessionManager.remove(task.session_id);
        console.log(`[BACKLOG_CLEANUP] Removed PTY session ${task.session_id}`);
      } catch { /* may already be dead */ }
    }

    // Delete session DB records
    sessionRepo.deleteByTaskId(task.id);

    // Remove worktree directory with EPERM retries.
    // Check both the DB-recorded path and the expected path (they may differ
    // if the task was renamed, but usually they're the same).
    const pathsToRemove = new Set<string>();
    if (task.worktree_path) pathsToRemove.add(task.worktree_path);
    pathsToRemove.add(expectedWorktreePath);

    for (const worktreePath of pathsToRemove) {
      if (!fs.existsSync(worktreePath)) continue;
      removeDirectorySync(worktreePath);
    }

    // Collect branches to delete (both DB-recorded and expected)
    if (task.branch_name) branchesToDelete.push(task.branch_name);
    if (expectedBranch !== task.branch_name) branchesToDelete.push(expectedBranch);

    // Clear DB fields
    if (hasStaleDbFields) {
      taskRepo.update({ id: task.id, worktree_path: null, branch_name: null, session_id: null });
    }
    cleaned++;
  }

  // Single `git worktree prune` after all directories are removed,
  // then delete all stale branches in one pass
  if (branchesToDelete.length > 0) {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: projectPath, stdio: 'ignore' });
    } catch { /* best effort */ }

    for (const branchName of branchesToDelete) {
      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: projectPath, stdio: 'ignore' });
        console.log(`[BACKLOG_CLEANUP] Deleted branch: ${branchName}`);
      } catch { /* branch may not exist */ }
    }
  }

  if (cleaned > 0) {
    console.log(`[BACKLOG_CLEANUP] Cleaned ${cleaned} task(s) with stale resources`);
  }

  return cleaned;
}

/** Check if a git branch exists locally (synchronous). */
function branchExistsSync(branchName: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', branchName], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Remove a directory synchronously with EPERM retries for Windows file handle timing. */
function removeDirectorySync(dirPath: string): boolean {
  const delays = [0, 300, 1000];
  for (const delay of delays) {
    if (delay > 0) {
      // Synchronous sleep using Atomics (avoids busy-wait CPU spin)
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      } catch {
        // SharedArrayBuffer may not be available; fall back to busy-wait
        const start = Date.now();
        while (Date.now() - start < delay) { /* sync wait fallback */ }
      }
    }
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`[BACKLOG_CLEANUP] Removed worktree directory: ${dirPath}`);
      return true;
    } catch {
      // EPERM - retry after next delay
    }
  }
  console.warn(`[BACKLOG_CLEANUP] Could not remove worktree directory after retries: ${dirPath}`);
  return false;
}
