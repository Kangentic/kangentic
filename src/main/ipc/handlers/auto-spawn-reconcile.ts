import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../helpers';
import { autoSpawnForTask } from '../helpers/agent-spawn';
import { applySuspendDbWrites } from './session-reconcile';
import { withTaskLock } from '../task-lifecycle-lock';
import { IPC } from '../../../shared/ipc-channels';
import type { StrategyChange } from './strategy-propagation';
import type { IpcContext } from '../ipc-context';
import type { SwimlaneRole } from '../../../shared/types';

/**
 * One task selected for a spawn because its column just started wanting agents.
 */
export interface AutoSpawnReconcileSpawn {
  taskId: string;
  taskTitle: string;
  swimlaneId: string;
  /** The column or profile whose edit selected this task, for log lines. */
  sourceName: string;
}

/**
 * One task selected for a suspend because its column just stopped wanting agents.
 */
export interface AutoSpawnReconcileSuspend {
  taskId: string;
  /**
   * The session id as of planning. The executor re-reads the task inside the
   * lock and suspends whatever is live THEN; this is carried so the plan is
   * assertable on its own.
   */
  sessionId: string;
  /**
   * The column the task was in when the suspend was planned. The executor
   * re-reads the task inside the lock and bails when it no longer matches, so a
   * card dragged into a column that still wants an agent is not suspended by a
   * decision made about the column it left.
   */
  swimlaneId: string;
  sourceName: string;
}

/**
 * Columns that never auto-spawn, whatever the flag says.
 *
 * The Board Manager strips `auto_spawn` for a role column and `apply-config.ts`
 * forces it false, but the MCP `update_column` tool writes the field with no
 * role validation - so `update_column({ column: 'To Do', autoSpawn: true })`
 * reaches this reconcile and would otherwise spawn an agent, and a worktree,
 * for every card in To Do. Those sessions are also unreachable afterwards:
 * `SESSION_RESUME` refuses role 'todo', and a To Do card relies on having no
 * session to open straight into the edit form.
 */
const NEVER_AUTO_SPAWN_ROLES: ReadonlySet<SwimlaneRole> = new Set<SwimlaneRole>(['todo', 'done']);

/** True when this change actually flips `auto_spawn` for its task. */
function flipsAutoSpawn(change: StrategyChange): boolean {
  return !!change.before && !!change.after && change.before.auto_spawn !== change.after.auto_spawn;
}

export interface AutoSpawnReconcilePlan {
  toSpawn: AutoSpawnReconcileSpawn[];
  toSuspend: AutoSpawnReconcileSuspend[];
}

/**
 * Decide which tasks an `auto_spawn` change should start or stop.
 *
 * Pure, so the selection rules are testable without the spawn stack. The gate is
 * PER TASK on the already-profile-folded before/after that `StrategyChange`
 * carries, which is what makes a column edit correct for a profiled task: a
 * profile may turn `auto_spawn` on for a column whose base has it off, or off
 * for one that has it on (see the `auto_spawn` case in `column-strategy.ts`'s
 * `applyProfileToLane`).
 *
 * The ON filters are `autoSpawnTasks`' filters, reused rather than reinvented -
 * minus its lane scan, which `StrategyChange` has already done.
 */
export function planAutoSpawnReconcile(
  changes: readonly StrategyChange[],
  dependencies: {
    userPausedTaskIds: ReadonlySet<string>;
    hasSessionForTask: (taskId: string) => boolean;
  },
): AutoSpawnReconcilePlan {
  const plan: AutoSpawnReconcilePlan = { toSpawn: [], toSuspend: [] };

  for (const change of changes) {
    const { task, before, after, sourceName } = change;
    // A colour / name / icon edit, or a re-save at the same value, reconciles
    // nothing. Same reasoning as the injection gate: act on a real delta only.
    if (!before || !after) continue;
    if (!flipsAutoSpawn(change)) continue;

    if (after.auto_spawn) {
      // To Do and Done never get an agent, however the flag was written. See
      // NEVER_AUTO_SPAWN_ROLES: only the OFF direction is meaningful there.
      if (after.role !== null && NEVER_AUTO_SPAWN_ROLES.has(after.role)) continue;
      // A task the user explicitly paused must NOT start just because a column
      // was switched on. Only an explicit Resume clears that, which is why
      // spawnAgent carries the same guard and both startup passes skip these ids.
      if (dependencies.userPausedTaskIds.has(task.id)) continue;
      // Already has a session (running, queued, or a suspended placeholder):
      // nothing to start.
      if (dependencies.hasSessionForTask(task.id)) continue;
      plan.toSpawn.push({
        taskId: task.id,
        taskTitle: task.title,
        swimlaneId: task.swimlane_id,
        sourceName,
      });
      continue;
    }

    // OFF: mirror the move-into-an-auto_spawn=false-column branch (task-move's
    // priority 2.5). No session means nothing to suspend.
    if (!task.session_id) continue;
    plan.toSuspend.push({
      taskId: task.id,
      sessionId: task.session_id,
      swimlaneId: task.swimlane_id,
      sourceName,
    });
  }

  return plan;
}

/**
 * Apply an `auto_spawn` change to the tasks ALREADY living in the edited column.
 *
 * Before this existed, `auto_spawn` was reconciled only by `autoSpawnTasks` on
 * project open, so switching a column on did nothing until the app restarted,
 * and switching it off left live sessions running in a column that no longer
 * wanted them. `propagateStrategyToLiveSessions` could not carry it: its gate is
 * blind to `auto_spawn`, and it bails on `!task.session_id`, so it is
 * structurally an inject-or-restart path that can never CREATE a session.
 *
 * Called from `propagateStrategyToLiveSessions`, so every surface that reaches
 * that chokepoint (a column edit, a Board Profile edit, the MCP `update_column`
 * tool) reconciles identically. That is the same parity argument the chokepoint
 * itself was extracted for.
 *
 * KNOWN GAP: the `kangentic.json` file watcher (`BOARD_CONFIG_APPLY` ->
 * `apply-config.ts`) also writes `auto_spawn` and does not route through here, so
 * a `git pull` that flips `autoSpawn` still needs a restart. Deliberate: that
 * path fires for whichever project changed on disk, often not the focused one,
 * which makes spawning agents from it materially riskier than from a deliberate
 * user edit.
 *
 * `projectId` is explicit and never resolved from ambient context: a
 * mis-targeted keystroke injection is cosmetic, a mis-targeted SPAWN is not.
 */
export function reconcileAutoSpawnChange(
  context: IpcContext,
  projectId: string | null,
  label: string,
  changes: readonly StrategyChange[],
): void {
  if (!projectId || changes.length === 0) return;
  // Cheap gate before any DB work: this runs on EVERY column and profile save,
  // including a colour or name edit, while `getUserPausedTaskIds` is a
  // self-join over the whole sessions table.
  if (!changes.some(flipsAutoSpawn)) return;

  const sessionRepo = new SessionRepository(getProjectDb(projectId));
  // `sessionManager.hasSessionForTask` matches ANY registry entry, including an
  // 'exited' one - and exited entries are never evicted, so a task whose agent
  // has already finished during this app run would be skipped forever and
  // switching the column on would silently do nothing. Count only entries that
  // represent a session there is any point keeping: live, or suspended (which
  // the user resumes by hand).
  // Scoped to this project as well: the registry is app-wide, and the whole
  // point of threading an explicit projectId here is to not resolve anything
  // ambiently.
  const occupiedTaskIds = new Set(
    context.sessionManager.listSessions()
      .filter((session) => session.projectId === projectId && session.status !== 'exited')
      .map((session) => session.taskId),
  );
  const plan = planAutoSpawnReconcile(changes, {
    userPausedTaskIds: sessionRepo.getUserPausedTaskIds(),
    hasSessionForTask: (taskId) => occupiedTaskIds.has(taskId),
  });
  if (plan.toSpawn.length === 0 && plan.toSuspend.length === 0) return;

  // Backgrounded so the Board Manager save stays responsive - the board learns
  // about the new/cleared session ids from the resync push below. Same shape as
  // the model-change restart in strategy-propagation.
  void (async () => {
    for (const entry of plan.toSuspend) {
      try {
        // Cancel outside the lock: a queued injection for a session we are about
        // to suspend has nothing left to type into.
        context.terminalSubmitScheduler.cancel(entry.taskId);
        await withTaskLock(entry.taskId, async () => {
          // Re-read inside the lock: a drag or an explicit pause may have landed
          // between planning and acquiring it. The plan is a synchronous
          // snapshot but each suspend awaits a PTY shutdown, so for a column of
          // several tasks the last entry can run many seconds after planning.
          const { tasks } = getProjectRepos(context, projectId);
          const currentTask = tasks.getById(entry.taskId);
          const liveSessionId = currentTask?.session_id;
          if (!liveSessionId) return;
          // The task must still be in the column this suspend was decided
          // about. Dragged into a column that wants an agent, it keeps (or
          // respawns) a session, and suspending that one would stop an agent
          // the board legitimately wants running. Mirrors task-move's own
          // "moved to a different column during Phase 2" re-check; the spawn
          // side inherits the equivalent guard from autoSpawnForTask.
          if (currentTask.swimlane_id !== entry.swimlaneId) return;
          // 'system', not 'user': this is a config change, not an explicit pause,
          // so it must not become sticky against a later spawn or move.
          applySuspendDbWrites(context, projectId, entry.taskId, 'system');
          await context.sessionManager.suspend(liveSessionId);
        });
        console.log(
          `[${label}] Suspended session for task ${entry.taskId.slice(0, 8)}`
          + ` (auto-spawn turned off on "${entry.sourceName}")`,
        );
      } catch (suspendError) {
        console.warn(
          `[${label}] Could not suspend session for task ${entry.taskId.slice(0, 8)}`
          + ` after auto-spawn was turned off on "${entry.sourceName}":`,
          suspendError,
        );
      }
    }

    // Sequential, NOT Promise.all: each spawn can create a worktree and check out
    // a branch, and a column may hold many tasks. A live config edit must not
    // stampede git the way a quiescent startup sweep can afford to.
    for (const entry of plan.toSpawn) {
      try {
        // Deliberately OUTSIDE any lock: autoSpawnForTask takes the task lock
        // itself, and withTaskLock is not reentrant. It also carries the
        // user-pause guard, the auto_spawn guard, and runSpawnPreamble, which is
        // what keeps this compliant with spawn-entry-point-parity.
        await autoSpawnForTask(
          context,
          projectId,
          { id: entry.taskId, title: entry.taskTitle },
          entry.swimlaneId,
        );
      } catch (spawnError) {
        console.warn(
          `[${label}] Could not spawn agent for task ${entry.taskId.slice(0, 8)}`
          + ` after auto-spawn was turned on for "${entry.sourceName}":`,
          spawnError,
        );
      }
    }

    // The board still holds the pre-reconcile session ids. Push a quiet
    // (toast-free) re-sync, as the model-change restart does.
    if (!context.mainWindow.isDestroyed()) {
      context.mainWindow.webContents.send(IPC.TASK_SESSION_RESYNC, projectId);
    }
  })();
}
