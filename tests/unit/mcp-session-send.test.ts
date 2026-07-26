import { describe, it, expect, vi } from 'vitest';
import {
  createSessionSendCoordinator,
  type SessionSendOutcome,
} from '../../src/main/agent/mcp-http/session-send';
import type { ActivityState } from '../../src/shared/types';

/**
 * Minimal stand-in for the SessionManager slice the coordinator consumes, with
 * an `emit` so tests can drive the activity/exit transitions that gate deferred
 * delivery. Booting a real SessionManager would mean spawning a PTY.
 */
function createFakeSessionManager(initial: { writable?: string[]; activity?: Record<string, ActivityState> } = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const writable = new Set(initial.writable ?? []);
  const activity: Record<string, ActivityState> = { ...(initial.activity ?? {}) };
  return {
    writable,
    activity,
    isWritable: (sessionId: string) => writable.has(sessionId),
    getActivityCache: () => activity,
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

/** Let queued microtasks (PQueue scheduling, promise chains) run to completion. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function isFailure(outcome: SessionSendOutcome): outcome is { error: string } {
  return 'error' in outcome;
}

describe('session-send coordinator', () => {
  it('delivers the message VERBATIM through the bracketed-paste submit path', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'idle' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'target',
      message: 'please rebase onto main',
      callerSessionId: 'caller',
      deliverWhen: 'now',
    });

    expect(outcome).toMatchObject({ status: 'delivered', sessionId: 'target', targetActivity: 'idle', hopDepth: 1 });
    expect(submitContent).toHaveBeenCalledTimes(1);
    const [sessionId, text, options] = submitContent.mock.calls[0];
    expect(sessionId).toBe('target');
    expect(options).toEqual({ source: 'mcp' });
    // No in-band attribution. A prefix costs tokens on every send and reads to
    // the receiving agent as injected content asserting its own authority,
    // which made it refuse messages sent this way (verified live 2026-07-25).
    // Provenance goes to the session_messages_sent table instead. Byte-exact equality
    // also keeps the stored `message` matchable against the transcript turn.
    expect(text).toBe('please rebase onto main');
    coordinator.dispose();
  });

  it('records provenance for a delivered message so a sent turn stays identifiable', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'idle' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({
      targetSessionId: 'target',
      message: 'take this over',
      callerSessionId: 'caller',
      deliverWhen: 'now',
      recordSentMessage,
    });

    expect(recordSentMessage).toHaveBeenCalledWith({
      targetSessionId: 'target',
      callerSessionId: 'caller',
      message: 'take this over',
      status: 'delivered',
    });
  });

  it('still resolves "delivered" when the recorder throws, per "provenance is best-effort"', async () => {
    // record() wraps recordSentMessage in try/catch specifically so a failing
    // provenance write (e.g. a locked SQLite handle) cannot turn a message that
    // actually landed in the target's PTY into a thrown error out of the tool
    // handler - the delivery already happened and cannot be undone.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'idle' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn(() => {
      throw new Error('db locked');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'target',
      message: 'go',
      deliverWhen: 'now',
      recordSentMessage,
    });

    // Red: removing the try/catch around `recordSentMessage?.(...)` in
    // session-send.ts's `record` makes this reject with "db locked" instead of
    // resolving.
    expect(outcome).toMatchObject({ status: 'delivered' });
    expect(submitContent).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('db locked'));
    consoleErrorSpy.mockRestore();
    coordinator.dispose();
  });

  it('records a refusal so "did my message go through?" always has an answer', async () => {
    const sessionManager = createFakeSessionManager({ writable: [] });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'gone', message: 'x', deliverWhen: 'now', recordSentMessage });

    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'gone',
      message: 'x',
      status: 'refused',
      error: expect.stringContaining('not accepting input'),
    }));
    expect(submitContent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('records a delivery failure, where whether a turn landed is genuinely unknown', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'] });
    const submitContent = vi.fn(() => Promise.reject(new Error('no-submission-evidence')));
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'target', message: 'x', deliverWhen: 'now', recordSentMessage });

    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('no-submission-evidence'),
    }));
    coordinator.dispose();
  });

  it('records a deferred delivery failure, the only channel left once the call returned', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'thinking' } });
    const submitContent = vi.fn(() => Promise.reject(new Error('paste exploded')));
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'target', message: 'x', deliverWhen: 'idle', recordSentMessage });
    expect(recordSentMessage).not.toHaveBeenCalled();

    sessionManager.emit('activity', 'target', 'idle');
    await flushMicrotasks();

    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('paste exploded'),
    }));
    coordinator.dispose();
  });

  it('dedupes repeated refusals per window so a runaway cannot fill the database', async () => {
    // The self-send and dead-session guards run BEFORE the rate limiter, so
    // they never consume a slot. Without dedupe, a looping agent writes one row
    // per attempt forever and the audit trail becomes the amplification vector.
    const sessionManager = createFakeSessionManager({ writable: [] });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await coordinator.send({ targetSessionId: 'gone', message: 'x', deliverWhen: 'now', recordSentMessage });
    }

    expect(recordSentMessage).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('keeps a separate refusal notice per reason and per target', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['live'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    // Distinct reason (self-send vs dead session) and distinct target: both
    // are separately interesting when debugging, so neither may mask the other.
    await coordinator.send({ targetSessionId: 'live', message: 'x', callerSessionId: 'live', deliverWhen: 'now', recordSentMessage });
    await coordinator.send({ targetSessionId: 'gone', message: 'x', deliverWhen: 'now', recordSentMessage });

    const statuses = recordSentMessage.mock.calls.map((call) => (call[0] as { targetSessionId: string }).targetSessionId);
    expect(statuses).toEqual(['live', 'gone']);
    coordinator.dispose();
  });

  it('accepts a message with no caller session without inventing an origin', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'target',
      message: 'hello',
      deliverWhen: 'now',
      recordSentMessage,
    });

    expect(isFailure(outcome)).toBe(false);
    expect(submitContent.mock.calls[0][1]).toBe('hello');
    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({ callerSessionId: undefined }));
    coordinator.dispose();
  });

  it('refuses a session sending to itself', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['same'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'same',
      message: 'loop',
      callerSessionId: 'same',
      deliverWhen: 'now',
    });

    expect(isFailure(outcome) && outcome.error).toMatch(/cannot send a message to itself/);
    expect(submitContent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('rejects a session with no live PTY without burning the submit timeout', async () => {
    // The mobile bridge checks registry existence, so a suspended session gets
    // all the way into the paste engine and fails ~7s later. Gate on isWritable.
    const sessionManager = createFakeSessionManager({ writable: [] });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'suspended',
      message: 'hello',
      deliverWhen: 'now',
    });

    expect(isFailure(outcome) && outcome.error).toMatch(/not accepting input/);
    expect(submitContent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('refuses an immediate send into an open permission prompt', async () => {
    // The submit path ends in \r (and retries it), which a modal prompt reads
    // as confirming its highlighted option - so an ordinary steer could approve
    // a tool call nobody sanctioned. The deferred path already excluded
    // 'permission'; the hazard is the delivery, not when it was scheduled.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'permission' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({
      targetSessionId: 'target',
      message: 'unrelated steer',
      deliverWhen: 'now',
      recordSentMessage,
    });

    expect(isFailure(outcome) && outcome.error).toMatch(/permission prompt/);
    expect(submitContent).not.toHaveBeenCalled();
    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'refused' }));
    coordinator.dispose();
  });

  it('QUEUES rather than refuses when deliverWhen is "idle" and the target is at a prompt', async () => {
    // The immediate-path refusal tells the caller to re-send with "idle", so
    // "idle" must actually hold for this state instead of refusing too.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'permission' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'idle' });

    expect(outcome).toMatchObject({ status: 'queued', targetActivity: 'permission' });
    expect(submitContent).not.toHaveBeenCalled();

    sessionManager.emit('activity', 'target', 'idle');
    await flushMicrotasks();
    expect(submitContent).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('records a failed row when the target exits before a queued message flushes', async () => {
    // The caller was already told "queued" and has returned. Dropping the entry
    // silently would leave an attempt with no row anywhere, breaking the "a row
    // exists for every attempt" contract the log is built on.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'thinking' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'idle', recordSentMessage });
    expect(recordSentMessage).not.toHaveBeenCalled();

    sessionManager.emit('exit', 'target');

    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'go',
      status: 'failed',
      error: expect.stringContaining('exited'),
    }));
    expect(submitContent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('records the whole batch as failed when the target stops accepting input at flush time', async () => {
    // A per-entry break would abandon everything after the first entry with no
    // row at all - the one outcome this table exists to make impossible.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'thinking' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    for (const message of ['first', 'second', 'third']) {
      await coordinator.send({ targetSessionId: 'target', message, deliverWhen: 'idle', recordSentMessage });
    }

    // Went unwritable without an 'exit' (suspended mid-flight), then reported idle.
    sessionManager.writable.delete('target');
    sessionManager.emit('activity', 'target', 'idle');
    await flushMicrotasks();

    expect(submitContent).not.toHaveBeenCalled();
    expect(recordSentMessage).toHaveBeenCalledTimes(3);
    expect(recordSentMessage.mock.calls.map((call) => (call[0] as { message: string }).message))
      .toEqual(['first', 'second', 'third']);
    coordinator.dispose();
  });

  it('rolls back the hop depth when a DEFERRED delivery fails, like the immediate path', async () => {
    // A target that never received the message must not carry this hop's depth
    // into its own onward sends, or repeated deferred failures ratchet it
    // toward the backstop with nothing ever delivered.
    const sessionManager = createFakeSessionManager({ writable: ['b', 'c'], activity: { b: 'thinking' } });
    // Only the deferred flush into b fails; the later onward send must succeed
    // so its reported hopDepth is observable.
    const submitContent = vi.fn((sessionId: string) => (
      sessionId === 'b' ? Promise.reject(new Error('paste exploded')) : Promise.resolve()
    ));
    const coordinator = createSessionSendCoordinator(
      { sessionManager, terminalSubmit: { submitContent } },
      { maxHopDepth: 2 },
    );

    // a -> b at depth 1, deferred, then fails on flush.
    await coordinator.send({ targetSessionId: 'b', message: 'go', callerSessionId: 'a', deliverWhen: 'idle' });
    sessionManager.emit('activity', 'b', 'idle');
    await flushMicrotasks();

    // b never received it, so b's own onward send starts a fresh chain at 1.
    const onward = await coordinator.send({ targetSessionId: 'c', message: 'go', callerSessionId: 'b', deliverWhen: 'now' });
    expect(onward).toMatchObject({ hopDepth: 1 });
    coordinator.dispose();
  });

  it('refuses once the per-target sliding window is full', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator(
      { sessionManager, terminalSubmit: { submitContent } },
      { maxSendsPerWindow: 2 },
    );

    const request = { targetSessionId: 'target', message: 'go', deliverWhen: 'now' as const };
    expect(isFailure(await coordinator.send(request))).toBe(false);
    expect(isFailure(await coordinator.send(request))).toBe(false);
    const third = await coordinator.send(request);

    expect(isFailure(third) && third.error).toMatch(/Rate limit/);
    expect(submitContent).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('counts a steer chain server-side and refuses past the depth backstop', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['b', 'c', 'd'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator(
      { sessionManager, terminalSubmit: { submitContent } },
      { maxHopDepth: 2 },
    );

    const first = await coordinator.send({ targetSessionId: 'b', message: 'go', callerSessionId: 'a', deliverWhen: 'now' });
    expect(first).toMatchObject({ hopDepth: 1 });

    // b now carries depth 1, so its own onward send is depth 2.
    const second = await coordinator.send({ targetSessionId: 'c', message: 'go', callerSessionId: 'b', deliverWhen: 'now' });
    expect(second).toMatchObject({ hopDepth: 2 });

    const third = await coordinator.send({ targetSessionId: 'd', message: 'go', callerSessionId: 'c', deliverWhen: 'now' });
    expect(isFailure(third) && third.error).toMatch(/chain depth 3 exceeds/);
    coordinator.dispose();
  });

  it('delivers immediately for deliverWhen "idle" when the target is ALREADY idle', async () => {
    // The motivating case is a target parked at idle_hint. Waiting for the next
    // idle transition would never fire, leaving the message stuck indefinitely.
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'idle' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'idle' });

    expect(outcome).toMatchObject({ status: 'delivered' });
    expect(submitContent).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('queues for deliverWhen "idle" against a busy target and flushes on the idle transition', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'thinking' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const recordSentMessage = vi.fn();
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'idle', recordSentMessage });
    expect(outcome).toMatchObject({ status: 'queued', targetActivity: 'thinking' });
    expect(submitContent).not.toHaveBeenCalled();
    // Provenance is written when the text LANDS, not when it was queued - a
    // queued message that never flushes must leave no row claiming it arrived.
    expect(recordSentMessage).not.toHaveBeenCalled();

    // A permission prompt is "not active", but a queued paste must not land on
    // an open prompt where its \r could confirm it.
    sessionManager.emit('activity', 'target', 'permission');
    await flushMicrotasks();
    expect(submitContent).not.toHaveBeenCalled();

    sessionManager.emit('activity', 'target', 'idle');
    await flushMicrotasks();
    expect(submitContent).toHaveBeenCalledTimes(1);
    expect(submitContent.mock.calls[0][1]).toBe('go');
    expect(recordSentMessage).toHaveBeenCalledWith(expect.objectContaining({ message: 'go', status: 'queued' }));
    coordinator.dispose();
  });

  it('drops a pending deferred delivery when the target session exits', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'], activity: { target: 'thinking' } });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'idle' });
    expect(coordinator._stateSizesForTesting().pending).toBe(1);

    sessionManager.emit('exit', 'target');
    expect(coordinator._stateSizesForTesting()).toMatchObject({ pending: 0, hops: 0, windows: 0 });

    sessionManager.emit('activity', 'target', 'idle');
    await flushMicrotasks();
    expect(submitContent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('serializes concurrent sends to one target so pastes cannot interleave', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'] });
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const submitContent = vi.fn((_sessionId: string, text: string) => {
      started.push(text);
      if (started.length === 1) {
        return new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve();
    });
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const first = coordinator.send({ targetSessionId: 'target', message: 'first', deliverWhen: 'now' });
    const second = coordinator.send({ targetSessionId: 'target', message: 'second', deliverWhen: 'now' });
    await flushMicrotasks();

    expect(started).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(started).toHaveLength(2);
    expect(started[0]).toContain('first');
    expect(started[1]).toContain('second');
    coordinator.dispose();
  });

  it('drains its per-target queue map so long-running instances do not accumulate entries', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['one', 'two'] });
    const submitContent = vi.fn(() => Promise.resolve());
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    await coordinator.send({ targetSessionId: 'one', message: 'go', deliverWhen: 'now' });
    await coordinator.send({ targetSessionId: 'two', message: 'go', deliverWhen: 'now' });
    await flushMicrotasks();

    expect(coordinator._stateSizesForTesting().queues).toBe(0);
    coordinator.dispose();
  });

  it('surfaces a submit failure as an error result rather than throwing', async () => {
    const sessionManager = createFakeSessionManager({ writable: ['target'] });
    const submitContent = vi.fn(() => Promise.reject(new Error('no-submission-evidence')));
    const coordinator = createSessionSendCoordinator({ sessionManager, terminalSubmit: { submitContent } });

    const outcome = await coordinator.send({ targetSessionId: 'target', message: 'go', deliverWhen: 'now' });

    expect(isFailure(outcome) && outcome.error).toMatch(/no-submission-evidence/);
    coordinator.dispose();
  });

  it('detaches its SessionManager listeners on dispose', () => {
    const sessionManager = createFakeSessionManager();
    const coordinator = createSessionSendCoordinator({
      sessionManager,
      terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) },
    });

    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
    coordinator.dispose();
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
  });

  it('clears its tracked state on dispose, not just the listeners', async () => {
    // dispose() runs on server shutdown. Detaching the listeners but leaving
    // the maps populated would strand a launch's worth of hop depths, rate
    // windows and refusal notices on a coordinator nothing can drain anymore.
    const sessionManager = createFakeSessionManager({ writable: ['live'], activity: { live: 'thinking' } });
    const coordinator = createSessionSendCoordinator({
      sessionManager,
      terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) },
    });

    // Populate every map: a queued deferred delivery (pending + hops + windows)
    // and a refusal against a dead target (refusalNotices).
    await coordinator.send({ targetSessionId: 'live', message: 'go', callerSessionId: 'caller', deliverWhen: 'idle' });
    await coordinator.send({ targetSessionId: 'gone', message: 'go', deliverWhen: 'now' });
    const populated = coordinator._stateSizesForTesting();
    expect(populated.pending).toBeGreaterThan(0);
    expect(populated.hops).toBeGreaterThan(0);
    expect(populated.windows).toBeGreaterThan(0);
    expect(populated.refusalNotices).toBeGreaterThan(0);

    coordinator.dispose();

    expect(coordinator._stateSizesForTesting()).toEqual({
      queues: 0,
      pending: 0,
      hops: 0,
      windows: 0,
      refusalNotices: 0,
    });
  });
});
