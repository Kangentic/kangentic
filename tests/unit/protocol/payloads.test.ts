/**
 * parseCapabilityRequestPayload() is the runtime trust boundary for every
 * field a phone-originated capability-request supplies: framing.ts only
 * confirms the envelope's payload is SOME JSON value, so a handler must
 * still narrow it to its verb's concrete shape before trusting a field.
 * These tests cover the missing-field / wrong-type / unknown-verb cases for
 * every verb.
 */
import { describe, expect, it } from 'vitest';
import { parseCapabilityRequestPayload } from '../../../packages/protocol/src/wire/payloads';
import type { JsonValue } from '../../../packages/protocol/src/wire/messages';
import type { CapabilityVerb } from '../../../packages/protocol/src/capabilities/verbs';

describe('parseCapabilityRequestPayload', () => {
  it('read-stream: parses a valid subscribe payload', () => {
    const parsed = parseCapabilityRequestPayload('read-stream', { sessionId: 'sess-1', action: 'subscribe' });
    expect(parsed).toEqual({ sessionId: 'sess-1', action: 'subscribe' });
  });

  it('read-stream: rejects a missing sessionId', () => {
    expect(() => parseCapabilityRequestPayload('read-stream', { action: 'subscribe' })).toThrow(/sessionId/);
  });

  it('read-stream: rejects an invalid action', () => {
    expect(() => parseCapabilityRequestPayload('read-stream', { sessionId: 'sess-1', action: 'watch' })).toThrow(/action/);
  });

  it('read-board: allows an omitted projectId', () => {
    const parsed = parseCapabilityRequestPayload('read-board', {});
    expect(parsed).toEqual({ projectId: undefined, action: undefined });
  });

  it('read-board: rejects a non-string projectId', () => {
    expect(() => parseCapabilityRequestPayload('read-board', { projectId: 42 })).toThrow(/projectId/);
  });

  it('read-board: parses an unsubscribe action', () => {
    const parsed = parseCapabilityRequestPayload('read-board', { projectId: 'p-1', action: 'unsubscribe' });
    expect(parsed).toEqual({ projectId: 'p-1', action: 'unsubscribe' });
  });

  it('read-board: rejects an invalid action', () => {
    expect(() => parseCapabilityRequestPayload('read-board', { action: 'watch' })).toThrow(/action/);
  });

  it('read-diff: parses a minimal valid payload', () => {
    const parsed = parseCapabilityRequestPayload('read-diff', { taskId: 't-1', projectId: 'p-1' });
    expect(parsed).toEqual({ taskId: 't-1', projectId: 'p-1', filePath: undefined, scope: undefined, action: undefined });
  });

  it('read-diff: parses an unsubscribe action', () => {
    const parsed = parseCapabilityRequestPayload('read-diff', { taskId: 't-1', projectId: 'p-1', action: 'unsubscribe' });
    expect(parsed).toEqual({ taskId: 't-1', projectId: 'p-1', filePath: undefined, scope: undefined, action: 'unsubscribe' });
  });

  it('read-diff: rejects an invalid action', () => {
    expect(() => parseCapabilityRequestPayload('read-diff', { taskId: 't-1', projectId: 'p-1', action: 'watch' })).toThrow(/action/);
  });

  it('read-diff: rejects an invalid scope', () => {
    expect(() =>
      parseCapabilityRequestPayload('read-diff', { taskId: 't-1', projectId: 'p-1', scope: 'everything' }),
    ).toThrow(/scope/);
  });

  it('read-diff: rejects a missing taskId', () => {
    expect(() => parseCapabilityRequestPayload('read-diff', { projectId: 'p-1' })).toThrow(/taskId/);
  });

  it('send-user-message: rejects a missing text', () => {
    expect(() => parseCapabilityRequestPayload('send-user-message', { sessionId: 'sess-1' })).toThrow(/text/);
  });

  it('move-task: rejects a non-number targetPosition', () => {
    expect(() =>
      parseCapabilityRequestPayload('move-task', {
        taskId: 't-1',
        targetSwimlaneId: 'lane-1',
        targetPosition: '0',
        projectId: 'p-1',
      }),
    ).toThrow(/targetPosition/);
  });

  it('move-task: parses a valid payload', () => {
    const parsed = parseCapabilityRequestPayload('move-task', {
      taskId: 't-1',
      targetSwimlaneId: 'lane-1',
      targetPosition: 2,
      projectId: 'p-1',
    });
    expect(parsed).toEqual({ taskId: 't-1', targetSwimlaneId: 'lane-1', targetPosition: 2, projectId: 'p-1' });
  });

  it('answer-permission-prompt: rejects a missing promptId', () => {
    expect(() =>
      parseCapabilityRequestPayload('answer-permission-prompt', { sessionId: 'sess-1', keystrokes: '1\r' }),
    ).toThrow(/promptId/);
  });

  it('answer-permission-prompt: parses a valid payload', () => {
    const parsed = parseCapabilityRequestPayload('answer-permission-prompt', {
      sessionId: 'sess-1',
      promptId: 'sess-1:tool-9',
      keystrokes: '1\r',
    });
    expect(parsed).toEqual({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1\r' });
  });

  it('interactive-terminal: rejects a missing data field', () => {
    expect(() => parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1' })).toThrow(/data/);
  });

  it('interactive-terminal: an action-less payload (every pre-0.4.0 phone) normalizes to a write', () => {
    const parsed = parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1', data: 'ls\r' });
    expect(parsed).toEqual({ sessionId: 'sess-1', action: 'write', data: 'ls\r' });
  });

  it('interactive-terminal: parses resize and release-size actions', () => {
    expect(parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } })).toEqual({
      sessionId: 'sess-1',
      action: 'resize',
      dimensions: { cols: 48, rows: 26 },
    });
    expect(parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1', action: 'release-size' })).toEqual({
      sessionId: 'sess-1',
      action: 'release-size',
    });
    expect(() => parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1', action: 'resize', dimensions: { cols: 1, rows: 26 } })).toThrow(/cols/);
    expect(() => parseCapabilityRequestPayload('interactive-terminal', { sessionId: 'sess-1', action: 'detach' })).toThrow(/action/);
  });

  it('board-tool-read: rejects a missing tool', () => {
    expect(() => parseCapabilityRequestPayload('board-tool-read', { params: {} })).toThrow(/tool/);
  });

  it('board-tool-read: parses a valid payload (tool is an internal commandHandlers key, not an MCP tool name)', () => {
    const parsed = parseCapabilityRequestPayload('board-tool-read', { tool: 'search_tasks', params: { query: 'flaky test' } });
    expect(parsed).toEqual({ tool: 'search_tasks', params: { query: 'flaky test' } });
  });

  it('board-tool-write: shares the same shape as board-tool-read', () => {
    const parsed = parseCapabilityRequestPayload('board-tool-write', { tool: 'update_task', params: {} });
    expect(parsed).toEqual({ tool: 'update_task', params: {} });
  });

  it('register-push: parses a valid register payload', () => {
    const pushKeyBase64 = 'A'.repeat(43); // 43 base64url chars decode to 32 bytes with 2 spare bits
    const parsed = parseCapabilityRequestPayload('register-push', {
      action: 'register',
      expoPushToken: 'ExponentPushToken[abc123]',
      pushKeyBase64,
      platform: 'android',
    });
    expect(parsed).toEqual({ action: 'register', expoPushToken: 'ExponentPushToken[abc123]', pushKeyBase64, platform: 'android' });
  });

  it('register-push: rejects a register without expoPushToken or pushKeyBase64', () => {
    expect(() => parseCapabilityRequestPayload('register-push', { action: 'register', pushKeyBase64: 'A'.repeat(43) })).toThrow(/expoPushToken/);
    expect(() => parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok' })).toThrow(/pushKeyBase64/);
  });

  it('register-push: rejects a push key that does not decode to exactly 32 bytes', () => {
    expect(() =>
      parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok', pushKeyBase64: 'A'.repeat(22) }),
    ).toThrow(/32 bytes/);
    expect(() =>
      parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok', pushKeyBase64: 'not base64url!!!' }),
    ).toThrow(/pushKeyBase64/);
  });

  it('register-push: rejects an unknown action or platform', () => {
    expect(() => parseCapabilityRequestPayload('register-push', { action: 'subscribe' })).toThrow(/action/);
    expect(() =>
      parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok', pushKeyBase64: 'A'.repeat(43), platform: 'windows' }),
    ).toThrow(/platform/);
  });

  it('register-push: an unregister without token or key is accepted', () => {
    expect(parseCapabilityRequestPayload('register-push', { action: 'unregister' })).toEqual({ action: 'unregister' });
  });

  it('register-push: categories is absent by default, and an explicit list survives', () => {
    const pushKeyBase64 = 'A'.repeat(43);
    const withoutCategories = parseCapabilityRequestPayload('register-push', {
      action: 'register',
      expoPushToken: 'tok',
      pushKeyBase64,
    });
    expect(withoutCategories).not.toHaveProperty('categories');

    const withCategories = parseCapabilityRequestPayload('register-push', {
      action: 'register',
      expoPushToken: 'tok',
      pushKeyBase64,
      categories: ['turn-complete', 'session-failed'],
    });
    expect(withCategories).toMatchObject({ categories: ['turn-complete', 'session-failed'] });
  });

  it('register-push: an unrecognized category is dropped, not rejected', () => {
    const parsed = parseCapabilityRequestPayload('register-push', {
      action: 'register',
      expoPushToken: 'tok',
      pushKeyBase64: 'A'.repeat(43),
      categories: ['turn-complete', 'a-category-from-the-future'],
    });
    expect(parsed).toMatchObject({ categories: ['turn-complete'] });
  });

  it('register-push: an explicitly empty categories list is preserved as "none"', () => {
    const parsed = parseCapabilityRequestPayload('register-push', {
      action: 'register',
      expoPushToken: 'tok',
      pushKeyBase64: 'A'.repeat(43),
      categories: [],
    });
    expect(parsed).toMatchObject({ categories: [] });
  });

  it('register-push: rejects a malformed categories value', () => {
    expect(() =>
      parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok', pushKeyBase64: 'A'.repeat(43), categories: 'turn-complete' }),
    ).toThrow(/categories/);
    expect(() =>
      parseCapabilityRequestPayload('register-push', { action: 'register', expoPushToken: 'tok', pushKeyBase64: 'A'.repeat(43), categories: [123] }),
    ).toThrow(/categories/);
  });

  it('rejects a non-object payload for every verb', () => {
    expect(() => parseCapabilityRequestPayload('read-board', 'not-an-object' as unknown as JsonValue)).toThrow();
    expect(() => parseCapabilityRequestPayload('move-task', null as unknown as JsonValue)).toThrow();
  });

  it('rejects an array payload (an array is not a record, even for the all-optional read-board shape)', () => {
    // read-board's fields are all optional, so an array payload would slip
    // through the "list projects" branch unless isRecord excludes arrays.
    expect(() => parseCapabilityRequestPayload('read-board', [] as unknown as JsonValue)).toThrow();
    expect(() => parseCapabilityRequestPayload('board-tool-read', [] as unknown as JsonValue)).toThrow();
  });

  it('throws for an unrecognized verb rather than silently passing through', () => {
    // In production framing.ts's decodeMessage already rejects an unknown
    // verb before a request reaches this parser (see framing.test.ts);
    // this exercises the exhaustiveness default branch directly as
    // defense in depth.
    const unrecognizedVerb = 'delete-everything' as unknown as CapabilityVerb;
    expect(() => parseCapabilityRequestPayload(unrecognizedVerb, {})).toThrow(/Unknown capability verb/);
  });
});
