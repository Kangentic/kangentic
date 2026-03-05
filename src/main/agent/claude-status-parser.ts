import type { SessionUsage, SessionEvent } from '../../shared/types';

/**
 * Parses Claude Code status line and event bridge data.
 *
 * Encapsulates all Claude-specific data parsing so it can be swapped
 * for other agent solutions without touching session-manager.ts.
 */

/** Shape of the `context_window` object from Claude Code's status line JSON. */
export interface StatusContextWindow {
  current_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  used_percentage?: number;
  context_window_size?: number;
}

export class ClaudeStatusParser {
  /**
   * Compute context window usage as a percentage.
   *
   * Claude Code's `used_percentage` is based on input tokens only
   * (input_tokens + cache_creation_input_tokens + cache_read_input_tokens).
   * It does NOT include output_tokens. We return it directly — no scaling.
   *
   * Two tiers:
   * 1. **Primary** (`used_percentage` > 0): return it directly.
   * 2. **Fallback** (no `used_percentage`, has `current_usage`): compute
   *    input-only `(input + cache_creation + cache_read) / window * 100`.
   */
  static computeContextPercentage(contextWindow: StatusContextWindow | null | undefined): number {
    if (!contextWindow) return 0;

    const usedPercentage = contextWindow.used_percentage ?? 0;

    if (usedPercentage > 0) {
      return Math.min(100, usedPercentage);
    }

    const usage = contextWindow.current_usage;
    const windowSize = contextWindow.context_window_size ?? 0;

    if (usage && windowSize > 0) {
      const input = usage.input_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const totalInput = input + cacheCreation + cacheRead;
      return Math.min(100, (totalInput / windowSize) * 100);
    }

    return 0;
  }

  /**
   * Parse raw status JSON from Claude Code's status line bridge into SessionUsage.
   * Returns null on parse errors or missing data.
   */
  static parseStatus(raw: string): SessionUsage | null {
    const result = ClaudeStatusParser.parseStatusWithMeta(raw);
    return result ? result.usage : null;
  }

  /**
   * Parse raw status JSON and return both the SessionUsage and raw metadata
   * (model ID, raw used_percentage) needed for logging/debugging.
   * Avoids the caller having to re-parse the same JSON.
   */
  static parseStatusWithMeta(raw: string): { usage: SessionUsage; meta: { modelId: string; rawUsedPercentage: number } } | null {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const cw = data.context_window as Record<string, unknown> | undefined;
      const cost = data.cost as Record<string, unknown> | undefined;
      const model = data.model as Record<string, unknown> | undefined;

      // Extract current_usage for cache/used token computation
      const cu = cw?.current_usage as Record<string, unknown> | undefined | null;
      const cacheCreation = (cu?.cache_creation_input_tokens as number) ?? 0;
      const cacheRead = (cu?.cache_read_input_tokens as number) ?? 0;
      const inputTokens = (cu?.input_tokens as number) ?? 0;
      const windowSize = (cw?.context_window_size as number) ?? 0;

      // Input-only token computation, matching computeContextPercentage:
      const rawUsedPercentage = (cw?.used_percentage as number) ?? 0;
      let usedTokens: number;
      let cacheTokens: number;
      if (cu && windowSize > 0 && rawUsedPercentage > 0) {
        // Primary: used_percentage covers all input tokens (excludes output)
        const inputFromPct = Math.round((rawUsedPercentage / 100) * windowSize);
        usedTokens = inputFromPct;
        cacheTokens = Math.max(0, inputFromPct - inputTokens);
      } else if (cu) {
        // Fallback: sum input token buckets only (no output)
        usedTokens = inputTokens + cacheCreation + cacheRead;
        cacheTokens = cacheCreation + cacheRead;
      } else {
        // Last resort: estimate from used_percentage alone
        usedTokens = Math.round((rawUsedPercentage / 100) * windowSize);
        cacheTokens = usedTokens; // without current_usage, all context is system/cache
      }

      const modelId = (model?.id as string) ?? '';

      return {
        usage: {
          contextWindow: {
            usedPercentage: ClaudeStatusParser.computeContextPercentage(
              cw as StatusContextWindow | undefined,
            ),
            usedTokens,
            cacheTokens,
            totalInputTokens: (cw?.total_input_tokens as number) ?? 0,
            totalOutputTokens: (cw?.total_output_tokens as number) ?? 0,
            contextWindowSize: windowSize,
          },
          cost: {
            totalCostUsd: (cost?.total_cost_usd as number) ?? 0,
            totalDurationMs: (cost?.total_duration_ms as number) ?? 0,
          },
          model: {
            id: modelId,
            displayName: (model?.display_name as string) ?? '',
          },
        },
        meta: { modelId, rawUsedPercentage },
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse a single JSONL line from Claude Code's event bridge into SessionEvent.
   * Returns null on malformed lines.
   */
  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }
}
