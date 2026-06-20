/**
 * Unit tests for UserInterruptCoordinator.
 *
 * The coordinator owns per-session settle timers for Ctrl+C user interrupts.
 * After a settle window, it checks whether the engine is still "hot"
 * (thinking and stuck) and synthesizes an Interrupted event if so.
 *
 * Key behaviors verified:
 * - `notify()` arms a settle timer; `fireIfStillHot` fires after the window
 * - Multiple Ctrl+C presses within the window collapse to a single timer (re-arm)
 * - `notify()` after `dispose()` is a no-op
 * - `fireIfStillHot` is suppressed when the engine is already idle
 * - `fireIfStillHot` is suppressed when `pendingToolCount===0 && !turnActive`
 *   even if `activity === 'thinking'` (hooks already recovered naturally)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserInterruptCoordinator } from '../../src/main/activity-engine/user-interrupt-coordinator';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

// Short engine timeouts so no watchdog fires during these tests.
const NO_WATCHDOG_OPTIONS = {
  bgShellEscapeHatchMs: 60_000,
  staleThinkingTimeoutMs: 60_000,
  idleStabilityWindowMs: 0,
};

const SETTLE_MS = 500;
const SESSION_ID = 'session-coord-test';

interface PushedEvent {
  sessionId: string;
  event: SessionEvent;
}

function makeCoordinator(): {
  coordinator: UserInterruptCoordinator;
  engine: ActivityEngine;
  pushedEvents: PushedEvent[];
} {
  const pushedEvents: PushedEvent[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange() { /* no-op for coordinator tests */ },
    },
    NO_WATCHDOG_OPTIONS,
  );

  const coordinator = new UserInterruptCoordinator({
    engine,
    pushEvent(sessionId, event) {
      pushedEvents.push({ sessionId, event });
    },
    settleMs: SETTLE_MS,
  });

  return { coordinator, engine, pushedEvents };
}

describe('UserInterruptCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('notify() basic settle-window mechanics', () => {
    it('fires fireIfStillHot after the settle window when session is stuck thinking', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      // Arm the engine to be thinking with pendingToolCount > 0 and turnActive.
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      coordinator.notify(SESSION_ID);

      // Before the window: no event pushed.
      vi.advanceTimersByTime(SETTLE_MS - 10);
      expect(pushedEvents).toHaveLength(0);

      // After the window: synthetic Interrupted pushed.
      vi.advanceTimersByTime(20);
      expect(pushedEvents).toHaveLength(1);
      expect(pushedEvents[0].sessionId).toBe(SESSION_ID);
      expect(pushedEvents[0].event.type).toBe(EventType.Interrupted);
      expect(pushedEvents[0].event.detail).toBe('user-ctrl-c');

      coordinator.dispose();
      engine.dispose();
    });

    it('clears the per-session timer from the map after it fires', () => {
      const { coordinator, engine } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });

      coordinator.notify(SESSION_ID);
      // Verify a timer is tracked (internal state cannot be observed directly,
      // but we can verify that a second notify after firing does not double-fire).
      vi.advanceTimersByTime(SETTLE_MS + 10);

      // Timer has already fired and removed itself. A second notify should
      // create a fresh timer - but since the engine is now idle (Interrupted
      // was processed), the second fire should be a no-op.
      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(SETTLE_MS + 10);

      coordinator.dispose();
      engine.dispose();
    });
  });

  describe('re-arm semantics: multiple Ctrl+C presses collapse to one timer', () => {
    it('second notify cancels first and re-arms; only one event is pushed', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });

      coordinator.notify(SESSION_ID);

      // Half-way through the window, a second Ctrl+C arrives.
      vi.advanceTimersByTime(SETTLE_MS / 2);
      coordinator.notify(SESSION_ID);

      // At the point where the FIRST timer would have fired: no event yet.
      vi.advanceTimersByTime(SETTLE_MS / 2 + 10);
      expect(pushedEvents).toHaveLength(0);

      // After the SECOND timer's window expires: exactly one event.
      vi.advanceTimersByTime(SETTLE_MS / 2);
      expect(pushedEvents).toHaveLength(1);
      expect(pushedEvents[0].event.type).toBe(EventType.Interrupted);

      coordinator.dispose();
      engine.dispose();
    });

    it('three rapid Ctrl+C presses still produce exactly one synthetic event', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });

      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(50);
      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(50);
      coordinator.notify(SESSION_ID);

      // None should have fired yet.
      vi.advanceTimersByTime(SETTLE_MS - 10);
      expect(pushedEvents).toHaveLength(0);

      // Third timer fires.
      vi.advanceTimersByTime(20);
      expect(pushedEvents).toHaveLength(1);

      coordinator.dispose();
      engine.dispose();
    });
  });

  describe('notify() after dispose() is a no-op', () => {
    it('does not arm a timer or push any event after dispose', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });

      coordinator.dispose();
      coordinator.notify(SESSION_ID);

      vi.advanceTimersByTime(SETTLE_MS + 100);
      expect(pushedEvents).toHaveLength(0);

      engine.dispose();
    });

    it('dispose() is idempotent', () => {
      const { coordinator, engine } = makeCoordinator();
      engine.initSession(SESSION_ID);
      coordinator.notify(SESSION_ID);

      expect(() => {
        coordinator.dispose();
        coordinator.dispose();
        coordinator.dispose();
      }).not.toThrow();

      engine.dispose();
    });

    it('dispose() clears all pending timers before they fire', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
      coordinator.notify(SESSION_ID);

      // Dispose before the settle window expires.
      vi.advanceTimersByTime(SETTLE_MS / 2);
      coordinator.dispose();
      vi.advanceTimersByTime(SETTLE_MS);

      // Timer was cancelled; no event should have been pushed.
      expect(pushedEvents).toHaveLength(0);

      engine.dispose();
    });
  });

  describe('fireIfStillHot suppression: engine already idle', () => {
    it('does not push an event when the session is already idle at fire time', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      // Start thinking, schedule interrupt coordinator.
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
      coordinator.notify(SESSION_ID);

      // Hooks fire naturally before the settle window expires.
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Idle });
      // idleStabilityWindowMs=0 so idle is immediate.
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');

      // Settle window expires: engine is now idle, fireIfStillHot should be suppressed.
      vi.advanceTimersByTime(SETTLE_MS + 10);
      expect(pushedEvents).toHaveLength(0);

      coordinator.dispose();
      engine.dispose();
    });

    it('does not push an event for an unknown session (state returns undefined)', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      // Schedule a notify for a session that was never initialized.
      coordinator.notify('unknown-session');

      vi.advanceTimersByTime(SETTLE_MS + 10);
      expect(pushedEvents).toHaveLength(0);

      coordinator.dispose();
      engine.dispose();
    });
  });

  describe('fireIfStillHot suppression: not stuck (pendingTools===0, turn self-recovering)', () => {
    it('is suppressed when thinking is held only by a live subagent (turnActive held, no tool)', () => {
      // A live subagent keeps the parent's turnActive set: its inner Stop no
      // longer ends the parent turn (see ActivityEngine.processEvent's
      // turn-ending gate). The coordinator's stillHot check is
      // pendingToolCount>0 || (turnActive && subagentDepth===0): a subagent
      // holding the turn is NOT "stuck" - its own SubagentStop self-recovers
      // the state - so no Interrupted is synthesized. Forcing idle here would
      // be a false idle while the subagent is still running.
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.SubagentStart });
      // The subagent's inner Stop (Idle at depth > 0) does NOT clear turnActive.
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Idle });
      // subagentDepth>0 keeps activity 'thinking'; turnActive stays set.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);

      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(SETTLE_MS + 10);

      // stillHot: pendingToolCount(0) > 0 is false; turnActive is true but
      // subagentDepth>0 excludes it. So no event synthesized.
      expect(pushedEvents).toHaveLength(0);

      coordinator.dispose();
      engine.dispose();
    });

    it('fires defensively when pendingToolCount>0 even if turnActive was cleared (OR-branch safety net)', () => {
      // `stillHot = pendingToolCount > 0 || turnActive` is defensive
      // programming. In the current engine, the two flags always
      // toggle together: ToolStart sets both, Idle clamps both.
      // There's no legitimate event sequence that produces
      // `pendingToolCount > 0 && turnActive === false` while activity
      // is still 'thinking'. But the OR branch protects against future
      // engine changes (e.g. relaxing the Idle clamp) that could
      // produce that combo. This test verifies the branch fires by
      // constructing the state via direct mutation - if someone
      // accidentally simplifies stillHot to just `state.turnActive`,
      // this test fails.
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // Direct mutation: clear turnActive without touching pendingToolCount
      // or re-deriving activity. This simulates the hypothetical edge case.
      const state = engine.getOrCreateState(SESSION_ID);
      state.turnActive = false;
      expect(state.pendingToolCount).toBe(1);
      expect(state.turnActive).toBe(false);
      expect(state.activity).toBe('thinking');  // last committed transition

      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(SETTLE_MS + 10);

      // pendingToolCount > 0 satisfies stillHot's OR even though turnActive=false.
      expect(pushedEvents).toHaveLength(1);
      expect(pushedEvents[0].event.type).toBe(EventType.Interrupted);

      coordinator.dispose();
      engine.dispose();
    });

    it('fires when turnActive=true, pendingToolCount=0, subagentDepth=0 (bare stuck turn)', () => {
      // Regression guard for the `(turnActive && subagentDepth === 0)` arm of
      // stillHot introduced alongside the subagent depth gate. This arm catches
      // the case where a Prompt set turnActive but no hook (ToolStart / Stop)
      // has fired yet - the turn is genuinely stuck with no self-recovering
      // holder. If someone re-simplifies stillHot to drop the turnActive arm
      // (e.g. `pendingToolCount > 0` only), this test fails and the regression
      // is caught before shipping.
      //
      // A Prompt event sets turnActive=true and pendingToolCount=0 on a fresh
      // session. idleStabilityWindowMs=0 so state settles immediately.
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Prompt });

      // Verify the state that stillHot's turnActive arm targets.
      const state = engine.getState(SESSION_ID)!;
      expect(state.turnActive).toBe(true);
      expect(state.pendingToolCount).toBe(0);
      expect(state.subagentDepth).toBe(0);
      expect(state.activity).toBe('thinking');

      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(SETTLE_MS + 10);

      // pendingToolCount(0) > 0 is false, but turnActive && subagentDepth===0
      // is true, so stillHot is true and one Interrupted must be synthesized.
      expect(pushedEvents).toHaveLength(1);
      expect(pushedEvents[0].sessionId).toBe(SESSION_ID);
      expect(pushedEvents[0].event.type).toBe(EventType.Interrupted);
      expect(pushedEvents[0].event.detail).toBe('user-ctrl-c');

      coordinator.dispose();
      engine.dispose();
    });

    it('is suppressed when thinking is held only by bg shells and turnActive=false', () => {
      const { coordinator, engine, pushedEvents } = makeCoordinator();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.BackgroundShellStart });
      engine.processEvent(SESSION_ID, { ts: Date.now(), type: EventType.Idle });
      // turnActive=false after Idle; bg shell holds thinking.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);

      coordinator.notify(SESSION_ID);
      vi.advanceTimersByTime(SETTLE_MS + 10);

      // stillHot = pendingToolCount(0) > 0 || turnActive(false) = false
      expect(pushedEvents).toHaveLength(0);

      coordinator.dispose();
      engine.dispose();
    });
  });
});
