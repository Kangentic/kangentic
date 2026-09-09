import path from 'node:path';
import { IPC } from '../../../shared/ipc-channels';
import fs from '../../git/original-fs';
import { withTaskLock } from '../task-lifecycle-lock';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo } from '../../git/git-checks';
import { runGitWithTimeout } from '../../git/git-spawn';
import { getProjectDb } from '../../db/database';
import { isLiveSession } from '../../pty/session-registry';
import { moveDirectory, removeDirectoryTree } from '../../fs/directory-move';
import { applySuspendDbWrites } from './session-reconcile';
import { abortInFlightResume } from './session-resume-controllers';
import { trackEvent } from '../../analytics/analytics';
import { agentRegistry } from '../../agent/agent-registry';
import { replacePathPrefix } from '../../../shared/paths';
import type { ProjectRelocateOptions, ProjectRelocateResult, ProjectRelocateWarning } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Platform-correct path equality via `path.relative` (case-insensitive on
 * Windows, where strict string comparison of resolved paths is not).
 */
function isSamePath(first: string, second: string): boolean {
  return path.relative(first, second) === '';
}

/**
 * Re-point an existing project at a new folder on disk, in one of two modes
 * (`options.mode`, default `repoint`):
 *
 * - `repoint`: the folder was already moved or renamed outside Kangentic
 *   (e.g. the user did it in their file explorer, or via the Locate Folder
 *   missing-path dialog). The new location must already exist.
 * - `move`: Kangentic moves the folder to `newPath` ITSELF (the one-step
 *   "Move..." flow), then relocates. The destination must NOT already exist.
 *
 * Tasks, board, and history live in the per-project DB keyed by project id,
 * so only stored absolute paths need rewriting:
 *
 * 1. Validate (mode-aware): the source/destination state and that no other
 *    project already points at the destination.
 * 2. Suspend the project's live sessions so they resume at the new cwd. This
 *    is the quiesce: suspend() fully terminates each PTY (so no process holds
 *    a cwd inside the folder) while keeping the session resumable.
 * 3. Release the main-process file handles INSIDE the old folder (the board
 *    config watcher and the worktree diff watchers). Windows cannot rename a
 *    directory while any process holds a handle inside it, so this must
 *    happen before the move. (An EXTERNAL process holding a cwd inside the
 *    folder is not ours to kill; in `move` mode that makes the rename fail
 *    cleanly after retries with nothing changed.)
 * 4. `move` mode only: move the folder on disk (atomic rename same-volume;
 *    recursive copy on a different volume, reporting progress). On failure
 *    nothing is changed (a partial cross-volume copy is rolled back).
 * 5. Update `projects.path` plus stored `tasks.worktree_path` and
 *    `sessions.cwd` prefixes.
 * 6. Best-effort `git worktree repair` (a moved repo's worktree metadata
 *    holds stale absolute paths).
 * 7. Notify each agent adapter so it can migrate per-project data it keeps
 *    OUTSIDE the project folder keyed by absolute path (e.g. Claude's
 *    ~/.claude/projects transcripts and ~/.claude.json keys).
 * 8. `move` mode + cross-volume copy only: delete the source folder now that
 *    relocation has succeeded against the new path. A failed delete is
 *    non-fatal and surfaces as a `source-delete-failed` warning.
 * 9. Reset per-path runtime state so the next open re-derives everything.
 *
 * The renderer re-opens the project afterwards (when it was the current one),
 * which re-attaches the board config watcher, rewrites the MCP config, and
 * re-runs session recovery via the normal PROJECT_OPEN flow.
 */
export async function relocateProject(
  context: IpcContext,
  projectId: string,
  newPath: string,
  options: ProjectRelocateOptions = {},
): Promise<ProjectRelocateResult> {
  const mode = options.mode ?? 'repoint';
  const warnings: ProjectRelocateWarning[] = [];
  const project = context.projectRepo.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const resolved = path.resolve(newPath);
  // Capture before updatePath: worktree queues are keyed by the stored
  // path string, and `project` may alias a row object a repo mock mutates.
  const storedOldPath = project.path;
  const oldPath = path.resolve(storedOldPath);
  if (isSamePath(oldPath, resolved)) return { project, warnings };

  // Mode-aware validation of the source and destination.
  if (mode === 'move') {
    if (!fs.existsSync(oldPath) || !fs.statSync(oldPath).isDirectory()) {
      throw new Error(`Project folder no longer exists: ${oldPath}. Use Locate Folder to re-point it.`);
    }
    if (fs.existsSync(resolved)) {
      throw new Error(`Destination already exists: ${resolved}`);
    }
    // The destination cannot be the source itself or nested inside it (would
    // recurse the folder into its own subtree). Checked before the parent
    // existence guard because a nested destination's parent may not exist
    // either, and "inside the project folder" is the more precise error.
    // replacePathPrefix is non-null exactly when resolved is oldPath or under it.
    if (replacePathPrefix(resolved, oldPath, oldPath) !== null) {
      throw new Error(`Destination is inside the project folder: ${resolved}`);
    }
    const destinationParent = path.dirname(resolved);
    if (!fs.existsSync(destinationParent) || !fs.statSync(destinationParent).isDirectory()) {
      throw new Error(`Destination folder does not exist: ${destinationParent}`);
    }
  } else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`New project location is not a directory: ${resolved}`);
  }

  const duplicate = context.projectRepo.list()
    .find((candidate) => candidate.id !== projectId && isSamePath(path.resolve(candidate.path), resolved));
  if (duplicate) {
    throw new Error(`Another project ("${duplicate.name}") already points at ${resolved}`);
  }

  // Suspend live sessions so they resume at the new cwd after reopen.
  // Mirrors SESSION_SUSPEND: abort any in-flight resume BEFORE acquiring the
  // task lock (aborting inside would deadlock on a holder stuck in unlocked
  // git I/O), then do the DB writes + PTY shutdown under the lock.
  const liveSessions = context.sessionManager.listSessions()
    .filter((session) => session.projectId === projectId && isLiveSession(session));
  for (const session of liveSessions) {
    if (session.transient || !session.taskId) {
      // Transient command terminals have no task or DB record; kill outright.
      try {
        await context.sessionManager.kill(session.id);
      } catch (err) {
        console.warn(`[PROJECT_RELOCATE] Failed to kill transient session ${session.id.slice(0, 8)}:`, err);
      }
      continue;
    }
    abortInFlightResume(session.taskId);
    await withTaskLock(session.taskId, async () => {
      applySuspendDbWrites(context, projectId, session.taskId, 'system');
      await context.sessionManager.suspend(session.id);
    });
  }

  // Release the main-process file handles INSIDE the old folder before any
  // move. The board config watcher is bound to <oldPath>/kangentic*.json;
  // PROJECT_OPEN re-attaches it after the renderer reopens. The diff watchers
  // hold recursive fs.watch handles on the worktree dirs under the folder.
  if (context.currentProjectId === projectId) {
    context.boardConfigManager.detach();
  }
  context.diffWatcher.releaseUnder(oldPath);

  // `move` mode: move the folder on disk now that nothing of ours holds a
  // handle inside it. Errors propagate; the engine leaves the source intact
  // (a partial cross-volume copy is rolled back), so the project is untouched.
  let movedAcrossVolumes = false;
  if (mode === 'move') {
    const sendProgress = (phase: 'moving' | 'copying', copiedEntries: number, totalEntries: number): void => {
      if (context.mainWindow.isDestroyed()) return;
      context.mainWindow.webContents.send(IPC.PROJECT_MOVE_PROGRESS, { projectId, phase, copiedEntries, totalEntries });
    };
    sendProgress('moving', 0, 0);
    const moveResult = await moveDirectory(oldPath, resolved, {
      onCopyProgress: ({ copiedEntries, totalEntries }) => sendProgress('copying', copiedEntries, totalEntries),
    });
    movedAcrossVolumes = moveResult.strategy === 'copy';
  }

  const updated = context.projectRepo.updatePath(projectId, resolved);

  // Rewrite stored absolute paths in the per-project DB. Worktrees and
  // session cwds live under <project>/.kangentic/, so they moved with the
  // folder; paths outside the old prefix are left untouched.
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);
  const rewrittenWorktreePaths: string[] = [];
  for (const task of [...taskRepo.list(), ...taskRepo.listArchived()]) {
    if (!task.worktree_path) continue;
    const rewritten = replacePathPrefix(task.worktree_path, oldPath, resolved);
    if (!rewritten) continue;
    taskRepo.update({ id: task.id, worktree_path: rewritten });
    rewrittenWorktreePaths.push(rewritten);
  }
  for (const record of sessionRepo.listAll()) {
    if (!record.cwd) continue;
    const rewritten = replacePathPrefix(record.cwd, oldPath, resolved);
    if (rewritten) sessionRepo.updateCwd(record.id, rewritten);
  }

  // A moved repo's worktree metadata (.git files and .git/worktrees/*/gitdir)
  // still holds the old absolute paths. `git worktree repair <paths>` fixes
  // both sides when repo and worktrees moved together. Best-effort: a non-git
  // folder is a valid project, and a repair failure only degrades worktrees.
  if (isGitRepo(resolved)) {
    const existingWorktreePaths = rewrittenWorktreePaths.filter((worktreePath) => fs.existsSync(worktreePath));
    try {
      await runGitWithTimeout(resolved, ['worktree', 'repair', ...existingWorktreePaths], { timeoutMs: 30_000 });
    } catch (err) {
      console.warn('[PROJECT_RELOCATE] git worktree repair failed (non-fatal):', err);
    }
  }

  // Give each agent adapter a chance to migrate per-project data it keeps
  // outside the project folder (e.g. Claude's ~/.claude/projects transcripts
  // and ~/.claude.json keys). Best-effort: a failure must not fail relocation.
  // The project folder is already at `resolved`, so an adapter can list its
  // worktrees to reconstruct old paths.
  for (const adapterName of agentRegistry.list()) {
    const adapter = agentRegistry.get(adapterName);
    if (!adapter?.onProjectRelocated) continue;
    try {
      await adapter.onProjectRelocated(oldPath, resolved);
    } catch (err) {
      console.warn(`[PROJECT_RELOCATE] ${adapterName} onProjectRelocated failed (non-fatal):`, err);
    }
  }

  // Cross-volume move only: the folder was COPIED to the new location, so the
  // original still exists. Delete it now that the relocation has fully
  // succeeded against the new path. Best-effort: a failed delete leaves the
  // old copy on disk but the project is correctly pointed at the new one, so
  // it degrades to a warning rather than failing the move.
  if (movedAcrossVolumes) {
    try {
      await removeDirectoryTree(oldPath);
    } catch (err) {
      warnings.push('source-delete-failed');
      console.warn(`[PROJECT_RELOCATE] Failed to remove old folder after cross-volume move (non-fatal): ${oldPath}`, err);
    }
  }

  // Reset per-path runtime state. Dropping the project from recoveredProjects
  // makes the next open run full recovery, which resumes the sessions
  // suspended above at their rewritten cwds. The board config watcher was
  // already detached above (before the move) so its handle did not block a
  // rename; nothing re-attaches it until PROJECT_OPEN.
  WorktreeManager.clearQueue(storedOldPath);
  context.recoveredProjects.delete(projectId);
  if (context.currentProjectId === projectId) {
    context.currentProjectPath = resolved;
  }

  trackEvent('project_relocate', { mode });
  console.log(`[PROJECT_RELOCATE] ${project.name} (${mode}): ${storedOldPath} -> ${resolved}`);
  return { project: updated, warnings };
}
