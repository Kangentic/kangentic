import type { Session } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';
import type { SessionResumedPayload } from '../pty/session-manager';

/**
 * Ask the turn-end runner to judge the reply a live agent left, as it does for
 * a resumed session (`catchUpAfterResume`). For a workflow's Resume: an agent a
 * person brought back while the workflow was paused had its reply judged then,
 * when no step check applied, and an idle agent ends no new turn, so nothing
 * else would judge it. A leaf module the runner registers with, so the
 * workflow service does not import the runner.
 */
let runCatchUp: ((resumed: SessionResumedPayload) => void) | null = null;

/** Set by the turn-end runner when it registers. */
export function setWorkflowCatchUp(runner: ((resumed: SessionResumedPayload) => void) | null): void {
  runCatchUp = runner;
}

/** Judge a live agent's last reply under its task's column, as a resume would. */
export function requestWorkflowCatchUp(context: IpcContext, liveSession: Session): void {
  // Only an idle agent has a finished reply waiting. A working one's own turn
  // end is judged as usual, and a catch-up of that same turn would judge it twice.
  // activity-state-ok: granular, a turn still running or a prompt open is not a finished reply.
  if (context.sessionManager.getActivityCache()[liveSession.id] !== 'idle') return;
  // The session's own serial, so a turn the user starts meanwhile reads as newer.
  const workSerial = context.sessionManager.currentWorkSerial(liveSession.id);
  if (workSerial === undefined) return;
  runCatchUp?.({
    sessionId: liveSession.id,
    taskId: liveSession.taskId,
    projectId: liveSession.projectId,
    agentSessionId: liveSession.agentSessionId ?? null,
    isolatedSwimlaneId: liveSession.isolatedSwimlaneId ?? null,
    workSerial,
    // A person's Resume of the workflow or of the task's automations.
    resumedBy: 'user',
  });
}
