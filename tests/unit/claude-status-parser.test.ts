import { describe, it, expect } from 'vitest';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude';
import { EventType } from '../../src/shared/types';

describe('ClaudeStatusParser', () => {
  // -------------------------------------------------------------------------
  // computeContextPercentage
  // -------------------------------------------------------------------------
  describe('computeContextPercentage', () => {
    it('returns Claude used_percentage 1:1', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 42 })).toBe(42);
    });

    it('honors explicit used_percentage of 0', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 0 })).toBe(0);
    });

    it('caps used_percentage at 100', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 105 })).toBe(100);
    });

    it('clamps negative used_percentage to 0', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: -5 })).toBe(0);
    });

    it('returns 0 when used_percentage is missing', () => {
      expect(ClaudeStatusParser.computeContextPercentage({})).toBe(0);
    });

    it('returns 0 for null context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(null)).toBe(0);
    });

    it('returns 0 for undefined context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(undefined)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // parseStatus
  // -------------------------------------------------------------------------
  describe('parseStatus', () => {
    it('parses valid Claude Code JSON into SessionUsage', () => {
      const raw = JSON.stringify({
        context_window: {
          current_usage: {
            input_tokens: 20_000,
            output_tokens: 5_000,
            cache_creation_input_tokens: 1_000,
            cache_read_input_tokens: 4_000,
          },
          used_percentage: 20,
          total_input_tokens: 20_000,
          total_output_tokens: 5_000,
          context_window_size: 200_000,
        },
        cost: {
          total_cost_usd: 0.15,
          total_duration_ms: 12345,
        },
        model: {
          id: 'claude-sonnet-4-20250514',
          display_name: 'Claude Sonnet 4',
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      // Trusts Claude's used_percentage 1:1 (raw token sum would compute 15)
      expect(usage!.contextWindow.usedPercentage).toBe(20);
      // usedTokens: sum of all token buckets including output
      expect(usage!.contextWindow.usedTokens).toBe(30_000);
      // cacheTokens: cache_creation + cache_read
      expect(usage!.contextWindow.cacheTokens).toBe(5_000);
      expect(usage!.contextWindow.totalInputTokens).toBe(20_000);
      expect(usage!.contextWindow.totalOutputTokens).toBe(5_000);
      expect(usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(usage!.cost.totalCostUsd).toBe(0.15);
      expect(usage!.cost.totalDurationMs).toBe(12345);
      expect(usage!.model.id).toBe('claude-sonnet-4-20250514');
      expect(usage!.model.displayName).toBe('Claude Sonnet 4');
    });

    it('returns null for invalid JSON', () => {
      expect(ClaudeStatusParser.parseStatus('not json')).toBeNull();
    });

    it('estimates usedTokens from used_percentage when current_usage is absent', () => {
      const raw = JSON.stringify({
        context_window: {
          used_percentage: 14,
          total_input_tokens: 3,
          total_output_tokens: 0,
          context_window_size: 200_000,
        },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      // 14% of 200k = 28000
      expect(usage!.contextWindow.usedTokens).toBe(28_000);
      // Without current_usage, all context is assumed to be cache
      expect(usage!.contextWindow.cacheTokens).toBe(28_000);
      // used_percentage returned directly
      expect(usage!.contextWindow.usedPercentage).toBe(14);
    });

    it('returns SessionUsage with zero defaults when context_window is missing', () => {
      const raw = JSON.stringify({ cost: { total_cost_usd: 0.01 } });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.contextWindow.usedPercentage).toBe(0);
      expect(usage!.contextWindow.usedTokens).toBe(0);
      expect(usage!.contextWindow.cacheTokens).toBe(0);
      expect(usage!.contextWindow.totalInputTokens).toBe(0);
      expect(usage!.contextWindow.contextWindowSize).toBe(0);
      expect(usage!.model.id).toBe('');
    });

    it('real-world: 14% raw shows 14% on bar (not inflated)', () => {
      const raw = JSON.stringify({
        context_window: {
          used_percentage: 14,
          context_window_size: 200_000,
        },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.contextWindow.usedPercentage).toBe(14);
    });
  });

  // -------------------------------------------------------------------------
  // parseEvent
  // -------------------------------------------------------------------------
  describe('parseEvent', () => {
    it('parses a valid event JSON line', () => {
      const line = JSON.stringify({
        ts: 1700000000,
        type: EventType.ToolStart,
        tool: 'Read',
        detail: '/src/main.ts',
      });
      const event = ClaudeStatusParser.parseEvent(line);
      expect(event).not.toBeNull();
      expect(event!.ts).toBe(1700000000);
      expect(event!.type).toBe(EventType.ToolStart);
      expect(event!.tool).toBe('Read');
      expect(event!.detail).toBe('/src/main.ts');
    });

    it('returns null for malformed line', () => {
      expect(ClaudeStatusParser.parseEvent('not valid json {')).toBeNull();
    });
  });
});
