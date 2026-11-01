import type { SessionUsage, SessionEvent, RateLimitWindow, SessionStartReport } from '../../../../shared/types';

/**
 * Parses Claude Code status line and event bridge data.
 *
 * Encapsulates all Claude-specific data parsing so it can be swapped
 * for other agent solutions without touching session-manager.ts.
 */

/**
 * Subset of the `context_window` object from Claude Code's status line JSON
 * that `computeContextPercentage` consumes. `parseStatusWithMeta` reads
 * additional fields (current_usage, context_window_size, totals) directly
 * from the raw JSON for token-count display.
 */
export interface StatusContextWindow {
  used_percentage?: number;
}

/** Each `rate_limits` key Claude Code sends and the window it becomes, shortest window first. */
const RATE_LIMIT_WINDOWS: ReadonlyArray<{ key: string } & Pick<RateLimitWindow, 'id' | 'label' | 'iconKind' | 'windowDurationSeconds'>> = [
  { key: 'five_hour', id: 'five-hour', label: '5h session', iconKind: 'session', windowDurationSeconds: 5 * 60 * 60 },
  { key: 'seven_day', id: 'seven-day', label: '7d weekly', iconKind: 'period', windowDurationSeconds: 7 * 24 * 60 * 60 },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A SessionStart payload's two fields, read by pattern when the event bridge's
// 2048-char hookContext cap cut the JSON short. Both sit at the top level of
// the payload, and a quote inside a string value is escaped, so neither
// pattern can match text from inside a path.
const HOOK_SESSION_ID_RE = /"session_id"\s*:\s*"([^"\\]+)"/;
const HOOK_SOURCE_RE = /"source"\s*:\s*"([^"\\]+)"/;

/**
 * The one SessionStart `source` that reports a session launched fresh. Claude
 * Code's other sources (`resume`, `clear`, `compact`, and `fork` when 2.1.316
 * moves a live conversation into its background daemon) each name the
 * conversation the terminal moved to.
 */
const LAUNCH_SOURCE = 'startup';

/**
 * The SessionStart `source` of a session Claude Code runs in the background:
 * `/bg` (and `/fork`) continue the conversation as a forked session its
 * supervisor owns. Kangentic itself never starts a fork: it launches with
 * `--session-id` (`startup`) or `--resume` (`resume`).
 */
const BACKGROUND_SOURCE = 'fork';

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class ClaudeStatusParser {
  /**
   * Context window usage as a percentage, taken directly from Claude Code's
   * `used_percentage` field in `status.json`. This is the same number Claude
   * shows in its own status line and accounts for internal overhead (system
   * prompt, tool definitions) that raw token sums miss. Claude Code
   * auto-updates, so we don't maintain a fallback for older versions.
   */
  static computeContextPercentage(contextWindow: StatusContextWindow | null | undefined): number {
    if (!contextWindow || contextWindow.used_percentage == null) return 0;
    return Math.min(100, Math.max(0, contextWindow.used_percentage));
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
      const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
      // Claude's status line carries the absolute path to its own session JSONL
      // transcript. It is the only truly-cumulative token source (the
      // context_window counts above became a current-context snapshot in
      // 2.1.132+), so capture it for the lifetime-stats rollup.
      const transcriptPath = typeof data.transcript_path === 'string' ? data.transcript_path : undefined;

      // Claude Code 2.1.119+ reports the active effort level (low/medium/high/
      // xhigh/max) as a top-level `effort: { level }` object alongside model.
      //
      // The key is absent in two distinct situations, and we deliberately do not
      // try to tell them apart here:
      //   1. Older Claude Code versions that predate the field.
      //   2. Current versions running a model with NO effort levels. Claude Code
      //      builds the field as `supportsEffort(model) ? { level } : undefined`
      //      and JSON.stringify drops it. Support is per MODEL, not per family
      //      or generation: `claude-haiku-4-5` and `claude-sonnet-4-5` have no
      //      effort while `claude-opus-4-8` does. This is the case that made the
      //      ContextBar show a stale configured effort as if it were live.
      // Either way the honest answer is "the agent reports no effort", which is
      // what `undefined` means downstream. `reportedByAgent` below carries the
      // separate fact that a snapshot arrived at all.
      const effortObject = data.effort as Record<string, unknown> | undefined;
      const effortLevel = typeof effortObject?.level === 'string' ? effortObject.level : undefined;

      // Claude Code emits session (5h) and weekly (7d) plan-usage countdowns
      // alongside context_window. resets_at is Unix epoch seconds. Each window
      // is sent only when it applies, so either may be absent on its own: Ultra
      // has no 5h window, and Claude drops a window once its resets_at passes.
      // Emit each window that is present (`RATE_LIMIT_WINDOWS`).
      const rateLimitsRaw = data.rate_limits as Record<string, unknown> | undefined;
      const reportedWindows: RateLimitWindow[] = [];
      for (const { key, ...windowShape } of RATE_LIMIT_WINDOWS) {
        const windowRaw = rateLimitsRaw?.[key];
        if (!isPlainObject(windowRaw)) continue;
        reportedWindows.push({
          ...windowShape,
          usedPercentage: Math.min(100, Math.max(0, finiteOrZero(windowRaw.used_percentage))),
          resetsAt: finiteOrZero(windowRaw.resets_at),
        });
      }
      const rateLimits: RateLimitWindow[] | undefined = reportedWindows.length > 0 ? reportedWindows : undefined;

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
            effort: effortLevel,
            // We only reach here by successfully parsing a real status payload,
            // so this block is agent-reported by construction. The single place
            // in the app that sets this.
            reportedByAgent: true,
          },
          sessionId,
          transcriptPath,
          rateLimits,
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

  /**
   * Read a SessionStart hook payload (`statusFile.parseSessionStart`): the
   * `session_id` it names, and whether its `source` moved the terminal's
   * conversation there. Every source but `startup` does. A missing source
   * reads as a launch, so a payload cut before the field confirms nothing.
   *
   * The background daemon in Claude Code 2.1.316 runs a spare session with the
   * task's own `--settings`. Its hook says `startup`, and the conversation it
   * moved says `fork` (measured on a live task, 2026-10-31).
   */
  static parseSessionStart(hookContext: string): SessionStartReport | null {
    let sessionId: unknown;
    let source: unknown;
    try {
      const payload: unknown = JSON.parse(hookContext);
      if (!isPlainObject(payload)) return null;
      sessionId = payload.session_id;
      source = payload.source;
    } catch {
      sessionId = HOOK_SESSION_ID_RE.exec(hookContext)?.[1];
      source = HOOK_SOURCE_RE.exec(hookContext)?.[1];
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const movesConversation = typeof source === 'string' && source.length > 0 && source !== LAUNCH_SOURCE;
    return { agentSessionId: sessionId, movesConversation, inBackgroundSession: source === BACKGROUND_SOURCE };
  }
}
