import { describe, it, expect, beforeEach } from 'vitest';
import { UsageTracker } from '../../src/main/pty/activity/usage-tracker';
import type { SessionUsage } from '../../src/shared/types';

/**
 * UsageTracker.setSessionUsage() merge behavior tests.
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
describe('UsageTracker.setSessionUsage - merge behavior', () => {
  let tracker: UsageTracker;
  let lastUsage: SessionUsage | null;

  beforeEach(() => {
    lastUsage = null;
    tracker = new UsageTracker({
      onUsageChange: (_sessionId, usage) => { lastUsage = usage; },
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      isSessionRunning: () => true,
    });
    tracker.initSession('test-session');
  });

  it('partial contextWindow merge does not overwrite base values with zeros', () => {
    // Chunk 1: task_started sets contextWindowSize
    tracker.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);

    expect(lastUsage!.contextWindow.contextWindowSize).toBe(200000);

    // Chunk 2: turn_context sets model only (no contextWindow at all)
    tracker.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    // contextWindowSize must survive the merge
    expect(lastUsage!.contextWindow.contextWindowSize).toBe(200000);
    expect(lastUsage!.model.id).toBe('gpt-5.3-codex');
  });

  it('usedPercentage is recalculated after cross-chunk merge', () => {
    // Chunk 1: task_started sets contextWindowSize only
    tracker.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);

    expect(lastUsage!.contextWindow.usedPercentage).toBe(0);

    // Chunk 2: token_count sets usedTokens (no contextWindowSize)
    tracker.setSessionUsage('test-session', {
      contextWindow: { usedTokens: 180000 },
    } as Partial<SessionUsage>);

    // Percentage must be recalculated from merged values
    expect(lastUsage!.contextWindow.contextWindowSize).toBe(200000);
    expect(lastUsage!.contextWindow.usedTokens).toBe(180000);
    expect(lastUsage!.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 200000) * 100,
      2,
    );
  });

  it('model merge preserves base model when partial has no model', () => {
    // Chunk 1: turn_context sets model
    tracker.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    expect(lastUsage!.model.id).toBe('gpt-5.3-codex');

    // Chunk 2: token_count updates contextWindow only
    tracker.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 50000,
        totalInputTokens: 50000,
        contextWindowSize: 200000,
      },
    } as Partial<SessionUsage>);

    // Model must survive the merge
    expect(lastUsage!.model.id).toBe('gpt-5.3-codex');
    expect(lastUsage!.model.displayName).toBe('gpt-5.3-codex');
    expect(lastUsage!.contextWindow.usedTokens).toBe(50000);
  });

  it('three-chunk Codex sequence produces correct final state', () => {
    // Simulates a real Codex session where task_started, turn_context,
    // and token_count arrive as separate append-mode chunks.

    // Chunk 1: task_started
    tracker.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 258400 },
    } as Partial<SessionUsage>);

    // Chunk 2: turn_context
    tracker.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    // Chunk 3: token_count (without model_context_window in info)
    tracker.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 180000,
        totalInputTokens: 180000,
        totalOutputTokens: 50,
        cacheTokens: 5000,
      },
    } as Partial<SessionUsage>);

    // Final state: all fields present, percentage correct
    expect(lastUsage!.model.id).toBe('gpt-5.3-codex');
    expect(lastUsage!.contextWindow.contextWindowSize).toBe(258400);
    expect(lastUsage!.contextWindow.usedTokens).toBe(180000);
    expect(lastUsage!.contextWindow.totalOutputTokens).toBe(50);
    expect(lastUsage!.contextWindow.cacheTokens).toBe(5000);
    expect(lastUsage!.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 258400) * 100,
      2,
    );
  });
});
