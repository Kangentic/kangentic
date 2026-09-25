/**
 * The application-level message shapes carried inside secretstream frames
 * once a bridge session is established (crypto/secretstream.ts handles
 * the encrypted framing; this is what gets encoded/decoded as the
 * plaintext payload - see framing.ts).
 *
 * Phase 1 wires the transport and the message ENVELOPE, not real
 * capability-verb handlers or event feeds - those are Phase 2 (data
 * feeds, interactive control) and Phase 3 (notifications). `payload` on
 * the request/response/event variants is intentionally a generic JSON
 * value here rather than a fully-typed union per verb/event, since the
 * real shapes depend on desktop internals (SessionManager, repositories,
 * DiffService) that Phase 2 integrates with; over-specifying them now
 * would just be guessing. The capability verb ENUM itself
 * (capabilities/verbs.ts) and the event type skeleton (events/) are
 * final for Phase 1; only their payload contents are deferred.
 */
import type { CapabilityVerb } from '../capabilities/verbs';
import type { BridgeEvent } from '../events/event';

/** JSON-serializable value - deliberately not `any`; every message payload must round-trip through JSON.stringify/parse. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export interface CapabilityRequestMessage {
  type: 'capability-request';
  requestId: string;
  verb: CapabilityVerb;
  payload: JsonValue;
}

/**
 * A stable key a client can branch on, beside the human-readable `error`.
 * Today the one member is the refusal a desktop sends for a verb its build
 * does not know (see `UnsupportedVerbError` in framing.ts), so a newer phone
 * can tell "desktop is old" from "desktop is unreachable" and show the right
 * copy. A union rather than a bare string so a second code is a deliberate
 * addition here, not a typo at a call site.
 */
export type CapabilityErrorCode = 'unsupported-verb';

export interface CapabilityResponseMessage {
  type: 'capability-response';
  requestId: string;
  ok: boolean;
  payload?: JsonValue;
  /** Present only when ok is false. */
  error?: string;
  /**
   * Present only when ok is false AND the refusal has a stable key. Additive
   * on the wire: a peer whose decoder predates the field rebuilds the message
   * from the keys it knows and keeps `error`, so the text still shows.
   */
  code?: CapabilityErrorCode;
}

export interface EventMessage {
  type: 'event';
  event: BridgeEvent;
}

export type BridgeMessage = HeartbeatMessage | CapabilityRequestMessage | CapabilityResponseMessage | EventMessage;
