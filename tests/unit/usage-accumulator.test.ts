import { describe, it, expect, beforeEach } from 'vitest';
import { UsageAccumulator } from '../../src/main/activity-engine/usage-accumulator';
import { EventType } from '../../src/shared/types';
import type { SessionUsage, SessionEvent } from '../../src/shared/types';

/** Build a tool lifecycle event, optionally carrying cost/token fields. */
function toolEvent(
  type: EventType,
  tool: string | undefined,
  ts: number,
  extra: Partial<SessionEvent> = {},
): SessionEvent {
  return { ts, type, tool, ...extra };
}

/**
 * UsageAccumulator.setSessionUsage() merge behavior tests.
 *
 * The merge logic uses shallow spread:
 *   contextWindow: { ...base.contextWindow, ...(partial.contextWindow ?? {}) }
 *
 * This means partial updates must only include fields that were actually
 * captured. If a partial includes `contextWindowSize: 0` (default for
 * uncaptured), it overwrites a previously-set non-zero value. These
 * tests verify the merge produces correct results when telemetry
 * arrives across multiple chunks (Codex append-mode JSONL).
 */
describe('UsageAccumulator.setSessionUsage - merge behavior', () => {
  let usage: UsageAccumulator;

  beforeEach(() => {
    usage = new UsageAccumulator();
  });

  it('partial contextWindow merge does not overwrite base values with zeros', () => {
    let merged = usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(200000);

    merged = usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    expect(merged.contextWindow.contextWindowSize).toBe(200000);
    expect(merged.model.id).toBe('gpt-5.3-codex');
  });

  it('usedPercentage is recalculated after cross-chunk merge', () => {
    let merged = usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.usedPercentage).toBe(0);

    merged = usage.setSessionUsage('test-session', {
      contextWindow: { usedTokens: 180000 },
    } as Partial<SessionUsage>);

    expect(merged.contextWindow.contextWindowSize).toBe(200000);
    expect(merged.contextWindow.usedTokens).toBe(180000);
    expect(merged.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 200000) * 100,
      2,
    );
  });

  it('model merge preserves base model when partial has no model', () => {
    let merged = usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);
    expect(merged.model.id).toBe('gpt-5.3-codex');

    merged = usage.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 50000,
        totalInputTokens: 50000,
        contextWindowSize: 200000,
      },
    } as Partial<SessionUsage>);

    expect(merged.model.id).toBe('gpt-5.3-codex');
    expect(merged.model.displayName).toBe('gpt-5.3-codex');
    expect(merged.contextWindow.usedTokens).toBe(50000);
  });

  it('three-chunk Codex sequence produces correct final state', () => {
    usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 258400 },
    } as Partial<SessionUsage>);

    usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    const final = usage.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 180000,
        totalInputTokens: 180000,
        totalOutputTokens: 50,
        cacheTokens: 5000,
      },
    } as Partial<SessionUsage>);

    expect(final.model.id).toBe('gpt-5.3-codex');
    expect(final.contextWindow.contextWindowSize).toBe(258400);
    expect(final.contextWindow.usedTokens).toBe(180000);
    expect(final.contextWindow.totalOutputTokens).toBe(50);
    expect(final.contextWindow.cacheTokens).toBe(5000);
    expect(final.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 258400) * 100,
      2,
    );
  });

  it('pairs a seeded 1M window with fresh transcript tokens into a real percentage', () => {
    // The resume seed sets the authoritative window; the transcript fallback then
    // supplies tokens with no window of its own.
    usage.setSessionUsage('resume-session', {
      contextWindow: { contextWindowSize: 1_000_000 },
    } as Partial<SessionUsage>);
    const merged = usage.setSessionUsage('resume-session', {
      contextWindow: { usedTokens: 650_398, totalInputTokens: 650_398 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(merged.contextWindow.usedPercentage).toBeCloseTo((650_398 / 1_000_000) * 100, 2);
  });

  it('degrades to the 0-sentinel when usedTokens exceeds the window (impossible pairing)', () => {
    // A stale 200K window (wrong for a 1M account) paired with 650,398 fresh
    // tokens would be 325%. The window is wrong, not the tokens: degrade to the
    // 0 "unknown size" sentinel (model-only), NEVER clamp to 100.
    usage.setSessionUsage('bad-session', {
      contextWindow: { contextWindowSize: 200_000 },
    } as Partial<SessionUsage>);
    const merged = usage.setSessionUsage('bad-session', {
      contextWindow: { usedTokens: 650_398, totalInputTokens: 650_398 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(0);
    expect(merged.contextWindow.usedPercentage).toBe(0);
    // Tokens are preserved (they are not the wrong part).
    expect(merged.contextWindow.usedTokens).toBe(650_398);
  });

  it('the degrade is sticky: a later token-only merge still sees the 0 window', () => {
    usage.setSessionUsage('bad-session', {
      contextWindow: { contextWindowSize: 200_000 },
    } as Partial<SessionUsage>);
    usage.setSessionUsage('bad-session', {
      contextWindow: { usedTokens: 650_398 },
    } as Partial<SessionUsage>);
    const later = usage.setSessionUsage('bad-session', {
      contextWindow: { usedTokens: 660_000 },
    } as Partial<SessionUsage>);
    expect(later.contextWindow.contextWindowSize).toBe(0);
    expect(later.contextWindow.usedPercentage).toBe(0);
  });

  it('fills a missing window from the known account window for the model (background transcript fallback)', () => {
    // A status.json from ANY session of this model teaches the accumulator the
    // account+model window.
    usage.recordKnownWindow('claude-opus-4-8', 1_000_000);
    // A different, background session of the same model has only the transcript
    // fallback: tokens + model, NO window. It must pair with the known window.
    const merged = usage.setSessionUsage('background-session', {
      contextWindow: { usedTokens: 357_527, totalInputTokens: 357_527 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(merged.contextWindow.usedPercentage).toBeCloseTo((357_527 / 1_000_000) * 100, 2);
  });

  it('RETROACTIVELY fills and returns an already-cached background session when the window is learned later', () => {
    // The exact live gap: an idle background Opus session emitted tokens with NO
    // window (its statusLine never painted), so its card showed the model name
    // only. When a SIBLING Opus session paints and teaches the 1M window, the
    // idle session must be back-filled and re-emitted - not left on the model
    // name until it happens to emit usage again.
    const before = usage.setSessionUsage('background-session', {
      contextWindow: { usedTokens: 175_422, totalInputTokens: 175_422 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);
    expect(before.contextWindow.contextWindowSize).toBe(0);

    const refilled = usage.recordKnownWindow('claude-opus-4-8', 1_000_000);
    expect(refilled).toContain('background-session');

    const after = usage.getSessionUsage('background-session')!;
    expect(after.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(after.contextWindow.usedPercentage).toBeCloseTo((175_422 / 1_000_000) * 100, 2);
  });

  it('does NOT retroactively fill a cached session whose tokens exceed the learned window', () => {
    usage.setSessionUsage('background-session', {
      contextWindow: { usedTokens: 650_398 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);
    const refilled = usage.recordKnownWindow('claude-opus-4-8', 200_000);
    expect(refilled).not.toContain('background-session');
    expect(usage.getSessionUsage('background-session')!.contextWindow.contextWindowSize).toBe(0);
  });

  it('keys the known window by base model id ([1m] variant shares the value)', () => {
    usage.recordKnownWindow('claude-opus-4-8[1m]', 1_000_000);
    const merged = usage.setSessionUsage('s', {
      contextWindow: { usedTokens: 100_000 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(1_000_000);
  });

  it('shows the model only (no fill) when no known window exists for the model', () => {
    const merged = usage.setSessionUsage('s', {
      contextWindow: { usedTokens: 100_000 },
      model: { id: 'claude-quasar-9', displayName: 'Quasar 9' },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(0);
    expect(merged.contextWindow.usedPercentage).toBe(0);
  });

  it('a filled window that is too small still degrades to the sentinel (never > 100%)', () => {
    // If the only known window for a model is wrong-and-too-small, the
    // impossibility guard still fires - the fill never produces an impossible %.
    usage.recordKnownWindow('claude-opus-4-8', 200_000);
    const merged = usage.setSessionUsage('s', {
      contextWindow: { usedTokens: 650_398 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(0);
    expect(merged.contextWindow.usedPercentage).toBe(0);
  });

  it('replaceSessionUsage bypasses the impossibility guard (status.json is self-consistent and already clamped)', () => {
    // The status.json path replaces the whole payload with Claude's own numbers.
    // Its used_percentage is clamped upstream, and its usedTokens include output
    // tokens which can legitimately brush the window near full - so replace never
    // second-guesses it.
    const authoritative: SessionUsage = {
      contextWindow: {
        usedPercentage: 92,
        usedTokens: 184_000,
        cacheTokens: 100_000,
        totalInputTokens: 184_000,
        totalOutputTokens: 2_000,
        contextWindowSize: 200_000,
      },
      cost: { totalCostUsd: 1.5, totalDurationMs: 1000 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    };
    usage.replaceSessionUsage('status-session', authoritative);
    const cached = usage.getSessionUsage('status-session');
    expect(cached?.contextWindow.contextWindowSize).toBe(200_000);
    expect(cached?.contextWindow.usedPercentage).toBe(92);
  });
});

describe('UsageAccumulator - per-tool aggregation', () => {
  let usage: UsageAccumulator;

  beforeEach(() => {
    usage = new UsageAccumulator();
  });

  it('ignores non-tool events', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.Prompt, undefined, 0));
    expect(usage.getToolBreakdown('s1')).toEqual([]);
    expect(usage.getToolCallCount('s1')).toBe(0);
  });

  it('pairs ToolStart/ToolEnd by name (FIFO) and accumulates duration', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Bash', 1000));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Bash', 1500));
    const [bash] = usage.getToolBreakdown('s1');
    expect(bash.toolName).toBe('Bash');
    expect(bash.callCount).toBe(1);
    expect(bash.totalDurationMs).toBe(500);
  });

  it('an unmatched ToolEnd still counts but contributes zero duration', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Read', 2000));
    const [read] = usage.getToolBreakdown('s1');
    expect(read.callCount).toBe(1);
    expect(read.totalDurationMs).toBe(0);
  });

  it('Interrupted increments interruptedCount, not callCount', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Bash', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.Interrupted, 'Bash', 100));
    const [bash] = usage.getToolBreakdown('s1');
    expect(bash.callCount).toBe(0);
    expect(bash.interruptedCount).toBe(1);
    expect(usage.getToolCallCount('s1')).toBe(0);
  });

  it('accumulates cost and tokens carried on ToolEnd and surfaces them only when present', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Bash', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Bash', 10, {
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 40,
    }));
    const [bash] = usage.getToolBreakdown('s1');
    expect(bash.costUsd).toBe(0.25);
    expect(bash.inputTokens).toBe(100);
    expect(bash.outputTokens).toBe(40);

    // A tool with no cost/token data omits those optional fields entirely.
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Read', 5));
    const read = usage.getToolBreakdown('s1').find((row) => row.toolName === 'Read')!;
    expect(read.costUsd).toBeUndefined();
    expect(read.inputTokens).toBeUndefined();
    expect(read.outputTokens).toBeUndefined();
  });

  it('getToolBreakdown skips tools that only started (zero completed and zero interrupted)', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Bash', 0)); // never ended
    expect(usage.getToolBreakdown('s1')).toEqual([]);
  });

  it('sorts by duration descending when no row carries cost', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Quick', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Quick', 100));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Slow', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Slow', 900));
    expect(usage.getToolBreakdown('s1').map((row) => row.toolName)).toEqual(['Slow', 'Quick']);
  });

  it('sorts by cost descending when any row carries cost', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Cheap', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Cheap', 900, { costUsd: 0.01 }));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolStart, 'Pricey', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Pricey', 100, { costUsd: 0.5 }));
    // Pricey wins on cost despite a shorter duration.
    expect(usage.getToolBreakdown('s1').map((row) => row.toolName)).toEqual(['Pricey', 'Cheap']);
  });

  it('getToolCallCount sums completed calls across tools (excludes interrupted)', () => {
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Bash', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Read', 0));
    usage.recordToolEvent('s1', toolEvent(EventType.Interrupted, 'Bash', 0));
    expect(usage.getToolCallCount('s1')).toBe(2);
    expect(usage.getToolCallCount('unknown')).toBe(0);
  });

  it('getUsageCache returns every cached session usage', () => {
    usage.setSessionUsage('s1', { contextWindow: { contextWindowSize: 1000 } } as Partial<SessionUsage>);
    usage.setSessionUsage('s2', { contextWindow: { contextWindowSize: 2000 } } as Partial<SessionUsage>);
    const cache = usage.getUsageCache();
    expect(Object.keys(cache).sort()).toEqual(['s1', 's2']);
    expect(cache.s1.contextWindow.contextWindowSize).toBe(1000);
  });

  it('removeSession drops both usage and per-tool stats', () => {
    usage.setSessionUsage('s1', {} as Partial<SessionUsage>);
    usage.recordToolEvent('s1', toolEvent(EventType.ToolEnd, 'Bash', 0));
    usage.removeSession('s1');
    expect(usage.getSessionUsage('s1')).toBeUndefined();
    expect(usage.getToolBreakdown('s1')).toEqual([]);
    expect(usage.getUsageCache()).toEqual({});
  });
});
