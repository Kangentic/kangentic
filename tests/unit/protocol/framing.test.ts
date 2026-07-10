import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '../../../packages/protocol/src/wire/framing';
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

  it('round-trips a board event message', () => {
    const message: BridgeMessage = {
      type: 'event',
      event: { kind: 'board', taskId: 'abc', payload: { column: 'Done' } },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
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

  it('rejects an oversized frame', () => {
    const huge: BridgeMessage = {
      type: 'capability-request',
      requestId: 'r',
      verb: 'send-user-message',
      payload: { text: 'x'.repeat(2 * 1024 * 1024) },
    };
    expect(() => encodeMessage(huge)).toThrow();
  });
});
