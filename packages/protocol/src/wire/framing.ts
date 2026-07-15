/**
 * Encodes/decodes a BridgeMessage to/from the plaintext bytes that flow
 * into and out of secretstream.seal()/open(). Nothing above this module
 * cares about the wire encoding.
 *
 * Two self-describing frame forms (protocol v2):
 * - Raw UTF-8 JSON. Every JSON message starts with '{' (0x7B), which
 *   doubles as the format discriminant.
 * - Deflated JSON: [0x01][u32le decodedByteLength][deflate-raw bytes].
 *   encodeMessage produces this automatically when the JSON exceeds
 *   COMPRESSION_THRESHOLD bytes and deflate actually helps; transcript
 *   deltas and windowed history pages are text-heavy and typically
 *   shrink 5-10x, which is what keeps chunked pushes small and fast.
 *
 * Size-bounded on both directions - even though this content is
 * post-Noise-authentication (unlike the QR payload), a malformed or
 * oversized message from a buggy or compromised peer should fail fast
 * with a clear error rather than trigger unbounded JSON parsing or a
 * decompression bomb: the declared decoded length is validated against
 * MAX_DECODED_LENGTH before any inflation happens, inflation is capped
 * to exactly that allocation, and the result must fill it.
 */
import { deflateSync, inflateSync } from 'fflate';
import { isCapabilityVerb } from '../capabilities/verbs';
import type { BridgeEvent } from '../events/event';
import type { BridgeMessage, JsonValue } from './messages';
import { isJsonValue, isRecord } from './json-value';

export const MAX_FRAME_LENGTH = 1024 * 1024;
/** Upper bound on the JSON a compressed frame may declare/inflate to. */
export const MAX_DECODED_LENGTH = 4 * 1024 * 1024;
/** JSON below this size ships raw - deflate overhead is not worth it. */
export const COMPRESSION_THRESHOLD = 4 * 1024;

const FRAME_FORMAT_DEFLATE = 0x01;
const JSON_OPEN_BRACE = 0x7b;
const DEFLATE_HEADER_LENGTH = 5;

export function encodeMessage(message: BridgeMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  if (json.length > MAX_DECODED_LENGTH) {
    throw new Error(`Encoded bridge message exceeds ${MAX_DECODED_LENGTH} bytes before compression`);
  }
  let frame = json;
  if (json.length > COMPRESSION_THRESHOLD) {
    const compressed = deflateSync(json);
    if (compressed.length + DEFLATE_HEADER_LENGTH < json.length) {
      frame = new Uint8Array(DEFLATE_HEADER_LENGTH + compressed.length);
      frame[0] = FRAME_FORMAT_DEFLATE;
      new DataView(frame.buffer).setUint32(1, json.length, true);
      frame.set(compressed, DEFLATE_HEADER_LENGTH);
    }
  }
  if (frame.length > MAX_FRAME_LENGTH) {
    throw new Error(`Encoded bridge message exceeds ${MAX_FRAME_LENGTH} bytes`);
  }
  return frame;
}

export function decodeMessage(bytes: Uint8Array): BridgeMessage {
  if (bytes.length > MAX_FRAME_LENGTH) {
    throw new Error(`Bridge message frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }
  if (bytes.length === 0) throw new Error('Bridge message frame is empty');

  let json: Uint8Array;
  if (bytes[0] === JSON_OPEN_BRACE) {
    json = bytes;
  } else if (bytes[0] === FRAME_FORMAT_DEFLATE) {
    if (bytes.length < DEFLATE_HEADER_LENGTH + 1) throw new Error('Compressed bridge message frame is truncated');
    const declaredLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
    if (declaredLength === 0 || declaredLength > MAX_DECODED_LENGTH) {
      throw new Error(`Compressed bridge message declares an invalid decoded length: ${declaredLength}`);
    }
    // fflate stops at the preallocated `out` size, so a frame lying about
    // its decoded length cannot balloon past the declared allocation.
    json = inflateSync(bytes.subarray(DEFLATE_HEADER_LENGTH), { out: new Uint8Array(declaredLength) });
    if (json.length !== declaredLength) {
      throw new Error('Compressed bridge message decoded length does not match its declaration');
    }
  } else {
    throw new Error(`Unknown bridge message frame format: 0x${bytes[0].toString(16)}`);
  }

  const parsed: unknown = JSON.parse(new TextDecoder().decode(json));
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
