import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { createTransitionEngine, resolveInjectionVerifier } from './agent-spawn';
import { getProjectRepos } from './project-repos';
import { reportAutoCommandOutcome } from './auto-command-outcome';
import { deliverAgentMessageInBackground } from '../../automations/turn-end/agent-message-delivery';
import { readSessionFinalReply } from '../../automations/turn-end/final-reply-reader';
import { moveTaskFromRow } from '../../automations/turn-end/move-from-row';
import { needsAgentReply } from '../../automations/row-guards';
import { showAutomationNotification } from '../../automations/shared/show-automation-notification';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { withTaskLock } from '../task-lifecycle-lock';
import { automationMovesTask } from '../../../shared/automation-manifest';
import type { IpcContext } from '../ipc-context';
import type { AutomationContext } from '../../automations/shared/automation-adapter';
import type { AutomationRunAgainResult, ColumnAutomation, Swimlane, Task } from '../../../shared/types';

/**
 * How long one re-run may take, whatever the adapter declares.
 *
 * A re-run is not a move, so it inherits neither the exit group's short-lock
 * cap nor Phase 3's spawn budget. It still takes the task lock, so it still has
 * to be bounded: a re-run of a hung webhook would otherwise wedge that task's
 * next move exactly the way the un-timed action system used to. Five minutes is
 * the script adapter's own default, which is the longest any single row is
 * allowed on the enter path.
 */
const RUN_AGAIN_BUDGET_MS = 5 * 60_000;

/**
 * Re-run ONE automation against the task's CURRENT state.
 *
 * Shared by the failure toast's Run again action (`IPC.AUTOMATION_RUN_AGAIN`)
 * and the MCP `kangentic_run_automation` tool, so the two cannot diverge about
 * what a re-run means.
 *
 * CURRENT state, not the state at the time of the failure: a task can have
 * moved twice since, and replaying a stale context would be a worse lie than
 * not offering the button. Both the toast and the tool description say so.
 *
 * Under `withTaskLock` because it mutates task-scoped state (it can type at the
 * agent, and a script can touch the worktree), and because a re-run racing a
 * move is exactly the interleaving the lock exists to prevent.
 *
 * Except a row that moves the task (Move to column, `endsGroup`), which runs
 * outside the lock as it does at a turn end: its move goes through
 * `handleTaskMove`, which takes the lock itself. It moves the task only from
 * the row's own column, the way the turn end that failed would have.
 */
export async function runAutomationAgain(
  context: IpcContext,
  projectId: string,
  taskId: string,
  automationId: string,
): Promise<AutomationRunAgainResult> {
  const repos = getProjectRepos(context, projectId);

  const automation = repos.automations.listAll().find((row) => row.id === automationId);
  if (!automation) {
    return { ok: false, error: 'That automation no longer exists. It was probably deleted or renamed in the Column Manager.' };
  }
  const column = repos.swimlanes.getById(automation.swimlane_id);
  if (!column) {
    return { ok: false, error: `The column "${automation.swimlane_id.slice(0, 8)}" this automation belongs to no longer exists.` };
  }

  // A turn-end row whose Text match, Condition or `{{agentReply}}` reads the
  // agent's final message gets the newest one the task's session wrote. That
  // is what a turn end reads, except that a re-run before the task's first
  // turn in this column reads the message the last column's turn ended on.
  // Read before the lock: it can take up to 15 s and holds nothing. A row that
  // reads no message skips it.
  const replyRead = automation.trigger === 'turn_end' && needsAgentReply(automation)
    ? await readLatestReply(projectId, repos.tasks.getById(taskId)?.session_id ?? null)
    : null;

  if (automationMovesTask(automation.type)) {
    // A row that moves the task (Move to column) runs outside the task lock,
    // as it does at a turn end: its move takes that lock (`handleTaskMove`),
    // and `withTaskLock` is not reentrant. The lock is taken only to let a move
    // queued ahead of this one land, so "current state" is still current.
    const task = await withTaskLock(taskId, async () => repos.tasks.getById(taskId));
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    // Next column resolves from the row's column, so a task that has left it
    // would be sent on from somewhere it no longer is.
    if (task.swimlane_id !== column.id) {
      return { ok: false, error: `The task is no longer in ${column.name}, so this row cannot move it. Drag the card instead.` };
    }
    return runRowAgain(context, projectId, task, column, automation, replyRead);
  }

  return withTaskLock(taskId, async () => {
    // Re-read INSIDE the lock: "current state" has to mean current as of the
    // run, and a move that was queued ahead of this one has now landed.
    const task = repos.tasks.getById(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    return runRowAgain(context, projectId, task, column, automation, replyRead);
  });
}

/** The session's latest final message, with the session it came from (`readLatestReply`). */
interface LatestReply {
  sessionId: string;
  text: string | null;
}

/**
 * Run the one row against `task` as it is now. A row that moves the task gets
 * the move a turn end would make (`moveTaskFromRow`), in no turn-end group.
 */
async function runRowAgain(
  context: IpcContext,
  projectId: string,
  task: Task,
  column: Swimlane,
  automation: ColumnAutomation,
  replyRead: LatestReply | null,
): Promise<AutomationRunAgainResult> {
  const repos = getProjectRepos(context, projectId);
  const taskId = task.id;
  // Undefined on enter and exit, which have no final message. Null when no
  // message was read, or when it came from a session a queued move has since
  // replaced, so another session's last line never decides this row.
  const agentReply = automation.trigger !== 'turn_end'
    ? undefined
    : replyRead !== null && replyRead.sessionId === task.session_id ? replyRead.text : null;

  const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
  if (!projectPath) return { ok: false, error: 'That project is not open.' };

  const moveTask: AutomationContext['moveTask'] = automationMovesTask(automation.type)
    ? (move) => moveTaskFromRow(context, { projectId, projectPath, task, fromColumn: column, move, fromTurnEndGroup: false })
    : undefined;

  const sessionRepo = new SessionRepository(getProjectDb(projectId));
  const engine = createTransitionEngine(
    context,
    repos.automations,
    repos.automationRuns,
    repos.tasks,
    sessionRepo,
    repos.attachments,
    projectId,
    projectPath,
  );

  const budget = AbortSignal.timeout(RUN_AGAIN_BUDGET_MS);
  try {
    const summary = await engine.executeSingleAutomation(task, column, automation, {
      signal: budget,
      // Stated explicitly, not left to the runner's trigger default. That
      // default is the 60s exit-group cap, which the comment on
      // RUN_AGAIN_BUDGET_MS says a re-run does not inherit, so re-running an
      // On exit row was silently cut to a minute.
      groupBudgetMs: RUN_AGAIN_BUDGET_MS,
      // Fire and forget, like the warm enter path: nothing here cancels the
      // scheduler, so a message queues rather than racing anything. A
      // message with line breaks is pasted once the agent's turn ends, and a
      // move out of the column cancels it.
      deliverToAgent: async (message, mode) => {
        const liveSession = task.session_id;
        if (!liveSession) return;
        deliverAgentMessageInBackground(context, {
          taskId,
          sessionId: liveSession,
          message,
          mode,
          verifier: resolveInjectionVerifier(task.agent, sessionRepo, taskId),
          onOutcome: (report) => reportAutoCommandOutcome(context, repos.tasks, task, report, projectId),
        });
      },
      showNotification: (notification) => showAutomationNotification(context, notification),
      onProgress: createProgressCallback(context.mainWindow, taskId),
      agentReply,
      moveTask,
    });

    const outcome = summary.outcomes[0];
    if (!outcome) {
      return { ok: false, error: 'The automation did not run. It may be switched off, or its column may no longer be able to run it.' };
    }
    return {
      ok: true,
      runId: outcome.runId,
      automationName: outcome.name,
      columnName: outcome.columnName,
      status: outcome.status,
      detail: outcome.detail,
    };
  } catch (error) {
    // The runner isolates every row, so reaching here means the run itself
    // could not start (a repository read, or the budget firing before the
    // first attempt). It records nothing, so this is the only report.
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The automation could not be run: ${detail}` };
  } finally {
    // A re-run has no spawn to clear the label, unlike a cold move, so it
    // clears its own. Without this the card keeps whatever phase the last row
    // announced until the next spawn happens to overwrite it.
    clearSpawnProgress(context.mainWindow, taskId);
  }
}

/**
 * The session's latest final message with the session it came from, so the
 * caller can tell whether it is still the task's. Null when the task has no
 * session; a null `text` when the read found nothing or failed.
 */
async function readLatestReply(projectId: string, sessionId: string | null): Promise<LatestReply | null> {
  if (!sessionId) return null;
  const reply = await readSessionFinalReply({ sessionId }, new SessionRepository(getProjectDb(projectId)));
  return { sessionId, text: reply?.text ?? null };
}
