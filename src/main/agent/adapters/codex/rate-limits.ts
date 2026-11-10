import type { RateLimitWindow } from '../../../../shared/types';

/**
 * Codex's plan usage windows, from the `rate_limits` snapshot on a rollout's `token_count`
 * record (task #1057).
 *
 * The shape is Codex's own (`RateLimitSnapshot` in `codex-rs/protocol/src/protocol.rs`): a
 * `primary` and a `secondary` window, each `{ used_percent: f64, window_minutes, resets_at }`,
 * with `resets_at` in Unix seconds. Builds before `resets_at` wrote `resets_in_seconds`, counted
 * from the record's own time. A window is null when the plan has none, and the whole snapshot is
 * null for a session on an API key, which is every record this machine's rollouts hold, so no
 * real sample was available: the parser follows the protocol and is held to it by its test.
 *
 * Ids are prefixed (`codex-...`) so they never meet Claude's `five-hour` and `seven-day` in the
 * renderer's shared snapshot (`RateLimitWindow.id`). A snapshot for a limit other than Codex's
 * main one (`limit_id`) gets its own ids, so two buckets never overwrite each other.
 */
export function parseCodexRateLimits(raw: unknown, recordTimeMs: number): RateLimitWindow[] | null {
  if (!isRecord(raw)) return null;
  const limitId = typeof raw.limit_id === 'string' && raw.limit_id !== '' && raw.limit_id !== 'codex' ? raw.limit_id : null;
  const prefix = limitId ? `codex-${limitId}` : 'codex';
  const windows: RateLimitWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = parseWindow(raw[slot], recordTimeMs, `${prefix}-${slot}`);
    if (window) windows.push(window);
  }
  return windows.length > 0 ? windows : null;
}

function parseWindow(raw: unknown, recordTimeMs: number, id: string): RateLimitWindow | null {
  if (!isRecord(raw) || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null;
  const minutes = typeof raw.window_minutes === 'number' && raw.window_minutes > 0 ? raw.window_minutes : null;
  return {
    id,
    label: labelFor(minutes),
    iconKind: minutes !== null && minutes > 24 * 60 ? 'period' : 'session',
    usedPercentage: Math.min(100, Math.max(0, raw.used_percent)),
    resetsAt: resetsAtOf(raw, recordTimeMs),
    ...(minutes !== null ? { windowDurationSeconds: minutes * 60 } : {}),
  };
}

/** Epoch seconds, or 0 when the window says nothing about its reset. */
function resetsAtOf(raw: Record<string, unknown>, recordTimeMs: number): number {
  if (typeof raw.resets_at === 'number' && raw.resets_at > 0) {
    // Seconds by the protocol; a millisecond value is read as one rather than as a far future.
    return Math.floor(raw.resets_at > 1e12 ? raw.resets_at / 1000 : raw.resets_at);
  }
  if (typeof raw.resets_in_seconds === 'number' && raw.resets_in_seconds >= 0) {
    return Math.floor(recordTimeMs / 1000 + raw.resets_in_seconds);
  }
  return 0;
}

/** The name the context bar and the Accounts tab show: "5h session", "7d weekly", as Claude's read. */
function labelFor(minutes: number | null): string {
  if (minutes === null) return 'Usage';
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return weeks === 1 ? '7d weekly' : `${weeks * 7}d`;
  }
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h session`;
  return `${minutes}m session`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
