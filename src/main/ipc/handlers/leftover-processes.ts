import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LeftoverStopOutcome } from '../../../shared/types';
import { leftoverProcessReports } from '../helpers/leftover-process-reports';
import { retryDoneWorktreeRemoval } from '../helpers/task-cleanup';
import type { IpcContext } from '../ipc-context';

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
  ipcMain.handle(IPC.LEFTOVER_PROCESSES_STOP, async (_event, processId: unknown): Promise<LeftoverStopOutcome> => {
    if (typeof processId !== 'string') return 'ended';
    const identity = leftoverProcessReports.resolve(processId);
    if (!identity) return 'ended';
    const outcome = await context.sessionManager.stopReportedProcess(identity.pid, identity.startKey);
    if (outcome !== 'failed') void retryDoneWorktreeRemoval(context, identity.projectPath, identity.taskId);
    return outcome;
  });
}
