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
  //
  // The verb answers when the move COMMITS, not when it settles. The board row
  // is on disk early in handleTaskMove's Phase 1; everything slow comes after
  // it, and on a Done move (suspend, leftover reap, worktree removal) still
  // inside the same lock. The phone gives every verb 10s, and 9% of measured
  // desktop moves ran past that (slowest 24.4s), so awaiting the whole move
  // reported a move that had already landed as "Move failed" and rolled it
  // back optimistically on the phone. Answering on the commit signal gives the
  // phone the same semantics the desktop's own drag has: the row moved, the
  // machinery is finishing. The commit-time board event handleTaskMove emits
  // just before firing the signal is what the phone settles its optimistic
  // move against, and the settle-time one corrects a committed-then-rolled-back
  // move, exactly as it already does for a desktop drag.
  let committed = false;
  let signalCommitted: () => void = () => {};
  const committedSignal = new Promise<void>((resolve) => {
    signalCommitted = () => {
      committed = true;
      resolve();
    };
  });
  const settled = handleTaskMove(
    context,
    { taskId: payload.taskId, targetSwimlaneId: payload.targetSwimlaneId, targetPosition: payload.targetPosition },
    'mobile',
    projectId,
    projectPath,
    { onCommitted: signalCommitted },
  );

  // The tail of the move runs behind the response. A failure there has already
  // been rolled back and announced inside handleTaskMove; all that is left is
  // to log it and keep the rejection out of the bridge's request loop, which
  // would otherwise see it as an unhandled rejection. Attached in the SAME
  // synchronous turn as the call above, so a rejection that lands before the
  // next tick is already handled. A pre-commit failure is not logged here: the
  // race below surfaces it as the verb's own failure, and the router turns the
  // throw into the ok:false response the phone has always received for it.
  settled.catch((error: unknown) => {
    if (!committed) return;
    console.error(`[mobile-bridge] move-task ${payload.taskId.slice(0, 8)} failed after commit:`, error);
  });

  await Promise.race([committedSignal, settled]);

  const responsePayload: MoveTaskResponsePayload = { ok: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
