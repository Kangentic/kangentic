import type { BridgeEvent } from '@kangentic/protocol';
import type { BridgeSession } from '../session/bridge-session';

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
 */
export function sendEvent(session: BridgeSession, event: BridgeEvent): void {
  if (!session.isEstablished) return;
  try {
    session.sendMessage({ type: 'event', event });
  } catch {
    // Best-effort push; a transient send failure should not throw out of
    // an event listener callback.
  }
}
