/**
 * Unit tests for the `toolCallCount` stamp added in session-telemetry.ts.
 *
 * Context: the renderer's `sessionEvents` cache is bounded at 500 entries.
 * After 500 events the renderer can no longer derive an accurate total
 * tool-call count by scanning its own cache. The fix stamps the authoritative
 * cumulative count from `UsageAccumulator.getToolCallCount()` onto the
 * `SessionUsage` payload at every `onUsageChange` emit, so the renderer always
 * receives the true count regardless of event-cache size.
 *
 * Two stamp sites are tested:
 *   1. `processStatusUpdate` - the Claude status-file ingest path.
 *   2. `setSessionUsage` - the Codex/Gemini merge path.
 *
 * The cap-immunity assertion is the centerpiece: after MORE than 500 tool
 * events (the renderer event-cache cap), the stamped `toolCallCount` must
 * equal the true cumulative count from the accumulator, not 500.
 *
 * Red-green verification: removing either stamp assignment from
 * session-telemetry.ts causes the matching assertion to fail because
 * `toolCallCount` would be undefined (stamp removed) instead of the expected
 * numeric count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionUsage, SessionEvent } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal callbacks — only `onUsageChange` is exercised in these tests. */
function makeCallbacks(onUsageChange: (sessionId: string, usage: SessionUsage) => void) {
  return {
    onUsageChange,
    onActivityChange: () => {},
    onEvent: () => {},
    onIdleTimeout: () => {},
    onPlanExit: () => {},
    onPRCandidate: () => {},
    requestSuspend: () => {},
    isSessionRunning: () => true,
  };
}

function makeTracker(onUsageChange: (sessionId: string, usage: SessionUsage) => void): SessionTelemetry {
  return new SessionTelemetry(
    makeCallbacks(onUsageChange),
    { disableBgShellWatcher: true },
  );
}

function toolEndEvent(toolName: string, timestamp: number): SessionEvent {
  return { ts: timestamp, type: EventType.ToolEnd, tool: toolName };
}

function toolStartEvent(toolName: string, timestamp: number): SessionEvent {
  return { ts: timestamp, type: EventType.ToolStart, tool: toolName };
}

/**
 * Minimal valid `SessionUsage` for the status-update ingest path.
 * `toolCallCount` is intentionally absent here to mirror what the
 * status-file reader emits before the stamp is applied.
 */
function minimalUsage(): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: 0,
      usedTokens: 0,
      cacheTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextWindowSize: 200_000,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'sonnet', displayName: 'Claude Sonnet' },
  };
}

// ---------------------------------------------------------------------------
// Test suite 1: processStatusUpdate stamp
// ---------------------------------------------------------------------------

describe('SessionTelemetry: processStatusUpdate stamps toolCallCount', () => {
  const SESSION_ID = 'sess-stamp-test';
  let emitted: SessionUsage | undefined;
  let tracker: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = undefined;
    tracker = makeTracker((sessionId, usage) => {
      if (sessionId === SESSION_ID) emitted = usage;
    });
    tracker.initSession(SESSION_ID);
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('stamps the accumulator tool-call count onto the emitted SessionUsage', () => {
    // Ingest 3 paired tool calls so the accumulator holds a count of 3.
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Bash', 1), toolEndEvent('Bash', 2),
      toolStartEvent('Read', 3), toolEndEvent('Read', 4),
      toolStartEvent('Edit', 5), toolEndEvent('Edit', 6),
    ]);

    // The accumulator's count is the intended behavior - not what the
    // renderer's bounded cache would return.
    const expectedCount = tracker.getToolCallCount(SESSION_ID);
    expect(expectedCount).toBe(3);

    // Fire the status-update path (Claude status-file reader).
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());

    // The emitted payload must carry the stamped count.
    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(expectedCount);
  });

  it('cap-immunity: toolCallCount stays accurate past the 500-event renderer cache cap', () => {
    // The renderer's `sessionEvents` cache caps at 500 events (MAX_EVENTS_PER_SESSION).
    // After that the renderer cannot count tool calls itself. The stamp in the
    // main process survives the cap because UsageAccumulator tracks counts
    // independently of the bounded eventCache.
    //
    // Drive 600 paired tool calls = 1200 events (well past the 500-entry cap).
    const events: SessionEvent[] = [];
    for (let callIndex = 0; callIndex < 600; callIndex += 1) {
      events.push(toolStartEvent('Bash', callIndex * 2));
      events.push(toolEndEvent('Bash', callIndex * 2 + 1));
    }
    tracker.ingestEvents(SESSION_ID, events);

    const trueCount = tracker.getToolCallCount(SESSION_ID);
    expect(trueCount).toBe(600); // Precondition: accumulator holds the true count.

    // Trigger the status-update stamp.
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());

    // The emitted payload must carry the true count (600), NOT 500.
    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(600);
    expect(emitted!.toolCallCount).not.toBe(500); // Explicit: NOT clamped to the cache limit.
  });

  it('stamps 0 when no tool events have been ingested yet', () => {
    // Edge case: first status update arrives before any tool events.
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());

    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(0);
  });

  it('accumulates across multiple processStatusUpdate calls', () => {
    // Each status update re-stamps with the current accumulator total.
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Bash', 1), toolEndEvent('Bash', 2),
    ]);
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());
    const firstEmitted = emitted;
    expect(firstEmitted?.toolCallCount).toBe(1);

    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Read', 3), toolEndEvent('Read', 4),
      toolStartEvent('Edit', 5), toolEndEvent('Edit', 6),
    ]);
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());
    // Count is cumulative: the second update should reflect all 3 tool calls.
    expect(emitted?.toolCallCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: setSessionUsage stamp (Codex/Gemini merge path)
// ---------------------------------------------------------------------------

describe('SessionTelemetry: setSessionUsage stamps toolCallCount', () => {
  const SESSION_ID = 'sess-merge-stamp-test';
  let emitted: SessionUsage | undefined;
  let tracker: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = undefined;
    tracker = makeTracker((sessionId, usage) => {
      if (sessionId === SESSION_ID) emitted = usage;
    });
    tracker.initSession(SESSION_ID);
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('stamps the accumulator tool-call count on the merged usage emitted via setSessionUsage', () => {
    // Ingest 4 tool calls before the merge-path update arrives.
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Bash', 1), toolEndEvent('Bash', 2),
      toolStartEvent('Read', 3), toolEndEvent('Read', 4),
      toolStartEvent('Edit', 5), toolEndEvent('Edit', 6),
      toolStartEvent('Grep', 7), toolEndEvent('Grep', 8),
    ]);

    const expectedCount = tracker.getToolCallCount(SESSION_ID);
    expect(expectedCount).toBe(4);

    // Fire the Codex/Gemini merge path.
    tracker.setSessionUsage(SESSION_ID, {
      cost: { totalCostUsd: 0.05, totalDurationMs: 5_000 },
    });

    // The merged payload forwarded to onUsageChange must carry the stamped count.
    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(expectedCount);
  });

  it('cap-immunity via setSessionUsage: count is not bounded by the event-cache limit', () => {
    // Same cap-immunity guarantee as processStatusUpdate, but via the merge path.
    const events: SessionEvent[] = [];
    for (let callIndex = 0; callIndex < 700; callIndex += 1) {
      events.push(toolStartEvent('Bash', callIndex * 2));
      events.push(toolEndEvent('Bash', callIndex * 2 + 1));
    }
    tracker.ingestEvents(SESSION_ID, events);

    const trueCount = tracker.getToolCallCount(SESSION_ID);
    expect(trueCount).toBe(700);

    tracker.setSessionUsage(SESSION_ID, {
      cost: { totalCostUsd: 0.10, totalDurationMs: 10_000 },
    });

    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(700);
    expect(emitted!.toolCallCount).not.toBe(500);
  });

  it('setSessionUsage merges partial fields while stamping the count', () => {
    // Verify that the merge semantics are preserved: cost fields from the
    // partial update should appear on the merged payload alongside the stamp.
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Bash', 1), toolEndEvent('Bash', 2),
    ]);

    tracker.setSessionUsage(SESSION_ID, {
      cost: { totalCostUsd: 0.02, totalDurationMs: 2_000 },
      model: { id: 'codex-mini', displayName: 'Codex mini' },
    });

    expect(emitted).toBeDefined();
    expect(emitted!.toolCallCount).toBe(1);
    // Merge correctness: partial fields from the update appear on the payload.
    expect(emitted!.cost.totalCostUsd).toBe(0.02);
    expect(emitted!.model.id).toBe('codex-mini');
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: the earlier runs' count (a resumed session is a new record)
// ---------------------------------------------------------------------------

describe('SessionTelemetry: the stamp adds the earlier runs\' tool calls', () => {
  const SESSION_ID = 'sess-resumed';
  let emittedUsages: SessionUsage[];
  let tracker: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    emittedUsages = [];
    tracker = makeTracker((sessionId, usage) => {
      if (sessionId === SESSION_ID) emittedUsages.push({ ...usage });
    });
    tracker.initSession(SESSION_ID);
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('shows the earlier runs\' count on the first usage, before any new call', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 482);

    tracker.processStatusUpdate(SESSION_ID, minimalUsage());

    expect(emittedUsages.at(-1)?.toolCallCount).toBe(482);
  });

  it('adds this run\'s calls on both stamp paths', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 482);
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Read', 1), toolEndEvent('Read', 2),
      toolStartEvent('Bash', 3), toolEndEvent('Bash', 4),
    ]);

    tracker.processStatusUpdate(SESSION_ID, minimalUsage());
    expect(emittedUsages.at(-1)?.toolCallCount).toBe(484);

    tracker.setSessionUsage(SESSION_ID, { cost: { totalCostUsd: 0.01, totalDurationMs: 1_000 } });
    expect(emittedUsages.at(-1)?.toolCallCount).toBe(484);
  });

  it('keeps the per-run reads per run, so no record stores another run\'s calls', () => {
    // captureSessionMetrics writes these to this run's record and the Session
    // Summary sums records: an earlier count here would be stored twice.
    tracker.setEarlierToolCallCount(SESSION_ID, 482);
    tracker.ingestEvents(SESSION_ID, [toolStartEvent('Read', 1), toolEndEvent('Read', 2)]);

    expect(tracker.getToolCallCount(SESSION_ID)).toBe(1);
    expect(tracker.getToolBreakdown(SESSION_ID).map((stat) => stat.callCount)).toEqual([1]);
  });

  it('re-emits a usage already on screen when the earlier count changes, and only then', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 30);
    tracker.processStatusUpdate(SESSION_ID, minimalUsage());
    const emitsBefore = emittedUsages.length;

    // The popover's fresh read found a backfill that landed after the spawn.
    tracker.setEarlierToolCallCount(SESSION_ID, 36);
    expect(emittedUsages).toHaveLength(emitsBefore + 1);
    expect(emittedUsages.at(-1)?.toolCallCount).toBe(36);
    expect(tracker.getUsageCache()[SESSION_ID].toolCallCount).toBe(36);

    tracker.setEarlierToolCallCount(SESSION_ID, 36);
    expect(emittedUsages).toHaveLength(emitsBefore + 1);
  });

  it('re-stamps a usage the known-window backfill re-emits with this run plus the earlier runs', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 482);
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Read', 1), toolEndEvent('Read', 2),
      toolStartEvent('Bash', 3), toolEndEvent('Bash', 4),
    ]);
    // A parked session's transcript fallback: tokens and a model, no window yet.
    tracker.setSessionUsage(SESSION_ID, {
      contextWindow: {
        usedPercentage: 0,
        usedTokens: 200_000,
        cacheTokens: 0,
        totalInputTokens: 200_000,
        totalOutputTokens: 0,
        contextWindowSize: 0,
      },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    });
    expect(emittedUsages.at(-1)?.toolCallCount).toBe(484);

    // More calls land after that emit. Ingesting events re-stamps nothing, so the
    // cached usage still carries the 484 it was stamped with. Without this gap
    // the cache would already hold the right number and the re-emit below could
    // not tell a fresh stamp from a stale one.
    tracker.ingestEvents(SESSION_ID, [
      toolStartEvent('Grep', 5), toolEndEvent('Grep', 6),
      toolStartEvent('Edit', 7), toolEndEvent('Edit', 8),
      toolStartEvent('Write', 9), toolEndEvent('Write', 10),
    ]);
    expect(tracker.getUsageCache()[SESSION_ID].toolCallCount).toBe(484);
    const emitsBefore = emittedUsages.length;

    // The window learned at project open back-fills the parked session.
    tracker.hydrateKnownWindows([{ modelId: 'claude-opus-4-8', contextWindowSize: 1_000_000 }]);

    expect(emittedUsages).toHaveLength(emitsBefore + 1);
    // The back-fill path ran: the window is filled in on the re-emitted usage.
    expect(emittedUsages.at(-1)?.contextWindow.contextWindowSize).toBe(1_000_000);
    // 5 calls this run plus the 482 earlier ones.
    expect(emittedUsages.at(-1)?.toolCallCount).toBe(487);
  });

  it('emits nothing before the first usage exists', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 482);

    expect(emittedUsages).toHaveLength(0);
  });

  it('forgets the earlier count when the session is removed', () => {
    tracker.setEarlierToolCallCount(SESSION_ID, 482);
    tracker.removeSession(SESSION_ID);
    tracker.initSession(SESSION_ID);

    tracker.processStatusUpdate(SESSION_ID, minimalUsage());

    expect(emittedUsages.at(-1)?.toolCallCount).toBe(0);
  });
});
