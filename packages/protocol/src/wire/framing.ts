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
import { isJsonValue, isRecord } from './json-value';

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

/**
 * Per-kind event validation. Each kind has a different required key set
 * (transcript/activity/terminal are session-scoped, board is project-scoped
 * with an optional task, diff is task-scoped) - there is no single field
 * (e.g. a universal "taskId") every event kind carries, so this cannot be a
 * single shared check.
 */
function validateEvent(event: Record<string, unknown>): BridgeEvent {
  if (typeof event.kind !== 'string') throw new Error('event message missing a valid "kind"');
  if (!isJsonValue(event.payload)) throw new Error('event payload is not JSON-serializable');

  switch (event.kind) {
    case 'transcript':
    case 'activity':
    case 'terminal': {
      if (typeof event.sessionId !== 'string') throw new Error(`"${event.kind}" event is missing "sessionId"`);
      if (typeof event.taskId !== 'string') throw new Error(`"${event.kind}" event is missing "taskId"`);
      return event as unknown as BridgeEvent;
    }
    case 'board': {
      if (typeof event.projectId !== 'string') throw new Error('"board" event is missing "projectId"');
      if (event.taskId !== undefined && typeof event.taskId !== 'string') throw new Error('"board" event has a non-string "taskId"');
      return event as unknown as BridgeEvent;
    }
    case 'diff': {
      if (typeof event.taskId !== 'string') throw new Error('"diff" event is missing "taskId"');
      return event as unknown as BridgeEvent;
    }
    default:
      throw new Error(`event message has an unknown event kind: ${event.kind}`);
  }
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
      if (!isRecord(value.event)) throw new Error('event message missing a valid "event"');
      return { type: 'event', event: validateEvent(value.event) };
    }

    default:
      throw new Error(`Unknown bridge message type: ${value.type}`);
  }
}
