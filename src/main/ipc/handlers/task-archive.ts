import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  buildAutoCommandVars,
  ensureTaskWorktree,
  ensureTaskBranchCheckout,
  createTransitionEngine,
} from '../helpers';
import { guardActiveNonWorktreeSessions } from './task-move';
import { interpolateTemplate } from '../../agent/shared';
import { withTaskLock } from '../task-lifecycle-lock';
import type { IpcContext } from '../ipc-context';

export function registerTaskArchiveHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_LIST_ARCHIVED, () => {
    const { tasks } = getProjectRepos(context);
    return tasks.listArchived();
  });

  ipcMain.handle(IPC.TASK_UNARCHIVE, async (_, input: { id: string; targetSwimlaneId: string }) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
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

      const toLane = swimlanes.getById(input.targetSwimlaneId);

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

      // Execute transition actions (from Done -> target) for ALL non-kill columns
      if (resolvedProjectPath) {
        const doneLane = swimlanes.list().find((l) => l.role === 'done');
        if (doneLane) {
          const db = getProjectDb(resolvedProjectId);
          const sessionRepo = new SessionRepository(db);
          const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachmentRepo, resolvedProjectId, resolvedProjectPath);

          try {
            await engine.executeTransition(task, doneLane.id, input.targetSwimlaneId, toLane?.permission_mode, true);
          } catch (err) {
            console.error('[TASK_UNARCHIVE] Transition engine error:', err);
          }

          // Re-read task; if still no session, resume suspended or spawn fresh.
          let finalTask = tasks.getById(task.id);
          if (finalTask && !finalTask.session_id && toLane?.auto_spawn) {
            console.log(`[TASK_UNARCHIVE] Ensuring agent for task ${task.id.slice(0, 8)}`);
            try {
              await engine.resumeSuspendedSession(finalTask, toLane.permission_mode, true);
              finalTask = tasks.getById(task.id);
            } catch (err) {
              console.error('[TASK_UNARCHIVE] Failed to start session:', err);
            }
          }

          // Schedule auto-command for freshly spawned session
          if (finalTask?.session_id && toLane?.auto_command) {
            const vars = buildAutoCommandVars(finalTask);
            const interpolated = interpolateTemplate(toLane.auto_command, vars);
            context.commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
          }
        }
      }

      return tasks.getById(input.id);
    });
  });

  ipcMain.handle(IPC.TASK_BULK_UNARCHIVE, async (_, ids: string[], targetSwimlaneId: string) => {
    const resolvedProjectId = context.currentProjectId;
    const resolvedProjectPath = context.currentProjectPath;
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

        if (!toLane?.auto_spawn) return;

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

            try {
              await engine.executeTransition(task, doneLane.id, targetSwimlaneId, toLane?.permission_mode, true);
            } catch (error) {
              console.error('[TASK_BULK_UNARCHIVE] Transition engine error:', error);
            }

            let finalTask = tasks.getById(task.id);
            if (finalTask && !finalTask.session_id && toLane?.auto_spawn) {
              try {
                await engine.resumeSuspendedSession(finalTask, toLane.permission_mode, true);
                finalTask = tasks.getById(task.id);
              } catch (error) {
                console.error('[TASK_BULK_UNARCHIVE] Failed to start session:', error);
              }
            }

            if (finalTask?.session_id && toLane?.auto_command) {
              const vars = buildAutoCommandVars(finalTask);
              const interpolated = interpolateTemplate(toLane.auto_command, vars);
              context.commandInjector.schedule(finalTask.id, finalTask.session_id, interpolated, { freshlySpawned: true });
            }
          }
        }
      });
    }
  });
}
