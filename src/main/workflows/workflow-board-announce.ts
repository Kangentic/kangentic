import { IPC } from '../../shared/ipc-channels';
import { sendToRenderer } from '../ipc/send-to-renderer';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * A quiet board reload for a board whose tasks a workflow wrote. Its own module
 * so the engine host can announce without importing the workflow service.
 */
export function announceBoardChange(context: IpcContext, projectId: string): void {
  try {
    context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [] });
  } catch {
    // Announcing is best effort.
  }
  sendToRenderer(context.mainWindow, IPC.TASK_MOVED_BY_AUTOMATION, projectId);
}
