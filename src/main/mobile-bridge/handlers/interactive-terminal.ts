import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type InteractiveTerminalResponsePayload } from '@kangentic/protocol';
import type { IpcContext } from '../../ipc/ipc-context';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { notAcceptingInputRefusal, unknownSessionRefusal } from './session-refusals';
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

  const session = context.sessionManager.getSession(payload.sessionId);
  if (!session) {
    return unknownSessionRefusal(request, payload.sessionId);
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
    return notAcceptingInputRefusal(request, session);
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

  // Task #952: a stray "1" reached an agent's input overnight. A phone write
  // while a permission prompt reads open is logged, by length only: what a
  // person types into a terminal can be a password.
  const snapshot = context.sessionManager.getActivityStatsSnapshot(payload.sessionId);
  if (snapshot?.permissionPending) {
    console.log(`[mobile-bridge] Phone typed ${payload.data.length} byte(s) into session ${payload.sessionId.slice(0, 8)} while a permission prompt read open (tool ${snapshot.permissionAwaitedToolId?.slice(0, 12) ?? 'unknown'}).`);
  }

  // A phone typing into the terminal is the same human input as the desktop
  // keyboard, so it feeds the prompt-draft ledger identically.
  context.sessionManager.write(payload.sessionId, payload.data, 'user');

  const responsePayload: InteractiveTerminalResponsePayload = { written: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}
