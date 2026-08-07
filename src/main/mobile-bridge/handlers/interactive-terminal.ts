import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type InteractiveTerminalResponsePayload } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { armTerminalSizeGuard, releaseTerminalSizeGuard } from './terminal-size-guard';
import { toWireJson } from './wire-mappers';

/**
 * Raw PTY write-path parity ("the '! npm login while away' scenario"): the
 * phone types directly into the running session, no different from the
 * desktop terminal. This is the power write verb - explicit grant only,
 * never in the default read-only capability set.
 *
 * Three actions ride the one grant (a device trusted to type raw bytes is
 * equally trusted to resize): `write` (the default), `resize` (fit-to-phone;
 * arms a per-device guard that restores the desktop's dimensions on release,
 * disconnect, revoke, or shutdown), and `release-size` (give the grid back
 * now). Contention is latest-writer-wins: a desktop resize while a phone
 * holds simply wins and updates the guard's restore target.
 */
export function handleInteractiveTerminal(
  request: CapabilityRequestMessage,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): CapabilityResponseMessage {
  const payload = parseCapabilityRequestPayload('interactive-terminal', request.payload);

  if (!context.sessionManager.getSession(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }

  if (payload.action === 'release-size') {
    releaseTerminalSizeGuard(payload.sessionId, subscriptions);
    const responsePayload: InteractiveTerminalResponsePayload = { released: true };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
  }

  // A suspended/queued/exited session stays in the registry but has no live
  // PTY, so write() silently drops the bytes (and a resize would only stash) -
  // report that rather than a false written/resized:true.
  if (!context.sessionManager.isWritable(payload.sessionId)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `Session is not accepting input (not running): ${payload.sessionId}` };
  }

  if (payload.action === 'resize') {
    // Arm BEFORE resizing so the guard's lazy desktop-dims snapshot (taken
    // inside resize() on the first mobile-origin call) and the guard itself
    // can never be split by a mid-sequence disconnect.
    armTerminalSizeGuard(payload.sessionId, context, subscriptions);
    const { colsChanged } = context.sessionManager.resize(
      payload.sessionId,
      payload.dimensions.cols,
      payload.dimensions.rows,
      'mobile',
    );
    const responsePayload: InteractiveTerminalResponsePayload = { resized: true, colsChanged };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
  }

  // A phone typing into the terminal is the same human input as the desktop
  // keyboard, so it feeds the prompt-draft ledger identically.
  context.sessionManager.write(payload.sessionId, payload.data, 'user');

  const responsePayload: InteractiveTerminalResponsePayload = { written: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}
