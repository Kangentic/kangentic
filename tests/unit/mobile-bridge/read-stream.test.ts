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

const usageFixture = {
  contextWindow: { usedPercentage: 10, usedTokens: 100, cacheTokens: 50, totalInputTokens: 150, totalOutputTokens: 20, contextWindowSize: 200000 },
  cost: { totalCostUsd: 0.5, totalDurationMs: 1000 },
  model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
};

// Authored fixture mirroring the numbered permission dialog Claude Code
// paints (box border + ❯ marker), for the option-label probe.
const permissionDialogFrame = [
  'Do you want to proceed?',
  '│ ❯ 1. Yes                                        │',
  "│   2. Yes, and don't ask again for this command  │",
  '│   3. No, and tell Claude what to do differently │',
].join('\r\n');
const permissionDialogOptions = ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'];

/** Let the async option-label probe inside the permission push settle. */
function flushProbe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeSessionManager extends EventEmitter {
  getSession = vi.fn((id: string) => ({ id, taskId: 'task-1', status: 'running' }));
  getScrollback = vi.fn(() => Promise.resolve('scrollback-content'));
  // The mobile seed uses the parsed-grid serialized frame, not the raw replay.
  getSerializedFrame = vi.fn(() => Promise.resolve('serialized-frame'));
  getActivityCache = vi.fn(() => ({ 'sess-1': 'thinking' }));
  getActivityReason = vi.fn(() => ({ kind: 'turn-active' }));
  getUsageCache = vi.fn(() => ({ 'sess-1': usageFixture }));
  getActivityStatsSnapshot = vi.fn(() => ({ permissionPending: false, permissionAwaitedToolId: null }));
  getSessionProjectId = vi.fn(() => 'proj-1');
  getDimensions = vi.fn((): { cols: number; rows: number } | null => ({ cols: 120, rows: 30 }));
  parkRestingGridForMobileSubscriber = vi.fn();
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
    const payload = response.payload as { scrollback: string; awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null; ptyDimensions?: unknown };
    expect(payload.scrollback).toBe('serialized-frame');
    expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
    // The frame shows no numbered dialog, so the option labels are unknown.
    expect(payload.awaitedPromptOptions).toBeNull();
    expect(payload.ptyDimensions).toEqual({ cols: 120, rows: 30 });
  });

  it('the snapshot carries the parsed option labels when the pending dialog is in the frame', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    sessionManager.getSerializedFrame.mockResolvedValue(permissionDialogFrame);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    const payload = response.payload as { awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null };
    expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
    expect(payload.awaitedPromptOptions).toEqual(permissionDialogOptions);
  });

  it('parks an unheld session for a terminal subscriber BEFORE serializing the seed', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    // Park first, then serialize: the one seed already carries the resting
    // grid instead of the strip the last desktop surface left behind (plus a
    // second reflow-and-reseed when the debounced park fired later).
    expect(sessionManager.parkRestingGridForMobileSubscriber).toHaveBeenCalledWith('sess-1');
    const parkOrder = sessionManager.parkRestingGridForMobileSubscriber.mock.invocationCallOrder[0];
    const serializeOrder = sessionManager.getSerializedFrame.mock.invocationCallOrder[0];
    expect(parkOrder).toBeLessThan(serializeOrder);
  });

  it('never parks for a list-only subscriber (terminal:false)', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

    expect(sessionManager.parkRestingGridForMobileSubscriber).not.toHaveBeenCalled();
  });

  it('omits awaitedPromptOptions entirely when no prompt is pending', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect('awaitedPromptOptions' in (response.payload as Record<string, unknown>)).toBe(false);
  });

  it('omits ptyDimensions from the snapshot when the grid is unknowable', async () => {
    sessionManager.getDimensions.mockReturnValue(null);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect('ptyDimensions' in (response.payload as Record<string, unknown>)).toBe(false);
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
    expect(sessionManager.listenerCount('pty-resize')).toBe(1);
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('usage')).toBe(1);
    expect(sessionManager.listenerCount('event')).toBe(1);

    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'unsubscribe' }), fakeSession(), context, subscriptions);
    expect(response.ok).toBe(true);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
  });

  /**
   * A phone showing its session list needs activity, permission and
   * transcript pushes, but discards PTY bytes on arrival. Measured live, that
   * discard cost roughly 13MB an hour of relay traffic for a feed with no
   * terminal open, plus a full serialized frame per session on every cold
   * start. `terminal: false` subscribes to everything except the bytes.
   */
  it('a list-only subscribe attaches no terminal taps and returns no scrollback', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }),
      fakeSession(),
      context,
      subscriptions,
    );

    expect((response.payload as { scrollback: string }).scrollback).toBe('');
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    // Everything the list actually renders still flows.
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('usage')).toBe(1);
    expect(sessionManager.listenerCount('event')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
  });

  it('an omitted terminal flag keeps the full stream, so an older phone is unaffected', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }),
      fakeSession(),
      context,
      subscriptions,
    );

    expect((response.payload as { scrollback: string }).scrollback).toBe('serialized-frame');
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    expect(sessionManager.listenerCount('pty-resize')).toBe(1);
  });

  it('a list-only subscriber receives no terminal events when the pty produces output', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }),
      session,
      context,
      subscriptions,
    );
    sessionManager.emit('data-tap', 'sess-1', 'output the phone would have discarded');
    sessionManager.emit('pty-resize', 'sess-1', 100, 40);

    const sent = vi.mocked(session.sendMessage).mock.calls.map((call) => call[0] as { event?: { kind?: string } });
    expect(sent.some((message) => message?.event?.kind === 'terminal')).toBe(false);
    expect(sent.some((message) => message?.event?.kind === 'terminal-resize')).toBe(false);
  });

  /**
   * Usage ticks on essentially every token but renders as a percentage bar.
   * Measured live, unthrottled pushes were the largest ONGOING cost once the
   * terminal stream was removed - roughly 1MB an hour to animate one bar.
   */
  it('coalesces a usage burst into one push carrying the newest value', async () => {
    vi.useFakeTimers();
    try {
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      const session = fakeSession();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);
      const before = vi.mocked(session.sendMessage).mock.calls.length;

      for (let tick = 1; tick <= 20; tick += 1) {
        sessionManager.emit('usage', 'sess-1', { ...usageFixture, contextWindow: { ...usageFixture.contextWindow, usedTokens: tick } });
      }
      // Nothing on the wire yet: the whole burst is parked on one timer.
      expect(vi.mocked(session.sendMessage).mock.calls.length).toBe(before);

      await vi.advanceTimersByTimeAsync(2100);

      const usagePushes = vi
        .mocked(session.sendMessage)
        .mock.calls.slice(before)
        .map((call) => call[0] as { event?: { payload?: { type?: string; usage?: { contextWindow?: { usedTokens?: number } } } } })
        .filter((message) => message?.event?.payload?.type === 'usage');
      expect(usagePushes).toHaveLength(1);
      // The NEWEST value, not the first of the burst.
      expect(usagePushes[0].event?.payload?.usage?.contextWindow?.usedTokens).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending usage when the session exits, so the final count is not lost', async () => {
    vi.useFakeTimers();
    try {
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      const session = fakeSession();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      sessionManager.emit('usage', 'sess-1', usageFixture);
      sessionManager.emit('exit', 'sess-1', 0, true);

      const sent = vi
        .mocked(session.sendMessage)
        .mock.calls.map((call) => call[0] as { event?: { payload?: { type?: string } } })
        .filter((message) => message?.event?.payload?.type === 'usage');
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    expect(subscriptions.has('stream:sess-1')).toBe(false);
  });

  it('pushes a session-ended activity event (with the intentional flag) before tearing down on exit', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

    sessionManager.emit('data-tap', 'sess-1', 'y'.repeat(300)); // parked on the coalesce timer
    sessionManager.emit('exit', 'sess-1', 0, true);

    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    // The pending old-grid output flushes FIRST, then session-ended is the feed's last word.
    expect((calls[calls.length - 2][0] as { event: { kind: string } }).event.kind).toBe('terminal');
    expect(calls[calls.length - 1][0]).toEqual({
      type: 'event',
      event: { kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'session-ended', intentional: true } },
    });
    expect(subscriptions.has('stream:sess-1')).toBe(false);
  });

  it('a crash exit (and the flag-less spawn-failure emit) reports intentional false', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    sessionManager.emit('exit', 'sess-1', -1); // spawn-failure path emits no intentional flag
    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[calls.length - 1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'session-ended',
      intentional: false,
    });
  });

  it('the subscribe snapshot carries the live session status', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect((response.payload as { sessionStatus?: string }).sessionStatus).toBe('running');
  });

  it('subscribing a suspended-but-registered session reports its suspended status', async () => {
    sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended' });
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(true);
    expect((response.payload as { sessionStatus?: string }).sessionStatus).toBe('suspended');
  });

  it('a small data-tap chunk flushes immediately (keystroke-echo fast path); a different session never pushes', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.emit('data-tap', 'sess-OTHER', 'ignored');
      expect(session.sendMessage).not.toHaveBeenCalled();

      // A few echoed keystrokes: at or under the immediate-flush budget, each
      // ships without waiting out the coalesce timer.
      sessionManager.emit('data-tap', 'sess-1', 'h');
      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: 'h' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an output burst past the immediate budget coalesces into one terminal event on the timer', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      const bigChunk = 'x'.repeat(300);
      sessionManager.emit('data-tap', 'sess-1', bigChunk);
      sessionManager.emit('data-tap', 'sess-1', 'tail');
      expect(session.sendMessage).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: `${bigChunk}tail` } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pty-resize flushes pending old-grid output first, then pushes a terminal-resize event', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.emit('data-tap', 'sess-1', 'y'.repeat(300)); // parked on the coalesce timer
      sessionManager.emit('pty-resize', 'sess-OTHER', 50, 20); // different session: ignored
      expect(session.sendMessage).not.toHaveBeenCalled();

      sessionManager.emit('pty-resize', 'sess-1', 48, 26);
      const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect((calls[0][0] as { event: { kind: string } }).event.kind).toBe('terminal');
      expect(calls[1][0]).toEqual({
        type: 'event',
        event: { kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 48, rows: 26 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  const userEntry = { kind: 'user', uuid: 'entry-user-1', ts: 100, text: 'hello agent' };
  const assistantEntry = { kind: 'assistant', uuid: 'entry-assistant-1', ts: 200, blocks: [{ type: 'text', text: 'hi there' }] };

  function liveTranscript(revision: number, entries: unknown[]): unknown {
    return { revision, entries, source: 'live', degraded: false };
  }

  function transcriptPushesOf(session: BridgeSession): unknown[][] {
    return (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => (message as { event?: { kind?: string } }).event?.kind === 'transcript',
    );
  }

  it('subscribe seeds the transcript sync without pushing - the phone bootstraps via transcript-window', async () => {
    resolveTaskTranscriptMock.mockResolvedValue(liveTranscript(1, [userEntry]));
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    await Promise.resolve();
    await Promise.resolve();

    expect(transcriptPushesOf(session)).toHaveLength(0);
  });

  it('a session event pushes only the changed entries as an indexed delta, and only when the revision increased', async () => {
    resolveTaskTranscriptMock
      .mockResolvedValueOnce(liveTranscript(1, [userEntry])) // subscribe-time seed (no push)
      .mockResolvedValueOnce(liveTranscript(1, [userEntry])) // unchanged revision - no push
      .mockResolvedValueOnce(liveTranscript(2, [userEntry, assistantEntry]));
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    await Promise.resolve();
    await Promise.resolve();
    expect(transcriptPushesOf(session)).toHaveLength(0);

    sessionManager.emit('event', 'sess-1', { ts: 1, type: 'tool_start' });
    await Promise.resolve();
    await Promise.resolve();
    expect(transcriptPushesOf(session)).toHaveLength(0); // unchanged revision

    sessionManager.emit('event', 'sess-1', { ts: 2, type: 'tool_end' });
    await Promise.resolve();
    await Promise.resolve();
    const transcriptPushes = transcriptPushesOf(session);
    expect(transcriptPushes).toHaveLength(1);
    expect((transcriptPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
      mode: 'delta',
      revision: 2,
      totalEntries: 2,
      upserts: [{ index: 1, entry: assistantEntry }],
    });
  });

  it('transcript-window returns the newest slice with its absolute start index', async () => {
    const older = { kind: 'user', uuid: 'entry-older', ts: 50, text: 'earlier question' };
    resolveTaskTranscriptMock.mockResolvedValue(liveTranscript(7, [older, userEntry, assistantEntry]));
    const context = { sessionManager } as unknown as IpcContext;

    const tail = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'transcript-window', limit: 2 }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
    );
    expect(tail.ok).toBe(true);
    expect(tail.payload).toEqual({ revision: 7, totalEntries: 3, startIndex: 1, entries: [userEntry, assistantEntry] });

    const olderPage = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'transcript-window', beforeIndex: 1, limit: 2 }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
    );
    expect(olderPage.payload).toEqual({ revision: 7, totalEntries: 3, startIndex: 0, entries: [older] });
  });

  it('pushes a permission activity event (with parsed option labels) when a prompt appears, deduplicates, and clears with pending false', async () => {
    const session = fakeSession();
    sessionManager.getSerializedFrame.mockResolvedValue(permissionDialogFrame);
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    const permissionPushes = (): unknown[][] =>
      (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );

    // A prompt appears after subscribe: the next activity emission carries it,
    // labeled from the dialog the probe finds in the frame.
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await flushProbe();
    expect(permissionPushes()).toHaveLength(1);
    expect(permissionPushes()[0][0]).toEqual({
      type: 'event',
      event: {
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'permission', promptId: 'sess-1:tool-7', pending: true, options: permissionDialogOptions },
      },
    });

    // The same outstanding prompt does not re-emit.
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await flushProbe();
    expect(permissionPushes()).toHaveLength(1);

    // The prompt clears: pending false carries the id that was answered.
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: false, permissionAwaitedToolId: null });
    sessionManager.emit('event', 'sess-1', { ts: 3, type: 'tool_end' });
    expect(permissionPushes()).toHaveLength(2);
    expect((permissionPushes()[1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'permission',
      promptId: 'sess-1:tool-7',
      pending: false,
    });
  });

  it('retries the option probe once when the dialog has not painted yet, then pushes with the labels', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      // First probe read races the TUI's dialog paint and misses; the retry sees it.
      sessionManager.getSerializedFrame
        .mockResolvedValueOnce('still thinking, no dialog yet')
        .mockResolvedValue(permissionDialogFrame);
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: true,
        options: permissionDialogOptions,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes pending true without options when no numbered dialog ever parses (blind fallback preserved)', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame stays 'serialized-frame': never a dialog
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a stale pending push when the prompt clears while the probe is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame never shows a dialog, so the probe parks on its retry timer
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });

      // The prompt clears (answered at the desk) before the retry fires.
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: false, permissionAwaitedToolId: null });
      sessionManager.emit('event', 'sess-1', { ts: 3, type: 'tool_end' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      // Only the clear went out; the in-flight pending push was dropped as stale.
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe parked on its retry never sends after the subscription tears down on exit', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame never shows a dialog, so the probe parks on its retry timer
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      sessionManager.emit('exit', 'sess-1', 0, true); // tears the subscription down
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(0);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a prompt already outstanding at subscribe time is not re-pushed by the next activity emission', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    expect((response.payload as { awaitedPromptId: string | null }).awaitedPromptId).toBe('sess-1:tool-9');

    // The snapshot already told the phone; an unchanged prompt must not double-notify.
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
    );
    expect(permissionPushes).toHaveLength(0);
  });
});
