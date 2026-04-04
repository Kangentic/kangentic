import { describe, it, expect } from 'vitest';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude';
import { EventType } from '../../src/shared/types';

describe('ClaudeStatusParser', () => {
  // -------------------------------------------------------------------------
  // computeContextPercentage
  // -------------------------------------------------------------------------
  describe('computeContextPercentage', () => {
    it('computes from raw tokens using Math.round when current_usage available', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 5000,
          output_tokens: 3000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 1000,
        },
        context_window_size: 100_000,
        used_percentage: 50, // ignored when current_usage is present
      });
      // (5000+3000+1000+1000)/100000*100 = 10 (exact)
      expect(pct).toBe(10);
    });

    it('caps at 100 when input tokens exceed window size', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 80_000,
          output_tokens: 30_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 20_000,
        },
        context_window_size: 100_000,
      });
      // (80000+30000+10000+20000)/100000*100 = 140 -- capped at 100
      expect(pct).toBe(100);
    });

    it('falls back to used_percentage when current_usage is missing', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        used_percentage: 42,
        context_window_size: 200_000,
      });
      expect(pct).toBe(42);
    });

    it('falls back to used_percentage when current_usage is null', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: null,
        used_percentage: 37,
        context_window_size: 200_000,
      });
      expect(pct).toBe(37);
    });

    it('falls back to used_percentage when context_window_size is 0', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 5000,
          output_tokens: 3000,
        },
        used_percentage: 60,
        context_window_size: 0,
      });
      // windowSize=0 prevents token computation, falls back to used_percentage
      expect(pct).toBe(60);
    });

    it('returns 0 for null context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(null)).toBe(0);
    });

    it('returns 0 for undefined context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(undefined)).toBe(0);
    });

    it('defaults missing token fields to 0', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 10_000,
          // output_tokens, cache_creation, cache_read all missing
        },
        context_window_size: 100_000,
      });
      // input-only = 10000/100000*100 = 10
      expect(pct).toBe(10);
    });

    it('includes output tokens in context percentage', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 60_000,
          output_tokens: 15_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: 75, // ignored when current_usage present
        context_window_size: 80_000,
      });
      // (60000+15000+0+0)/80000*100 = 93.75 -- round to 94
      expect(pct).toBe(94);
    });

    it('uses Math.round to match Claude Code used_percentage', () => {
      // Real-world scenario: 20.9485% should round to 21
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 11_165,
          cache_read_input_tokens: 30_729,
        },
        used_percentage: 21, // Claude JSON uses Math.round -- 21
        context_window_size: 200_000,
      });
      // (3+11165+30729)/200000*100 = 20.9485 -- round to 21
      expect(pct).toBe(21);
    });

    it('computes from tokens for near-full sessions', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 120_000,
          output_tokens: 25_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: 82,
        context_window_size: 200_000,
      });
      // (120000+25000+0+0)/200000*100 = 72.5 -- round to 73
      expect(pct).toBe(73);
    });

    it('returns 95 for used_percentage=95 when no current_usage', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        used_percentage: 95,
        context_window_size: 200_000,
      });
      expect(pct).toBe(95);
    });

    it('returns 15 for used_percentage=15 when no current_usage', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        used_percentage: 15,
        context_window_size: 200_000,
      });
      expect(pct).toBe(15);
    });

    it('caps at 100 when used_percentage exceeds 100', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        used_percentage: 105,
        context_window_size: 200_000,
      });
      expect(pct).toBe(100);
    });

    it('includes output tokens in token computation', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 170_000,
          output_tokens: 20_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        context_window_size: 200_000,
      });
      // (170000+20000)/200000*100 = 95
      expect(pct).toBe(95);
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
      // Computed from tokens: (20000+5000+1000+4000)/200000*100 = 15 (exact)
      expect(usage!.contextWindow.usedPercentage).toBe(15);
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
