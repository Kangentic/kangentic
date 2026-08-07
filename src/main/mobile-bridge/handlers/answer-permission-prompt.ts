import { parseCapabilityRequestPayload, type AnswerPermissionPromptResponsePayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';
import { buildPermissionPromptId } from './permission-prompt-id';

/**
 * The most sensitive verb: it can authorize the agent to run a command. The
 * phone sends raw keystrokes (no agent-specific semantics here - keeps
 * agent knowledge out of the bridge per agent-adapters-boundary.md) plus
 * the prompt id it believes is outstanding; this handler is the desktop
 * enforcement point that the response binds to a SPECIFIC live prompt,
 * rejecting a stale or already-resolved one rather than blindly forwarding
 * keystrokes (which interactive-terminal already allows for a granted
 * device - the value here is exclusively the binding check).
 */
export function handleAnswerPermissionPrompt(
  request: CapabilityRequestMessage,
  context: IpcContext,
): CapabilityResponseMessage {
  const payload = parseCapabilityRequestPayload('answer-permission-prompt', request.payload);

  if (!context.sessionManager.getSession(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }

  const snapshot = context.sessionManager.getActivityStatsSnapshot(payload.sessionId);
  if (!snapshot?.permissionPending || !snapshot.permissionAwaitedToolId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No permission prompt is currently outstanding for this session' };
  }

  const livePromptId = buildPermissionPromptId(payload.sessionId, snapshot.permissionAwaitedToolId);
  if (livePromptId !== payload.promptId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'promptId does not match the currently outstanding prompt (stale or already answered)' };
  }
  // A pending prompt on a live session implies a writable PTY; guard anyway so
  // a race that nulled the pty reports the drop instead of a false answered:true.
  if (!context.sessionManager.isWritable(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `Session is not accepting input (not running): ${payload.sessionId}` };
  }

  context.sessionManager.write(payload.sessionId, payload.keystrokes, 'user');

  const responsePayload: AnswerPermissionPromptResponsePayload = { answered: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
