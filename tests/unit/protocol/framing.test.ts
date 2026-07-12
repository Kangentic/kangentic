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
