/**
 * Direct unit tests for ActivityStateMachine, the event-driven state machine
 * that owns the idle <-> thinking transitions for each session.
 *
 * These tests pin the transition table and the two guards (subagent-wake
 * suppression under permission idle, and stop-deferred-until-subagent-done).
 * SessionManager-level integration tests live in event-activity-derivation.test.ts
 * and agent-pty-detection.test.ts -- this file focuses on the state machine
 * itself without the surrounding PTY and file-watcher plumbing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityStateMachine } from '../../src/main/pty/activity/activity-state-machine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

type TransitionLog = Array<{ sessionId: string; activity: ActivityState; permissionIdle: boolean }>;

function makeMachine(): { machine: ActivityStateMachine; transitions: TransitionLog } {
  const transitions: TransitionLog = [];
  const machine = new ActivityStateMachine({
    onActivityChange(sessionId, activity, permissionIdle) {
      transitions.push({ sessionId, activity, permissionIdle });
    },
  });
  return { machine, transitions };
}

function event(type: EventType, detail?: string): SessionEvent {
  return { ts: Date.now(), type, detail };
}

const SESSION_ID = 'session-1';

describe('ActivityStateMachine', () => {
  let machine: ActivityStateMachine;
  let transitions: TransitionLog;

  beforeEach(() => {
    ({ machine, transitions } = makeMachine());
  });

  describe('lifecycle', () => {
    it('emits an initial idle transition on initSession', () => {
      machine.initSession(SESSION_ID);
      expect(transitions).toEqual([
        { sessionId: SESSION_ID, activity: 'idle', permissionIdle: false },
      ]);
      expect(machine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('deleteSession drops all per-session state', () => {
      machine.initSession(SESSION_ID);
      machine.deleteSession(SESSION_ID);
      expect(machine.getState(SESSION_ID)).toBeUndefined();
    });

    it('getActivityCache returns a snapshot of all sessions', () => {
      machine.initSession('a');
      machine.initSession('b');
      machine.forceThinking('b');
      expect(machine.getActivityCache()).toEqual({ a: 'idle', b: 'thinking' });
    });
  });

  describe('basic transitions', () => {
    beforeEach(() => {
      machine.initSession(SESSION_ID);
      transitions.length = 0; // drop the initial idle
    });

    it('tool_start transitions idle -> thinking', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({ sessionId: SESSION_ID, activity: 'thinking', permissionIdle: false });
    });

    it('idle transitions thinking -> idle', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ activity: 'idle', permissionIdle: false });
    });

    it('repeated same-state events do not re-fire onActivityChange', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1); // only the first thinking transition
    });

    it('log-only events (ToolEnd, Notification) do not transition', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      machine.processEvent(SESSION_ID, event(EventType.Notification));
      machine.processEvent(SESSION_ID, event(EventType.SessionStart));
      expect(transitions).toHaveLength(0);
    });

    it('permission idle carries permissionIdle=true in the transition', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      expect(transitions[0]).toEqual({ sessionId: SESSION_ID, activity: 'idle', permissionIdle: true });
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(true);
    });
  });

  describe('Guard 1: suppressSubagentWakeDuringPermission', () => {
    beforeEach(() => {
      machine.initSession(SESSION_ID);
      // Enter thinking, then spawn a subagent, then permission-idle.
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStart, 'general'));
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      transitions.length = 0;
    });

    it('keeps the state idle when a subagent ToolStart fires during permission idle', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      expect(transitions).toHaveLength(0);
      expect(machine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(true);
    });

    it('a fresh Prompt always wakes the state even during permission idle', () => {
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ activity: 'thinking' });
    });

    it('releases the suppression after tool_end drains pendingPermissions to zero', () => {
      // tool_end decrements pendingPermissions at depth <= 1.
      machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      // Now the next tool_start should wake.
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      expect(transitions.at(-1)).toMatchObject({ activity: 'thinking' });
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(false);
    });
  });

  describe('Guard 2: deferStopUntilSubagentFinishes', () => {
    beforeEach(() => {
      machine.initSession(SESSION_ID);
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStart, 'general'));
      transitions.length = 0;
    });

    it('defers a plain idle while a subagent is running', () => {
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Prompt));
      expect(transitions).toHaveLength(0);
      expect(machine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(machine.getState(SESSION_ID)?.pendingIdleWhileSubagent).toBe(true);
    });

    it('emits the deferred idle when the subagent stops', () => {
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Prompt));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(transitions).toEqual([
        { sessionId: SESSION_ID, activity: 'idle', permissionIdle: false },
      ]);
    });

    it('permission idle bypasses the guard - fires immediately', () => {
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ activity: 'idle', permissionIdle: true });
    });

    it('interrupts bypass the guard - fires immediately', () => {
      machine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ activity: 'idle' });
    });

    it('a new Prompt before SubagentStop clears the pending idle', () => {
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Prompt));
      expect(machine.getState(SESSION_ID)?.pendingIdleWhileSubagent).toBe(true);
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(machine.getState(SESSION_ID)?.pendingIdleWhileSubagent).toBe(false);
    });
  });

  describe('pendingPermissions counter', () => {
    it('freezes at depth >= 2 to preserve sticky behavior', () => {
      machine.initSession(SESSION_ID);
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStart, 'a'));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStart, 'b'));
      transitions.length = 0;

      // Depth-2 permission idle: counter should NOT increment.
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      expect(machine.getState(SESSION_ID)?.pendingPermissions).toBe(0);

      // Depth-2 tool_end: should not clear permissionIdle since counter was 0.
      machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(true);
    });

    it('increments once per permission idle at depth <= 1 and decrements on tool_end', () => {
      machine.initSession(SESSION_ID);
      machine.processEvent(SESSION_ID, event(EventType.Prompt));
      machine.processEvent(SESSION_ID, event(EventType.SubagentStart, 'a'));
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      expect(machine.getState(SESSION_ID)?.pendingPermissions).toBe(2);
      machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(machine.getState(SESSION_ID)?.pendingPermissions).toBe(1);
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(true);
      machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(machine.getState(SESSION_ID)?.pendingPermissions).toBe(0);
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(false);
    });
  });

  describe('forceThinking / forceIdle', () => {
    beforeEach(() => {
      machine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('forceThinking from idle fires a transition and records timestamps', () => {
      machine.forceThinking(SESSION_ID);
      expect(transitions[0]).toMatchObject({ activity: 'thinking' });
      const state = machine.getState(SESSION_ID)!;
      expect(state.activity).toBe('thinking');
      expect(state.lastThinkingSignal).not.toBeNull();
      expect(state.firstThinkingTimestamp).not.toBeNull();
      expect(state.idleTimestamp).toBeNull();
    });

    it('forceIdle clears permissionIdle regardless of source', () => {
      machine.processEvent(SESSION_ID, event(EventType.ToolStart));
      machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(true);
      transitions.length = 0;
      machine.forceIdle(SESSION_ID);
      expect(machine.getState(SESSION_ID)?.permissionIdle).toBe(false);
      expect(transitions[0]).toMatchObject({ activity: 'idle', permissionIdle: false });
    });

    it('forceThinking after forceIdle keeps firstThinkingTimestamp sticky', () => {
      machine.forceThinking(SESSION_ID);
      const firstTimestamp = machine.getState(SESSION_ID)!.firstThinkingTimestamp;
      machine.forceIdle(SESSION_ID);
      machine.forceThinking(SESSION_ID);
      expect(machine.getState(SESSION_ID)!.firstThinkingTimestamp).toBe(firstTimestamp);
    });
  });

  describe('PR command detector accessors', () => {
    it('defaults to false and persists across set/get', () => {
      expect(machine.hasPendingPRCommand(SESSION_ID)).toBe(false);
      machine.setPendingPRCommand(SESSION_ID, true);
      expect(machine.hasPendingPRCommand(SESSION_ID)).toBe(true);
      machine.setPendingPRCommand(SESSION_ID, false);
      expect(machine.hasPendingPRCommand(SESSION_ID)).toBe(false);
    });

    it('is isolated per session', () => {
      machine.setPendingPRCommand('a', true);
      machine.setPendingPRCommand('b', false);
      expect(machine.hasPendingPRCommand('a')).toBe(true);
      expect(machine.hasPendingPRCommand('b')).toBe(false);
    });
  });

  describe('markThinkingSignal', () => {
    it('is a no-op on unknown sessions', () => {
      expect(() => machine.markThinkingSignal('nope')).not.toThrow();
    });

    it('updates lastThinkingSignal without firing a transition', () => {
      machine.initSession(SESSION_ID);
      machine.forceThinking(SESSION_ID);
      const before = machine.getState(SESSION_ID)!.lastThinkingSignal;
      transitions.length = 0;
      // Advance time so the stamp changes deterministically.
      const later = before! + 1000;
      const originalNow = Date.now;
      Date.now = () => later;
      try {
        machine.markThinkingSignal(SESSION_ID);
      } finally {
        Date.now = originalNow;
      }
      expect(machine.getState(SESSION_ID)!.lastThinkingSignal).toBe(later);
      expect(transitions).toHaveLength(0);
    });
  });
});
