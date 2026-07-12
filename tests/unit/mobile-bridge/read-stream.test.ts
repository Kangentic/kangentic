import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

const resolveTaskTranscriptMock = vi.fn();
vi.mock('../../../src/main/agent/transcript-service', () => ({
  resolveTaskTranscript: (...args: unknown[]) => resolveTaskTranscriptMock(...args),
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleReadStream } from '../../../src/main/mobile-bridge/handlers/read-stream';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'read-stream', payload };
}

function fakeSession(): BridgeSession {
  return { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn() } as unknown as BridgeSession;
}

class FakeSessionManager extends EventEmitter {
  getSession = vi.fn((id: string) => ({ id, taskId: 'task-1' }));
  getScrollback = vi.fn(() => Promise.resolve('scrollback-content'));
  getActivityCache = vi.fn(() => ({ 'sess-1': 'thinking' }));
  getActivityReason = vi.fn(() => ({ kind: 'turn-active' }));
  getUsageCache = vi.fn(() => ({ 'sess-1': { contextWindow: { used: 1 } } }));
  getActivityStatsSnapshot = vi.fn(() => ({ permissionPending: false, permissionAwaitedToolId: null }));
  getSessionProjectId = vi.fn(() => 'proj-1');
}

describe('handleReadStream', () => {
  let sessionManager: FakeSessionManager;

  beforeEach(() => {
    sessionManager = new FakeSessionManager();
    resolveTaskTranscriptMock.mockReset();
  });

  it('rejects when the session does not exist', async () => {
    sessionManager.getSession.mockReturnValueOnce(undefined as never);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(false);
  });

  it('returns the initial snapshot including the awaited prompt id when a permission prompt is pending', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    expect(response.ok).toBe(true);
    const payload = response.payload as { scrollback: string; awaitedPromptId: string | null };
    expect(payload.scrollback).toBe('scrollback-content');
    expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
  });

  it('awaitedPromptId is null when no permission is pending', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    const payload = response.payload as { awaitedPromptId: string | null };
    expect(payload.awaitedPromptId).toBeNull();
  });

  it('subscribe registers session-manager listeners; unsubscribe removes them', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('usage')).toBe(1);
    expect(sessionManager.listenerCount('event')).toBe(1);

    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'unsubscribe' }), fakeSession(), context, subscriptions);
    expect(response.ok).toBe(true);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
  });

  it('tears its own subscription down when the streamed session exits (no listener leak)', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);

    // Exiting a DIFFERENT session leaves this subscription intact.
    sessionManager.emit('exit', 'sess-OTHER', 0, false);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);

    // Exiting the streamed session removes EVERY listener it registered, so a
    // long-lived phone connection does not leak listeners per streamed session.
    sessionManager.emit('exit', 'sess-1', 0, false);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    expect(subscriptions.has('stream:sess-1')).toBe(false);
  });

  it('data-tap for a DIFFERENT session does not push, and coalesces same-session chunks into one terminal event', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.emit('data-tap', 'sess-OTHER', 'ignored');
      sessionManager.emit('data-tap', 'sess-1', 'hello ');
      sessionManager.emit('data-tap', 'sess-1', 'world');
      expect(session.sendMessage).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: 'hello world' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a session event push also checks the transcript and pushes a delta only when the revision increased', async () => {
    resolveTaskTranscriptMock
      .mockResolvedValueOnce({ revision: 1, entries: ['a'] })
      .mockResolvedValueOnce({ revision: 1, entries: ['a'] }) // unchanged revision - no second push
      .mockResolvedValueOnce({ revision: 2, entries: ['a', 'b'] });
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    sessionManager.emit('event', 'sess-1', { type: 'tool_start' });
    await Promise.resolve();
    await Promise.resolve();
    sessionManager.emit('event', 'sess-1', { type: 'tool_end' });
    await Promise.resolve();
    await Promise.resolve();

    const transcriptPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => message.event?.kind === 'transcript',
    );
    expect(transcriptPushes).toHaveLength(1);
    expect(transcriptPushes[0][0]).toEqual({
      type: 'event',
      event: { kind: 'transcript', sessionId: 'sess-1', taskId: 'task-1', payload: ['a'] },
    });

    sessionManager.emit('event', 'sess-1', { type: 'tool_start' });
    await Promise.resolve();
    await Promise.resolve();
    const secondTranscriptPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => message.event?.kind === 'transcript',
    );
    expect(secondTranscriptPushes).toHaveLength(2);
    expect(secondTranscriptPushes[1][0].event.payload).toEqual(['a', 'b']);
  });
});
