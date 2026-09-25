/**
 * The deferred force-kill primitive behind SessionManager.kill()'s grace for
 * young sessions (src/main/pty/lifecycle/deferred-kill.ts): the young
 * predicate's two bounds, and the registry's timer, cancel, detach, and flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as pty from 'node-pty';
import {
  DeferredKillRegistry,
  isYoungSession,
  KILL_GRACE_MS,
  YOUNG_AFTER_ALT_SCREEN_MS,
  YOUNG_SINCE_SPAWN_MS,
} from '../../src/main/pty/lifecycle/deferred-kill';

describe('isYoungSession', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const secondsAgo = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('is young inside the alt-screen window and mature once it has passed', () => {
    const startedAt = secondsAgo(5);
    expect(isYoungSession({ startedAt, altScreenEnteredAt: now - 1_000 }, now)).toBe(true);
    expect(isYoungSession({ startedAt, altScreenEnteredAt: now - (YOUNG_AFTER_ALT_SCREEN_MS - 1) }, now)).toBe(true);
    expect(isYoungSession({ startedAt, altScreenEnteredAt: now - YOUNG_AFTER_ALT_SCREEN_MS }, now)).toBe(false);
  });

  it('falls back to the spawn bound when no alt-screen frame has been seen', () => {
    expect(isYoungSession({ startedAt: secondsAgo(1) }, now)).toBe(true);
    expect(isYoungSession({ startedAt: new Date(now - (YOUNG_SINCE_SPAWN_MS - 1)).toISOString() }, now)).toBe(true);
    expect(isYoungSession({ startedAt: new Date(now - YOUNG_SINCE_SPAWN_MS).toISOString() }, now)).toBe(false);
  });

  it('lets an alt-screen frame end the window before the spawn bound would', () => {
    // Spawned 30 s ago (young by the spawn bound) but its first frame was 20 s
    // ago: the canary was withdrawn 10 s after that frame, so the grace is over.
    expect(isYoungSession({ startedAt: secondsAgo(30), altScreenEnteredAt: now - 20_000 }, now)).toBe(false);
  });

  it('reads an unparseable startedAt as young', () => {
    // A wrong "mature" costs a strike; a wrong "young" costs 1.5 s.
    expect(isYoungSession({ startedAt: 'not-a-date' }, now)).toBe(true);
  });
});

describe('DeferredKillRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakePty(pid: number | undefined): pty.IPty {
    return { pid, kill: vi.fn(), write: vi.fn() } as unknown as pty.IPty;
  }

  function makeDisposable() {
    return { dispose: vi.fn() };
  }

  it('force-kills at the grace and not a tick before', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    const ptyRef = fakePty(4242);

    registry.schedule({ sessionId: 'sess-1', ptyRef, pid: 4242 });
    expect(registry.size).toBe(1);

    vi.advanceTimersByTime(KILL_GRACE_MS - 1);
    expect(killPty).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(killPty).toHaveBeenCalledTimes(1);
    expect(killPty).toHaveBeenCalledWith(ptyRef);
    expect(registry.size).toBe(0);
  });

  it('honors an injected grace', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty, graceMs: 20 });
    registry.schedule({ sessionId: 'sess-1', ptyRef: fakePty(1), pid: 1 });
    vi.advanceTimersByTime(20);
    expect(killPty).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the timer so a natural exit is never followed by a kill', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    registry.schedule({ sessionId: 'sess-1', ptyRef: fakePty(4242), pid: 4242 });

    expect(registry.cancel('sess-1')).toBe(true);
    expect(registry.size).toBe(0);
    vi.advanceTimersByTime(KILL_GRACE_MS * 2);
    expect(killPty).not.toHaveBeenCalled();
    // A second cancel, or one for an unknown session, is a no-op.
    expect(registry.cancel('sess-1')).toBe(false);
  });

  it('scheduling the same PTY twice keeps the first timer', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    const ptyRef = fakePty(4242);
    registry.schedule({ sessionId: 'sess-1', ptyRef, pid: 4242 });
    vi.advanceTimersByTime(1000);
    registry.schedule({ sessionId: 'sess-1', ptyRef, pid: 4242 });
    vi.advanceTimersByTime(KILL_GRACE_MS - 1000);
    expect(killPty).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('keys entries by PTY, so two sessions with the same id never collide', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    const first = fakePty(1);
    const second = fakePty(2);
    registry.schedule({ sessionId: 'reused-id', ptyRef: first, pid: 1 });
    registry.schedule({ sessionId: 'reused-id', ptyRef: second, pid: 2 });
    expect(registry.size).toBe(2);
    expect(registry.pendingPids()).toEqual([1, 2]);
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(killPty).toHaveBeenCalledWith(first);
    expect(killPty).toHaveBeenCalledWith(second);
  });

  it('pendingPids lists only probe-able pids', () => {
    const registry = new DeferredKillRegistry({ killPty: vi.fn(() => true) });
    registry.schedule({ sessionId: 'a', ptyRef: fakePty(4242), pid: 4242 });
    registry.schedule({ sessionId: 'b', ptyRef: fakePty(undefined), pid: undefined });
    registry.schedule({ sessionId: 'c', ptyRef: fakePty(0), pid: 0 });
    expect(registry.size).toBe(3);
    expect(registry.pendingPids()).toEqual([4242]);
  });

  it('flushAll kills every parked PTY now, disposes the captured listeners, and reports what it killed', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    const listener = makeDisposable();
    const throwing = { dispose: vi.fn(() => { throw new Error('emitter already gone'); }) };
    const readable = fakePty(4242);
    const unreadable = fakePty(undefined);
    registry.schedule({
      sessionId: 'a',
      ptyRef: readable,
      pid: 4242,
      ptyDisposables: [throwing, listener] as unknown as pty.IDisposable[],
    });
    registry.schedule({ sessionId: 'b', ptyRef: unreadable, pid: undefined });

    // Like killAllSessions' report: every kill counts, only readable pids probe.
    expect(registry.flushAll()).toEqual({ pids: [4242], count: 2 });
    expect(killPty).toHaveBeenCalledTimes(2);
    expect(listener.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);

    // The timers are gone with the entries: nothing fires later.
    vi.advanceTimersByTime(KILL_GRACE_MS * 2);
    expect(killPty).toHaveBeenCalledTimes(2);
  });

  it('detachAllListeners disposes the captured listeners but leaves the timers armed', () => {
    const killPty = vi.fn(() => true);
    const registry = new DeferredKillRegistry({ killPty });
    const listener = makeDisposable();
    registry.schedule({
      sessionId: 'a',
      ptyRef: fakePty(4242),
      pid: 4242,
      ptyDisposables: [listener] as unknown as pty.IDisposable[],
    });

    registry.detachAllListeners();
    expect(listener.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
    expect(killPty).not.toHaveBeenCalled();

    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(killPty).toHaveBeenCalledTimes(1);
    // A later flush must not dispose the same listener twice.
    registry.detachAllListeners();
    expect(listener.dispose).toHaveBeenCalledTimes(1);
  });
});
