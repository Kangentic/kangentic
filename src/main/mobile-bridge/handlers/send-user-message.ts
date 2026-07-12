import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type SendUserMessageResponsePayload } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';

export async function handleSendUserMessage(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('send-user-message', request.payload);

  if (!context.sessionManager.getSession(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }

  // The same bracketed-paste delivery path the renderer's Browser-pane
  // "Send" affordance uses, not a raw sessionManager.write - this handles
  // drain, chunked write, and submission evidence rather than a bare
  // keystroke injection.
  await context.terminalSubmit.submitContent(payload.sessionId, payload.text, { source: 'mobile-bridge' });

  const responsePayload: SendUserMessageResponsePayload = { delivered: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
