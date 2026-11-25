import { IPC } from '../../shared/ipc-channels';
import { sendToRenderer } from '../ipc/send-to-renderer';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowEngineReporter } from './workflow-report';

/**
 * A quiet board reload for a board whose tasks a workflow wrote. Its own module
 * so the engine host can announce without importing the workflow service.
 */
export function announceBoardChange(context: IpcContext, projectId: string): void {
  try {
    context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [] });
  } catch (error) {
    // A listener that throws stops the bus there: the listeners after it (a paired
    // phone, the Agent Monitor, the engine's wake) never hear this change.
    workflowEngineReporter.report(error, { tags: { stage: 'board_listener' } });
  }
  sendToRenderer(context.mainWindow, IPC.TASK_MOVED_BY_AUTOMATION, projectId);
}
