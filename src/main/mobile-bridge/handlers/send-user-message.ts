import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type SendUserMessageResponsePayload } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';
import { holdTaskMessage } from '../../held-messages/held-messages';
import { notAcceptingInputRefusal, unknownSessionRefusal } from './session-refusals';

function deliveredResponse(request: CapabilityRequestMessage): CapabilityResponseMessage {
  const responsePayload: SendUserMessageResponsePayload = { delivered: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}

export async function handleSendUserMessage(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('send-user-message', request.payload);

  const session = context.sessionManager.getSession(payload.sessionId);
  if (!session) {
    return unknownSessionRefusal(request, payload.sessionId);
  }

  // A suspended/queued/exited session stays in the registry with no PTY. The
  // paste below would drop every byte and fail on its evidence wait about 6 s
  // later, so it is never tried. A task's session holds the message for the
  // task's next agent instead, as the MCP send tool does: the phone's chat to
  // a paused task reaches the agent that resumes it. A Command Terminal or a
  // workflow's own agent (transient) has no task to hold it for.
  if (!context.sessionManager.isWritable(payload.sessionId)) {
    if (session.transient || !session.taskId || !session.projectId) {
      return notAcceptingInputRefusal(request, session);
    }
    // No caller ids: a person sent it, as from the desktop.
    const held = holdTaskMessage(context, { projectId: session.projectId, taskId: session.taskId, message: payload.text });
    if (held.status === 'refused') {
      // The refusal's code is unchanged, since phones branch on it; the
      // reason says why nothing was held (a task in Done, a message too long).
      return { ...notAcceptingInputRefusal(request, session), error: held.error };
    }
    return deliveredResponse(request);
  }

  // The same bracketed-paste delivery path the renderer's Browser-pane
  // "Send" affordance uses, not a raw sessionManager.write - this handles
  // drain, chunked write, and submission evidence rather than a bare
  // keystroke injection.
  await context.terminalSubmit.submitContent(payload.sessionId, payload.text, { source: 'mobile-bridge' });

  return deliveredResponse(request);
}
