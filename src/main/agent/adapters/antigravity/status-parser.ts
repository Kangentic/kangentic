import { EventType, IdleReason } from '../../../../shared/types';
import type { RateLimitWindow, SessionUsage, SessionEvent } from '../../../../shared/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return isPlainObject(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Prefix of every rate-limit window id this adapter reports. Main's
 * `RateLimitLedger` keeps one generation per window id across every agent, so
 * an agy bucket must never share an id with another agent's window.
 */
const QUOTA_WINDOW_PREFIX = 'antigravity-quota-';

/**
 * agy's `quota` map as rate-limit windows. Per the statusline doc each bucket
 * id maps to `remaining_fraction` or `remaining_amount`, `reset_time`,
 * `reset_in_seconds` and an optional `disabled`. Only a bucket with a
 * fraction becomes a window (an amount has no share to draw), and a disabled
 * one is skipped. The doc gives no bucket's length, so no window carries a
 * duration and the pill draws no time marker. A missing or unreadable
 * `reset_time` is an unknown reset (0).
 */
function quotaWindows(quota: unknown): RateLimitWindow[] | undefined {
  if (!isPlainObject(quota)) return undefined;
  const windows: RateLimitWindow[] = [];
  for (const [bucketId, bucket] of Object.entries(quota)) {
    if (!isPlainObject(bucket) || bucket.disabled === true) continue;
    const remaining = bucket.remaining_fraction;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
    const resetMs = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN;
    windows.push({
      id: `${QUOTA_WINDOW_PREFIX}${bucketId}`,
      label: bucketId,
      iconKind: 'period',
      usedPercentage: Math.min(100, Math.max(0, (1 - remaining) * 100)),
      resetsAt: Number.isFinite(resetMs) ? Math.floor(resetMs / 1000) : 0,
    });
  }
  return windows.length > 0 ? windows : undefined;
}

/**
 * Parses Antigravity CLI status and event data.
 *
 * Status: agy's custom status line pipes a JSON state payload to its command
 * on stdin whenever the agent state changes (documented at
 * https://antigravity.google/docs/cli/statusline). The command builder points
 * a per-session status line at `status-bridge.js` through `--settings`
 * (listed by `agy --help` on 1.4.12), which writes the payload to the
 * session's status file, and `parseStatus` maps it here. Built from the
 * documented payload; not yet run against a real agy (see the concept doc).
 *
 * An agy without `--settings` never writes the file, and the adapter's
 * `liveTelemetryUnsupported` label stands in.
 *
 * Event parsing reuses the agent-agnostic event-bridge JSONL format, which is
 * how the hook pipeline reaches the activity engine.
 */
export class AntigravityStatusParser {
  /**
   * Map one status-line payload to SessionUsage. Null on a parse error, and
   * before the payload names a model: agy sends `model: null` until one is
   * selected, and a usage with no model would blank the board card's pill.
   *
   * Field sources (statusline doc): `model.id`, `model.display_name`,
   * `model.effort` (only for a model with several levels);
   * `context_window.used_percentage`, `context_window_size` (0 when unknown),
   * `total_input_tokens`, `total_output_tokens`, and `current_usage` (null
   * before the first response); `cost.total_usd` (a list-price estimate,
   * omitted until a cost is reported); `quota` (see `quotaWindows`). Main
   * stamps each window with the reporting session's agent, and the pill shows
   * an agent only its own windows.
   *
   * `conversation_id` is not reported as `sessionId`. Main adopts every change
   * of a reported id (and the next resume follows it), with no SessionStart
   * guard for agy, and the doc defines the field as the ACTIVE conversation:
   * whether that follows a subagent view or a `/btw` side question is not
   * documented. The hook and shutdown captures already find the id.
   */
  static parseStatus(raw: string): SessionUsage | null {
    const data = parseObject(raw);
    if (!data) return null;

    const model = isPlainObject(data.model) ? data.model : null;
    const modelId = nonEmptyString(model?.id);
    const displayName = nonEmptyString(model?.display_name) ?? modelId;
    if (!modelId || !displayName) return null;

    const contextWindow = isPlainObject(data.context_window) ? data.context_window : null;
    const currentUsage = isPlainObject(contextWindow?.current_usage) ? contextWindow.current_usage : null;
    const windowSize = finiteOrZero(contextWindow?.context_window_size);
    const usedPercentage = Math.min(100, Math.max(0, finiteOrZero(contextWindow?.used_percentage)));

    let usedTokens = 0;
    let cacheTokens = 0;
    if (currentUsage) {
      const cacheCreation = finiteOrZero(currentUsage.cache_creation_input_tokens);
      const cacheRead = finiteOrZero(currentUsage.cache_read_input_tokens);
      cacheTokens = cacheCreation + cacheRead;
      usedTokens = finiteOrZero(currentUsage.input_tokens)
        + finiteOrZero(currentUsage.output_tokens)
        + cacheTokens;
    } else if (usedPercentage > 0 && windowSize > 0) {
      usedTokens = Math.round((usedPercentage / 100) * windowSize);
    }

    const cost = isPlainObject(data.cost) ? data.cost : null;
    const effort = nonEmptyString(model?.effort);
    const rateLimits = quotaWindows(data.quota);

    return {
      contextWindow: {
        usedPercentage,
        usedTokens,
        cacheTokens,
        totalInputTokens: finiteOrZero(contextWindow?.total_input_tokens),
        totalOutputTokens: finiteOrZero(contextWindow?.total_output_tokens),
        contextWindowSize: windowSize,
      },
      cost: {
        totalCostUsd: finiteOrZero(cost?.total_usd),
        totalDurationMs: 0,
      },
      model: {
        id: modelId,
        displayName,
        ...(effort ? { effort } : {}),
        reportedByAgent: true,
      },
      ...(rateLimits ? { rateLimits } : {}),
    };
  }

  /**
   * The activity a status write reports that agy's hooks cannot: a change of
   * plan mode (`cycle_mode`, below), and `tool_confirmation_pending`, "True
   * while a tool confirmation dialog
   * shows (omitted otherwise)" (statusline doc). A PreToolUse hook cannot tell
   * a tool that asks from one that runs, since agy's own policy decides after
   * it. The write on which the field turns true raises an approval wait. The
   * engine ends it on the tool's own end, the next prompt, or the turn's end,
   * so nothing is raised when the dialog closes. Only the edge is reported,
   * because agy rewrites the file on every state change while the dialog
   * stays up. The payload names no tool, so the wait awaits the newest call in
   * flight. Built from the documentation; not yet run against a real agy.
   *
   * Null for a write that is not a JSON object (a read that caught the bridge
   * mid-write), so the reader keeps comparing against the last whole one.
   */
  static parseStatusEvents(raw: string, previousRaw: string | null, now: number): SessionEvent[] | null {
    const current = parseObject(raw);
    if (!current) return null;
    const previous = parseObject(previousRaw);
    const events: SessionEvent[] = [];

    // Plan mode: `cycle_mode` is `accept-edits`, `auto` or `plan`, "omitted in
    // default mode" (statusline doc). A change of plan-ness is reported on a
    // log-only `config_change` carrying `planMode`, which the engine's plan
    // mode trail records (`SessionEvent.planMode`); a missing previous write
    // reads as out of plan mode, so a session launched in plan mode reports it.
    const inPlanMode = current.cycle_mode === 'plan';
    const wasInPlanMode = previous?.cycle_mode === 'plan';
    if (inPlanMode !== wasInPlanMode) {
      const mode = typeof current.cycle_mode === 'string' ? current.cycle_mode : 'default';
      events.push({ ts: now, type: EventType.ConfigChange, detail: mode, planMode: inPlanMode });
    }

    if (current.tool_confirmation_pending === true && previous?.tool_confirmation_pending !== true) {
      events.push({ ts: now, type: EventType.Idle, detail: IdleReason.Permission, waitKind: 'approval' });
    }
    return events;
  }

  /** Parse a single event-bridge JSONL line into a SessionEvent. */
  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }
}
