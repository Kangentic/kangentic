/**
 * Regression guard for the background-shell false-idle bug.
 *
 * Bug (now fixed): when a Claude Code agent launches a backgrounded
 * Bash (Bash tool with run_in_background: true), the agent receives
 * the handle back immediately and typically yields its turn shortly
 * after. Claude Code then fires:
 *
 *   PreToolUse (Bash + run_in_background) -> background_shell_start
 *   PostToolUse                            -> tool_end
 *   Stop                                   -> idle
 *
 * Before the fix, the state machine transitioned straight to 'idle'
 * because pendingToolCount returned to zero and Idle was the terminal
 * event. Confirmed in the wild on task #503 (session e426341b-...):
 * events.jsonl had idle at ts=17617675411 while `npx playwright test`
 * was still running in a backgrounded shell.
 *
 * Fix: a new `background_shell_start` event increments the session's
 * activeBackgroundShells counter, and Guard 3 defers any Stop-driven
 * idle while that counter is > 0. When the last bg shell is explicitly
 * killed via KillBash (`background_shell_end` drops the counter to
 * zero), the deferred idle emits. Natural completion of a bg shell is
 * not tracked (no hook fires for it), so the counter over-estimates,
 * which errs on the safe side: the session keeps showing as thinking
 * while work might still be happening.
 *
 * Tests in this file pin:
 *   1. The Idle event is deferred while a bg shell is active.
 *   2. A subsequent BackgroundShellEnd emits the deferred idle.
 *   3. SessionEnd resets the counter so the next session starts clean.
 *   4. Interrupts bypass the guard (user needs to see them immediately).
 *
 * Companion E2E reproduction + fix-gate lives in
 * tests/e2e/background-shell-idle.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { ActivityStateMachine } from '../../src/main/pty/activity/activity-state-machine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

type TransitionLog = Array<{
  sessionId: string;
  activity: ActivityState;
  permissionIdle: boolean;
}>;

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

const SESSION_ID = 'bg-shell-session';

describe('Background-shell false-idle bug (Guard 3)', () => {
  it('defers the Stop-driven idle while a backgrounded Bash is active', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0; // drop the initial idle emission

    // Real event sequence from task #503's events.jsonl for a
    // backgrounded Bash call:
    //   prompt
    //   background_shell_start  (PreToolUse remapped by run_in_background)
    //   tool_end                (handle returned ~300ms later)
    //   idle                    (Stop hook, agent yielded)
    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
      detail: 'npx playwright test --project=ui &',
    });
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.ToolEnd,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));

    const state = machine.getState(SESSION_ID);
    // Guard 3 suppresses the Stop -> idle transition. Activity stays
    // thinking because there is still unfinished background work.
    expect(state?.activity).toBe('thinking');
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    // Only the initial prompt-driven thinking transition fired; idle
    // was deferred, so no second transition.
    expect(transitions).toEqual([
      { sessionId: SESSION_ID, activity: 'thinking', permissionIdle: false },
    ]);
  });

  it('emits the deferred idle when the last bg shell is killed via KillBash', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));
    // Guard 3 deferred idle.

    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      tool: 'KillBash',
    });

    const state = machine.getState(SESSION_ID);
    expect(state?.activity).toBe('idle');
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    expect(transitions).toEqual([
      { sessionId: SESSION_ID, activity: 'thinking', permissionIdle: false },
      { sessionId: SESSION_ID, activity: 'idle', permissionIdle: false },
    ]);
  });

  it('interrupts bypass the guard so users see cancellation immediately', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Interrupted));

    const state = machine.getState(SESSION_ID);
    // Interrupt must flip to idle regardless of bg shells.
    expect(state?.activity).toBe('idle');
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('permission idle bypasses the guard so the user can approve the prompt', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));

    const state = machine.getState(SESSION_ID);
    expect(state?.activity).toBe('idle');
    expect(state?.permissionIdle).toBe(true);
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle', permissionIdle: true });
  });

  it('SessionEnd resets the counter so the next session starts clean', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
    machine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(2);

    machine.processEvent(SESSION_ID, event(EventType.SessionEnd));
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(0);
    expect(machine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(false);
  });

  it('with no bg shell, Idle transitions normally (guard does not over-fire)', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, event(EventType.ToolStart));
    machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
    machine.processEvent(SESSION_ID, event(EventType.Idle));

    // No bg shell was ever started -- idle should fire normally.
    expect(machine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(0);
  });
});

describe('Guard 2 + Guard 3 composition (both guards active simultaneously)', () => {
  const COMP_SESSION = 'guard-composition-session';

  it('(a) idle deferred by BOTH guards at once: no idle emits, both pending flags set', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    // Start subagent and background shell at the same time.
    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    // Stop-derived idle now arrives while both guards are active.
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('thinking');
    expect(state?.subagentDepth).toBe(1);
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileSubagent).toBe(true);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    // Only the initial prompt->thinking transition fired; deferred idle
    // should not have appeared.
    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(b) SubagentStop fires first while bg shell still active: Guard 3 holds, no idle emitted', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    // Both guards have deferred the idle.

    // Subagent finishes first -- bg shell still running.
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStop,
    });

    const state = machine.getState(COMP_SESSION);
    // Guard 3 must still hold the idle -- activity stays thinking.
    expect(state?.activity).toBe('thinking');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(c) BackgroundShellEnd fires first while subagent still active: Guard 2 holds, no idle emitted', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    // Both guards have deferred the idle.

    // Background shell finishes first -- subagent still running.
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      tool: 'KillBash',
    });

    const state = machine.getState(COMP_SESSION);
    // Guard 2 must still hold -- activity stays thinking.
    expect(state?.activity).toBe('thinking');
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.subagentDepth).toBe(1);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(state?.pendingIdleWhileSubagent).toBe(true);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(d) order SubagentStop then BackgroundShellEnd: deferred idle emits exactly once', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.BackgroundShellEnd, tool: 'KillBash' });

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('idle');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(1);
  });

  it('(d-alt) order BackgroundShellEnd then SubagentStop: deferred idle emits exactly once', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.BackgroundShellEnd, tool: 'KillBash' });
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('idle');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(1);
  });
});
