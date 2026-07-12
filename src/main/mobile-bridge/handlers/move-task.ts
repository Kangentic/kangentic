import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type MoveTaskResponsePayload } from '@kangentic/protocol';
import { handleTaskMove } from '../../ipc/handlers/task-move';
import { resolveProjectContext } from '../../ipc/helpers/project-repos';
import type { IpcContext } from '../../ipc/ipc-context';

export async function handleMoveTask(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('move-task', request.payload);
  const { projectId, projectPath } = resolveProjectContext(context, payload.projectId);
  if (!projectId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${payload.projectId}` };
  }

  // handleTaskMove already wraps withTaskLock + the transition engine +
  // rollback (see task-lifecycle-lock.md). Never call
  // TaskRepository.move() directly, and never forward a continuationPrompt
  // from the wire payload - it is deliberately excluded from the raw
  // renderer-facing input shape, and a phone is no more trusted than the
  // renderer here.
  await handleTaskMove(
    context,
    { taskId: payload.taskId, targetSwimlaneId: payload.targetSwimlaneId, targetPosition: payload.targetPosition },
    projectId,
    projectPath,
  );

  const responsePayload: MoveTaskResponsePayload = { ok: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
