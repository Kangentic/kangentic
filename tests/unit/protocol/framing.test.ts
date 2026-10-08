import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_THRESHOLD,
  decodeMessage,
  encodeMessage,
  encodeMessageFailure,
  isUnsupportedVerbError,
  MAX_DECODED_LENGTH,
  MAX_FRAME_LENGTH,
  RESPONSE_TOO_LARGE_ERROR_CODE,
  UNSUPPORTED_VERB_ERROR_CODE,
  UnsupportedVerbError,
} from '../../../packages/protocol/src/wire/framing';
import type { BridgeMessage } from '../../../packages/protocol/src/wire/messages';
// The rest of this file deliberately reaches into wire/framing directly so a
// throw's concrete shape can be asserted without the package's public
// barrel in the way. isUnsupportedVerbError and UNSUPPORTED_VERB_ERROR_CODE
// are ALSO consumed through the '@kangentic/protocol' alias by production
// code (bridge-session.ts) and so are already proven re-exported end to end
// by bridge-session.test.ts - but UnsupportedVerbError (the class) has no
// such consumer, so nothing catches it dropping out of
// packages/protocol/src/index.ts's barrel re-export. Confirmed by removing
// it from that export list: every other unit suite stayed green.
import { UnsupportedVerbError as UnsupportedVerbErrorFromEntry, encodeMessageFailure as encodeMessageFailureFromEntry } from '@kangentic/protocol';

/** Pseudo-random hex from a fixed seed: barely compressible, and the same bytes on every run. */
function seededHexText(length: number): string {
  let seed = 0x12345678;
  const randomHexChunk = (): string => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed.toString(16).padStart(8, '0');
  };
  return Array.from({ length: Math.ceil(length / 8) }, randomHexChunk).join('').slice(0, length);
}

/**
 * Pseudo-random CJK ideographs (U+4E00 to U+9FFF) from a fixed seed: each is one
 * UTF-16 code unit but three UTF-8 bytes, no surrogates, nothing JSON escapes,
 * and barely compressible. The same text on every run.
 */
function seededCjkText(length: number): string {
  const firstCodePoint = 0x4e00;
  const codePointCount = 0x9fff - firstCodePoint + 1;
  let seed = 0x9e3779b9;
  const codeUnits = new Uint16Array(length);
  for (let index = 0; index < length; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    codeUnits[index] = firstCodePoint + ((seed >>> 8) % codePointCount);
  }
  return new TextDecoder('utf-16le').decode(codeUnits);
}

/** The thrown value of a decode that is expected to fail. */
function decodeFailure(bytes: Uint8Array): unknown {
  try {
    decodeMessage(bytes);
  } catch (error) {
    return error;
  }
  throw new Error('decodeMessage was expected to throw');
}

function rawJsonFrame(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('wire message framing', () => {
  it('round-trips a heartbeat message', () => {
    const message: BridgeMessage = { type: 'heartbeat' };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('round-trips a capability-request message', () => {
    const message: BridgeMessage = {
      type: 'capability-request',
      requestId: 'req-1',
      verb: 'move-task',
      payload: { taskId: 'abc', toColumnId: 'def' },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('round-trips a capability-response message', () => {
    const message: BridgeMessage = {
      type: 'capability-response',
      requestId: 'req-1',
      ok: false,
      error: 'not authorized',
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('round-trips a board event message with a taskId', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'board', projectId: 'proj-1', taskId: 'abc', payload: { change: 'task-updated', ids: ['abc'] } },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('round-trips a board event message with no taskId (e.g. a swimlane or backlog change)', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'board', projectId: 'proj-1', payload: { change: 'backlog-changed', ids: [] } },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a board event missing projectId', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'event', event: { kind: 'board', taskId: 'abc', payload: { change: 'task-updated', ids: ['abc'] } } }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('round-trips a terminal event message', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: 'hello\r\n' } },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a terminal event missing taskId', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'event', event: { kind: 'terminal', sessionId: 'sess-1', payload: { data: 'x' } } }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('round-trips a terminal-resize event message', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 48, rows: 26 } },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a terminal-resize event missing sessionId', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'event', event: { kind: 'terminal-resize', taskId: 'task-1', payload: { cols: 48, rows: 26 } } }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('round-trips a diff event message', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'diff', taskId: 'task-1', payload: null },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a diff event missing taskId', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'event', event: { kind: 'diff', payload: null } }));
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('round-trips an activity event with a discriminated permission payload', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: {
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'permission', promptId: 'sess-1:tool-9', pending: true },
      },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('decodes an activity event whose payload type this build does not know, leaving the drop to isBridgeEvent', () => {
    // Why a new live signal ships as an activity payload TYPE rather than a
    // new event KIND: framing checks only the activity envelope, so an older
    // phone still decodes the frame and drops the one event, while an unknown
    // KIND (below) fails the whole decode.
    const bytes = rawJsonFrame({
      type: 'event',
      event: { kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'some-future-signal', value: 1 } },
    });
    const decoded = decodeMessage(bytes);
    expect(decoded.type).toBe('event');
  });

  it('rejects an unknown event kind', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'event', event: { kind: 'shell-output', taskId: 'abc', payload: {} } }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('rejects an unknown message type', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'not-a-real-type' }));
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('rejects a capability-request with an unknown verb, naming the request so the receiver can answer it', () => {
    // A bare toThrow() stayed green while checking nothing: the point of the
    // typed error is that it carries the envelope a refusal needs.
    const error = decodeFailure(
      rawJsonFrame({ type: 'capability-request', requestId: 'r', verb: 'run-shell-command', payload: {} }),
    );
    expect(isUnsupportedVerbError(error)).toBe(true);
    expect(error).toBeInstanceOf(UnsupportedVerbError);
    expect(error).toMatchObject({ requestId: 'r', verb: 'run-shell-command' });
  });

  it('still rejects a malformed request with an unknown verb as a plain, unanswerable error', () => {
    // Only a WELL-FORMED request earns the typed error. Each of these is one
    // envelope field away from it, and each stays a silent rejection: there is
    // no request to answer, and replying to unstructured input hands whoever
    // sent it a probe.
    const missingRequestId = decodeFailure(
      rawJsonFrame({ type: 'capability-request', verb: 'run-shell-command', payload: {} }),
    );
    expect(missingRequestId).toBeInstanceOf(Error);
    expect(isUnsupportedVerbError(missingRequestId)).toBe(false);

    const nonStringVerb = decodeFailure(
      rawJsonFrame({ type: 'capability-request', requestId: 'r', verb: 42, payload: {} }),
    );
    expect(isUnsupportedVerbError(nonStringVerb)).toBe(false);

    const nonJsonPayload = decodeFailure(
      rawJsonFrame({ type: 'capability-request', requestId: 'r', verb: 'run-shell-command' }),
    );
    expect(isUnsupportedVerbError(nonJsonPayload)).toBe(false);
  });

  it('isUnsupportedVerbError keys on the error name and fields, not the class identity', () => {
    // The mobile app resolves the published dist while the desktop consumes
    // source, so a bundler can hold two copies of the class. A structurally
    // identical error from "the other copy" must still be recognized.
    const foreignCopy = Object.assign(new Error('from another bundle'), {
      name: 'UnsupportedVerbError',
      requestId: 'r-2',
      verb: 'time-travel',
    });
    expect(isUnsupportedVerbError(foreignCopy)).toBe(true);
    expect(isUnsupportedVerbError(new Error('UnsupportedVerbError'))).toBe(false);
    expect(isUnsupportedVerbError(Object.assign(new Error('x'), { name: 'UnsupportedVerbError' }))).toBe(false);
  });

  it('re-exports UnsupportedVerbError through the public @kangentic/protocol entry point, not only wire/framing', () => {
    // isUnsupportedVerbError and UNSUPPORTED_VERB_ERROR_CODE both have a real
    // consumer that imports them through the '@kangentic/protocol' alias
    // (bridge-session.ts), so a dropped re-export of either already fails
    // bridge-session.test.ts. The class itself has no such consumer - nothing
    // in src/ imports UnsupportedVerbError by name through the alias - so it
    // is the one name in the barrel's `export { ... } from './wire/framing'`
    // whose presence in packages/protocol/src/index.ts had no test at all.
    // Red on that export dropped from index.ts: the entry-point import above
    // resolves to undefined, and this identity check fails.
    expect(UnsupportedVerbErrorFromEntry).toBe(UnsupportedVerbError);
  });

  it.each([
    ['unsupported-verb', 'Unsupported verb: time-travel', UNSUPPORTED_VERB_ERROR_CODE],
    ['response-too-large', 'Response too large to send', RESPONSE_TOO_LARGE_ERROR_CODE],
  ] as const)('round-trips a capability-response carrying the %s error code', (_label, error, code) => {
    const message: BridgeMessage = { type: 'capability-response', requestId: 'req-1', ok: false, error, code };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('decodes a capability-response with no code as code undefined (an older peer sent it)', () => {
    const decoded = decodeMessage(
      rawJsonFrame({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'not authorized' }),
    );
    expect(decoded).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'not authorized' });
    expect((decoded as { code?: unknown }).code).toBeUndefined();
  });

  it('keeps a code this build does not know, rather than failing the whole response', () => {
    // The union is the sender-side contract; a newer peer's code must not cost
    // an older peer the `error` text it can still show.
    const decoded = decodeMessage(
      rawJsonFrame({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'nope', code: 'from-the-future' }),
    );
    expect(decoded).toMatchObject({ ok: false, error: 'nope', code: 'from-the-future' });
  });

  it('rejects a capability-response with a non-string code', () => {
    expect(() => decodeMessage(
      rawJsonFrame({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'nope', code: 7 }),
    )).toThrow(/non-string "code"/);
  });

  it('rejects a transcript event missing sessionId', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'event', event: { kind: 'transcript', taskId: 'abc', payload: {} } }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeMessage(new TextEncoder().encode('{not json'))).toThrow();
  });

  it('keeps small messages as raw self-describing JSON frames', () => {
    const frame = encodeMessage({ type: 'heartbeat' });
    expect(frame[0]).toBe('{'.charCodeAt(0));
    expect(frame.length).toBeLessThan(COMPRESSION_THRESHOLD);
  });

  it('deflates a large compressible message and round-trips it', () => {
    const message: BridgeMessage = {
      type: 'capability-response',
      requestId: 'req-1',
      ok: true,
      payload: { text: 'streamed transcript content '.repeat(4096) },
    };
    const frame = encodeMessage(message);
    expect(frame[0]).toBe(0x01);
    expect(frame.length).toBeLessThan(JSON.stringify(message).length / 4);
    expect(decodeMessage(frame)).toEqual(message);
  });

  it('rejects a message whose JSON exceeds the decoded-length cap even when compressible', () => {
    const huge: BridgeMessage = {
      type: 'capability-request',
      requestId: 'r',
      verb: 'send-user-message',
      payload: { text: 'x'.repeat(MAX_DECODED_LENGTH + 1024) },
    };
    expect(() => encodeMessage(huge)).toThrow(/before compression/);
  });

  it('rejects an incompressible frame above the wire cap', () => {
    // Pseudo-random hex compresses barely at all, so the deflated frame
    // still exceeds MAX_FRAME_LENGTH and the encode must throw.
    const incompressible = seededHexText(2 * 1024 * 1024);
    const huge: BridgeMessage = {
      type: 'capability-request',
      requestId: 'r',
      verb: 'send-user-message',
      payload: { text: incompressible },
    };
    expect(() => encodeMessage(huge)).toThrow(/exceeds/);
  });

  it('rejects a compressed frame declaring an oversized decoded length', () => {
    const frame = encodeMessage({
      type: 'capability-response',
      requestId: 'req-1',
      ok: true,
      payload: { text: 'compress me '.repeat(2048) },
    });
    expect(frame[0]).toBe(0x01);
    const tampered = frame.slice();
    new DataView(tampered.buffer).setUint32(1, MAX_DECODED_LENGTH + 1, true);
    expect(() => decodeMessage(tampered)).toThrow(/invalid decoded length/);
  });

  it('rejects a compressed frame whose declared length does not match its content', () => {
    const frame = encodeMessage({
      type: 'capability-response',
      requestId: 'req-1',
      ok: true,
      payload: { text: 'compress me '.repeat(2048) },
    });
    expect(frame[0]).toBe(0x01);
    const tampered = frame.slice();
    const declared = new DataView(tampered.buffer).getUint32(1, true);
    new DataView(tampered.buffer).setUint32(1, declared + 7, true);
    expect(() => decodeMessage(tampered)).toThrow();
  });

  it('rejects an unknown frame format byte and an empty frame', () => {
    expect(() => decodeMessage(new Uint8Array([0x7f, 1, 2, 3]))).toThrow(/Unknown bridge message frame format/);
    expect(() => decodeMessage(new Uint8Array(0))).toThrow(/empty/);
  });
});

/**
 * A sender that checks a message before committing side effects (read-stream
 * refuses an over-cap seed before it subscribes) must reach the same verdict
 * encodeMessage would, or it either refuses a message that would have gone
 * out or commits for one that will not.
 */
describe('encodeMessageFailure', () => {
  function responseCarrying(text: string): BridgeMessage {
    return { type: 'capability-response', requestId: 'req-1', ok: true, payload: { scrollback: text } };
  }

  /** What encodeMessage itself throws for this message, or null when it encodes. */
  function encodeMessageVerdict(message: BridgeMessage): string | null {
    try {
      encodeMessage(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each([
    ['a message under 1 MiB of raw JSON fits', () => responseCarrying('x'.repeat(512 * 1024)), false],
    ['a compressible 2 MiB message fits through deflate', () => responseCarrying('x'.repeat(2 * 1024 * 1024)), false],
    ['an incompressible 2 MiB message fails the 1 MiB compressed cap', () => responseCarrying(seededHexText(2 * 1024 * 1024)), true],
    ['a message over 4 MiB fails the decoded cap', () => responseCarrying('x'.repeat(4.5 * 1024 * 1024)), true],
  ])('%s, matching encodeMessage', (_label, makeMessage, shouldFail) => {
    const message = makeMessage();
    const failure = encodeMessageFailure(message);

    expect(failure).toBe(encodeMessageVerdict(message));
    expect(failure !== null).toBe(shouldFail);
  });

  it('measures UTF-8 bytes, not UTF-16 characters, when deciding a message cannot fit', () => {
    // 800k CJK characters: JSON text under 1 MiB in JS string length, but
    // about 2.4 MB of UTF-8 (3 bytes each), under the 4 MiB decoded cap. Random
    // BMP characters hold about 14 bits of entropy each, so deflate leaves it
    // near 1.7 MB and encodeMessage must throw the compressed-cap error. A
    // fast path that compared the string length would call this message fine.
    const message = responseCarrying(seededCjkText(800_000));
    const characterLength = JSON.stringify(message).length;
    const byteLength = new TextEncoder().encode(JSON.stringify(message)).length;
    expect(characterLength).toBeLessThanOrEqual(MAX_FRAME_LENGTH);
    expect(byteLength).toBeGreaterThan(MAX_FRAME_LENGTH);
    expect(byteLength).toBeLessThan(MAX_DECODED_LENGTH);

    const failure = encodeMessageFailure(message);

    expect(failure).toBe(`Encoded bridge message exceeds ${MAX_FRAME_LENGTH} bytes`);
    expect(failure).toBe(encodeMessageVerdict(message));
  });

  it('is reachable through the public @kangentic/protocol entry point', () => {
    expect(encodeMessageFailureFromEntry).toBe(encodeMessageFailure);
  });
});
