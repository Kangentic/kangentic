/**
 * An agent turn interrupted with Esc, for an agent whose hooks say nothing
 * about it. Measured on agy 1.5.13: an Esc during a tool fired neither
 * PostToolUse nor Stop, so the engine held the turn (a pending tool, the card
 * working) until the next prompt, while the idle footer `? for shortcuts` was
 * already on screen. Live hooks make the PTY tracker ignore that footer, so an
 * adapter that declares `idlePromptEndsOpenTurn` has the footer arm the
 * interrupt settle window instead. What a user loses without it: a card that
 * reads working after they stopped the agent. An interrupt is not a turn the
 * agent finished, so On agent turn end rows still do not run for it.
 *
 * Tier: Unit. The real SessionTelemetry and ActivityEngine on fake timers; the
 * bg-shell watcher is off so no OS probe is built.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { ActivityDetection, EventType } from '../../src/shared/types';
import type { Activity, AgentParser, SessionEvent } from '../../src/shared/types';

const SETTLE_MS = 3_000;

function parser(idlePromptEndsOpenTurn: boolean): AgentParser {
  return {
    detectFirstOutput: () => true,
    removeHooks: () => undefined,
    runtime: {
      activity: ActivityDetection.hooksAndPty(() => true),
      reportsTurnEnd: true,
      ...(idlePromptEndsOpenTurn ? { idlePromptEndsOpenTurn: true } : {}),
    },
  } as unknown as AgentParser;
}

function event(type: EventType, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { ts: Date.now(), type, ...extra };
}

describe('an idle prompt while hooks hold a turn open', () => {
  let telemetry: SessionTelemetry | null = null;
  let activity: Activity | null;
  let logged: SessionEvent[];

  function start(idlePromptEndsOpenTurn: boolean, suppressesPtyTracker = true): SessionTelemetry {
    const created = new SessionTelemetry(
      {
        onUsageChange: () => {},
        onActivityChange: (_sessionId, next) => { activity = next; },
        onEvent: (_sessionId, pushed) => { logged.push(pushed); },
        onIdleTimeout: () => {},
        onPlanExit: () => {},
        onPRCandidate: () => {},
        requestSuspend: () => {},
        isSessionRunning: () => true,
      },
      { disableBgShellWatcher: true, activityEngineOptions: { idleStabilityWindowMs: 0 } },
    );
    created.initSession('s1', parser(idlePromptEndsOpenTurn));
    // The turn agy began: its PreInvocation proves the hooks run (the PTY tracker
    // is suppressed from here) and its PreToolUse opened a tool that never ends.
    created.ingestEvents(
      's1',
      [event(EventType.Prompt), event(EventType.ToolStart, { tool: 'run_command', toolId: 'call-1' })],
      suppressesPtyTracker ? {} : { suppressesPtyTracker: false },
    );
    telemetry = created;
    return created;
  }

  const interrupts = (): SessionEvent[] => logged.filter((entry) => entry.type === EventType.Interrupted);

  beforeEach(() => {
    vi.useFakeTimers();
    activity = null;
    logged = [];
  });

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
    vi.useRealTimers();
  });

  it('ends the turn as interrupted once the settle window passes with no hook', () => {
    const session = start(true);
    expect(activity).toBe('thinking');

    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(activity).toBe('thinking');
    vi.advanceTimersByTime(1);

    expect(activity).toBe('idle');
    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'idle-prompt' })]);
  });

  it('leaves the turn alone for an agent that does not declare it', () => {
    const session = start(false);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(activity).toBe('thinking');
    expect(interrupts()).toEqual([]);
  });

  // A footer chunk can land just before the next turn's first hook. A hook
  // batch reaches telemetry as SessionManager's onEventsParsed hands it on.
  it('drops the window when the agent\'s hooks write a line inside it', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS - 500);
    session.notifyHookLines('s1');
    session.ingestEvents('s1', [event(EventType.ToolEnd, { tool: 'run_command', toolId: 'call-1' })]);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(interrupts()).toEqual([]);
    expect(activity).toBe('thinking');
  });

  it('synthesizes nothing when the turn ends on its own Stop', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    session.ingestEvents('s1', [event(EventType.ToolEnd, { tool: 'run_command', toolId: 'call-1' }), event(EventType.Idle)]);
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(activity).toBe('idle');
    expect(interrupts()).toEqual([]);
  });

  it('keeps a Ctrl+C window armed through a later event, named as the user\'s', () => {
    const session = start(true);
    session.notifyUserInterrupt('s1');
    session.notifyPtyIdle('s1');
    session.ingestEvents('s1', [event(EventType.ToolStart, { tool: 'read_file', toolId: 'call-2' })]);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(activity).toBe('idle');
    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'user-ctrl-c' })]);
  });

  it('drops the window when the terminal prints new text after the prompt', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS - 500);
    session.notifyPtyData('s1');
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(interrupts()).toEqual([]);
    expect(activity).toBe('thinking');
  });

  it('keeps a window armed after output that arrived before the prompt', () => {
    const session = start(true);
    session.notifyPtyData('s1');
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS);

    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'idle-prompt' })]);
    expect(activity).toBe('idle');
  });

  // A status line's events (a plan-mode toggle) prove no turn is running, so they
  // reach telemetry through ingestEvents alone, with no notifyHookLines.
  it('keeps the window when a status line\'s events arrive inside it', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS - 500);
    session.ingestEvents('s1', [event(EventType.ConfigChange)]);
    vi.advanceTimersByTime(500);

    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'idle-prompt' })]);
  });

  it('keeps the first deadline when the footer repaints, and ends the turn once', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS - 500);
    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(499);
    expect(interrupts()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(interrupts()).toHaveLength(1);

    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(interrupts()).toHaveLength(1);
  });

  it('names the interrupt as the user\'s when a Ctrl+C follows the idle prompt', () => {
    const session = start(true);
    session.notifyPtyIdle('s1');
    session.notifyUserInterrupt('s1');
    vi.advanceTimersByTime(SETTLE_MS);

    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'user-ctrl-c' })]);
  });

  it('hands the prompt to the PTY tracker and arms nothing while the tracker is not suppressed', () => {
    const session = start(true, false);
    const tracker = (session as unknown as {
      ptyTracker: { isSuppressed: (sessionId: string) => boolean; onIdleDetected: (sessionId: string) => void };
    }).ptyTracker;
    const onIdleDetected = vi.spyOn(tracker, 'onIdleDetected').mockImplementation(() => undefined);
    // The precondition that keeps this from passing vacuously: hot engine, live tracker.
    expect(tracker.isSuppressed('s1')).toBe(false);
    expect(activity).toBe('thinking');

    session.notifyPtyIdle('s1');
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(onIdleDetected).toHaveBeenCalledWith('s1');
    expect(interrupts()).toEqual([]);
    expect(activity).toBe('thinking');
  });
});
