/**
 * Encodes/decodes a BridgeMessage to/from the plaintext bytes that flow
 * into and out of secretstream.seal()/open(). JSON for Phase 1 simplicity;
 * nothing above this module cares about the wire encoding, so a future
 * phase can switch to a binary format without touching callers.
 *
 * Size-bounded on both directions - even though this content is
 * post-Noise-authentication (unlike the QR payload), a malformed or
 * oversized message from a buggy or compromised peer should fail fast
 * with a clear error rather than trigger unbounded JSON parsing.
 */
import { isCapabilityVerb } from '../capabilities/verbs';
import type { BridgeEvent } from '../events/event';
import type { BridgeMessage, JsonValue } from './messages';

export const MAX_FRAME_LENGTH = 1024 * 1024;

export function encodeMessage(message: BridgeMessage): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  if (bytes.length > MAX_FRAME_LENGTH) {
    throw new Error(`Encoded bridge message exceeds ${MAX_FRAME_LENGTH} bytes`);
  }
  return bytes;
}

export function decodeMessage(bytes: Uint8Array): BridgeMessage {
  if (bytes.length > MAX_FRAME_LENGTH) {
    throw new Error(`Bridge message frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return validateBridgeMessage(parsed);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'boolean' || t === 'number' || t === 'string') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (t === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateBridgeMessage(value: unknown): BridgeMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid bridge message: missing "type"');
  }

  switch (value.type) {
    case 'heartbeat':
      return { type: 'heartbeat' };

    case 'capability-request': {
      if (typeof value.requestId !== 'string') throw new Error('capability-request missing "requestId"');
      if (typeof value.verb !== 'string' || !isCapabilityVerb(value.verb)) throw new Error('capability-request has an invalid "verb"');
      if (!isJsonValue(value.payload)) throw new Error('capability-request has a non-JSON "payload"');
      return { type: 'capability-request', requestId: value.requestId, verb: value.verb, payload: value.payload };
    }

    case 'capability-response': {
      if (typeof value.requestId !== 'string') throw new Error('capability-response missing "requestId"');
      if (typeof value.ok !== 'boolean') throw new Error('capability-response missing "ok"');
      if (value.payload !== undefined && !isJsonValue(value.payload)) throw new Error('capability-response has a non-JSON "payload"');
      if (value.error !== undefined && typeof value.error !== 'string') throw new Error('capability-response has a non-string "error"');
      return {
        type: 'capability-response',
        requestId: value.requestId,
        ok: value.ok,
        payload: value.payload as JsonValue | undefined,
        error: value.error as string | undefined,
      };
    }

    case 'event': {
      const event = value.event;
      if (!isRecord(event) || typeof event.kind !== 'string') {
        throw new Error('event message missing a valid "event"');
      }
      if (typeof event.taskId !== 'string') throw new Error('event is missing "taskId"');
      if (!isJsonValue(event.payload)) throw new Error('event payload is not JSON-serializable');
      if (event.kind === 'transcript' || event.kind === 'activity') {
        if (typeof event.sessionId !== 'string') throw new Error(`"${event.kind}" event is missing "sessionId"`);
      } else if (event.kind !== 'board') {
        throw new Error(`event message has an unknown event kind: ${event.kind}`);
      }
      return { type: 'event', event: event as unknown as BridgeEvent };
    }

    default:
      throw new Error(`Unknown bridge message type: ${value.type}`);
  }
}
