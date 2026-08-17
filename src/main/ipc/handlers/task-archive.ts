import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  ensureTaskWorktree,
  ensureTaskBranchCheckout,
  notifyBranchCheckoutBlocked,
  createTransitionEngine,
  spawnAgent,
  cleanupTaskSession,
} from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from '../helpers/task-profile';
import { withTaskLock } from '../task-lifecycle-lock';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import type { TaskRepository } from '../../db/repositories/task-repository';
import type { SwimlaneRole, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Restoring an archived task into a To Do lane is a full reset, exactly as
 * TASK_MOVE treats every other route into To Do (`task-move.ts` priority 1).
 *
 * Without this the task keeps the session the move into Done deliberately
 * SUSPENDED rather than destroyed. That suspended entry stays in the PTY
 * registry (`SessionManager.suspend` mutates `status` and never deletes), and
 * `listSessions()` has no status filter, so `SESSION_LIST` keeps handing it to
 * the renderer - `syncSessions()` reinstates the orphan instead of healing it.
 * `TaskCard` resolves its session through `_sessionByTaskId`, not
 * `task.session_id`, so nulling the task pointer does not hide it either: the
 * restored card renders "Paused" for the rest of the app session.
 *
 * Startup recovery already refuses to give a non-auto-spawn task a suspended
 * placeholder (`session-startup/resume-suspended.ts`), which is why a restart
 * shows the card correctly today. This only makes the live app agree.
 *
 * Scoped to `role === 'todo'`, not to `!auto_spawn`: moving into a custom
 * non-auto-spawn column deliberately suspends and offers Resume, and a restore
 * into that same column should behave identically.
 *
 * Deliberately the SESSION-only half of TASK_MOVE's cleanup, not the full
 * `cleanupTaskResources`. The full helper force-deletes the branch
 * (`git branch -D`) whenever it removes a worktree and `git.autoCleanup` is on,
 * which defaults to true. That is safe on the move-to-Backlog route, where the
 * user is warned first, but not here: `deleteTaskWorktree` nulls `worktree_path`
 * only when the Done-time removal SUCCEEDED and always preserves `branch_name`,
 * so an archived task whose worktree was pinned at Done time (routine on
 * Windows - AV, an open editor, `node_modules` handles) still carries both
 * fields. Restoring it would then re-attempt the removal, now usually succeed
 * because the agent PTY is long dead, and force-delete the branch holding the
 * task's committed work with no confirmation anywhere in the flow.
 *
 * `cleanupTaskSession` kills the PTY and wipes the session records while leaving
 * the worktree and branch alone, which is exactly the reset this route wants.
 */
async function resetSessionForTodoRestore(
  context: IpcContext,
  task: Task,
  tasks: TaskRepository,
  laneRole: SwimlaneRole | null | undefined,
  projectId: string | null,
  projectPath: string | null,
): Promise<void> {
  if (laneRole !== 'todo') return;
  try {
    await cleanupTaskSession(context, task, tasks, projectId, projectPath);
  } catch (cleanupError) {
    // Best-effort: the task is already unarchived and visible. A failed
    // teardown leaves the stale card state, not a broken board.
    console.error(`[TASK_UNARCHIVE] Session reset failed for task ${task.id.slice(0, 8)}:`, cleanupError);
  }
}

export function registerTaskArchiveHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_LIST_ARCHIVED, () => {
    const { tasks } = getProjectRepos(context);
    return tasks.listArchived();
  });

  ipcMain.handle(IPC.TASK_LIST_ARCHIVED_PREVIEW, (_, limit: number) => {
    const { tasks } = getProjectRepos(context);
    return tasks.listArchivedPreview(limit);
  });

  ipcMain.handle(IPC.TASK_UNARCHIVE, async (_, input: { id: string; targetSwimlaneId: string }, projectId?: string | null) => {
    const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks, swimlanes, actions, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);

    // Serialize the unarchive + spawn flow against any other in-flight
    // lifecycle op for this task. Unarchive writes the DB row synchronously,
    // but the worktree/checkout/spawn awaits below must not race with
    // TASK_DELETE / TASK_MOVE / etc.
    return withTaskLock(input.id, async () => {
      // Determine position at end of target lane
      const laneTasks = tasks.list(input.targetSwimlaneId);
      const position = laneTasks.length;

      const task = tasks.unarchive(input.id, input.targetSwimlaneId, position);

      // Folded through the unarchived task's Board Profile, so it comes back
      // on the same rung it was archived from.
      const toLane = applyProfileToLane(
        swimlanes.getById(input.targetSwimlaneId),
        loadTaskProfile(context, task, resolvedProjectPath),
      );

      // Guard: don't resume if target doesn't auto-spawn (backlog, done, or custom with auto_spawn=false)
      if (!toLane?.auto_spawn) {
        await resetSessionForTodoRestore(context, task, tasks, toLane?.role, resolvedProjectId, resolvedProjectPath);
        return tasks.getById(input.id);
      }

      // Report progress exactly as task-move does. Restoring from Done deletes
      // no time: the worktree has to be recreated from the preserved branch and
      // the CLI booted, and the task's suspended record survives that whole
      // window. Without a label the card sits on "Paused" behind a manual
      // "Resume session" button while the engine is already restoring the
      // conversation; with one, getTaskProgress reports 'preparing' and the
      // restore reads as continuous.
      const onProgress = createProgressCallback(context.mainWindow, task.id);
      // Emitted immediately, before any git work: the several seconds spent
      // resolving the lane and queueing the worktree op are exactly when the
      // card would otherwise still read "Paused".
      onProgress('resuming');

      // ONE `finally` for the whole labelled region, rather than a clear in each
      // exit branch. Every branch below retires the label unconditionally, so
      // per-branch calls were pure duplication - and they covered only the
      // branches someone remembered: the engine construction below (getProjectDb
      // / new SessionRepository / createTransitionEngine) sat outside every
      // `try`, so a throw there (a project DB closed by a concurrent switch)
      // stranded the card on "Resuming session..." until the 120s TTL swept it.
      try {
        // Create worktree if needed (any non-backlog column gets an agent)
        try {
          await ensureTaskWorktree(context, task, tasks, resolvedProjectPath, { onProgress });
        } catch (worktreeError) {
          console.error('[TASK_UNARCHIVE] Worktree creation failed:', worktreeError);
          return tasks.getById(input.id);
        }

        // Checkout the task's branch in the main repo (non-worktree tasks only).
        // If checkout fails, the task is still unarchived but no agent is spawned.
        try {
          await ensureTaskBranchCheckout(context, task, resolvedProjectPath, { onProgress });
        } catch (checkoutError) {
          console.error('[TASK_UNARCHIVE] Branch checkout failed:', checkoutError);
          notifyBranchCheckoutBlocked(context, task, checkoutError, resolvedProjectId);
          return tasks.getById(input.id);
        }

        // Execute transition actions (from Done -> target) for ALL non-kill columns,
        // via the shared spawn chokepoint (spawn preamble, transition actions,
        // fallback spawn). Recovery move: unarchive is always the FIRST move out
        // of Done, so suppressAutoCommand keeps the destination column's
        // auto_command out of the resumed session - it comes up idle, ready for
        // the user to inspect, matching startup recovery (resume-suspended.ts).
        // The next normal move injects per column config. skipPromptTemplate for
        // the same reason: an unarchived task is never a fresh "do this task" run.
        if (resolvedProjectPath) {
          const doneLane = swimlanes.list().find((l) => l.role === 'done');
          if (doneLane) {
            const db = getProjectDb(resolvedProjectId);
            const sessionRepo = new SessionRepository(db);
            const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachmentRepo, resolvedProjectId, resolvedProjectPath);

            try {
              await spawnAgent({
                context, engine, tasks, sessionRepo, task,
                fromSwimlaneId: doneLane.id,
                toLane,
                skipPromptTemplate: true,
                suppressAutoCommand: true,
                projectId: resolvedProjectId,
                projectPath: resolvedProjectPath,
                attachments: attachmentRepo,
              });
            } catch (err) {
              console.error('[TASK_UNARCHIVE] Failed to start session:', err);
            }
          }
        }

        return tasks.getById(input.id);
      } finally {
        // Mirrors task-move's Phase 3: the label goes once the restore has
        // resolved, whichever way, so a task that never reaches a live session
        // does not sit on "preparing" until the 120s TTL sweeps it.
        clearSpawnProgress(context.mainWindow, task.id);
      }
    });
  });

  ipcMain.handle(IPC.TASK_BULK_UNARCHIVE, async (_, ids: string[], targetSwimlaneId: string, projectId?: string | null) => {
    const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks, swimlanes, actions, attachments: attachmentRepo } = getProjectRepos(context, resolvedProjectId);
    const toLane = swimlanes.getById(targetSwimlaneId);

    for (const id of ids) {
      // Per-task lock so each unarchive+spawn serializes against any
      // in-flight session op for that task, while different tasks remain
      // independent. Early exits inside the callback (equivalent to the
      // previous `continue`) just complete the lock for that task and move
      // the outer loop to the next id.
      await withTaskLock(id, async () => {
        const laneTasks = tasks.list(targetSwimlaneId);
        const position = laneTasks.length;
        const task = tasks.unarchive(id, targetSwimlaneId, position);

        // Per-task fold: a bulk unarchive can carry tasks on different profiles
        // into the same column, so the auto-spawn gate is resolved per task
        // rather than once for the shared lane.
        const taskLane = applyProfileToLane(toLane, loadTaskProfile(context, task, resolvedProjectPath));
        if (!taskLane?.auto_spawn) {
          await resetSessionForTodoRestore(context, task, tasks, taskLane?.role, resolvedProjectId, resolvedProjectPath);
          return;
        }

        // Per task, same as the single-unarchive handler above: a restore is
        // slow enough (worktree recreate + CLI boot) that the card must show
        // it is working rather than a stale "Paused".
        const onProgress = createProgressCallback(context.mainWindow, task.id);
        onProgress('resuming');

        // One `finally` for the whole labelled region, as in the single-unarchive
        // handler above. `task.id` here comes from this iteration's own
        // `tasks.unarchive(...)` inside the per-task `withTaskLock`, so the clear
        // can only ever retire this task's label, never a sibling's.
        try {
          try {
            await ensureTaskWorktree(context, task, tasks, resolvedProjectPath, { onProgress });
          } catch (worktreeError) {
            console.error(`[TASK_BULK_UNARCHIVE] Worktree creation failed for task ${id.slice(0, 8)}:`, worktreeError);
            return;
          }

          // Checkout the task's branch in the main repo (non-worktree tasks only).
          // Catch per-task so one failure doesn't block the entire batch.
          try {
            await ensureTaskBranchCheckout(context, task, resolvedProjectPath, { onProgress });
          } catch (checkoutError) {
            console.error(`[TASK_BULK_UNARCHIVE] Branch checkout failed for task ${id.slice(0, 8)}:`, checkoutError);
            notifyBranchCheckoutBlocked(context, task, checkoutError, resolvedProjectId);
            return;
          }

          if (resolvedProjectPath) {
            const doneLane = swimlanes.list().find((lane) => lane.role === 'done');
            if (doneLane) {
              const db = getProjectDb(resolvedProjectId);
              const sessionRepo = new SessionRepository(db);
              const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachmentRepo, resolvedProjectId, resolvedProjectPath);

              // Same shared-chokepoint recovery-move contract as the single
              // TASK_UNARCHIVE handler above: suppressAutoCommand +
              // skipPromptTemplate, session resumes idle.
              try {
                await spawnAgent({
                  context, engine, tasks, sessionRepo, task,
                  fromSwimlaneId: doneLane.id,
                  // The per-task folded lane, so a bulk unarchive spawns each task
                  // on its own profile's rung rather than the column's base.
                  toLane: taskLane,
                  skipPromptTemplate: true,
                  suppressAutoCommand: true,
                  projectId: resolvedProjectId,
                  projectPath: resolvedProjectPath,
                  attachments: attachmentRepo,
                });
              } catch (error) {
                console.error('[TASK_BULK_UNARCHIVE] Failed to start session:', error);
              }
            }
          }
        } finally {
          clearSpawnProgress(context.mainWindow, task.id);
        }
      });
    }
  });
}
