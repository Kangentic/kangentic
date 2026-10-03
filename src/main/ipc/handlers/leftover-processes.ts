import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LeftoverProcessReport, LeftoverStopOutcome } from '../../../shared/types';
import { trackEvent } from '../../analytics/analytics';
import { leftoverProcessReports } from '../helpers/leftover-process-reports';
import { retryDoneWorktreeRemoval } from '../helpers/task-cleanup';
import type { IpcContext } from '../ipc-context';

/**
 * What the `leftover_processes` analytics event carries for one report: counts
 * only, never a label, a pid or a task. It is the one view of whether the reap
 * works on users' machines, and of where it does not: a platform whose
 * "couldn't stop" count climbs. Hard failures (a reader that will not load, a
 * scan that lists nothing) go to Sentry instead (`task-reap-failure-report.ts`).
 */
export function leftoverReportCounts(report: LeftoverProcessReport): { stopped: number; kept: number; failed: number; stoppingEnabled: boolean } {
  const counts = { stopped: 0, kept: 0, failed: 0, stoppingEnabled: report.stoppingEnabled };
  for (const leftover of report.processes) counts[leftover.outcome] += 1;
  return counts;
}

/**
 * The leftover-process list's Stop button. It names a process by the id a
 * report minted (`leftover-process-reports.ts`), never by pid, so the renderer
 * can only ask to stop something main reported; an id main does not know reads
 * as already ended. Not project-scoped: the id carries its own identity.
 *
 * Once the process is gone, a Done task's worktree it was holding is removed
 * in the background (`retryDoneWorktreeRemoval`), after the answer goes back.
 */
export function registerLeftoverProcessHandlers(context: IpcContext): void {
  leftoverProcessReports.setReportListener((report) => trackEvent('leftover_processes', leftoverReportCounts(report)));
  ipcMain.handle(IPC.LEFTOVER_PROCESSES_STOP, async (_event, processId: unknown): Promise<LeftoverStopOutcome> => {
    if (typeof processId !== 'string') return 'ended';
    const identity = leftoverProcessReports.resolve(processId);
    if (!identity) return 'ended';
    const outcome = await context.sessionManager.stopReportedProcess(identity.pid, identity.startKey);
    if (outcome !== 'failed') void retryDoneWorktreeRemoval(context, identity.projectPath, identity.taskId);
    return outcome;
  });
}
