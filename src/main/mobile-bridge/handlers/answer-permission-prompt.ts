import { parseCapabilityRequestPayload, type AnswerPermissionPromptResponsePayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';
import { buildPermissionPromptId } from './permission-prompt-id';
import { notAcceptingInputRefusal, unknownSessionRefusal } from './session-refusals';

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

  const session = context.sessionManager.getSession(payload.sessionId);
  if (!session) {
    return unknownSessionRefusal(request, payload.sessionId);
  }

  // Checked before the prompt binding. An ended (suspended or exited) row has no
  // PTY, and a suspend also drops its activity state, so the binding below would
  // answer it "no prompt outstanding" with no code. This runs in the same tick
  // as the write, so a PTY a kill just nulled is still reported as a drop, never
  // as a false answered:true.
  if (!context.sessionManager.isWritable(payload.sessionId)) {
    return notAcceptingInputRefusal(request, session);
  }

  const snapshot = context.sessionManager.getActivityStatsSnapshot(payload.sessionId);
  if (!snapshot?.permissionPending || !snapshot.permissionAwaitedToolId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No permission prompt is currently outstanding for this session' };
  }

  const livePromptId = buildPermissionPromptId(payload.sessionId, snapshot.permissionAwaitedToolId);
  if (livePromptId !== payload.promptId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'promptId does not match the currently outstanding prompt (stale or already answered)' };
  }

  context.sessionManager.write(payload.sessionId, payload.keystrokes, 'user');

  const responsePayload: AnswerPermissionPromptResponsePayload = { answered: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
