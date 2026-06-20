/**
 * Per-tool aggregator tests. Drives `SessionTelemetry.ingestEvents` with synthetic
 * events and asserts the snapshots returned by `getToolBreakdown` /
 * `getToolCallCount`. Covers FIFO pairing, interleaved tool names, interrupted
 * pairs, the optional cost/token fields on ToolEnd, and the bounded-cache
 * resilience that motivated the standalone counter (see audit failure mode #5).
 */
import { describe, it, expect } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

function makeTracker(): SessionTelemetry {
  return new SessionTelemetry({
    onUsageChange: () => {},
    onActivityChange: () => {},
    onEvent: () => {},
    onIdleTimeout: () => {},
    onPlanExit: () => {},
    onPRCandidate: () => {},
    requestSuspend: () => {},
    isSessionRunning: () => true,
  });
}

function start(tool: string, ts: number): SessionEvent {
  return { ts, type: EventType.ToolStart, tool };
}

function end(tool: string, ts: number, extra?: Partial<SessionEvent>): SessionEvent {
  return { ts, type: EventType.ToolEnd, tool, ...extra };
}

function interrupted(tool: string, ts: number): SessionEvent {
  return { ts, type: EventType.Interrupted, tool };
}

const SID = 'session-1';

describe('SessionTelemetry per-tool aggregator', () => {
  it('pairs ToolStart and ToolEnd by tool name FIFO', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Bash', 1_000),
      end('Bash', 1_500),
      start('Read', 2_000),
      end('Read', 2_100),
    ]);
    const rows = tracker.getToolBreakdown(SID);
    expect(rows).toHaveLength(2);
    const bashRow = rows.find((row) => row.toolName === 'Bash');
    const readRow = rows.find((row) => row.toolName === 'Read');
    expect(bashRow).toMatchObject({ callCount: 1, totalDurationMs: 500, interruptedCount: 0 });
    expect(readRow).toMatchObject({ callCount: 1, totalDurationMs: 100, interruptedCount: 0 });
  });

  it('handles interleaved tools with a per-tool FIFO', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Bash', 0),
      start('Read', 50),
      end('Read', 150),
      start('Bash', 200),
      end('Bash', 600),
      end('Bash', 700),
    ]);
    const rows = tracker.getToolBreakdown(SID);
    const bashRow = rows.find((row) => row.toolName === 'Bash');
    const readRow = rows.find((row) => row.toolName === 'Read');
    // Bash: first end pairs with start@0 -> 600ms; second end pairs with start@200 -> 500ms
    expect(bashRow).toMatchObject({ callCount: 2, totalDurationMs: 1100 });
    expect(readRow).toMatchObject({ callCount: 1, totalDurationMs: 100 });
  });

  it('counts Interrupted events separately from successful ToolEnd', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Bash', 0),
      interrupted('Bash', 250),
      start('Bash', 300),
      end('Bash', 800),
    ]);
    const rows = tracker.getToolBreakdown(SID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolName: 'Bash',
      callCount: 1,
      interruptedCount: 1,
      totalDurationMs: 750, // 250 (interrupted) + 500 (success)
    });
  });

  it('sums optional cost and token fields when present on ToolEnd', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Bash', 0),
      end('Bash', 100, { costUsd: 0.005, inputTokens: 200, outputTokens: 50 }),
      start('Bash', 200),
      end('Bash', 400, { costUsd: 0.003, inputTokens: 100, outputTokens: 25 }),
      start('Read', 500),
      end('Read', 600),
    ]);
    const rows = tracker.getToolBreakdown(SID);
    const bashRow = rows.find((row) => row.toolName === 'Bash');
    const readRow = rows.find((row) => row.toolName === 'Read');
    expect(bashRow).toMatchObject({ callCount: 2, costUsd: 0.008, inputTokens: 300, outputTokens: 75 });
    // Read had no cost/token data on its end event - fields should be omitted entirely.
    expect(readRow?.costUsd).toBeUndefined();
    expect(readRow?.inputTokens).toBeUndefined();
    expect(readRow?.outputTokens).toBeUndefined();
  });

  it('sorts by cost descending when any row carries cost, otherwise by duration', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Cheap', 0),
      end('Cheap', 1_000, { costUsd: 0.01 }),
      start('Expensive', 0),
      end('Expensive', 100, { costUsd: 0.50 }),
    ]);
    const withCost = tracker.getToolBreakdown(SID);
    expect(withCost.map((row) => row.toolName)).toEqual(['Expensive', 'Cheap']);

    const noCostTracker = makeTracker();
    noCostTracker.initSession('session-2');
    noCostTracker.ingestEvents('session-2', [
      start('Slow', 0),
      end('Slow', 5_000),
      start('Fast', 0),
      end('Fast', 50),
    ]);
    const byDuration = noCostTracker.getToolBreakdown('session-2');
    expect(byDuration.map((row) => row.toolName)).toEqual(['Slow', 'Fast']);
  });

  it('getToolCallCount sums all ToolEnd events across tools', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [
      start('Bash', 0), end('Bash', 1),
      start('Bash', 2), end('Bash', 3),
      start('Read', 4), end('Read', 5),
      start('Edit', 6), interrupted('Edit', 7), // Interrupted does not increment callCount
    ]);
    expect(tracker.getToolCallCount(SID)).toBe(3);
  });

  it('total counter is unaffected by the bounded event-cache trim', () => {
    // Drive 1200 paired tool calls (well past MAX_EVENTS_PER_SESSION = 500
    // and the 2400 events those pairs add to eventCache). Reproduces audit
    // failure mode #5 -- before the dedicated counter, captureSessionMetrics
    // counted from the trimmed eventCache and undercounted long sessions.
    const tracker = makeTracker();
    tracker.initSession(SID);
    const events: SessionEvent[] = [];
    for (let i = 0; i < 1200; i += 1) {
      events.push(start('Bash', i * 2));
      events.push(end('Bash', i * 2 + 1));
    }
    tracker.ingestEvents(SID, events);
    expect(tracker.getToolCallCount(SID)).toBe(1200);
    const rows = tracker.getToolBreakdown(SID);
    expect(rows[0]).toMatchObject({ toolName: 'Bash', callCount: 1200 });
  });

  it('removeSession clears per-tool state', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [start('Bash', 0), end('Bash', 100)]);
    expect(tracker.getToolCallCount(SID)).toBe(1);
    tracker.removeSession(SID);
    expect(tracker.getToolCallCount(SID)).toBe(0);
    expect(tracker.getToolBreakdown(SID)).toEqual([]);
  });

  it('returns an empty breakdown for sessions with no tool events', () => {
    const tracker = makeTracker();
    tracker.initSession(SID);
    expect(tracker.getToolBreakdown(SID)).toEqual([]);
    expect(tracker.getToolCallCount(SID)).toBe(0);
  });

  it('an unmatched ToolEnd still counts (start was dropped pre-capture)', () => {
    // If a ToolStart was issued before this session began capturing (e.g.
    // resumed from suspend), the pairing FIFO is empty when ToolEnd arrives.
    // We still increment callCount so the totals don't lie - duration is
    // simply zero for that orphan pair.
    const tracker = makeTracker();
    tracker.initSession(SID);
    tracker.ingestEvents(SID, [end('Bash', 100)]);
    const rows = tracker.getToolBreakdown(SID);
    expect(rows).toEqual([{ toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }]);
  });
});
