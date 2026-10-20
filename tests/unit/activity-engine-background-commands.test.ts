/**
 * The engine side of background command reporting for CLIs other than
 * Claude (task #859). Their hooks report a launch as a named
 * `background_shell_start` written by the event bridge's
 * `appendBackgroundLaunch` directive beside the tool's own `tool_end`, with no
 * `toolId`, and report the opt-out flag on the start itself
 * (`noActivityHold`) because their payloads carry no tool id for the memo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'session-background';

function makeEngine(): ActivityEngine {
  return new ActivityEngine(
    { onActivityChange: () => {}, onSyntheticEvent: () => {} },
    {
      bgShellEscapeHatchMs: 600_000,
      bgShellOnlyGraceMs: 600_000,
      staleThinkingTimeoutMs: 600_000,
      idleStabilityWindowMs: 0,
    },
  );
}

const at = (type: EventType, fields: Omit<SessionEvent, 'ts' | 'type'> = {}): SessionEvent => ({ ts: Date.now(), type, ...fields });

describe('background commands reported beside tool_end', () => {
  let engine: ActivityEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine();
    engine.initSession(SESSION_ID);
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('holds the session past the Stop when the start comes before the tool_end (the bridge order)', () => {
    engine.processEvent(SESSION_ID, at(EventType.Prompt));
    engine.processEvent(SESSION_ID, at(EventType.ToolStart, { tool: 'run_shell_command', detail: 'node server.js' }));
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { tool: 'run_shell_command', detail: '84272' }));
    engine.processEvent(SESSION_ID, at(EventType.ToolEnd, { tool: 'run_shell_command' }));
    engine.processEvent(SESSION_ID, at(EventType.Idle));
    const state = engine.getState(SESSION_ID);
    expect(state?.pendingToolCount).toBe(0);
    expect(state?.pendingToolStack).toHaveLength(0);
    expect(state?.anonymousBackgroundShellCount).toBe(0);
    expect([...state!.activeBackgroundShellIds]).toEqual(['84272']);
    expect(state?.activity).toBe('thinking');
  });

  it('leaves the counters as clean when the tool_end lands first', () => {
    engine.processEvent(SESSION_ID, at(EventType.Prompt));
    engine.processEvent(SESSION_ID, at(EventType.ToolStart, { tool: 'powershell', toolId: 'call-1' }));
    engine.processEvent(SESSION_ID, at(EventType.ToolEnd, { tool: 'powershell', toolId: 'call-1' }));
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { tool: 'powershell', detail: 'probe-server' }));
    const state = engine.getState(SESSION_ID);
    expect(state?.pendingToolCount).toBe(0);
    expect([...state!.activeBackgroundShellIds]).toEqual(['probe-server']);
  });

  it('does not close a parallel tool of the same name', () => {
    engine.processEvent(SESSION_ID, at(EventType.Prompt));
    engine.processEvent(SESSION_ID, at(EventType.ToolStart, { tool: 'powershell' }));
    engine.processEvent(SESSION_ID, at(EventType.ToolStart, { tool: 'powershell' }));
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { tool: 'powershell', detail: 'one' }));
    engine.processEvent(SESSION_ID, at(EventType.ToolEnd, { tool: 'powershell' }));
    // One launch reported and one tool ended: the other powershell call is still running.
    expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
  });

  it('lands a start flagged noActivityHold in the exempt set, so the Stop goes idle', () => {
    engine.processEvent(SESSION_ID, at(EventType.Prompt));
    engine.processEvent(SESSION_ID, at(EventType.ToolStart, { tool: 'run_shell_command', detail: 'node server.js --kangentic-no-activity-hold' }));
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { tool: 'run_shell_command', detail: 'bg_5d90bd48', noActivityHold: true }));
    engine.processEvent(SESSION_ID, at(EventType.ToolEnd, { tool: 'run_shell_command' }));
    engine.processEvent(SESSION_ID, at(EventType.Idle));
    const state = engine.getState(SESSION_ID);
    expect([...state!.exemptBackgroundShellIds]).toEqual(['bg_5d90bd48']);
    expect(state?.activeBackgroundShellIds.size).toBe(0);
    expect(state?.activity).toBe('idle');
  });

  it('ends the hold on a stop reported for the id', () => {
    engine.processEvent(SESSION_ID, at(EventType.Prompt));
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { tool: 'run_shell_command', detail: 'bg_bc67cecc' }));
    engine.processEvent(SESSION_ID, at(EventType.Idle));
    expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellEnd, { tool: 'task_stop', detail: 'bg_bc67cecc' }));
    expect(engine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(0);
    vi.advanceTimersByTime(10);
    expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
  });

  it('ignores noActivityHold on an anonymous start: it is honored only on a named one', () => {
    engine.processEvent(SESSION_ID, at(EventType.BackgroundShellStart, { detail: 'node server.js and more words', noActivityHold: true }));
    const state = engine.getState(SESSION_ID);
    expect(state?.anonymousBackgroundShellCount).toBe(1);
    expect(state?.exemptBackgroundShellIds.size).toBe(0);
  });
});
