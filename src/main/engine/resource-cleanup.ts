import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SessionManager } from '../pty/session-manager';
import { slugify } from '../../shared/slugify';
import { removeNodeModulesJunction } from '../git/worktree-manager';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Clean up all stale resources under `.kangentic/` on project open.
 *
 * Runs three passes in order:
 *  1. Prune tasks whose worktree directories were deleted externally
 *  2. Clean worktree dirs, branches, and sessions for backlog tasks
 *  3. Remove orphaned worktree, session, and task directories
 *
 * Async to avoid blocking the Electron main thread during startup.
 * This is the single source of truth for resource cleanup - session-recovery.ts
 * only handles session lifecycle (resume, reconcile).
 */
export async function cleanupStaleResources(
  projectPath: string,
  taskRepo: TaskRepository,
  swimlaneRepo: SwimlaneRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): Promise<void> {
  // 1. Prune tasks whose worktree dirs were deleted externally (sync, fast)
  pruneOrphanedWorktreeTasks(projectPath, taskRepo, sessionRepo, sessionManager);

  // 2. Clean backlog task resources (worktree dirs, branches, sessions)
  await cleanBacklogTaskResources(projectPath, taskRepo, swimlaneRepo, sessionRepo, sessionManager);

  // 3. Remove orphaned directories not referenced by any task
  await pruneOrphanedDirectories(projectPath, taskRepo, sessionRepo, sessionManager);
}

// ---------------------------------------------------------------------------
// Pass 1: Prune tasks with missing worktree directories
// ---------------------------------------------------------------------------

/**
 * Delete tasks whose worktree directories have been removed outside the app.
 *
 * Only prunes if the `.kangentic/worktrees/` parent directory exists (if
 * missing, the project may be on an unmounted drive - don't prune anything).
 *
 * Never prunes tasks without a worktree_path or tasks with an active PTY.
 */
function pruneOrphanedWorktreeTasks(
  projectPath: string,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): number {
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');
  if (!fs.existsSync(worktreesDir)) return 0;

  const activeTaskIds = new Set(
    sessionManager.listSessions()
      .filter(session => session.status === 'running' || session.status === 'queued')
      .map(session => session.taskId),
  );

  let pruned = 0;
  for (const task of taskRepo.list()) {
    if (!task.worktree_path) continue;
    if (fs.existsSync(task.worktree_path)) continue;
    if (activeTaskIds.has(task.id)) continue;

    console.log(`[RESOURCE_CLEANUP] Deleting orphaned task "${task.title}" (${task.id.slice(0, 8)}) - worktree missing`);
    sessionRepo.deleteByTaskId(task.id);
    taskRepo.delete(task.id);
    pruned++;
  }

  return pruned;
}

// ---------------------------------------------------------------------------
// Pass 2: Clean backlog task resources
// ---------------------------------------------------------------------------

/**
 * Remove stale worktree directories, branches, and session records for tasks
 * in the Backlog column. Backlog is the "reset everything" column - tasks
 * there should have zero resources.
 *
 * Checks BOTH DB fields and disk state: the core failure mode is that DB
 * fields were cleared (by the revert to backlog) but stale directories or
 * branches remain on disk, blocking future worktree creation.
 *
 * This is error recovery, not normal workflow - it does NOT respect the
 * `autoCleanup` config setting.
 */
async function cleanBacklogTaskResources(
  projectPath: string,
  taskRepo: TaskRepository,
  swimlaneRepo: SwimlaneRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): Promise<number> {
  const todoLane = swimlaneRepo.list().find(lane => lane.role === 'todo');
  if (!todoLane) return 0;

  const backlogTasks = taskRepo.list(todoLane.id);
  let cleaned = 0;

  // Collect branches to delete after a single `git worktree prune`
  const branchesToDelete: string[] = [];

  for (const task of backlogTasks) {
    const shortId = task.id.slice(0, 8);
    const expectedSlug = slugify(task.title) || 'task';
    const expectedFolder = `${expectedSlug}-${shortId}`;
    const expectedWorktreePath = path.join(projectPath, '.kangentic', 'worktrees', expectedFolder);
    const expectedBranch = expectedFolder;

    const hasStaleDbFields = task.worktree_path || task.branch_name || task.session_id;
    const hasStaleDirectory = fs.existsSync(task.worktree_path || expectedWorktreePath);
    const hasStaleBranch = task.branch_name || await branchExists(expectedBranch, projectPath);

    if (!hasStaleDbFields && !hasStaleDirectory && !hasStaleBranch) continue;

    console.log(`[RESOURCE_CLEANUP] Cleaning stale resources for task "${task.title}" (${shortId})`);

    // Kill PTY session if alive
    if (task.session_id) {
      try {
        sessionManager.remove(task.session_id);
        console.log(`[RESOURCE_CLEANUP] Removed PTY session ${task.session_id}`);
      } catch { /* may already be dead */ }
    }

    // Delete session DB records
    sessionRepo.deleteByTaskId(task.id);

    // Remove worktree directories
    const pathsToRemove = new Set<string>();
    if (task.worktree_path) pathsToRemove.add(task.worktree_path);
    pathsToRemove.add(expectedWorktreePath);

    for (const worktreePath of pathsToRemove) {
      if (!fs.existsSync(worktreePath)) continue;
      removeNodeModulesJunction(path.join(worktreePath, 'node_modules'));
      await removeWorktreeDirectory(worktreePath, projectPath);
    }

    // Collect branches to delete
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
      await execFileAsync('git', ['worktree', 'prune'], { cwd: projectPath });
    } catch { /* best effort */ }

    for (const branchName of branchesToDelete) {
      try {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: projectPath });
        console.log(`[RESOURCE_CLEANUP] Deleted branch: ${branchName}`);
      } catch { /* branch may not exist */ }
    }
  }

  if (cleaned > 0) {
    console.log(`[RESOURCE_CLEANUP] Cleaned ${cleaned} backlog task(s) with stale resources`);
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Pass 3: Remove orphaned directories
// ---------------------------------------------------------------------------

/**
 * Remove directories under `.kangentic/` not referenced by any task:
 *  - `worktrees/<slug>/`  - matched against task.worktree_path
 *  - `sessions/<uuid>/`   - matched against task.session_id + active PTY sessions
 *  - `tasks/<uuid>/`      - matched against task.id
 */
/** @internal Exported for testing. */
export async function pruneOrphanedDirectories(
  projectPath: string,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): Promise<void> {
  const kangenticDir = path.join(projectPath, '.kangentic');
  const allTasks = [...taskRepo.list(), ...taskRepo.listArchived()];

  // Worktree directories: match by full path
  const referencedWorktrees = new Set(
    allTasks.map(task => task.worktree_path).filter((worktreePath): worktreePath is string => Boolean(worktreePath)),
  );
  await pruneDirectory(
    path.join(kangenticDir, 'worktrees'),
    (dirPath) => referencedWorktrees.has(dirPath),
    'worktree',
    true, // has junctions
  );

  // Session directories: match by directory name (UUID)
  const referencedSessionIds = new Set([
    ...allTasks.map(task => task.id),
    ...allTasks.map(task => task.session_id).filter((sessionId): sessionId is string => Boolean(sessionId)),
    ...sessionManager.listSessions().map(session => session.id),
    ...sessionRepo.listAllClaudeSessionIds(),
  ]);
  await pruneDirectory(
    path.join(kangenticDir, 'sessions'),
    (_dirPath, name) => referencedSessionIds.has(name),
    'session',
  );

  // Task directories: match by directory name (UUID)
  const referencedTaskIds = new Set(allTasks.map(task => task.id));
  await pruneDirectory(
    path.join(kangenticDir, 'tasks'),
    (_dirPath, name) => referencedTaskIds.has(name),
    'task',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove unreferenced subdirectories with retry on EPERM. */
async function pruneDirectory(
  parentDir: string,
  isReferenced: (dirPath: string, name: string) => boolean,
  label: string,
  hasJunctions = false,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(parentDir, entry.name);
    if (isReferenced(dirPath, entry.name)) continue;

    console.log(`[RESOURCE_CLEANUP] Removing orphaned ${label} directory: ${entry.name}`);

    if (hasJunctions) {
      removeNodeModulesJunction(path.join(dirPath, 'node_modules'));
    }

    let removed = false;
    const delays = [0, 300, 1000];
    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        removed = true;
        break;
      } catch {
        // EPERM - retry after next delay
      }
    }
    if (!removed) {
      console.warn(`[RESOURCE_CLEANUP] Could not remove orphaned ${label} directory: ${entry.name}`);
    }
  }
}

/** Check if a git branch exists locally. */
async function branchExists(branchName: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', branchName], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a worktree directory. Tries `git worktree remove --force` first,
 * then falls back to `fs.promises.rm`.
 *
 * Callers must remove node_modules junctions before calling this.
 */
async function removeWorktreeDirectory(worktreePath: string, projectPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectPath });
    console.log(`[RESOURCE_CLEANUP] Removed worktree directory: ${worktreePath}`);
    return true;
  } catch {
    console.log(`[RESOURCE_CLEANUP] git worktree remove failed, falling back to manual removal`);
  }

  try {
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    console.log(`[RESOURCE_CLEANUP] Removed worktree directory: ${worktreePath}`);
    return true;
  } catch (error) {
    console.warn(`[RESOURCE_CLEANUP] Could not remove worktree directory: ${(error as Error).message}`);
  }
  return false;
}
