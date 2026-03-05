import { describe, it, expect } from 'vitest';
import { ClaudeStatusParser } from '../../src/main/agent/claude-status-parser';
import { EventType } from '../../src/shared/types';

describe('ClaudeStatusParser', () => {
  // -------------------------------------------------------------------------
  // computeContextPercentage
  // -------------------------------------------------------------------------
  describe('computeContextPercentage', () => {
    it('returns used_percentage directly when available', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 5000,
          output_tokens: 3000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 1000,
        },
        context_window_size: 100_000,
        used_percentage: 50,
      });
      // used_percentage returned directly (input-only, no output addition, no scaling)
      expect(pct).toBe(50);
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
      // No used_percentage → fallback: (80000+10000+20000)/100000*100 = 110 → capped at 100
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

    it('returns used_percentage when context_window_size is 0', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 5000,
          output_tokens: 3000,
        },
        used_percentage: 60,
        context_window_size: 0,
      });
      expect(pct).toBe(60);
    });

    it('returns 0 for null context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(null)).toBe(0);
    });

    it('returns 0 for undefined context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(undefined)).toBe(0);
    });

    it('defaults missing token fields to 0 in fallback path', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 10_000,
          // output_tokens, cache_creation, cache_read all missing
        },
        context_window_size: 100_000,
      });
      // Fallback (no used_percentage): input-only = 10000/100000*100 = 10
      expect(pct).toBe(10);
    });

    it('ignores output tokens — uses used_percentage directly', () => {
      // used_percentage is input-only per Claude Code docs
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 60_000,
          output_tokens: 15_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: 75,
        context_window_size: 80_000,
      });
      expect(pct).toBe(75);
    });

    it('used_percentage accounts for cached system prompt not in token buckets', () => {
      // used_percentage=40 includes cached system prompt; token fields only sum to 15%
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 15_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: 40,
        context_window_size: 100_000,
      });
      // Returns used_percentage directly
      expect(pct).toBe(40);
    });

    it('returns used_percentage directly for near-full sessions', () => {
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
      expect(pct).toBe(82);
    });

    it('returns 95 for used_percentage=95 (no scaling to 100)', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        used_percentage: 95,
        context_window_size: 200_000,
      });
      expect(pct).toBe(95);
    });

    it('returns 15 for used_percentage=15 (fresh session)', () => {
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

    it('fallback path uses input tokens only (excludes output)', () => {
      const pct = ClaudeStatusParser.computeContextPercentage({
        current_usage: {
          input_tokens: 170_000,
          output_tokens: 20_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        context_window_size: 200_000,
      });
      // No used_percentage → fallback: input-only = 170000/200000*100 = 85
      expect(pct).toBe(85);
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
      // used_percentage returned directly
      expect(usage!.contextWindow.usedPercentage).toBe(20);
      // usedTokens: inputFromPct(20%*200k=40000) — no output added
      expect(usage!.contextWindow.usedTokens).toBe(40_000);
      // cacheTokens: inputFromPct(40000) - input_tokens(20000) = 20000
      expect(usage!.contextWindow.cacheTokens).toBe(20_000);
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
