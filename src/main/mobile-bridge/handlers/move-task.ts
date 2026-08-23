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
  //
  // The 'mobile' origin is what makes the desktop board and every other paired
  // phone hear about this move. It stays a plain argument rather than a
  // fan-out block here: this handler is a thin verb wrapper, and putting the
  // notifications at the call site is exactly how this path came to be silent.
  await handleTaskMove(
    context,
    { taskId: payload.taskId, targetSwimlaneId: payload.targetSwimlaneId, targetPosition: payload.targetPosition },
    'mobile',
    projectId,
    projectPath,
  );

  const responsePayload: MoveTaskResponsePayload = { ok: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
