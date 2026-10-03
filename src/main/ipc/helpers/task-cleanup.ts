import fs from 'node:fs';
import path from 'node:path';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager, prepareWorktreeForRemoval, GitQueuePriority } from '../../git/worktree-manager';
import { readWorktreeHead } from '../../git/worktree-head';
import { getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import type { IpcContext } from '../ipc-context';
import { leftoverProcessReports, publishLeftoverProcesses } from './leftover-process-reports';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';
import type { LeftoverSweepOptions } from '../../transition-engine/resource-cleanup';

/**
 * Kill what the given tasks left running: the processes carrying their
 * `KANGENTIC_TASK_ID` tag, which each task session's PTY is spawned with and
 * every descendant inherits, however it detached (`nohup`, `Start-Process`,
 * `setsid`, a launcher that already exited), and that are the task's (see
 * `src/main/pty/process-tag/reap-plan.ts` for what is spared). Works across
 * sessions and across an app restart, because the tag lives in the processes
 * themselves.
 *
 * Call it on a TERMINAL transition only (Done, To Do, Backlog, delete), AFTER
 * every session of the task has exited: the reap force-kills, and a young
 * agent must get its exit grace (`.claude/rules/pty-teardown-grace.md`). The
 * pty host protects any PTY it still holds as a second line. Call it BEFORE a
 * worktree removal: a live process holding the directory as its cwd is what
 * makes the removal fail on Windows.
 *
 * Only processes working inside the task's project or worktree are reaped, so
 * pass the project path and each task's worktree: a shared daemon the agent
 * happened to start first (it moves to `/` or home) and anything it started
 * elsewhere are left alone. A process with no project path to check against
 * is never killed.
 *
 * With the user's "Stop leftover processes" setting off it kills nothing.
 * Either way the user is told what was stopped and what kept running: the
 * result goes to the leftover-process toast (`leftover-process-reports.ts`),
 * under each task's title, so pass `title` where the caller has it.
 *
 * Best-effort by contract: a teardown never fails because a reap did.
 */
export async function reapTaskLeftovers(
  context: IpcContext,
  projectPath: string | null | undefined,
  tasks: ReadonlyArray<{ id: string; worktree_path: string | null; title?: string }>,
): Promise<void> {
  if (tasks.length === 0) return;
  // Held for the whole reap, so a bulk delete's reaps, which the host runs in
  // two batches a second apart, still make one toast.
  const releaseReport = leftoverProcessReports.beginReap();
  try {
    const stoppingEnabled = context.configManager.load().stopLeftoverProcesses !== false;
    const entries = await context.sessionManager.reapTaskProcesses(
      projectPath ?? null,
      tasks.map((task) => ({ id: task.id, worktreePath: task.worktree_path })),
      { stop: stoppingEnabled },
    );
    const taskTitles = new Map<string, string>();
    for (const task of tasks) if (task.title) taskTitles.set(task.id, task.title);
    publishLeftoverProcesses(context.mainWindow, entries, taskTitles, stoppingEnabled, projectPath ?? null);
  } catch (error) {
    console.warn(`[TASK-REAP] Leftover reap failed for ${tasks.length} task(s) (non-fatal):`, error);
  } finally {
    releaseReport();
  }
}

/**
 * The startup sweep's view of the setting and the toast
 * (`sweepTerminalTaskLeftovers`): the same as a transition's reap.
 */
export function leftoverSweepOptions(context: IpcContext, projectPath: string): LeftoverSweepOptions {
  return {
    stoppingEnabled: () => context.configManager.load().stopLeftoverProcesses !== false,
    onReport: (entries, taskTitles, stoppingEnabled) => {
      publishLeftoverProcesses(context.mainWindow, entries, taskTitles, stoppingEnabled, projectPath);
    },
  };
}

/**
 * After the user stopped a leftover process from the list, retry removing its
 * task's worktree when the task is in Done and the worktree is still on disk.
 * On Windows a process working in a directory blocks its removal, so a window
 * or a server the Done move left running is what kept it; without this, the
 * worktree waits for the next project open (`retryFailedDoneCleanups`).
 *
 * Best-effort and quiet: if something else still holds the directory, the
 * removal fails as it did at Done, and the same startup retry takes it.
 */
export async function retryDoneWorktreeRemoval(
  context: IpcContext,
  projectPath: string | null,
  taskId: string,
): Promise<boolean> {
  if (!projectPath) return false;
  try {
    const project = context.projectRepo.list().find((candidate) => candidate.path === projectPath);
    if (!project) return false;
    const { tasks, swimlanes } = getProjectRepos(context, project.id);
    const doneLane = swimlanes.list().find((lane) => lane.role === 'done');
    if (!doneLane) return false;
    return await withTaskLock(taskId, async () => {
      const task = tasks.getById(taskId);
      if (!task?.worktree_path || task.swimlane_id !== doneLane.id) return false;
      return deleteTaskWorktree(context, task, tasks, projectPath);
    });
  } catch (error) {
    console.warn(`[TASK-REAP] Worktree removal retry after a stop failed for ${taskId.slice(0, 8)} (non-fatal):`, error);
    return false;
  }
}

/**
 * Let every adapter drop the per-directory state it recorded for a worktree
 * Kangentic has just deleted (Codex's directory trust in
 * `~/.codex/config.toml` is the motivating case). Generic over the registry,
 * so no agent is named here - see .claude/rules/agent-adapters-boundary.md,
 * and `onProjectRelocated` in project-relocate.ts for the same shape.
 *
 * Best-effort: the worktree is already gone, and a failure only leaves a
 * stale entry behind. It must never fail the cleanup.
 */
export async function notifyAdaptersWorktreeRemoved(worktreePath: string): Promise<void> {
  for (const adapterName of agentRegistry.list()) {
    const adapter = agentRegistry.get(adapterName);
    if (!adapter?.onWorktreeRemoved) continue;
    try {
      await adapter.onWorktreeRemoved(worktreePath);
    } catch (error) {
      console.warn(`[WORKTREE] ${adapterName} onWorktreeRemoved failed (non-fatal):`, error);
    }
  }
}

/**
 * Kill the PTY session and wipe session records for a task.
 * Preserves the worktree and branch so code is not lost.
 *
 * Used by `cleanupTaskResources` (below) and by an unarchive into To Do
 * (`resetSessionForTodoRestore` in task-archive.ts), which resets the session
 * but keeps a worktree the Done move could not remove.
 */
export async function cleanupTaskSession(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null; title?: string },
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
      // kill() always tags the exit intentional, so this deliberate hard
      // reset (move to To Do, backlog demote, task delete) never surfaces a
      // false "Session crashed" toast from the non-zero force-kill exit.
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
  // Awaited: a spawn of the task still in flight is cancelled, and the PTY its
  // host may already have started holds the worktree until it exits, which
  // must come before the session directories and the worktree go.
  await context.sessionManager.removeByTaskId(task.id);

  // A dev server the agent backgrounded outlives the PTY and holds the worktree
  // directory as its cwd, which is what makes the removal in
  // cleanupTaskResources fail. After removeByTaskId, so every session of the
  // task has exited and none is force-killed outside its exit grace.
  await reapTaskLeftovers(context, resolvedProjectPath, [{ ...task, title: task.title ?? tasks.getById(task.id)?.title }]);

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

      // Never delete the on-disk directory of a session that is still live.
      // The kills above (task.session_id + removeByTaskId) clear the
      // intended-for-deletion sessions from the manager, so anything still
      // running/queued here is a session a concurrent spawn brought to life
      // for this task. Wiping its events.jsonl directory mid-write severs the
      // activity feed and makes the card falsely read idle. A spared dir whose
      // DB record we then delete is still protected from the orphan prune by
      // pruneOrphanedDirectories' listSessions() guard until the session
      // actually exits, at which point it gets pruned normally.
      const liveSessionIds = new Set(
        context.sessionManager.listSessions()
          .filter((session) => session.status === 'running' || session.status === 'queued')
          .map((session) => session.id),
      );

      await Promise.all(records.map(({ id }) => {
        if (liveSessionIds.has(id)) return Promise.resolve();
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
 * Used by a move into a todo-role column (full reset), BACKLOG_DEMOTE (the task
 * becomes a backlog item), TASK_DELETE and TASK_BULK_DELETE (permanent removal).
 */
export async function cleanupTaskResources(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null; title?: string },
  tasks: TaskRepository,
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  await cleanupTaskSession(context, task, tasks, projectId, projectPath);

  // A full reset ends the spawn decision `worktree_skip_reason` describes; the
  // next spawn re-decides. Unconditional (not inside the worktree block below)
  // because the task carrying a reason is exactly the one WITHOUT a worktree.
  // Guarded: a concurrent delete may already have removed the row.
  if (tasks.getById(task.id)) {
    tasks.setWorktreeSkipReason(task.id, null);
  }

  const resolvedProjectPath = projectPath ?? context.currentProjectPath;

  // Remove worktree + branch
  if (task.worktree_path && resolvedProjectPath) {
    let removed = false;
    // Capture the tip before the checkout goes, as `deleteTaskWorktree` does:
    // the commit is the one anchor that survives a reset, and a task whose PR
    // was not linked yet when the reset ran (resolver down) can otherwise never
    // link it again.
    const { sha: capturedSha } = await readWorktreeHead(task.worktree_path);
    try {
      const worktreeManager = new WorktreeManager(resolvedProjectPath);
      // Reap orphans + clear node_modules BEFORE taking the git lock so the slow
      // fs work does not hold the per-project queue. Safe outside the lock: the
      // caller holds withTaskLock(taskId), which serializes same-path work.
      await prepareWorktreeForRemoval(task.worktree_path, 'moderate');
      await worktreeManager.withLock(async () => {
        removed = await worktreeManager.removeWorktree(task.worktree_path!, { removalProfile: 'moderate' });
        if (removed && task.branch_name) {
          const config = context.configManager.getEffectiveConfig(resolvedProjectPath);
          if (config.git.autoCleanup) {
            // Prune stale worktree metadata so git allows branch deletion
            // even if removeWorktree couldn't fully remove the directory
            try { await worktreeManager.pruneWorktrees(); } catch { /* best effort */ }
            await worktreeManager.removeBranch(task.branch_name);
          }
        }
        // BACKGROUND: cleanup is best-effort with a startup retry net
        // (retryFailedDoneCleanups); a batch of removals must not park a
        // fresh agent spawn waiting at USER priority on this project.
      }, { label: `cleanup-worktree:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND });
    } catch (err) {
      console.error(`[WORKTREE] Failed to clean up worktree for task ${task.id.slice(0, 8)}:`, err);
    }
    // Only clear DB fields if the directory was actually removed.
    // Keeping them set allows resource-cleanup to retry on next startup.
    // Guard against concurrent delete: the task row may already be gone
    // by the time removeWorktree resolves. Update is idempotent.
    // `pushed_branch` is deliberately kept: it is a remote fact and a PR
    // anchor that outlives the local checkout, like `pr_number`.
    if (removed && tasks.getById(task.id)) {
      tasks.update({
        id: task.id,
        worktree_path: null,
        branch_name: null,
        resolved_base_branch: null,
        ...(capturedSha ? { head_sha: capturedSha } : {}),
      });
    }
  }
}

/**
 * Delete only the local worktree directory, preserving branch_name and
 * all session records. `worktree_path` is nulled on success so the task
 * reads as "deleted-but-resumable". Moving out of Done re-creates the
 * worktree from the preserved branch via ensureTaskWorktree().
 *
 * Before removal it reads the worktree's live HEAD and, if the agent renamed
 * the branch inside the worktree, writes the real branch name back to
 * `tasks.branch_name`. Agents rename branches to team conventions, so the
 * stored slug can be stale; without this the Done dialog would name the wrong
 * branch and, worse, restore (`createWorktree`) would re-attach to a branch
 * that no longer exists and silently fork a fresh one from base, losing the
 * committed work. The write-back happens BEFORE the removal attempt so a
 * failed removal still leaves the corrected name persisted for the startup
 * retry pass.
 *
 * Returns true when the directory was actually removed and the DB field
 * was cleared, false when there was nothing to delete or the removal
 * failed. Callers use the return value for log classification; callers
 * that want to retry on failure rely on the preserved `worktree_path`.
 *
 * LOCK CONTRACT: callers MUST hold a `withTaskLock(taskId, ...)` for the
 * duration of this call. Crosses an await boundary and mutates per-task
 * state (`worktree_path`, `branch_name`, plus filesystem state under the
 * project's worktrees directory). Without the lock, a concurrent
 * ensureTaskWorktree or cleanupTaskResources for the same task can interleave
 * with the removal and corrupt git's worktree metadata.
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

  // Capture the worktree HEAD before removal: the immutable commit anchor
  // survives the Done transition (PR resolution can match by commit after a
  // rename), and the live branch name corrects a stale stored slug so both the
  // Done dialog and the eventual restore name the branch the work lives on.
  const { branch: capturedBranch, sha: capturedSha } = await readWorktreeHead(task.worktree_path);
  if (capturedBranch && capturedBranch !== task.branch_name && tasks.getById(task.id)) {
    tasks.update({ id: task.id, branch_name: capturedBranch });
  }

  let removed = false;
  try {
    const worktreeManager = new WorktreeManager(resolvedProjectPath);
    // Reap orphans + clear node_modules BEFORE taking the git lock so the slow
    // fs work (and a pinned-handle stall) does not head-of-line-block every
    // other spawn on this project. Safe outside the lock per the LOCK CONTRACT
    // above: the caller holds withTaskLock(taskId), which serializes same-path
    // work; no other task ever shares this worktree path.
    await prepareWorktreeForRemoval(task.worktree_path, 'moderate');
    await worktreeManager.withLock(async () => {
      removed = await worktreeManager.removeWorktree(task.worktree_path!, { removalProfile: 'moderate' });
      // BACKGROUND: nothing user-visible gates on the removal finishing (the
      // board mutation + archive already happened); a batch Done-move must not
      // park a fresh agent spawn behind its removals.
    }, { label: `remove-worktree:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND });
  } catch (err) {
    console.error(`[WORKTREE] Failed to delete worktree for task ${task.id.slice(0, 8)}:`, err);
  }

  if (removed) {
    tasks.update({ id: task.id, worktree_path: null, ...(capturedSha ? { head_sha: capturedSha } : {}) });
  }
  return removed;
}
