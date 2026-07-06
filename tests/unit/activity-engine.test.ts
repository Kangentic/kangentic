/**
 * Direct unit tests for ActivityEngine, the predicate-based activity engine
 * that owns idle/thinking/permission transitions for each session.
 *
 * These tests pin:
 * - The single predicate (turnActive | tools | subagent | bg shells)
 * - 3-state permission as a top-level state
 * - Discriminated-union ActivityReason (kind: 'tool'|'subagent'|...)
 * - Counter mechanics for tools, subagents, bg shells (Set-based + anonymous fallback)
 * - currentTool stickiness
 * - Force paths (forceThinking, forceIdle, markThinkingSignal)
 * - Interrupted bypasses everything to immediate idle
 * - 5-min escape hatch for orphaned background shells
 * - 180s stale-thinking watchdog
 * - 400ms idle stability window
 * - markBackgroundShellEnded (Subsystem B watcher entry point)
 * - adoptAnonymousBackgroundShells (Subsystem G resume entry point)
 * - getStatsSnapshot (Subsystem E debug surface)
 * - dispose() idempotent + clears timers
 *
 * Tests construct ActivityEngine with explicit options to keep timers
 * tight (vs the production 5min/45s defaults). Production code never
 * mutates the engine timing constants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine, type ActivityEngineOptions } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionEvent } from '../../src/shared/types';

/** Load a sanitized real-capture replay fixture (one JSON event per line). */
function loadReplayFixture(name: string): SessionEvent[] {
  const filePath = path.join(__dirname, '..', 'fixtures', 'replay', name);
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

interface Transition {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
}

interface SyntheticEvent {
  sessionId: string;
  event: SessionEvent;
}

// Test timings: short windows so tests run in single-digit ms
const TEST_BG_SHELL_HATCH_MS = 5_000;
const TEST_STALE_TIMEOUT_MS = 1_000;
const TEST_STABILITY_WINDOW_MS = 100;
// Idle-hint-shortened stuck-counter grace. Deliberately below the 5s hatch so
// the stuck-subagent / stuck-pending-tools tests can prove the SHORT path fires
// well before the long cap would.
const TEST_STALE_AFTER_IDLE_HINT_MS = 1_500;

function makeEngine(options: Partial<ActivityEngineOptions> = {}): {
  engine: ActivityEngine;
  transitions: Transition[];
  syntheticEvents: SyntheticEvent[];
} {
  const transitions: Transition[] = [];
  const syntheticEvents: SyntheticEvent[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(sessionId, activity, reason) {
        transitions.push({ sessionId, activity, reason });
      },
      onSyntheticEvent(sessionId, event) {
        syntheticEvents.push({ sessionId, event });
      },
    },
    {
      bgShellEscapeHatchMs: TEST_BG_SHELL_HATCH_MS,
      // The bg-shell hatch is now anchored to bgShellHoldSince; default its
      // grace to the same test window so the hatch tests below fire on the
      // same advanceTimersByTime they always used.
      bgShellOnlyGraceMs: TEST_BG_SHELL_HATCH_MS,
      staleThinkingTimeoutMs: TEST_STALE_TIMEOUT_MS,
      staleAfterIdleHintMs: TEST_STALE_AFTER_IDLE_HINT_MS,
      idleStabilityWindowMs: TEST_STABILITY_WINDOW_MS,
      ...options,
    },
  );
  return { engine, transitions, syntheticEvents };
}

function event(type: EventType, opts?: { detail?: string; tool?: string; toolId?: string }): SessionEvent {
  return { ts: Date.now(), type, detail: opts?.detail, tool: opts?.tool, toolId: opts?.toolId };
}

const SESSION_ID = 'session-1';

/** Type-narrow ActivityReason to a specific kind for assertions. */
function asTool(reason: ActivityReason) {
  if (reason.kind !== 'tool') throw new Error(`expected tool reason, got ${reason.kind}`);
  return reason;
}
function asSubagent(reason: ActivityReason) {
  if (reason.kind !== 'subagent') throw new Error(`expected subagent reason, got ${reason.kind}`);
  return reason;
}
function asBgShell(reason: ActivityReason) {
  if (reason.kind !== 'background-shell') throw new Error(`expected background-shell reason, got ${reason.kind}`);
  return reason;
}

describe('ActivityEngine', () => {
  let engine: ActivityEngine;
  let transitions: Transition[];
  let syntheticEvents: SyntheticEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    ({ engine, transitions, syntheticEvents } = makeEngine());
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('emits an initial idle transition on initSession', () => {
      engine.initSession(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].sessionId).toBe(SESSION_ID);
      expect(transitions[0].activity).toBe('idle');
      expect(transitions[0].reason.kind).toBe('idle');
    });

    it('seeds an initial thinking transition for a fresh spawn (initialTurnActive)', () => {
      // A fresh agent spawn is already processing its initial prompt, so the
      // first emitted state is thinking - no idle flash during the boot window.
      engine.initSession(SESSION_ID, true);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].sessionId).toBe(SESSION_ID);
      expect(transitions[0].activity).toBe('thinking');
      expect(transitions[0].reason.kind).toBe('turn-active');
    });

    it('watchdog is armed on a seeded-thinking spawn (stale-thinking reclaims it when no hook follows)', () => {
      // The fix: initSession calls scheduleTimer after seeding thinking so the
      // stale-thinking watchdog fires when the agent never emits a hook event.
      // Without the scheduleTimer call, the seeded session stays 'thinking'
      // forever because no event processing ever arms the timer.
      //
      // Red-green: remove the this.scheduleTimer(sessionId, state) line from
      // initSession and this test goes red (activity stays 'thinking' after the
      // timeout; staleThinking counter stays 0).
      engine.initSession(SESSION_ID, true);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      transitions.length = 0;
      syntheticEvents.length = 0;

      // Advance past the stale-thinking threshold. The watchdog must reclaim
      // the session to idle and emit a synthetic Idle/Timeout event.
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);

      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      expect(snapshot.compensationCounters.staleThinking).toBe(1);
      // Synthetic Idle/Timeout event must have been emitted.
      expect(syntheticEvents).toHaveLength(1);
      expect(syntheticEvents[0].event.type).toBe(EventType.Idle);
      expect(syntheticEvents[0].event.detail).toBe(IdleReason.Timeout);
    });

    it('idleTimestamp invariant: thinking seed leaves it null, idle seed stamps it', () => {
      // The code comment in initSession says: "A seeded 'thinking' turn leaves
      // idleTimestamp null, preserving the invariant that idleTimestamp is
      // non-null iff activity is 'idle'." Verify both branches.
      engine.initSession(SESSION_ID, true);
      expect(engine.getState(SESSION_ID)?.idleTimestamp).toBeNull();
      engine.deleteSession(SESSION_ID);

      // Idle seed (default / resuming / transient) must stamp idleTimestamp.
      engine.initSession(SESSION_ID, false);
      expect(engine.getState(SESSION_ID)?.idleTimestamp).not.toBeNull();
    });

    it('deleteSession drops all per-session state', () => {
      engine.initSession(SESSION_ID);
      engine.deleteSession(SESSION_ID);
      expect(engine.getState(SESSION_ID)).toBeUndefined();
    });

    it('getActivityCache returns a snapshot of all sessions', () => {
      engine.initSession('a');
      engine.initSession('b');
      engine.forceThinking('b');
      expect(engine.getActivityCache()).toEqual({ a: 'idle', b: 'thinking' });
    });

    it('getActivityReason returns null for unknown sessions and a snapshot otherwise', () => {
      expect(engine.getActivityReason('unknown')).toBeNull();
      engine.initSession(SESSION_ID);
      const reason = engine.getActivityReason(SESSION_ID);
      expect(reason).not.toBeNull();
      expect(reason!.kind).toBe('idle');
    });

    it('dispose() clears all timers and is idempotent', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      // Trigger timer arming via stale-thinking watchdog window
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const transitionCountBeforeDispose = transitions.length;
      engine.dispose();
      expect(vi.getTimerCount()).toBe(0);
      // Idempotent
      expect(() => engine.dispose()).not.toThrow();
      // Post-dispose, processEvent is a no-op
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      expect(transitions.length).toBe(transitionCountBeforeDispose);
    });
  });

  describe('basic transitions', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('tool_start transitions idle -> thinking with reason.kind=tool', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      const reason = asTool(transitions[0].reason);
      expect(reason.pendingCount).toBe(1);
      expect(reason.currentTool).toBe('Bash');
    });

    it('prompt event transitions to thinking and stays within stale-thinking window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      // Just before the stale watchdog window expires, still thinking
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS - 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('Idle event transitions thinking -> idle through stability window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Stability window: NOT yet idle
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      // Window expires
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      expect(transitions[0].reason.kind).toBe('idle');
    });

    it('tool_end does NOT transition (turnActive holds)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('repeated same-state events do not re-fire onActivityChange', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
    });

    it('log-only events do not transition', () => {
      engine.processEvent(SESSION_ID, event(EventType.Notification));
      engine.processEvent(SESSION_ID, event(EventType.SessionStart));
      engine.processEvent(SESSION_ID, event(EventType.ModelStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('permission idle transitions to permission state immediately (3rd state)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      // Permission is immediate, not gated by stability window
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('permission');
      expect(transitions[0].reason.kind).toBe('permission');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
    });

    it('Interrupted bypasses stability window and fires immediate idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
    });
  });

  describe('predicate: counters keep thinking past Idle', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('long-running tool: turnActive holds thinking until Idle + window', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      vi.advanceTimersByTime(500);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Stability window before idle
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('a subagent Idle does not end the parent turn; the parent Stop at depth 0 does', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      transitions.length = 0;

      // A subagent's inner-loop Stop arrives as Idle while the subagent is live
      // (subagentDepth > 0). It is the SUBAGENT's stop, not the parent's, so it
      // must NOT end the parent turn: the session stays thinking.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      const reason = asSubagent(engine.getActivityReason(SESSION_ID)!);
      expect(reason.depth).toBe(1);

      // The subagent returns (depth -> 0). The parent turn is still active
      // (turnActive was never cleared by the subagent's Idle), so the session
      // stays thinking - the parent is about to consume the subagent result.
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // The parent fires its OWN Stop (Idle at depth 0): now the turn ends.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('background shell keeps thinking until BackgroundShellEnd', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(1);
      expect(reason.ids).toEqual(['bash_1']);

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd, { detail: 'bash_1' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('Idle event clears stale pendingToolCount (PostToolUse hook drop recovery)', () => {
      // Regression: Claude Code's PostToolUse hook can drop or be
      // killed mid-tool, leaving an unmatched ToolStart and a stuck
      // pendingToolCount > 0. The bg-shell watcher's pending-tools
      // guard then permanently suppresses natural-exit, leaving bg
      // shells stuck in the count after the agent has officially
      // stopped. Idle (Stop hook) means the agent's turn is done -
      // any in-flight tools are stale and must be cleared.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      // Only one of them gets a ToolEnd. The other is dropped.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(1);

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)!.currentTool).toBeNull();
    });

    it('Idle with permission detail does NOT clear pendingToolCount (tool may resume)', () => {
      // Permission idle is the agent pausing for approval - it may
      // resume the same tool. Don't clear counters.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Edit' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)!.currentTool).toBe('Edit');
    });

    it('Stop with BOTH subagent and bg shell active holds until both drain AND the parent Stop', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      transitions.length = 0;

      // The subagent's inner Idle does not end the parent turn (depth > 0).
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('background-shell');

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      // Subagent and bg shell both drained, but the parent turn is still active.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // The parent's own Stop (Idle at depth 0, no holders) ends the turn.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
    });

    it('reverse composite order (bg shell ends first, then subagent), then the parent Stop', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      // Both holders drained, but the parent turn is still active.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // The parent's own Stop (Idle at depth 0) ends the turn.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
    });

    it('permission idle at subagentDepth > 0 does NOT clear turnActive (new depth gate)', () => {
      // Regression guard for the TURN_ENDING_EVENTS gate introduced in the
      // false-idle-during-live-subagent fix. Before the fix, any Idle event
      // (including idle:permission) cleared turnActive unconditionally. The fix
      // gates the clear on subagentDepth === 0 (or EventType.Interrupted).
      //
      // Sequence: parent Prompt -> SubagentStart -> permission Idle at depth 1.
      // The permission flag must be set (so activity = 'permission'), but
      // turnActive must remain true - the parent turn is NOT over, it is blocked
      // by the live subagent that triggered the permission prompt.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));

      // Permission is immediate (no stability window).
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('permission');

      const state = engine.getState(SESSION_ID)!;
      // The permission flag is set - the UI must display the permission prompt.
      expect(state.permissionPending).toBe(true);
      // The depth gate must have preserved turnActive - the parent turn is not done.
      expect(state.turnActive).toBe(true);
    });

    it('Interrupted at subagentDepth > 0 clears turnActive (depth gate bypass)', () => {
      // The Interrupted arm in TURN_ENDING_EVENTS is the ONLY path that clears
      // turnActive when subagentDepth > 0. applyInterruptedBypass (which fires
      // immediately after) resets counters but does NOT touch turnActive, so
      // without the `event.type === EventType.Interrupted` branch, an interrupt
      // inside a subagent context would leave turnActive stuck true permanently.
      //
      // Sequence: Prompt -> SubagentStart -> plain Idle (held by gate, depth > 0)
      // -> Interrupted. After the plain Idle the turn must still be active;
      // after the Interrupted both turnActive and subagentDepth must be zero.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));

      // Plain subagent Idle - gate holds turnActive.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      // Reason is 'subagent' while the subagent counter still holds.
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('subagent');
      transitions.length = 0;

      // User presses Ctrl+C - Interrupted fires while subagentDepth === 1.
      engine.processEvent(SESSION_ID, event(EventType.Interrupted));

      // Interrupted bypasses the stability window.
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');

      const state = engine.getState(SESSION_ID)!;
      // The Interrupted || branch must have cleared turnActive.
      expect(state.turnActive).toBe(false);
      // applyInterruptedBypass zeroes the subagent counter.
      expect(state.subagentDepth).toBe(0);
    });
  });

  describe('idle stability window', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('Stop + thinking signal within window suppresses idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Halfway through window, a fresh ToolStart arrives
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS / 2);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      // Advance past where the window WOULD have fired
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      // No idle transition was emitted
      expect(transitions.filter((t) => t.activity === 'idle')).toHaveLength(0);
    });

    it('Stop + no signal emits idle after window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS - 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      vi.advanceTimersByTime(20);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('Permission idle bypasses window (instant)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      // No window for permission
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('permission');
    });

    it('window is 0 when idleStabilityWindowMs option is 0', () => {
      const e = makeEngine({ idleStabilityWindowMs: 0 });
      e.engine.initSession(SESSION_ID);
      e.engine.processEvent(SESSION_ID, event(EventType.Prompt));
      e.transitions.length = 0;
      e.engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Instant idle, no window
      expect(e.transitions).toHaveLength(1);
      expect(e.transitions[0].activity).toBe('idle');
      e.engine.dispose();
    });
  });

  describe('permission state', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('Prompt clears permissionPending and wakes to thinking', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('subagent ToolStart at depth>0 does NOT clear permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('Interrupted clears permissionPending and forces idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('non-permission Idle clears permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('permission-resolving tool_end restores thinking immediately (AskUserQuestion / ExitPlanMode resume)', () => {
      // A permission-class pause (AskUserQuestion, ExitPlanMode plan-approval,
      // tool prompt) begins with idle:permission, which clears turnActive. When
      // it resolves, the only signal is a depth-0 tool_end - a non-turn-initiating
      // event that clears permissionPending but never re-arms turnActive. Without the
      // fix the predicate drops to idle and the card sits idle until the PTY
      // force-thinking net catches up seconds later. The resumed turn must show
      // as thinking the instant the pause resolves.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'AskUserQuestion' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'AskUserQuestion' }));

      // No timer advance: recovery is immediate via the hook, not the stability
      // window or the PTY net.
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('a normal tool_end with no permission pending does NOT force turnActive (guard is load-bearing)', () => {
      // Drive to a clean idle: a full tool cycle then an explicit Idle.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      transitions.length = 0;

      // A stray depth-0 tool_end arriving while idle (permissionPending=false)
      // must NOT resurrect turnActive via the permission-resume branch.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(transitions).toHaveLength(0);
    });

    it('subagent ToolEnd at depth>0 does NOT clear permissionPending or wake the turn', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      // The tool belongs to the still-running subagent, not the paused main
      // agent - it must not clear permission or re-arm the turn.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('subagent ToolEnd carrying the AWAITED toolId clears permissionPending (approved tool)', () => {
      // Task #194: a tool inside a subagent raised the permission prompt
      // (PreToolUse fired, then idle:permission). The user approved and the
      // tool ran to completion - its tool_end carries the same toolId but
      // arrives at depth 1, which the depth-0 gate ignores. The awaited-tool
      // match must clear the flag regardless of depth and resume the turn.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell', toolId: 'tool-awaited' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'PowerShell', toolId: 'tool-awaited' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
    });

    it('subagent tool events with a DIFFERENT toolId still do NOT clear permissionPending', () => {
      // The parallel-subagent property the depth gate protects: unrelated
      // subagent tool churn must not dismiss a genuinely pending prompt.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell', toolId: 'tool-awaited' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'tool-unrelated' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read', toolId: 'tool-unrelated' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('duplicate ToolStart carrying the awaited toolId also clears (duplicate-safe)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell', toolId: 'tool-awaited' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell', toolId: 'tool-awaited' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('no-toolId permission: permissionAwaitedToolId is null and depth-0 ToolEnd still clears (id-less adapter no-regression)', () => {
      // When an adapter supplies no correlation id, updatePermissionFlag must
      // store null in permissionAwaitedToolId (the `?? null` fallback). The
      // pre-existing depth-0 gate must still clear permissionPending so
      // adapters without toolId support are not permanently stuck.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      // The stack top has no id, so permissionAwaitedToolId must be null.
      expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBeNull();
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      // Depth-0 ToolEnd with no toolId - the existing depth-0 gate fires.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      // The permission-resume branch restores turnActive, so activity is
      // thinking (not stuck idle) after the depth-0 gate clears the flag.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });
  });

  describe('force paths', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('forceThinking from idle emits thinking transition with turnActive', () => {
      engine.forceThinking(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
    });

    it('forceIdle from thinking emits idle and clears all counters', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;

      engine.forceIdle(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      const state = engine.getState(SESSION_ID)!;
      expect(state.turnActive).toBe(false);
      expect(state.subagentDepth).toBe(0);
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.pendingToolCount).toBe(0);
      expect(state.currentTool).toBeNull();
    });

    it('forceIdle from permission clears permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.forceIdle(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(transitions[0].activity).toBe('idle');
    });

    it('forceIdle nulls lastPtyOutputAt so a stale PTY timestamp cannot defer the stuck-pending deadline', () => {
      // markPtyOutput sets lastPtyOutputAt to a non-null timestamp. forceIdle
      // must reset it to null; otherwise the watchdogBaseTime for the
      // stuck-pending-tools hold would use the stale PTY time as its base and
      // the watchdog would not fire until an additional 5 minutes past the force-idle.
      // We verify via getStatsSnapshot which exposes both lastPtyOutputAt and
      // msSincePtyOutput directly.

      // Start the engine with a real clock so markPtyOutput produces a real timestamp.
      engine.markPtyOutput(SESSION_ID);

      // Confirm the PTY timestamp is set before force-idle.
      const snapshotBeforeForceIdle = engine.getStatsSnapshot(SESSION_ID);
      expect(snapshotBeforeForceIdle).not.toBeNull();
      expect(snapshotBeforeForceIdle!.lastPtyOutputAt).not.toBeNull();
      expect(snapshotBeforeForceIdle!.msSincePtyOutput).not.toBeNull();

      engine.forceIdle(SESSION_ID);

      // After forceIdle, both fields must be null.
      const snapshotAfterForceIdle = engine.getStatsSnapshot(SESSION_ID);
      expect(snapshotAfterForceIdle).not.toBeNull();
      expect(snapshotAfterForceIdle!.lastPtyOutputAt).toBeNull();
      expect(snapshotAfterForceIdle!.msSincePtyOutput).toBeNull();
    });

    it('forceThinking clears permissionAwaitedToolId when a tracked toolId is pending', () => {
      // Drive the engine to permission state with a tracked awaited toolId so
      // the field is non-null before forceThinking fires. Starting from idle
      // (the prior test) would leave it null from the start and miss a
      // regression in the `state.permissionAwaitedToolId = null` line.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell', toolId: 'tool-x' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBe('tool-x');
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      engine.forceThinking(SESSION_ID);

      // The field must be null - this is the line under test in forceThinking().
      expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBeNull();
      // forceThinking also clears permissionPending and sets thinking.
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
    });

    it('markThinkingSignal is no-op on unknown sessions', () => {
      expect(() => engine.markThinkingSignal('unknown')).not.toThrow();
    });

    it('markThinkingSignal updates lastSignalAt without firing a transition', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      transitions.length = 0;
      vi.advanceTimersByTime(500);
      const before = engine.getState(SESSION_ID)!.lastSignalAt;
      engine.markThinkingSignal(SESSION_ID);
      expect(engine.getState(SESSION_ID)!.lastSignalAt).not.toBe(before);
      expect(transitions).toHaveLength(0);
    });
  });

  describe('ActivityReason discriminated union', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('priority: permission > tool > subagent > background-shell > turn-active > idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('permission');

      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('tool');

      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('subagent');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('background-shell');

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('turn-active');

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('idle');
    });

    it('exposes granular counts via narrowing', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const toolReason = asTool(engine.getActivityReason(SESSION_ID)!);
      expect(toolReason.pendingCount).toBe(1);
      expect(toolReason.currentTool).toBe('Bash');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      const subagentReason = asSubagent(engine.getActivityReason(SESSION_ID)!);
      expect(subagentReason.depth).toBe(2);
    });

    it('background-shell reason exposes ids', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(2);
      expect(new Set(reason.ids)).toEqual(new Set(['bash_1', 'bash_2']));
    });
  });

  describe('currentTool stickiness', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('is set on ToolStart and persists across the tool lifetime', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
    });

    it('is replaced by the next ToolStart', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Read');
    });

    it('is cleared when pendingToolCount drops to 0', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('survives one tool ending while another is still in flight', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Read');
    });

    it('falls back to the still-running tool when the most recent ends first', () => {
      // Concurrent tools that end out-of-order: A starts, B starts, B
      // ends. Old behavior (single field) would leave currentTool='B'
      // because pendingToolCount stays > 0. Stack-based tracking falls
      // back to A which is genuinely still in flight.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Grep' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Grep');
    });

    it('handles three concurrent tools ending in arbitrary order', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'A' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'B' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'C' }));
      // End B (middle): A and C still in flight, currentTool=C (top of stack).
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'B' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('C');
      // End C (top): A still in flight.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'C' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('A');
      // End A (last): all clear.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'A' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('handles duplicate tool names by removing the most recent occurrence', () => {
      // Two concurrent Bash invocations - hooks don't carry correlation
      // IDs, so LIFO-by-name is the closest correlation we can do.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(2);
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('hard-resets the stack when pendingToolCount reaches zero (recovers from name desync)', () => {
      // A hook drop could leave a name in the stack with no matching count.
      // The hard-reset on pendingToolCount=0 ensures the stack does not
      // grow forever across drift.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Stale' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Real' }));
      // Simulate ToolEnd arriving for an unknown tool name (name drift).
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Mystery' }));
      // Stale and Real still in stack since neither matched 'Mystery'.
      // pendingToolCount decremented to 1.
      // Now ToolEnd 'Real' decrements to 0 - hard reset clears stack.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Real' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([]);
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('ID-based correlation: ToolEnd matches ToolStart by toolId regardless of order', () => {
      // The killer scenario: two concurrent Bash invocations with
      // different toolIds. LIFO-by-name would always remove the most
      // recent, leaving currentTool wrong. ID-matching removes the
      // exact one that ended.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'tu_001' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'tu_002' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_001', name: 'Bash' },
        { id: 'tu_002', name: 'Bash' },
      ]);
      // The FIRST Bash (tu_001) ends - even though it's not at the top.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash', toolId: 'tu_001' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_002', name: 'Bash' },
      ]);
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
    });

    it('ID-based correlation: falls back to LIFO-by-name when ID does not match', () => {
      // Hook drop / version skew: ToolStart had ID, ToolEnd arrives
      // with a different ID. We still drain the stack via name to
      // avoid getting permanently stuck.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'tu_001' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'tu_002' }));
      // ToolEnd with mismatched ID.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read', toolId: 'tu_999' }));
      // Fell back to LIFO-by-name - removed the most recent Read.
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_001', name: 'Read' },
      ]);
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
    });

    it('mixed ID and no-ID adapters coexist on the same stack', () => {
      // Edge case: an adapter rolls out IDs incrementally. Some events
      // have toolId, others don't. Stack must handle both.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'A', toolId: 'tu_a' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'B' }));  // no id
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'C', toolId: 'tu_c' }));
      // ToolEnd by id removes A precisely.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'A', toolId: 'tu_a' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: undefined, name: 'B' },
        { id: 'tu_c', name: 'C' },
      ]);
      // ToolEnd without id falls back to LIFO-by-name - removes C.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'C' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: undefined, name: 'B' },
      ]);
    });
  });

  describe('5-min stuck-pending-tools watchdog (Ctrl+C hook drop recovery)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
      syntheticEvents.length = 0;
    });

    it('fires after threshold when only pendingToolCount is holding (turnActive=true)', () => {
      // Reproduces the user-reported bug: user pressed Ctrl+C, Claude
      // killed the bash, but PostToolUseFailure didn't propagate.
      // Engine has pending=1 + turnActive=true with no other holders
      // and no events arriving. Without this watchdog the engine is
      // stuck in 'thinking' forever.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('thinking');
      expect(state.pendingToolCount).toBe(1);
      expect(state.turnActive).toBe(true);

      // Advance past the 5-min hatch threshold + stability window.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 50);

      const lastTransition = transitions.at(-1);
      expect(lastTransition?.activity).toBe('idle');
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.turnActive).toBe(false);
      // Synthetic Idle/Timeout event was emitted to the activity log.
      expect(syntheticEvents.at(-1)?.event.type).toBe(EventType.Idle);
      expect(syntheticEvents.at(-1)?.event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire while a subagent is also active (legitimate work)', () => {
      // Subagent depth > 0 means agent is doing nested work - sub-tools
      // emit events that refresh lastSignalAt. Not stuck.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 50);
      // Still thinking - subagent + tool is legitimate.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while bg shells are also active (separate hatch handles those)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 50);
      // Still thinking - the bg-shell hatch's predicate doesn't match
      // either (pendingToolCount>0). The pending-tools hatch's
      // predicate doesn't match either (bgShells>0). Mutual exclusion
      // is intentional: when multiple holders co-exist, no hatch fires
      // because there's a chance one is genuine activity.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('signal during the wait re-arms with fresh deadline', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      // Half the threshold passes...
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      // A nested ToolStart arrives - refreshes lastSignalAt.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      // Half the threshold AGAIN passes - total time is more than
      // threshold but the deadline was reset, so still thinking.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2 + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });
  });

  describe('5-min stuck-subagent watchdog (dropped named SubagentStop recovery)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
      syntheticEvents.length = 0;
    });

    it('recovers a subagentDepth stuck > 0 after the named terminal stop is lost', () => {
      // Real shape introduced by the task #237 fix: a subagent starts, fires
      // its spurious empty-detail inner stop (ignored by updateCounters, so
      // depth stays > 0), but its authoritative NAMED terminal stop is dropped
      // - depth never returns to 0. Every OTHER watchdog gates on
      // subagentDepth === 0 and the PTY-tracker forceIdle is suppressed for
      // hook-active agents, so without this hold the board is stuck thinking.
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'Explore' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop, { detail: '' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('thinking');
      expect(state.subagentDepth).toBe(1);

      // Advance past the 5-min cap + stability window.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 50);

      expect(transitions.at(-1)?.activity).toBe('idle');
      expect(state.subagentDepth).toBe(0);
      expect(state.turnActive).toBe(false);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(1);
      // Synthetic Idle/Timeout event was emitted to the activity log.
      expect(syntheticEvents.at(-1)?.event.type).toBe(EventType.Idle);
      expect(syntheticEvents.at(-1)?.event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire while a nested tool keeps refreshing the signal (genuine work)', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'Explore' }));
      // Half the cap passes, then a nested tool event refreshes lastSignalAt.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      // Half the cap AGAIN - total exceeds the cap, but the deadline re-armed.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2 + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);
    });

    it('does NOT fire while pending tools co-exist (mutual exclusion)', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'Explore' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 50);
      // pendingToolCount > 0 -> the stuck-subagent predicate (pending === 0)
      // does not match, and the stuck-pending predicate (depth === 0) does
      // not match either; no recovery fires while both holders co-exist.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });
  });

  describe('aborted/errored-turn recovery (StopFailure + idle-hint)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
      syntheticEvents.length = 0;
    });

    // ---- Layer A: StopFailure -> turn_failed -> hard reset, immediate idle ----

    it('turn_failed resets a stuck subagentDepth and idles immediately (service-error abort)', () => {
      // A subagent started but its NAMED terminal stop was lost (only the
      // ignored empty inner stop arrived), so depth is stuck > 0.
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'test-builder' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop, { detail: '' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);
      transitions.length = 0;

      // Claude's StopFailure hook fires (turn aborted by an API error), mapped
      // to turn_failed: a hard turn-end that resets counters and idles NOW, not
      // 5 minutes from now via the watchdog.
      engine.processEvent(SESSION_ID, event(EventType.TurnFailed, { detail: 'rate_limit' }));

      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('idle');
      expect(state.subagentDepth).toBe(0);
      expect(state.turnActive).toBe(false);
      expect(transitions.at(-1)?.activity).toBe('idle');
      // The error type is preserved in the trigger for outage diagnosis, and is
      // distinct from a user-Esc 'interrupted'.
      expect(state.recentTransitions.at(-1)?.trigger).toBe('event:turn_failed:rate_limit');
    });

    it('turn_failed clears stuck pending tools too (lost tool_end in an aborted turn)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Agent', toolId: 't1' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Agent', toolId: 't2' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(2);

      engine.processEvent(SESSION_ID, event(EventType.TurnFailed, { detail: 'overloaded' }));

      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('idle');
      expect(state.pendingToolCount).toBe(0);
      expect(state.turnActive).toBe(false);
    });

    it('turn_failed with no detail still idles (trigger carries no error suffix)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.TurnFailed));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('idle');
      expect(state.recentTransitions.at(-1)?.trigger).toBe('event:turn_failed');
    });

    // ---- Layer B: idle-hint shortens the stuck-counter watchdogs ----

    it('reclaims a subagentDepth stuck by an idle_hint on the SHORT grace, not the 5-min cap (#277)', () => {
      // Condensed task #277: a subagent's named stop is lost (depth stuck = 1),
      // the parent Stop fires (gated by depth > 0, so turnActive stays true),
      // then the agent reports it is waiting for input.
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'test-builder' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop, { detail: '' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);
      expect(engine.getStatsSnapshot(SESSION_ID)?.idleHintPending).toBe(true);
      transitions.length = 0;

      // The SHORT grace (1.5s) fires well before the 5-min cap (5s in tests).
      vi.advanceTimersByTime(TEST_STALE_AFTER_IDLE_HINT_MS + TEST_STABILITY_WINDOW_MS + 50);

      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(0);
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(1);
    });

    it('still holds thinking BEFORE the short grace elapses (the cap was not simply removed)', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'test-builder' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop, { detail: '' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      // Just under the short grace: not reclaimed yet.
      vi.advanceTimersByTime(TEST_STALE_AFTER_IDLE_HINT_MS - 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(0);
    });

    it('reclaims stuck pending tools on the short grace after an idle_hint', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 't1' }));
      // The Stop hook's Idle zeros pending tools, so to model a LOST tool_end
      // with no intervening Stop we go straight to the idle_hint.
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      vi.advanceTimersByTime(TEST_STALE_AFTER_IDLE_HINT_MS + TEST_STABILITY_WINDOW_MS + 50);

      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckPendingTools).toBe(1);
    });

    it('does NOT reclaim a genuinely-live subagent after an idle_hint while PTY keeps streaming (#237 guard)', () => {
      // Claude's idle notification can fire WHILE a subagent is genuinely live
      // (task #237 / session-018). idle_hint only shortens the watchdog; the
      // signal-or-pty-output anchor still defers it while the live subagent
      // streams output, so no false idle.
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'Explore' }));
      // A sibling subagent's inner Stop arrives as Idle, gated by depth > 0.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      expect(engine.getState(SESSION_ID)?.idleHintPending).toBe(true);

      // Stream PTY output more often than the short grace: the deadline slides
      // forward each chunk, so the watchdog never fires while work is live.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(TEST_STALE_AFTER_IDLE_HINT_MS - 500);
        engine.markPtyOutput(SESSION_ID);
      }
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(0);

      // The named terminal stop finally arrives -> depth drains; the parent's
      // own Stop then ends the turn cleanly (no watchdog involved).
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop, { detail: 'Explore' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(0);
    });

    it('a genuine new turn-initiating event clears the idle_hint short grace', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart, { detail: 'Explore' }));
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      expect(engine.getState(SESSION_ID)?.idleHintPending).toBe(true);
      // The agent resumed real work: a fresh tool_start invalidates the hint, so
      // the stuck-counter watchdog returns to its full 5-min cap.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.idleHintPending).toBe(false);
      // Past the short grace but well under the cap: still thinking.
      vi.advanceTimersByTime(TEST_STALE_AFTER_IDLE_HINT_MS + 200);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(0);
    });
  });

  describe('user Ctrl+C interrupt synthesis', () => {
    // The synthesis itself is wired in SessionTelemetry, not the engine,
    // but the engine MUST handle a synthetic Interrupted event the same
    // way as a hook-driven one: clear all counters, commit idle.
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('synthetic Interrupted with detail clears stuck pending tools immediately', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // The synthesis SessionTelemetry would do after Ctrl+C settle window:
      engine.processEvent(SESSION_ID, event(EventType.Interrupted, { detail: 'user-ctrl-c' }));

      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('idle');
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.turnActive).toBe(false);
      // Bypasses stability window - idle commits in this same tick.
      expect(transitions.at(-1)?.activity).toBe('idle');
    });

    it('applyInterruptedBypass zeroes every individual counter field', () => {
      // Pre-load ALL counters to non-zero values, then fire Interrupted and
      // assert each field individually. This pins the full zeroing contract
      // of applyInterruptedBypass - not just that activity becomes 'idle'.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Write' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_a' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_b' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));  // anonymous
      // Request permission so permissionPending=true; then re-prompt to
      // get back to thinking before firing Interrupted.
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: 'permission' }));
      engine.processEvent(SESSION_ID, event(EventType.Prompt));

      // Verify we started with all counters populated.
      const priorState = engine.getState(SESSION_ID)!;
      expect(priorState.pendingToolCount).toBe(3);
      expect(priorState.subagentDepth).toBe(2);
      expect(priorState.activeBackgroundShellIds.size).toBe(2);
      expect(priorState.anonymousBackgroundShellCount).toBe(1);
      expect(priorState.turnActive).toBe(true);

      transitions.length = 0;

      // Fire the synthetic Interrupted event (matches what UserInterruptCoordinator sends).
      engine.processEvent(SESSION_ID, event(EventType.Interrupted, { detail: 'user-ctrl-c' }));

      const state = engine.getState(SESSION_ID)!;

      // Activity immediately idle (no stability window on Interrupted path).
      expect(state.activity).toBe('idle');

      // Every counter must be at its zero value.
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.subagentDepth).toBe(0);
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.turnActive).toBe(false);
      expect(state.permissionPending).toBe(false);
      expect(state.pendingIdleAt).toBeNull();

      // Exactly one idle transition committed.
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
    });
  });

  describe('background-shell tracking (Set + anonymous fallback)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('with shell_id detail uses Set tracking', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(2);
      expect(state.anonymousBackgroundShellCount).toBe(0);
    });

    it('without shell_id falls back to anonymous counter', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('mixed: Set + anonymous coexist', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(2);
      expect(reason.ids).toEqual(['bash_1']);
    });

    it('markBackgroundShellEnded removes by id when known', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      engine.markBackgroundShellEnded(SESSION_ID, 'bash_1');
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.has('bash_1')).toBe(false);
      expect(state.activeBackgroundShellIds.has('bash_2')).toBe(true);
    });

    it('markBackgroundShellEnded with unknown id is no-op (does NOT corrupt anonymous count)', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.markBackgroundShellEnded(SESSION_ID, 'bash_unknown');
      const state = engine.getState(SESSION_ID)!;
      // Named shell call with unknown id: ignored, anonymous untouched.
      expect(state.activeBackgroundShellIds.size).toBe(1);
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('markBackgroundShellEnded with no id decrements anonymous', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.markBackgroundShellEnded(SESSION_ID);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('adoptAnonymousBackgroundShells (Subsystem G resume)', () => {
      engine.adoptAnonymousBackgroundShells(SESSION_ID, 3);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(3);
      expect(state.activity).toBe('thinking');
    });

    it('adoptAnonymousBackgroundShells with 0 is no-op', () => {
      engine.adoptAnonymousBackgroundShells(SESSION_ID, 0);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.activity).toBe('idle');
    });

    it('command-string detail goes to anonymous (not named set)', () => {
      // Regression: the Claude PreToolUse directive falls back to
      // tool_input.command when shell_id is absent, so detail looks
      // like "npm run typecheck". That MUST be treated as anonymous,
      // not added to the named set as a synthetic id.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm run typecheck' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npx playwright test' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('repeated command-string starts increment anonymous (no Set collision)', () => {
      // If both went into the named set as keys, two starts of the
      // same command would Set.add to the same key and undercount.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm test' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm test' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('absurdly long detail goes to anonymous (length cap on shell_id shape)', () => {
      const wayTooLong = 'a'.repeat(200);
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: wayTooLong }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('watcher anonymous decrement does NOT drain named set when anonymous is empty', () => {
      // The anonymous decrement path (no shellId, fired by the
      // background-shell watcher) used to drain a named entry as a
      // last resort. That clobbered live named bg shells whenever a
      // helper process (MCP server, statusline worker) churned, since
      // the watcher cannot distinguish "tracked named shell exited"
      // from "helper exited" without PID-aware identity decrement.
      //
      // New contract: anonymous decrement is a no-op when anon=0.
      // Genuinely stuck named entries are recovered by the 5-min
      // bg-shell escape-hatch watchdog (engine/watchdog.ts), not by
      // the watcher's count-based heuristic.
      const state = engine.getState(SESSION_ID)!;
      state.activeBackgroundShellIds.add('legacy-key-1');
      state.activeBackgroundShellIds.add('legacy-key-2');
      expect(state.anonymousBackgroundShellCount).toBe(0);

      engine.markBackgroundShellEnded(SESSION_ID); // no shellId, anon=0
      // Named entries preserved.
      expect(state.activeBackgroundShellIds.size).toBe(2);
      expect(state.anonymousBackgroundShellCount).toBe(0);

      engine.markBackgroundShellEnded(SESSION_ID);
      expect(state.activeBackgroundShellIds.size).toBe(2);
    });

    it('helper churn while a named bg shell is alive does not flip session to idle', () => {
      // Repro for task #121: a real named bg shell is running
      // (e.g. `npm run build` via Claude's `Bash run_in_background:true`).
      // A helper process exits and the watcher fires its deficit
      // signal -> markBackgroundShellEnded(sessionId) (no shellId).
      // With the bug this would drain the named entry and flip the
      // engine to idle while the bash is still alive.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      expect(engine.getState(SESSION_ID)!.activity).toBe('thinking');

      engine.markBackgroundShellEnded(SESSION_ID);

      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.has('bash_1')).toBe(true);
      expect(state.activity).toBe('thinking');
    });

    it('BackgroundShellEnd event with an unmatchable shellId is a no-op (preserves named state, bumps counter)', () => {
      // Engine invariant: an end that matches no named id AND has no
      // anonymous slot to drain must NOT drain an arbitrary named shell.
      // That last-resort drain let a spurious end (e.g. a tool-blind
      // remap mislabeling a foreground Agent completion as a bg-shell
      // end) corrupt a real, id-tracked shell and trigger a premature
      // idle. It is now a no-op that bumps the unmatchedBgShellEnd
      // compensation counter. This matches the watcher path's contract
      // above (markBackgroundShellEnded preserves named entries).
      const state = engine.getState(SESSION_ID)!;
      state.activeBackgroundShellIds.add('legacy-key');
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd, { detail: 'bash_assigned_id' }));
      expect(state.activeBackgroundShellIds.size).toBe(1);
      expect(state.activeBackgroundShellIds.has('legacy-key')).toBe(true);
      expect(state.compensationCounters.unmatchedBgShellEnd).toBe(1);
    });

    it('BackgroundShellEnd event without a shellId still drains an anonymous shell (legit KillBash)', () => {
      // The legit KillBash-without-shell_id decrement is preserved: when
      // the start was anonymous (PreToolUse fell back to the command
      // string), a no-detail end drains the anonymous count, not a named
      // shell, and does not bump the unmatched counter.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm run build' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(1);
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.compensationCounters.unmatchedBgShellEnd).toBe(0);
    });
  });

  describe('foreground Bash auto-backgrounded on timeout (#187)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('closes the in-flight pending tool and tracks the shell as named, holding thinking', () => {
      // Empirical repro (session 3fc0dca7, events.jsonl lines 19-20): a
      // foreground `npx playwright test` ToolStart (run_in_background absent),
      // then ~601s later a tool_end carrying the assigned shell id
      // `bjosycg6w` that the adapter remaps to BackgroundShellStart. The tool
      // didn't end, it moved to the background: the pending tool must close
      // (so it doesn't orphan and stick thinking for 5 min) AND the shell must
      // be tracked so the session stays active while the E2E runs.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'toolu_e2e' }));
      let state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(1);

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_e2e', detail: 'bjosycg6w' }));
      state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toHaveLength(0);
      expect(state.currentTool).toBeNull();
      expect(state.activeBackgroundShellIds.has('bjosycg6w')).toBe(true);
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.activity).toBe('thinking');

      // The agent's turn then ends (Stop hook) while the shell keeps running.
      // The named shell holds the session thinking - this is the false-idle
      // the fix prevents.
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(asBgShell(engine.getActivityReason(SESSION_ID)!).ids).toEqual(['bjosycg6w']);

      // Once the shell actually exits, the session settles to idle.
      engine.markBackgroundShellEnded(SESSION_ID, 'bjosycg6w');
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('does NOT close an unrelated in-flight foreground tool (id-only match)', () => {
      // A foreground Read is in flight when a DIFFERENT Bash auto-backgrounds.
      // The pending-tool closure matches by correlation id only, so the Read
      // stays pending and only the bg shell is added.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'toolu_read' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_bg', detail: 'bjosycg6w' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(1);
      expect(state.pendingToolStack.map((entry) => entry.id)).toEqual(['toolu_read']);
      expect(state.activeBackgroundShellIds.has('bjosycg6w')).toBe(true);
    });

    it('explicit run_in_background promotion pair does not spuriously decrement pending tools', () => {
      // The explicit run_in_background path: PreToolUse is already a
      // BackgroundShellStart (anonymous, no prior ToolStart), PostToolUse
      // promotes it to a named slot. Both carry a tool_use_id, but there is no
      // pending tool under it, so the closure is a no-op and the promotion
      // keeps the count at 1.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_bg', detail: 'npx playwright test --project=ui' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_bg', detail: 'bash_1' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(0);
      expect(state.activeBackgroundShellIds.has('bash_1')).toBe(true);
      expect(state.anonymousBackgroundShellCount).toBe(0);
    });
  });

  describe('bg-shell hatch: orphaned-shell sole-holder grace', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('force-clears bg shell counter after escape hatch when only bg shells hold', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      transitions.length = 0;
      syntheticEvents.length = 0;

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 100);
      // Stability window applies even on watchdog-driven idle
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.anonymousBackgroundShellCount).toBe(0);
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
      // Synthetic Idle/Timeout event emitted before transition
      expect(syntheticEvents).toHaveLength(1);
      expect(syntheticEvents[0].event.type).toBe(EventType.Idle);
      expect(syntheticEvents[0].event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire when other counters also hold', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      transitions.length = 0;

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.anonymousBackgroundShellCount).toBe(1);
    });

    it('is reset by intermediate signals (polling pattern)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'BashOutput' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'BashOutput' }));

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2 + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('watcher keep-alive cannot pin a phantom shell: grace reclaims it (real #175 trace)', () => {
      // Empirical red-green for the deadlock. Drive the real captured event
      // stream (session 4632519c, task #175) to its stuck precondition: the
      // worktree-setup `npm install` promoted to named bg shell `beg7osflu`,
      // the turn ended (idle), and no background_shell_end ever arrived - so
      // a single orphaned shell is the sole holder.
      for (const captured of loadReplayFixture('session-009-phantom-bg-shell-no-end.jsonl')) {
        engine.processEvent(SESSION_ID, captured);
      }
      const stuck = engine.getState(SESSION_ID)!;
      expect(stuck.activity).toBe('thinking');
      expect(stuck.turnActive).toBe(false);
      expect(stuck.activeBackgroundShellIds.size + stuck.anonymousBackgroundShellCount).toBe(1);

      transitions.length = 0;
      syntheticEvents.length = 0;

      // Simulate the old watcher keep-alive: onShellsObservedAlive (since
      // removed) called markThinkingSignal every 2s. Pre-fix (hatch anchored
      // to lastSignalAt) every pulse pushed the deadline out, pinning the
      // session `thinking` forever. The grace is anchored to bgShellHoldSince,
      // so the pulses cannot move it.
      const keepAliveIntervalMs = 2_000;
      const totalMs = TEST_BG_SHELL_HATCH_MS * 2 + TEST_STABILITY_WINDOW_MS + 100;
      for (let elapsed = 0; elapsed < totalMs; elapsed += keepAliveIntervalMs) {
        vi.advanceTimersByTime(keepAliveIntervalMs);
        engine.markThinkingSignal(SESSION_ID);
      }
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);

      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(0);
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
      const timeouts = syntheticEvents.filter(
        (entry) => entry.event.type === EventType.Idle && entry.event.detail === IdleReason.Timeout,
      );
      expect(timeouts).toHaveLength(1);
    });

    it('reclaims MULTIPLE orphaned shells at the grace (mirrors #180)', () => {
      // #180 was held by 2 phantom named shells (npm run build + playwright),
      // both with dropped end hooks. The hatch reset clears the whole set, so
      // count does not matter - 1 or 5 reclaim the same way.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bhucfw82g' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bzdmmq3h8' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(2);
      transitions.length = 0;

      const keepAliveIntervalMs = 2_000;
      for (let elapsed = 0; elapsed < TEST_BG_SHELL_HATCH_MS * 2; elapsed += keepAliveIntervalMs) {
        vi.advanceTimersByTime(keepAliveIntervalMs);
        engine.markThinkingSignal(SESSION_ID);
      }
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);

      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(0);
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
    });

    it('grace stays put under keep-alive but a fresh bg-shell start re-arms it', () => {
      // The anchor clears and re-stamps when bg work genuinely restarts, so a
      // new background_shell_start mid-grace resets the clock (not stuck).
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      transitions.length = 0;

      // Pulse past half the grace, then a real new bg shell starts.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      engine.markThinkingSignal(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));

      // Less than a full grace since the re-arm: still thinking.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS - 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // Past the grace from the re-arm: reclaimed.
      vi.advanceTimersByTime(200 + TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('markBackgroundShellsAlive holds a genuinely-running bg shell past the grace, then releases it (regression for 8f8b5071)', () => {
      // The sibling of the phantom case: a backgrounded E2E whose
      // BackgroundShellEnd hook was dropped is STILL running. The watcher
      // confirms it alive each cycle (markBackgroundShellsAlive), which
      // advances the anchor so the 30s grace does not false-idle it. Unlike
      // markThinkingSignal (which cannot move the anchor - see the phantom
      // tests above), this keep-alive holds the session active.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      transitions.length = 0;

      // Watcher confirms liveness every 2s for 3x the grace.
      const cycleMs = 2_000;
      for (let elapsed = 0; elapsed < TEST_BG_SHELL_HATCH_MS * 3; elapsed += cycleMs) {
        vi.advanceTimersByTime(cycleMs);
        engine.markBackgroundShellsAlive(SESSION_ID);
      }
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(0);

      // The shell finally exits: confirmations stop. The grace now elapses
      // from the last confirmation and reclaims (the backstop still works).
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
    });

    it('markBackgroundShellsAlive is a no-op unless the bg-shell hold is the active deadline', () => {
      // (a) turnActive thinking with a bg shell: the bg-shell hold predicate
      // requires !turnActive, so no hold is active and bgShellHoldSince is
      // null. The keep-alive must not stamp/advance an anchor here (it would
      // otherwise keep a thinking turn warm forever).
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      expect(engine.getState(SESSION_ID)?.bgShellHoldSince).toBeNull();
      engine.markBackgroundShellsAlive(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.bgShellHoldSince).toBeNull();
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // (b) idle session: no-op, stays idle.
      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      engine.markBackgroundShellsAlive(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');

      // (c) unknown session: no throw.
      expect(() => engine.markBackgroundShellsAlive('unknown')).not.toThrow();
    });
  });

  describe('bg-shell hold split by evidence quality (named cap vs anon grace)', () => {
    // The default makeEngine aliases both thresholds to the same window, so
    // these tests use a SPLIT config to distinguish a hook-declared (named)
    // shell - held to the long 5-min cap - from an anonymous (heuristic)
    // shell reclaimed fast at the short grace.
    const SPLIT_GRACE_MS = 1_000;   // anonymous-only grace (30s analog)
    const SPLIT_CAP_MS = 5_000;     // named-shell cap (5-min analog)

    function makeSplitEngine() {
      return makeEngine({
        bgShellOnlyGraceMs: SPLIT_GRACE_MS,
        bgShellEscapeHatchMs: SPLIT_CAP_MS,
      });
    }

    it('holds a named bg shell past the short anon grace, reclaims it only at the long cap', () => {
      const { engine } = makeSplitEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bx6k8r2cr' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      const stuck = engine.getState(SESSION_ID)!;
      expect(stuck.activity).toBe('thinking');
      expect(stuck.activeBackgroundShellIds.size).toBe(1);
      expect(engine.getActivityReason(SESSION_ID)?.kind).toBe('background-shell');

      // Past the short anon grace: a phantom ANONYMOUS shell would be gone by
      // now, but a hook-declared named shell must still be held.
      vi.advanceTimersByTime(SPLIT_GRACE_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(0);

      // Out to the long named cap: now reclaimed.
      vi.advanceTimersByTime(SPLIT_CAP_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(0);
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
    });

    it('reclaims an anonymous-only bg shell fast at the short grace', () => {
      const { engine } = makeSplitEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart)); // no detail -> anonymous
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.anonymousBackgroundShellCount).toBe(1);

      vi.advanceTimersByTime(SPLIT_GRACE_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
    });

    it('reclaims a named shell promptly on positive exit evidence (BackgroundShellEnd), not via the cap', () => {
      const { engine } = makeSplitEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bx6k8r2cr' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // Positive evidence the shell ended - reclaim well before the cap.
      engine.markBackgroundShellEnded(SESSION_ID, 'bx6k8r2cr');
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      // Reclaimed by the event path, not the watchdog hatch.
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(0);
    });

    it('markBackgroundShellsAlive holds a named shell past the long cap (Tier A liveness)', () => {
      const { engine } = makeSplitEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bx6k8r2cr' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // Watcher confirms the PID alive each cycle for 3x the cap.
      const cycleMs = 1_000;
      for (let elapsed = 0; elapsed < SPLIT_CAP_MS * 3; elapsed += cycleMs) {
        vi.advanceTimersByTime(cycleMs);
        engine.markBackgroundShellsAlive(SESSION_ID);
      }
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(0);

      // Confirmations stop (shell exited): reclaimed at the cap from the last.
      vi.advanceTimersByTime(SPLIT_CAP_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('replay #212 (session-012): a live auto-backgrounded shell stays thinking past the short grace', () => {
      // Real capture: foreground `npx playwright test --project=electron`
      // auto-backgrounds to named shell `bx6k8r2cr`, the turn ends (idle),
      // and no background_shell_end ever arrives - the named shell is the
      // sole holder. Replay to that point and confirm it is NOT reclaimed at
      // the short anon grace (the production bug), only at the long named cap.
      const events = loadReplayFixture('session-012-auto-bg-named-shell-live.jsonl');
      const startIndex = events.findIndex((entry) => entry.type === EventType.BackgroundShellStart);
      expect(startIndex).toBeGreaterThan(0);
      const idleIndex = events.findIndex(
        (entry, index) => index > startIndex && entry.type === EventType.Idle,
      );
      expect(idleIndex).toBeGreaterThan(startIndex);

      const { engine } = makeSplitEngine();
      engine.initSession(SESSION_ID);
      for (const captured of events.slice(0, idleIndex + 1)) {
        engine.processEvent(SESSION_ID, captured);
      }
      const stuck = engine.getState(SESSION_ID)!;
      expect(stuck.activity).toBe('thinking');
      expect(stuck.turnActive).toBe(false);
      expect(stuck.activeBackgroundShellIds.has('bx6k8r2cr')).toBe(true);
      expect(engine.getActivityReason(SESSION_ID)?.kind).toBe('background-shell');

      vi.advanceTimersByTime(SPLIT_GRACE_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      vi.advanceTimersByTime(SPLIT_CAP_MS + TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.bgShellHatch).toBe(1);
    });
  });

  describe('markPtyOutput defers the signal-or-pty-output watchdogs (live streaming is not force-idled)', () => {
    it('streaming PTY output keeps a pending tool thinking, then silence fires the hatch', () => {
      const { engine } = makeEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'PowerShell' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // PTY output every 2s for 2x the hatch window - no hook/status signal.
      const stepMs = 2_000;
      for (let elapsed = 0; elapsed < TEST_BG_SHELL_HATCH_MS * 2; elapsed += stepMs) {
        vi.advanceTimersByTime(stepMs);
        engine.markPtyOutput(SESSION_ID);
      }
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.stuckPendingTools).toBe(0);

      // Output stops: after the hatch window of true silence, it fires.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.stuckPendingTools).toBe(1);
    });

    it('streaming PTY output defers the stale-thinking watchdog (live tool-less generation, no false idle)', () => {
      // Task #246: a single heavy generation turn streamed PTY output for 211s
      // between two completed tools with no nested hook event and a silent
      // status heartbeat. turnActive alone (no pending tool) -> stale-thinking
      // hold; the streaming PTY must keep it thinking. RED before the anchor
      // change (anchor: 'signal'): force-idled at the threshold, staleThinking 1.
      const { engine } = makeEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // Continuous PTY output more frequent than the stale window, for 3x the
      // window - no hook/status signal arrives.
      const stepMs = 200;
      for (let elapsed = 0; elapsed < TEST_STALE_TIMEOUT_MS * 3; elapsed += stepMs) {
        vi.advanceTimersByTime(stepMs);
        engine.markPtyOutput(SESSION_ID);
      }
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(0);

      // Output stops (the turn really finished, Stop hook lost): the safety net
      // still fires after the stale window of true silence.
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(1);
    });

    it('still fires the stale-thinking watchdog on a genuinely silent turn (no PTY output)', () => {
      // The over-correction guard: with no PTY data at all (the agent sat idle
      // at a quiet prompt after a lost Stop hook), the anchor stays frozen and
      // the hold recovers within the threshold. Green before and after the fix.
      const { engine } = makeEngine();
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(1);
    });
  });

  // Task #294: a parked Claude session falsely flipped idle -> active because
  // the status-file heartbeat force-thinked it on background housekeeping output
  // growth, overriding a fresh hook-derived idle. The engine now records idle
  // provenance so the telemetry heartbeat can defer to a hook-authoritative idle
  // (the suppression itself lives in SessionTelemetry.processStatusUpdate; these
  // tests pin the field the engine exposes for it).
  describe('idle provenance (idleAuthoritative)', () => {
    it('a fresh session is a NON-authoritative idle (heartbeat may wake it)', () => {
      engine.initSession(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(false);
    });

    it('a hook Idle marks the idle hook-authoritative (set immediately, before the stability commit)', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // The provenance flag is set the instant the hook clears the turn, even
      // while the idle transition is still deferred by the stability window.
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
    });

    it('an idle_hint that ends the turn marks the idle hook-authoritative', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt)); // thinking, nothing else holds
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
    });

    it('a watchdog hatch resets to a FALLBACK idle, overriding a prior hook-authoritative idle', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.Idle)); // hook-authoritative idle
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
      // A new turn starts but its Stop hook is dropped; the stale-thinking
      // watchdog reclaims it. That reclaimed idle is a fallback, so the heartbeat
      // stays free to recover a session that is actually generating.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(false);
    });

    it('forceIdle is a FALLBACK idle (not authoritative)', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 50);
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
      engine.forceIdle(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(false);
    });

    it('a synthetic-style Idle/Timeout does NOT mark the idle hook-authoritative (only a real Stop does)', () => {
      // The engine's own synthetic watchdog idle carries detail = Timeout. If it
      // ever re-enters processEvent it must stay a FALLBACK so the heartbeat can
      // still wake a session that is actually generating. (RED if the
      // isSyntheticWatchdogTimeout exclusion is removed: idleAuthoritative would
      // be set true by the plain TURN_ENDING_EVENTS branch instead.)
      //
      // Contrast: a plain Idle (no detail) IS hook-authoritative, because it is
      // the real agent Stop hook.
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Timeout }));
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(false);

      // Contrast path: a plain Idle (the real Stop hook) DOES mark authoritative.
      engine.deleteSession(SESSION_ID);
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
    });

    it('Interrupted marks the idle hook-authoritative (bypassed turn; heartbeat must not re-wake on compaction)', () => {
      // After a user Ctrl+C, the turn ends via Interrupted which routes through
      // applyInterruptedBypass. The resulting idle must be hook-authoritative so
      // the heartbeat does not false-think the session when background compaction
      // ticks output tokens while Claude shuts down.
      //
      // RED if idleAuthoritative=true is omitted from the TURN_ENDING_EVENTS block
      // for Interrupted (e.g. the assignment is narrowed to event.type===Idle only):
      // idleAuthoritative would stay false, and processStatusUpdate would later
      // force-think a user-stopped session on any output growth.
      //
      // Note: applyInterruptedBypass clears counters but does NOT touch
      // idleAuthoritative, so the value set in the TURN_ENDING_EVENTS block persists.
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
    });

    it('TurnFailed marks the idle hook-authoritative (service-error abort; heartbeat must not re-wake on compaction)', () => {
      // A rate-limit / overload abort arrives as TurnFailed (Claude StopFailure
      // hook). Same provenance as Interrupted: the agent explicitly ended the turn
      // via a hook, so the resulting idle is authoritative. Background compaction
      // that ticks output tokens post-failure must NOT re-wake the session.
      //
      // RED if idleAuthoritative=true is omitted from the TurnFailed branch: stays
      // false, and a post-failure status update with growing output tokens would
      // wrongly force-think the failed session as active.
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.TurnFailed, { detail: 'rate_limit' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.idleAuthoritative).toBe(true);
    });
  });

  // Task #294 part 2 (defense-in-depth): once the agent reports waiting-for-input
  // (idle_hint), parked-TUI statusline repaints (PTY bytes) must stop deferring
  // the stale-thinking net, so a stuck turnActive self-heals at 180s. A live
  // long-generation turn never idle-hints, so it keeps the PTY anchor (#246).
  describe('stale-thinking ignores PTY repaints once idle_hint is pending', () => {
    // The blind-spot shape: turnActive stuck true, all counters zero, AND
    // idleHintPending true. Arises when idle_hint fires while a tool is still
    // pending (idleHintEndsTurn is a no-op) and the tool then drains without a
    // Stop hook - exactly the stuck turn parked-TUI repaints would pin forever.
    function driveToStuckTurnWithIdleHint(target: ActivityEngine): void {
      target.initSession(SESSION_ID);
      target.processEvent(SESSION_ID, event(EventType.Prompt));
      target.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 't1' }));
      target.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      // The tool is still pending, so idle_hint cannot end the turn: it is a
      // no-op on turnActive but leaves idleHintPending set.
      expect(target.getState(SESSION_ID)?.turnActive).toBe(true);
      expect(target.getState(SESSION_ID)?.idleHintPending).toBe(true);
      target.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash', toolId: 't1' }));
      expect(target.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(target.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(target.getState(SESSION_ID)?.idleHintPending).toBe(true);
    }

    it('fires the stale-thinking net despite continuous PTY repaints (anchor narrows to signal)', () => {
      const { engine: localEngine } = makeEngine();
      driveToStuckTurnWithIdleHint(localEngine);

      // Statusline repaints stream PTY bytes more frequently than the stale
      // window. RED before the idleHintAnchor change: signal-or-pty-output keeps
      // deferring it (staleThinking 0, stuck thinking forever).
      const stepMs = 200;
      for (let elapsed = 0; elapsed < TEST_STALE_TIMEOUT_MS + 400; elapsed += stepMs) {
        vi.advanceTimersByTime(stepMs);
        localEngine.markPtyOutput(SESSION_ID);
      }
      expect(localEngine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(localEngine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(1);
      localEngine.dispose();
    });

    it('control: without an idle_hint, PTY repaints still defer the net (#246 preserved)', () => {
      const { engine: localEngine } = makeEngine();
      localEngine.initSession(SESSION_ID);
      localEngine.processEvent(SESSION_ID, event(EventType.Prompt));
      // A live long-generation turn, no idle_hint. The PTY anchor keeps it alive.
      const stepMs = 200;
      for (let elapsed = 0; elapsed < TEST_STALE_TIMEOUT_MS * 2; elapsed += stepMs) {
        vi.advanceTimersByTime(stepMs);
        localEngine.markPtyOutput(SESSION_ID);
      }
      expect(localEngine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(localEngine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(0);
      localEngine.dispose();
    });
  });

  describe('180s stale-thinking watchdog (hook loss safety net)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('forces idle after stale timeout when only turnActive holds', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      syntheticEvents.length = 0;
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(syntheticEvents).toHaveLength(1);
      expect(syntheticEvents[0].event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire while a tool is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while a subagent is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while a bg shell is active (escape hatch handles that)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('is reset by intermediate signals', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS / 2);
      engine.markThinkingSignal(SESSION_ID);
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS / 2 + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('periodic markThinkingSignal calls over many timeout windows keep thinking alive', () => {
      // Pins the contract used by `processStatusUpdate` in
      // SessionTelemetry: while Claude's statusline is updating, each
      // update that shows OUTPUT-token growth (and no pending idle_hint)
      // fires `markThinkingSignal`, refreshing `lastSignalAt` and
      // re-arming the watchdog timer. As long as those proof-of-work
      // signals arrive at sub-threshold intervals, the engine stays in
      // `thinking` indefinitely. This is what kept Task #121's
      // 189-second plan-composition gap from running away into an
      // unbounded idle flip-flop - the bumped 180s threshold on top of
      // status-update intervals handles the recorded scenario.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      const signalIntervalMs = TEST_STALE_TIMEOUT_MS / 2;
      const totalDurationMs = TEST_STALE_TIMEOUT_MS * 60;
      let elapsed = 0;
      while (elapsed < totalDurationMs) {
        vi.advanceTimersByTime(signalIntervalMs);
        elapsed += signalIntervalMs;
        engine.markThinkingSignal(SESSION_ID);
        expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      }
      // No stale-thinking transition should have been recorded across
      // the entire window.
      const state = engine.getState(SESSION_ID)!;
      const staleTransitions = state.recentTransitions.filter(
        (transition) => transition.trigger === 'timer:stale-thinking',
      );
      expect(staleTransitions).toHaveLength(0);
    });

    it('re-anchors on tool_end so a long tool gets a fresh window, but a lost Stop still recovers', () => {
      // The false-idle-after-long-foreground-tool fix: tool_end refreshes
      // lastSignalAt (it is NOT log-only). A foreground tool that runs longer
      // than the stale timeout must therefore hand the post-tool thinking gap a
      // FRESH stale-thinking window, not the frozen tool_start anchor that
      // force-idled the card the instant the tool ended.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'tool-long' }));
      // Tool runs longer than the stale timeout (held by the stuck-pending-tools
      // hold, whose 5s window does not fire here). lastSignalAt is now stale.
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 500);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash', toolId: 'tool-long' }));
      // Just under the threshold measured from tool_end: still thinking (green).
      // Pre-fix the frozen anchor is already 1500ms stale, so it would be idle.
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS - 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(0);

      // Inverse guard: the Stop hook never arrives, so stale-thinking must still
      // recover within the threshold of the genuinely-last activity (tool_end).
      vi.advanceTimersByTime(200);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(1);
    });
  });

  describe('idle hint (waiting-for-input notification)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('settles a delegated turn to idle via the stability window, NOT the stale watchdog', () => {
      // Reproduces the bug: the whole turn was delegated to a subagent. When it
      // stops, turnActive is still true with no other holders. Pre-fix, only the
      // 1000ms (prod 180s) stale watchdog could drive idle.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      transitions.length = 0;
      syntheticEvents.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      // turnActive cleared; idle deferred by the stability window (not committed yet).
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(transitions).toHaveLength(0);

      // Idle commits well before the stale-thinking timeout.
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      // It was NOT the watchdog: no synthetic Idle event, no stale compensation.
      expect(syntheticEvents).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(0);
    });

    it('does NOT force idle while a tool is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
    });

    it('does NOT force idle while a subagent is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT force idle while a bg shell is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT force idle while a permission is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('is a no-op when the session is already idle (turnActive false)', () => {
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });
  });

  describe('SessionEnd is log-only', () => {
    it('does not change activity, turnActive, or counters', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const before = { ...engine.getState(SESSION_ID)! };
      engine.processEvent(SESSION_ID, event(EventType.SessionEnd));
      const after = engine.getState(SESSION_ID)!;
      expect(after.activity).toBe(before.activity);
      expect(after.turnActive).toBe(before.turnActive);
      expect(after.subagentDepth).toBe(before.subagentDepth);
      expect(after.pendingToolCount).toBe(before.pendingToolCount);
    });
  });

  describe('getStatsSnapshot (Subsystem E)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('returns null for unknown session', () => {
      expect(engine.getStatsSnapshot('unknown')).toBeNull();
    });

    it('exposes all current state fields', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));

      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      expect(snapshot.activity).toBe('thinking');
      expect(snapshot.pendingToolCount).toBe(1);
      expect(snapshot.subagentDepth).toBe(1);
      expect(snapshot.backgroundShellIds).toEqual(['bash_1']);
      expect(snapshot.turnActive).toBe(true);
      expect(snapshot.permissionPending).toBe(false);
      expect(snapshot.msSinceLastSignal).not.toBeNull();
    });

    it('includes ring buffer of recent audit log entries (capped at 50)', () => {
      // Drive 60 events that each mutate counters. Each ToolStart/Idle
      // pair produces multiple log entries: ToolStart (counter delta),
      // Idle event step, plus the actual idle transition after the
      // stability window. The buffer should cap at 50 regardless.
      for (let i = 0; i < 30; i++) {
        engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: `Tool${i}` }));
        engine.processEvent(SESSION_ID, event(EventType.Idle));
        vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      }
      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      expect(snapshot.recentTransitions.length).toBeLessThanOrEqual(50);
      // Last entry should be the most recent
      const last = snapshot.recentTransitions[snapshot.recentTransitions.length - 1];
      expect(last.from).toBeDefined();
      expect(last.to).toBeDefined();
    });

    it('audit log records counter-affecting events that DO NOT change activity (non-transition steps)', () => {
      // Regression: log used to record only state transitions, missing
      // every counter shift in between. With richer logging, a sequence
      // of tool starts/ends during a thinking turn should each appear.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));

      const log = engine.getStatsSnapshot(SESSION_ID)!.recentTransitions;
      // Expect entries for each tool_start (tools +1) and tool_end (tools -1).
      const counterDeltaEntries = log.filter((entry) => entry.counterDelta !== undefined);
      expect(counterDeltaEntries.length).toBeGreaterThanOrEqual(4);
      // Some entries are non-transitions (from === to).
      const nonTransitions = log.filter((entry) => entry.from === entry.to);
      expect(nonTransitions.length).toBeGreaterThan(0);
      // Counter-delta strings include human-readable labels.
      expect(counterDeltaEntries.some((entry) => entry.counterDelta?.includes('tools +1'))).toBe(true);
      expect(counterDeltaEntries.some((entry) => entry.counterDelta?.includes('tools -1'))).toBe(true);
    });

    it('transitions carry a trigger label sourced from the originating event/timer/force path', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      engine.forceThinking(SESSION_ID);

      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      const triggers = snapshot.recentTransitions.map((transition) => transition.trigger);
      expect(triggers[0]).toBe('event:tool_start');
      // Stop -> stability-window-driven idle -> 'timer:stability'
      expect(triggers).toContain('timer:stability');
      // forceThinking -> 'force-thinking'
      expect(triggers[triggers.length - 1]).toBe('force-thinking');
    });
  });

  describe('guards and edge branches (coverage completeness)', () => {
    it('initSession is a no-op after dispose (no transition, no state)', () => {
      engine.dispose();
      transitions.length = 0;
      engine.initSession(SESSION_ID);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)).toBeUndefined();
    });

    it('processEvent lazily creates state for an unknown (never-initialized) session', () => {
      // No initSession: getOrCreateState must materialize the state so a stray
      // event for a session the engine never saw still tracks correctly.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
    });

    it('every force / mark / adopt / processEvent entry point is a no-op after dispose', () => {
      engine.initSession(SESSION_ID);
      engine.dispose();
      expect(() => {
        engine.forceThinking(SESSION_ID);
        engine.forceIdle(SESSION_ID);
        engine.markThinkingSignal(SESSION_ID);
        engine.markBackgroundShellsAlive(SESSION_ID);
        engine.markPtyOutput(SESSION_ID);
        engine.markBackgroundShellEnded(SESSION_ID, 'x');
        engine.adoptAnonymousBackgroundShells(SESSION_ID, 1);
        engine.processEvent(SESSION_ID, event(EventType.Prompt));
      }).not.toThrow();
      // dispose() cleared the state map and nothing recreated it.
      expect(engine.getState(SESSION_ID)).toBeUndefined();
    });

    it('mark / end entry points are no-ops for an unknown session (no state created)', () => {
      expect(() => {
        engine.markThinkingSignal('ghost');
        engine.markBackgroundShellsAlive('ghost');
        engine.markPtyOutput('ghost');
        engine.markBackgroundShellEnded('ghost', 'shell');
      }).not.toThrow();
      expect(engine.getState('ghost')).toBeUndefined();
    });

    it('anonymous bg-shell end while a named shell is tracked is a no-op and warns (ambiguity guard)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bx6k8r2cr' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      // Anonymous decrement (no shellId) while anon=0 but a named shell is
      // tracked: must NOT drain the real named shell.
      engine.markBackgroundShellEnded(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.has('bx6k8r2cr')).toBe(true);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it('anonymous bg-shell end with nothing tracked is a silent no-op (no warn)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      engine.initSession(SESSION_ID);
      engine.markBackgroundShellEnded(SESSION_ID);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('a holder appearing during the stability window suppresses the deferred idle', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt)); // thinking, turnActive
      engine.processEvent(SESSION_ID, event(EventType.Idle));   // turnActive=false -> idle deferred
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.pendingIdleAt).not.toBeNull();
      // A bg shell is adopted mid-window. Unlike a turn-initiating event it does
      // NOT clear pendingIdleAt, so when the window elapses onTick re-derives,
      // finds the bg-shell holder, and reschedules instead of committing idle.
      engine.adoptAnonymousBackgroundShells(SESSION_ID, 1);
      transitions.length = 0;
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 20);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(transitions.filter((transition) => transition.activity === 'idle')).toHaveLength(0);
    });

    it('ToolEnd with a non-matching toolId falls back to LIFO-by-name', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 't1' }));
      // ToolEnd carries a toolId that matches nothing in the stack, but the name
      // does: id-no-match drops to the LIFO-by-name fallback so the stack drains.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash', toolId: 'no-match' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('a foreground Bash auto-backgrounded as the only pending tool hard-resets the stack', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 't1' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      // Claude auto-backgrounds the running Bash: BackgroundShellStart carries the
      // SAME toolId. The pending tool is promoted (not ended); the count drops to
      // exactly zero, hard-resetting the stack and currentTool.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { toolId: 't1', detail: 'bx6k8r2cr' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(0);
      expect(state.currentTool).toBeNull();
      expect(state.pendingToolStack).toHaveLength(0);
      expect(state.activeBackgroundShellIds.has('bx6k8r2cr')).toBe(true);
      // Now held solely by the backgrounded shell.
      expect(state.activity).toBe('thinking');
    });

    it('ToolEnd carrying an unmatched toolId and no tool name still decrements (LIFO fallback skipped)', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 't1' }));
      // toolId present but matches nothing, AND no tool name: the LIFO-by-name
      // fallback (else-if event.tool) is skipped; the count still drops to zero
      // and the hard reset clears the dangling stack entry.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { toolId: 'no-match' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('LIFO-by-name fallback skips a non-matching top entry to drain the right tool', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'r1' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'b1' }));
      // ToolEnd for 'Read' with a non-matching id: LIFO scans from the top
      // ('Bash' - no match) down to 'Read' (match), draining the right entry and
      // leaving 'Bash' as the still-running current tool.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read', toolId: 'no-match' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(1);
      expect(state.currentTool).toBe('Bash');
    });

    it('auto-backgrounding one of several pending tools leaves the rest pending (no hard reset)', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'r1' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'b1' }));
      // The Bash auto-backgrounds; the count drops 2 -> 1 (NOT zero), so the
      // stack is NOT hard-reset and the still-running Read remains current.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { toolId: 'b1', detail: 'bx6k8r2cr' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.pendingToolCount).toBe(1);
      expect(state.currentTool).toBe('Read');
      expect(state.activeBackgroundShellIds.has('bx6k8r2cr')).toBe(true);
    });
  });
});
