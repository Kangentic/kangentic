import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_THRESHOLD,
  decodeMessage,
  encodeMessage,
  MAX_DECODED_LENGTH,
} from '../../../packages/protocol/src/wire/framing';
import type { BridgeMessage } from '../../../packages/protocol/src/wire/messages';

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

  it('rejects a capability-request with an unknown verb', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'capability-request', requestId: 'r', verb: 'run-shell-command', payload: {} }),
    );
    expect(() => decodeMessage(bytes)).toThrow();
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
    let seed = 0x12345678;
    const randomHexChunk = (): string => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed.toString(16).padStart(8, '0');
    };
    const incompressible = Array.from({ length: (2 * 1024 * 1024) / 8 }, randomHexChunk).join('');
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
