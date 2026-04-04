import type { SessionUsage, SessionEvent } from '../../../../shared/types';

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
   * Claude Code's `used_percentage` field uses Math.round internally.
   * We match that behavior: compute from raw token counts when available
   * using Math.round, falling back to the pre-rounded `used_percentage`.
   *
   * Two tiers:
   * 1. **Primary** (has `current_usage` + `context_window_size`): compute
   *    total token percentage via Math.round - matches Claude Code's JSON.
   * 2. **Fallback** (`used_percentage` only, no tokens): return it directly.
   */
  static computeContextPercentage(contextWindow: StatusContextWindow | null | undefined): number {
    if (!contextWindow) return 0;

    const usage = contextWindow.current_usage;
    const windowSize = contextWindow.context_window_size ?? 0;

    // Primary: compute from raw tokens using Math.round to match Claude
    // Code's used_percentage field.
    if (usage && windowSize > 0) {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const totalUsed = input + output + cacheCreation + cacheRead;
      return Math.min(100, Math.round((totalUsed / windowSize) * 100));
    }

    // Fallback: use pre-rounded used_percentage when tokens aren't available
    const usedPercentage = contextWindow.used_percentage ?? 0;
    if (usedPercentage > 0) {
      return Math.min(100, usedPercentage);
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

      // Total token computation - always use raw token sums when
      // available for exact counts. Only estimate from used_percentage
      // when current_usage is missing (e.g. very early status updates).
      const rawUsedPercentage = (cw?.used_percentage as number) ?? 0;
      let usedTokens: number;
      let cacheTokens: number;
      const outputTokens = (cu?.output_tokens as number) ?? 0;
      if (cu) {
        // Primary: sum all token buckets including output tokens
        usedTokens = inputTokens + outputTokens + cacheCreation + cacheRead;
        cacheTokens = cacheCreation + cacheRead;
      } else if (rawUsedPercentage > 0 && windowSize > 0) {
        // Fallback: estimate from used_percentage when no current_usage
        usedTokens = Math.round((rawUsedPercentage / 100) * windowSize);
        cacheTokens = usedTokens; // without current_usage, all context is system/cache
      } else {
        usedTokens = 0;
        cacheTokens = 0;
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
