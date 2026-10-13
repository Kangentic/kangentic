/**
 * The usage dashboard's Background card and history table display rules
 * (src/renderer/components/stats/background-display.ts). The one that matters
 * most: a figure the agent did not report is null, so the card draws a dash,
 * never $0.00 and never an estimate.
 */
import { describe, it, expect } from 'vitest';
import {
  backgroundCallsTitle,
  backgroundMetricText,
  backgroundModelLabel,
  backgroundModelLine,
  formatAverageCallTime,
  formatCallCount,
} from '../../src/renderer/components/stats/background-display';
import type { BackgroundCallTotals } from '../../src/shared/types';

function totals(overrides: Partial<BackgroundCallTotals> = {}): BackgroundCallTotals {
  return {
    calls: 4,
    failedCalls: 0,
    reportedCalls: 4,
    inputTokens: 8000,
    cacheCreationInputTokens: 400,
    cacheReadInputTokens: 4000,
    outputTokens: 180,
    costUsd: 0.0125,
    durationMs: 7600,
    ...overrides,
  };
}

describe('backgroundMetricText', () => {
  it('shows cost, or fresh input plus output, by the selected metric', () => {
    expect(backgroundMetricText(totals(), 'cost')).toBe('$0.01');
    expect(backgroundMetricText(totals(), 'tokens')).toBe('8.2k');
  });

  it('is null, not zero, when no call reported the figure', () => {
    const unreported = totals({ reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null });
    expect(backgroundMetricText(unreported, 'cost')).toBeNull();
    expect(backgroundMetricText(unreported, 'tokens')).toBeNull();
  });
});

describe('model labels', () => {
  it('names the model, merging a context-window twin, or the agent default when there is none', () => {
    expect(backgroundModelLabel({ agent: 'claude', modelId: 'claude-haiku-5-5', calls: 1 })).toBe('Haiku 5.5');
    expect(backgroundModelLabel({ agent: 'codex', modelId: null, calls: 1 })).toBe('Codex default');
  });

  it('lists every model once, most calls first', () => {
    expect(backgroundModelLine([
      { agent: 'claude', modelId: 'claude-sonnet-5-5', calls: 9 },
      { agent: 'claude', modelId: 'claude-haiku-5-5', calls: 6 },
      { agent: 'claude', modelId: 'claude-sonnet-5-5[1m]', calls: 1 },
    ])).toBe('Sonnet 5.5, Haiku 5.5');
  });
});

describe('counts and times', () => {
  it('says "call" for one and separates thousands', () => {
    expect(formatCallCount(1)).toBe('1 call');
    expect(formatCallCount(1234)).toBe(`${(1234).toLocaleString()} calls`);
  });

  it('keeps tenths of a second under a minute, where checks live', () => {
    expect(formatAverageCallTime(7600, 4)).toBe('1.9s');
    expect(formatAverageCallTime(150_000, 1)).toBe('2m 30s');
    expect(formatAverageCallTime(0, 0)).toBe('-');
  });
});

describe('backgroundCallsTitle', () => {
  it('names the agent that reported nothing instead of suffixing the value', () => {
    const title = backgroundCallsTitle(
      totals({ reportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: null }),
      [{ agent: 'codex', modelId: null, calls: 4 }],
    );
    expect(title).toContain('Codex reported no usage for these calls');
    expect(title).not.toContain('fresh input');
  });

  it('carries the four token types, failures, partial reporting and the average time', () => {
    const title = backgroundCallsTitle(totals({ failedCalls: 1, reportedCalls: 3 }), []);
    expect(title).toContain('1 failed or timed out (still paid for)');
    expect(title).toContain('Usage reported for 3 of them.');
    expect(title).toContain('8k fresh input, 180 output, 400 cache write, 4k cache read.');
    expect(title).toContain('Average 1.9s per call.');
  });
});
