import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { createTransitionEngine, resolveInjectionVerifier } from './agent-spawn';
import { getProjectRepos } from './project-repos';
import { reportAutoCommandOutcome } from './auto-command-outcome';
import { showDesktopNotification } from '../handlers/system';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { withTaskLock } from '../task-lifecycle-lock';
import type { IpcContext } from '../ipc-context';
import type { AutomationRunAgainResult } from '../../../shared/types';

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

  return withTaskLock(taskId, async () => {
    // Re-read INSIDE the lock: "current state" has to mean current as of the
    // run, and a move that was queued ahead of this one has now landed.
    const task = repos.tasks.getById(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };

    const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
    if (!projectPath) return { ok: false, error: 'That project is not open.' };

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
        // Fire and forget, like the warm enter path: nothing here cancels the
        // scheduler, so a message queues rather than racing anything.
        deliverToAgent: async (message, mode) => {
          const liveSession = task.session_id;
          if (!liveSession) return;
          context.terminalSubmitScheduler.scheduleKeystrokes(
            taskId,
            liveSession,
            [{ text: message, verify: 'submitted' }],
            {
              mode,
              verifier: resolveInjectionVerifier(task.agent, sessionRepo, taskId),
              onOutcome: (report) => reportAutoCommandOutcome(context, repos.tasks, task, report, projectId),
            },
          );
        },
        showNotification: (notification) => showDesktopNotification(context, notification),
        onProgress: createProgressCallback(context.mainWindow, taskId),
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
  });
}
