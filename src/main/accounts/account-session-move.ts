import { CONTINUE_PROMPT } from './account-continuation';
import { accountsReporter } from './account-report';

/** A running task session, as a Switch to that moves running sessions needs it. */
export interface RunningTaskSession {
  sessionId: string;
  taskId: string;
  projectId: string;
  /** The account it runs on. Null where accounts do not apply (a CLI in WSL): never moved. */
  accountId: string | null;
  /** Its agent is mid-turn, or waiting on a prompt of its own. Idle sessions resume idle. */
  working: boolean;
}

export interface MoveRunningSessionsDependencies {
  /** Every running task session of `agent`, across projects. Never a Command Terminal or a workflow agent. */
  listRunning: (agent: string) => RunningTaskSession[];
  /** Restarts the task's session on `accountId`, resuming its conversation. False when it did not restart. */
  restartOn: (session: RunningTaskSession, accountId: string, prompt: string | undefined) => Promise<boolean>;
}

/**
 * Moves an agent's running task sessions onto `targetAccountId`: the "running sessions too"
 * choice of Switch to (task #1057). Each is restarted in place and resumes its own conversation,
 * which the shared history folder makes possible on any account. A session that was working is
 * told to continue, so the turn the restart cut is picked up; an idle one comes back idle. One at
 * a time, so a board of sessions does not restart at once. Sessions already on the account, and
 * sessions accounts do not apply to, are left alone. Resolves how many moved and how many could
 * not be, which stay on the account they were on.
 */
export async function moveRunningSessions(
  dependencies: MoveRunningSessionsDependencies,
  agent: string,
  targetAccountId: string,
): Promise<{ moved: number; failed: number }> {
  let moved = 0;
  let failed = 0;
  for (const session of dependencies.listRunning(agent)) {
    if (session.accountId === null || session.accountId === targetAccountId) continue;
    try {
      if (await dependencies.restartOn(session, targetAccountId, session.working ? CONTINUE_PROMPT : undefined)) moved += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[ACCOUNTS] Could not move task ${session.taskId.slice(0, 8)} to another account:`, error);
      accountsReporter.report(error, { tags: { stage: 'session_move' } });
    }
  }
  return { moved, failed };
}
