import { IPC } from '../../../shared/ipc-channels';
import type { AutoCommandResultNotice, AutoCommandState, Task } from '../../../shared/types';
import type { InjectionReport } from '../../transition-engine/terminal-submit-scheduler';
import type { IpcContext } from '../ipc-context';
import type { TaskRepository } from '../../db/repositories/task-repository';

/**
 * Record what happened to a task's auto_command, and tell the user when it
 * matters.
 *
 * Before this existed, every failure in the injection path was a
 * `console.warn`. A task would simply sit there having quietly not run its
 * command, which is a large part of why the subsystem read as flaky rather
 * than as a known error: there was no difference, from the outside, between
 * "delivered" and "silently dropped".
 *
 * Two sinks, deliberately different in what they carry:
 *
 *  - The DB row is the durable record. It survives a restart and a project
 *    switch, and it holds every outcome including the boring ones, so the
 *    state is inspectable after the fact.
 *  - The push event is the interruption, and it is rationed. See
 *    `shouldNotify` for exactly which outcomes earn one.
 */
export function reportAutoCommandOutcome(
  context: IpcContext,
  tasks: TaskRepository,
  task: Pick<Task, 'id' | 'title'>,
  report: InjectionReport,
  projectId?: string | null,
): void {
  const state = toState(report);
  const command = report.commands.join(' | ');

  try {
    tasks.recordAutoCommandOutcome(task.id, {
      state,
      command,
      error: report.reason ?? null,
    });
  } catch (caughtError) {
    // Persistence is best-effort: a DB hiccup must not swallow the notice,
    // which is the part the user actually sees.
    console.error(`[auto-command] Failed to record outcome for task ${task.id.slice(0, 8)}:`, caughtError);
  }

  if (!shouldNotify(state, report)) return;
  if (!context.mainWindow || context.mainWindow.isDestroyed()) return;

  const notice: AutoCommandResultNotice = {
    taskId: task.id,
    taskTitle: task.title,
    projectId: projectId ?? context.currentProjectId ?? undefined,
    state,
    command,
    ...(report.reason ? { reason: report.reason } : {}),
    ...(report.discardedDraft ? { discardedDraft: report.discardedDraft } : {}),
    interruptedTurn: report.interruptedTurn,
    escalated: report.escalated,
  };
  context.mainWindow.webContents.send(IPC.TASK_AUTO_COMMAND_RESULT, notice);
}

function toState(report: InjectionReport): AutoCommandState {
  // Escalation wins over the underlying keystroke outcome: the command was
  // delivered, just not by the path that reported. Recorded as its own state
  // rather than folded into `confirmed`, because nothing verified it.
  if (report.escalated) return 'escalated';
  // `aborted` is the byte-layer's word for the same thing the scheduler calls
  // `cancelled`; the persisted vocabulary keeps one name for it.
  if (report.outcome === 'cancelled' || report.outcome === 'aborted') return 'cancelled';
  return report.outcome;
}

/**
 * Which outcomes are worth interrupting the user for.
 *
 * `unconfirmed` is deliberately silent. Only Claude implements a
 * `command-injection` verifier, so on every other agent EVERY delivery lands
 * there; notifying would fire on every single column move for most users and
 * would say nothing they can act on.
 *
 * `cancelled` is also silent: the usual cause is the user themselves moving
 * the task again or stopping the session, and reporting their own action back
 * to them is noise.
 *
 * Discarding typed text is the one thing that overrides both. It is a loss the
 * user did not ask for and cannot recover from anywhere else, and it is
 * orthogonal to whether a verifier happened to confirm the delivery - so it is
 * checked BEFORE the silent states rather than after. Ordering it after them
 * meant a cleared draft was announced on Claude and swallowed on every other
 * agent, which is precisely backwards: those are the agents where the outcome
 * is least observable to begin with.
 *
 * What remains is a real failure, or a success that took something from the
 * user without asking: it discarded text they had typed, or it interrupted a
 * turn that was running.
 */
function shouldNotify(state: AutoCommandState, report: InjectionReport): boolean {
  if (state === 'failed') return true;
  // A session respawn is never silent: the user's terminal just went away.
  if (state === 'escalated') return true;
  if (report.discardedDraft) return true;
  if (state === 'cancelled' || state === 'unconfirmed') return false;
  return report.interruptedTurn;
}
