/**
 * The own-call mark and the wait for the calling agent's turn
 * (src/main/ipc/handlers/own-call-turn-wait.ts).
 *
 * The mark is a per-session COUNT: one turn can hold two own calls (a move of
 * its task and a pause of its workflow), and a move's release runs outside the
 * task lock, after the next move of the task may have marked. A release that
 * dropped the whole mark, or that ran twice, would lift a mark another call
 * still depends on, and the turn-end runner, the workflow recovery and the idle
 * notices would act on a turn that belongs to a session about to end.
 *
 * The wait returns at once for a session that is not running. An exit before
 * the wait starts sends no event the wait could hear, so without that early
 * return a call on an exited session would sit for the full bound.
 *
 * Every test uses its own session id: the marks are module state, shared by the
 * whole file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OWN_CALL_TURN_WAIT_MS,
  isSessionInOwnCall,
  markOwnCallSession,
  waitForOwnAgentTurn,
} from '../../src/main/ipc/handlers/own-call-turn-wait';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ActivityState, SessionStatus } from '../../src/shared/types';

let sessionCounter = 0;
const nextSessionId = (): string => `own-call-session-${++sessionCounter}`;

describe('markOwnCallSession', () => {
  const releases: Array<() => void> = [];

  /** Marks a session and remembers the release, so no test leaves a mark behind. */
  function mark(sessionId: string): () => void {
    const release = markOwnCallSession(sessionId);
    releases.push(release);
    return release;
  }

  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });

  it('is not in an own call until marked', () => {
    expect(isSessionInOwnCall(nextSessionId())).toBe(false);
  });

  it('counts its calls: releasing one of two marks leaves the session in its own call until the second is released', () => {
    const sessionId = nextSessionId();
    const releaseFirst = mark(sessionId);
    const releaseSecond = mark(sessionId);
    expect(isSessionInOwnCall(sessionId)).toBe(true);

    releaseFirst();
    expect(isSessionInOwnCall(sessionId)).toBe(true);

    releaseSecond();
    expect(isSessionInOwnCall(sessionId)).toBe(false);
  });

  it('runs a release once: calling the same release again does not clear a second call\'s mark', () => {
    const sessionId = nextSessionId();
    const releaseFirst = mark(sessionId);
    const releaseSecond = mark(sessionId);

    releaseFirst();
    releaseFirst();
    expect(isSessionInOwnCall(sessionId)).toBe(true);

    releaseSecond();
    expect(isSessionInOwnCall(sessionId)).toBe(false);
  });
});

describe('waitForOwnAgentTurn', () => {
  /** What the wait reads from the session manager: the sessions' state and the events its turn predicate hears. */
  class StubSessionManager extends EventEmitter {
    readonly activity: Record<string, ActivityState> = {};
    readonly sessions = new Map<string, { id: string; status: SessionStatus }>();

    getActivityCache(): Record<string, ActivityState> {
      return this.activity;
    }

    getSession(sessionId: string): { id: string; status: SessionStatus } | undefined {
      return this.sessions.get(sessionId);
    }
  }

  let sessionManager: StubSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sessionManager = new StubSessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionManager.removeAllListeners();
  });

  /** A session that is mid-turn: were the wait to start, only an idle PTY, an exit or the bound would end it. */
  function addMidTurnSession(sessionId: string, status: SessionStatus): void {
    sessionManager.sessions.set(sessionId, { id: sessionId, status });
    sessionManager.activity[sessionId] = 'thinking';
  }

  /** Starts the wait and reports whether it has returned, without ever blocking the test on it. */
  function startWait(sessionId: string): { isSettled: () => boolean } {
    let settled = false;
    void waitForOwnAgentTurn(sessionManager as unknown as SessionManager, sessionId, 'moved its task').then(() => {
      settled = true;
    });
    return { isSettled: () => settled };
  }

  /** Lets promise callbacks run without moving the fake clock. */
  const flushMicrotasks = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Nothing waited: no listener on the session manager and no timer, the bound's included. */
  function expectNothingWaitedOn(): void {
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('output-seen')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  it('returns at once for a session the manager does not know', async () => {
    const sessionId = nextSessionId();
    sessionManager.activity[sessionId] = 'thinking';

    const wait = startWait(sessionId);
    await flushMicrotasks();

    expect(wait.isSettled()).toBe(true);
    expectNothingWaitedOn();
  });

  it.each<SessionStatus>(['exited', 'suspended', 'queued'])('returns at once for a session that is %s, without waiting for idle or the bound', async (status) => {
    const sessionId = nextSessionId();
    addMidTurnSession(sessionId, status);

    const wait = startWait(sessionId);
    await flushMicrotasks();

    expect(wait.isSettled()).toBe(true);
    expectNothingWaitedOn();
  });

  // The control: the same mid-turn session, running. It proves the cases above
  // are returning because of the status, not because this stub cannot wait.
  it('waits for a running session\'s turn to end: idle and a quiet PTY release it', async () => {
    const sessionId = nextSessionId();
    addMidTurnSession(sessionId, 'running');

    const wait = startWait(sessionId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.isSettled()).toBe(false);
    expect(sessionManager.listenerCount('activity')).toBe(1);

    // The turn's last frame is still painting when the engine reports idle.
    sessionManager.emit('output-seen', sessionId);
    sessionManager.activity[sessionId] = 'idle';
    sessionManager.emit('activity', sessionId, 'idle');
    await flushMicrotasks();
    expect(wait.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(wait.isSettled()).toBe(true);
  });

  it('gives up at the bound when a running session\'s turn never ends', async () => {
    const sessionId = nextSessionId();
    addMidTurnSession(sessionId, 'running');

    const wait = startWait(sessionId);
    await vi.advanceTimersByTimeAsync(OWN_CALL_TURN_WAIT_MS - 1);
    expect(wait.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(wait.isSettled()).toBe(true);
  });
});
