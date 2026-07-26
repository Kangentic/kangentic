import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  ensureTaskWorktree,
  ensureTaskBranchCheckout,
  createTransitionEngine,
  spawnAgent,
} from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from '../helpers/task-profile';
import { guardActiveNonWorktreeSessions } from './task-move';
import { withTaskLock } from '../task-lifecycle-lock';
import type { IpcContext } from '../ipc-context';

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
        return tasks.getById(input.id);
      }

      // Create worktree if needed (any non-backlog column gets an agent)
      try {
        await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);
      } catch (worktreeError) {
        console.error('[TASK_UNARCHIVE] Worktree creation failed:', worktreeError);
        return tasks.getById(input.id);
      }

      // Checkout the task's branch in the main repo (non-worktree tasks only).
      // If checkout fails, the task is still unarchived but no agent is spawned.
      try {
        guardActiveNonWorktreeSessions(context, task, tasks);
        await ensureTaskBranchCheckout(task, resolvedProjectPath);
      } catch (checkoutError) {
        console.error('[TASK_UNARCHIVE] Branch checkout failed:', checkoutError);
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
        if (!taskLane?.auto_spawn) return;

        try {
          await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);
        } catch (worktreeError) {
          console.error(`[TASK_BULK_UNARCHIVE] Worktree creation failed for task ${id.slice(0, 8)}:`, worktreeError);
          return;
        }

        // Checkout the task's branch in the main repo (non-worktree tasks only).
        // Catch per-task so one failure doesn't block the entire batch.
        try {
          guardActiveNonWorktreeSessions(context, task, tasks);
          await ensureTaskBranchCheckout(task, resolvedProjectPath);
        } catch (checkoutError) {
          console.error(`[TASK_BULK_UNARCHIVE] Branch checkout failed for task ${id.slice(0, 8)}:`, checkoutError);
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
      });
    }
  });
}
