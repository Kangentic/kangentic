/**
 * `ActivityEngineCallbacks.onTurnEnded`: the signal column automations' On
 * agent turn end and a workflow task's step check hang off. It must fire once
 * for a turn the agent itself ended, after that turn has fully settled, and
 * never for an interrupt, a failed turn, an `idle_hint` (Esc between tool
 * calls ends a turn that way, with no hook), PTY silence, a watchdog guess, a
 * resume's idle seed, or a permission prompt.
 *
 * The replay half drives task #529's eighth Code Review pass (session #76),
 * whose Stops arrived while background `test-builder` subagents were still
 * running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'turn-end-session';
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');

interface Harness {
  engine: ActivityEngine;
  turnEnds: number[];
  send: (type: EventType, extra?: Partial<SessionEvent>) => void;
}

function createHarness(options: { stabilityMs?: number; seedThinking?: boolean } = {}): Harness {
  const turnEnds: number[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange() {},
      onTurnEnded() {
        turnEnds.push(Date.now());
      },
    },
    {
      idleStabilityWindowMs: options.stabilityMs ?? 0,
      bgShellEscapeHatchMs: 300_000,
      staleThinkingTimeoutMs: 180_000,
    },
  );
  engine.initSession(SESSION_ID, options.seedThinking ?? false);
  const send = (type: EventType, extra: Partial<SessionEvent> = {}) => {
    engine.processEvent(SESSION_ID, { ts: Date.now(), type, ...extra });
  };
  return { engine, turnEnds, send };
}

function loadFixture(name: string): SessionEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as SessionEvent);
}

describe('onTurnEnded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once for a turn the agent ended with its Stop', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.ToolEnd, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    // A second Stop for the same turn reports nothing more.
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('fires for a fresh spawn seeded thinking, whose first Stop is its first turn end', () => {
    const harness = createHarness({ seedThinking: true });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('never fires for a resume idle seed, with no turn behind it', () => {
    const harness = createHarness();
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('waits out the stability window and fires once it commits', () => {
    const harness = createHarness({ stabilityMs: 400 });
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    vi.advanceTimersByTime(399);
    expect(harness.turnEnds).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a new turn inside the stability window cancels the pending turn end', () => {
    const harness = createHarness({ stabilityMs: 400 });
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(100);
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(1000);
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(401);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('does not fire for an idle_hint that ends the turn (Esc between tool calls fires no hook)', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'b' });
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'b' });
    harness.send(EventType.IdleHint, { detail: 'Claude is waiting for your input' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('does not fire for an interrupt (Esc during a tool, Ctrl+C)', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'c' });
    harness.send(EventType.Interrupted, { tool: 'Bash' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    // A Stop that trails the interrupt reports nothing either: the turn did not finish.
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('does not fire for a failed turn, nor for a retry that wound down', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.TurnFailed, { detail: 'server_error' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Prompt);
    harness.send(EventType.IdleHint, { detail: 'Claude is waiting for your input' });
    harness.send(EventType.TurnRetrying, { detail: 'overloaded' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('fires after a live retry resolves into a real Stop', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.TurnRetrying, { detail: 'overloaded' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    harness.send(EventType.ToolStart, { tool: 'Read', toolId: 'd' });
    harness.send(EventType.ToolEnd, { tool: 'Read', toolId: 'd' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a permission prompt is the agent waiting mid-turn, not a turn end', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'e' });
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('permission');
    expect(harness.turnEnds).toHaveLength(0);
    // Approved: the tool ends and the turn carries on to its own Stop.
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'e' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('holds the turn end until background shells the Stop left running drain', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'f', detail: 'shell-1' });
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.BackgroundShellEnd, { detail: 'shell-1' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a Stop inside a live subagent is the subagent\'s; the parent\'s Stop after it ends the turn once', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.SubagentStart, { detail: 'review-finder' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.SubagentStop, { detail: 'review-finder' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('PTY silence and a dead agent are not turn ends', () => {
    const harness = createHarness();
    harness.engine.forceThinking(SESSION_ID);
    harness.engine.forceIdle(SESSION_ID);
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('the stale-thinking watchdog idles a turn whose Stop never came, without a turn end', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(181_000);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  describe('session-030: #529 Code Review pass with background test-builder subagents', () => {
    // The pass fanned out to background reviewers and test-builders. Claude
    // logged a Stop each time the main agent paused to wait on them; the
    // engine holds the turn while they run (subagent depth > 0), so those
    // Stops report nothing, and only the three after which no subagent was
    // left are turn ends. Seconds are from the pass's first event.
    function replayTurnEnds(): { turnEnds: number[]; stops: number[] } {
      const events = loadFixture('session-030-code-review-background-subagents.jsonl');
      const turnEnds: number[] = [];
      let currentTs = 0;
      const engine = new ActivityEngine(
        {
          onActivityChange() {},
          onTurnEnded() {
            turnEnds.push(currentTs);
          },
        },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 1000, staleThinkingTimeoutMs: 60_000 },
      );
      engine.initSession(SESSION_ID, true);
      for (const event of events) {
        currentTs = event.ts;
        engine.processEvent(SESSION_ID, event);
      }
      engine.dispose();
      const first = events[0]?.ts ?? 0;
      const toSeconds = (ts: number) => Math.round((ts - first) / 1000);
      return {
        turnEnds: turnEnds.map(toSeconds),
        stops: events.filter((event) => event.type === EventType.Idle).map((event) => toSeconds(event.ts)),
      };
    }

    it('of twelve Stops, only the three with no subagent left running end a turn', () => {
      const { turnEnds, stops } = replayTurnEnds();
      expect(stops).toHaveLength(12);
      expect(turnEnds).toEqual([2295, 2779, 4878]);
    });

    it('the Stops logged while background reviewers and test-builders ran report nothing', () => {
      const { turnEnds } = replayTurnEnds();
      for (const heldStop of [676, 1459, 1782, 1868, 2074]) {
        expect(turnEnds).not.toContain(heldStop);
      }
    });
  });
});
