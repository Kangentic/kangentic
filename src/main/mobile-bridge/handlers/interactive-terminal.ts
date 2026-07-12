import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type InteractiveTerminalResponsePayload, type JsonValue } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';

/**
 * Raw PTY write-path parity ("the '! npm login while away' scenario"): the
 * phone types directly into the running session, no different from the
 * desktop terminal. This is the power write verb - explicit grant only,
 * never in the default read-only capability set.
 */
export function handleInteractiveTerminal(
  request: CapabilityRequestMessage,
  context: IpcContext,
): CapabilityResponseMessage {
  const payload = parseCapabilityRequestPayload('interactive-terminal', request.payload);

  if (!context.sessionManager.getSession(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }
  // A suspended/queued/exited session stays in the registry but has no live
  // PTY, so write() silently drops the bytes - report that rather than a
  // false written:true.
  if (!context.sessionManager.isWritable(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `Session is not accepting input (not running): ${payload.sessionId}` };
  }

  context.sessionManager.write(payload.sessionId, payload.data);

  const responsePayload: InteractiveTerminalResponsePayload = { written: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
