import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LeftoverProcessReport, LeftoverStopOutcome, LeftoverStopSettled } from '../../../shared/types';
import { trackEvent } from '../../analytics/analytics';
import { leftoverProcessReports, RETAINED_PROCESS_IDS, type ReportedIdentity } from '../helpers/leftover-process-reports';
import { retryDoneWorktreeRemoval } from '../helpers/task-cleanup';
import type { IpcContext } from '../ipc-context';
import { sendToRenderer } from '../send-to-renderer';

/** At most this many ids per recheck: as many as main keeps identities for (`RETAINED_PROCESS_IDS`). */
export const MAX_CHECKED_PROCESSES = RETAINED_PROCESS_IDS;

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
 *
 * A Stop that runs past main's budget answers `failed`, but the pty host
 * finishes it anyway. When it does, the real outcome goes to the row
 * (`LEFTOVER_PROCESSES_STOP_SETTLED`) and the removal is retried the same way,
 * so the row and the worktree catch up with nothing for the user to do.
 *
 * The list's recheck (`LEFTOVER_PROCESSES_CHECK`) names reported processes the
 * same way and answers which have ended, by pid and start key, so a row that
 * reads "still running" catches up with a process that exited on its own. An
 * ended one may have been what held its Done task's worktree, so that removal
 * is retried as after a Stop.
 */
export function registerLeftoverProcessHandlers(context: IpcContext): void {
  leftoverProcessReports.setReportListener((report) => trackEvent('leftover_processes', leftoverReportCounts(report)));
  ipcMain.handle(IPC.LEFTOVER_PROCESSES_STOP, async (_event, processId: unknown): Promise<LeftoverStopOutcome> => {
    if (typeof processId !== 'string') return 'ended';
    const identity = leftoverProcessReports.resolve(processId);
    if (!identity) return 'ended';
    const retryRemovalOnceGone = (outcome: LeftoverStopOutcome): void => {
      if (outcome !== 'failed') void retryDoneWorktreeRemoval(context, identity.projectPath, identity.taskId);
    };
    const outcome = await context.sessionManager.stopReportedProcess(identity.pid, identity.startKey, (lateOutcome) => {
      const settled: LeftoverStopSettled = { processId, outcome: lateOutcome };
      sendToRenderer(context.mainWindow, IPC.LEFTOVER_PROCESSES_STOP_SETTLED, settled);
      retryRemovalOnceGone(lateOutcome);
    });
    retryRemovalOnceGone(outcome);
    return outcome;
  });
  ipcMain.handle(IPC.LEFTOVER_PROCESSES_CHECK, async (_event, processIds: unknown): Promise<string[]> => {
    if (!Array.isArray(processIds)) return [];
    const known: Array<{ processId: string; identity: ReportedIdentity }> = [];
    for (const processId of new Set(processIds.slice(0, MAX_CHECKED_PROCESSES))) {
      if (typeof processId !== 'string') continue;
      const identity = leftoverProcessReports.resolve(processId);
      if (identity) known.push({ processId, identity });
    }
    if (known.length === 0) return [];
    const answers = await context.sessionManager.checkReportedProcesses(
      known.map(({ identity }) => ({ pid: identity.pid, startKey: identity.startKey })),
    );
    const ended = known.filter((_entry, index) => answers[index] === false);
    const retriedTasks = new Set<string>();
    for (const { identity } of ended) {
      const taskKey = `${identity.projectPath}\u0000${identity.taskId}`;
      if (retriedTasks.has(taskKey)) continue;
      retriedTasks.add(taskKey);
      void retryDoneWorktreeRemoval(context, identity.projectPath, identity.taskId);
    }
    return ended.map(({ processId }) => processId);
  });
}
