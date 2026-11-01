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

  console.log(describeAnsweredPrompt(context, payload.sessionId, snapshot.permissionAwaitedToolId, payload.keystrokes));
  context.sessionManager.write(payload.sessionId, payload.keystrokes, 'user');

  const responsePayload: AnswerPermissionPromptResponsePayload = { answered: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}

/**
 * The log line for a phone's answer. Task #952: a stray "1" reached two
 * agents' input right after a prompt closed. The likely cause is a phone tap on
 * a prompt the desktop already answered, which still binds while its tool runs,
 * but that is unconfirmed. So every phone answer is logged with what it typed
 * (the keys are a choice, "1" or Enter, never free text), how long the call had
 * been open, and whether someone typed into the session after it began. Those
 * lines are the evidence a fix needs; nothing is refused on a guess.
 */
function describeAnsweredPrompt(context: IpcContext, sessionId: string, awaitedToolId: string, keystrokes: string): string {
  const awaitedCall = context.sessionManager.getOpenWork(sessionId).toolCalls.find((call) => call.id === awaitedToolId);
  const typedAt = context.sessionManager.getLastUserInputAt(sessionId);
  const openFor = awaitedCall ? `, open ${Math.round((Date.now() - awaitedCall.since) / 1000)} s` : '';
  const typedSince = awaitedCall && typedAt !== null && typedAt > awaitedCall.since
    ? `; someone typed into the session ${Math.round((Date.now() - typedAt) / 1000)} s ago, after the call began`
    : '';
  return `[mobile-bridge] Phone answered the ${awaitedCall?.tool ?? 'permission'} prompt for session ${sessionId.slice(0, 8)}`
    + ` (tool ${awaitedToolId.slice(0, 12)}${openFor}): keys ${printableKeys(keystrokes)}${typedSince}`;
}

/** Keys as a log can show them: control characters named, cut short. */
function printableKeys(keystrokes: string): string {
  const shown = JSON.stringify(keystrokes.slice(0, 16));
  return keystrokes.length > 16 ? `${shown} (+${keystrokes.length - 16})` : shown;
}
