import type { BridgeEvent } from '@kangentic/protocol';
import type { BridgeSession } from '../session/bridge-session';

/** `encodeMessage`'s two size-cap throws (packages/protocol/src/wire/framing.ts) both start
 *  with this prefix; every other `sendMessage` failure (session torn down mid-send, transport
 *  disconnected) is routine and must stay silent. */
const ENCODE_SIZE_ERROR_PREFIX = 'Encoded bridge message exceeds';

/**
 * Pushes one BridgeEvent to a device, silently dropping it if the session
 * is not established. `isEstablished` is only false before the first Noise
 * handshake completes or after the session is torn down; a routine ~2-minute
 * re-handshake (bridge-session.ts) keeps the existing secretstream until the
 * new one is derived, so it does NOT drop events. A dropped event is not
 * recovered - there is no 'established' re-push, so the phone catches up by
 * re-issuing its read-* requests (each of which returns a fresh snapshot),
 * not by this side replaying missed deltas. `BridgeSession.sendMessage` also
 * throws once torn down; the try/catch keeps a transient send failure from
 * escaping an event-listener callback.
 *
 * An oversize frame is the one failure worth surfacing: it is not transient
 * (retrying sends the same over-budget payload again) and, unlike a torn-down
 * session, the phone has no other signal that this event was dropped.
 */
export function sendEvent(session: BridgeSession, event: BridgeEvent): void {
  if (!session.isEstablished) return;
  try {
    session.sendMessage({ type: 'event', event });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(ENCODE_SIZE_ERROR_PREFIX)) {
      console.warn(`[mobile-bridge/send-event] dropped oversize ${event.kind} event:`, error.message);
    }
  }
}
