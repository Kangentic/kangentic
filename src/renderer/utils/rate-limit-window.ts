import type { RateLimitWindow } from '../../shared/types';

/**
 * The shared account-wide rate-limit snapshot held by the session store. Rate
 * limits are account-wide, but each session only sees its own status.json
 * updates, so the renderer keeps ONE snapshot that every ContextBar reads.
 * `capturedAt` (epoch ms) and `sourceSessionId` are provenance for the pill's
 * "Updated ... via ..." tooltip.
 */
export interface RateLimitSnapshot {
  rateLimits: RateLimitWindow[];
  capturedAt: number;
  sourceSessionId: string;
}

/**
 * Two reports whose `resetsAt` differ by no more than this many seconds
 * describe the SAME fixed window (this absorbs per-report jitter). A genuine
 * window rollover advances `resetsAt` by a whole window length (hours or days),
 * far past this tolerance. The comparison is always between two reported
 * `resetsAt` values, never the local clock, so it carries no wall-clock or
 * timezone dependence.
 */
export const RATE_LIMIT_RESET_EPSILON_SECONDS = 60;

/**
 * Monotonically merge an incoming rate-limit snapshot into the shared one,
 * per window id. Rate-limit windows are FIXED windows anchored by a `resetsAt`
 * epoch, so within one window `usedPercentage` only rises. Each Claude CLI
 * process refreshes its rate-limit info only from its own API traffic, so a
 * concurrently running sibling session can report a much older cached value for
 * the same window. Under a naive last-writer-wins snapshot those two sessions
 * make every ContextBar flip-flop between the fresh and stale numbers every few
 * seconds. Merging per window instead keeps the account-wide truth: within one
 * window we keep the maximum, we take a genuine rollover wholesale, and we
 * ignore a report for an older window.
 *
 * Per window id, comparing the incoming window to the one we already hold:
 * - id not present in current   -> add the incoming window.
 * - resetsAt advanced past the epsilon (rollover) -> take incoming wholesale,
 *   even when its `usedPercentage` is lower (the window reset).
 * - resetsAt within the epsilon (same window) -> keep the higher
 *   `usedPercentage` but hold the current window's `resetsAt` as the anchor, so
 *   the anchor cannot drift within a window; a lower or equal report is stale
 *   and is dropped.
 * - resetsAt older than the epsilon (stale window) -> ignore the incoming window.
 * - id present in current but absent from incoming -> keep the current window.
 *
 * Returns the EXACT `current` reference when nothing changed, so Zustand
 * subscribers do not re-render and `useValuePulse` does not fire on a no-op
 * report. Never mutates either input. A `null` current returns `incoming`
 * unchanged (the first snapshot, including the empty-array case).
 */
export function mergeRateLimitSnapshot(
  current: RateLimitSnapshot | null,
  incoming: RateLimitSnapshot,
): RateLimitSnapshot {
  if (current === null) {
    return incoming;
  }

  const incomingById = new Map<string, RateLimitWindow>(
    incoming.rateLimits.map((rateLimitWindow): [string, RateLimitWindow] => [rateLimitWindow.id, rateLimitWindow]),
  );
  let changed = false;

  const mergedWindows = current.rateLimits.map((currentWindow) => {
    const incomingWindow = incomingById.get(currentWindow.id);
    if (incomingWindow === undefined) {
      // Window absent from the incoming report: keep the one we already hold.
      return currentWindow;
    }
    incomingById.delete(currentWindow.id);

    const resetDelta = incomingWindow.resetsAt - currentWindow.resetsAt;
    if (resetDelta > RATE_LIMIT_RESET_EPSILON_SECONDS) {
      // The window rolled over (resetsAt jumped forward by ~a window length).
      // Take the incoming window wholesale, even when its usedPercentage is lower.
      changed = true;
      return incomingWindow;
    }
    if (resetDelta < -RATE_LIMIT_RESET_EPSILON_SECONDS) {
      // The incoming report describes an OLDER window than the one we hold:
      // stale cached data. Keep the current window.
      return currentWindow;
    }
    // Same fixed window (resetsAt within epsilon). usedPercentage only rises
    // within a window, so a strictly higher report is fresher and wins; a lower
    // or equal one is stale and must not clobber the value already shown. Keep
    // the current window's `resetsAt` as the anchor (bump only usedPercentage)
    // rather than adopting the incoming one: taking the incoming resetsAt would
    // let the anchor walk by up to the epsilon on every accepted update, and
    // that drift compounds until a genuine rollover lands within the epsilon of
    // the drifted anchor and is misclassified as same-window (then rejected as
    // stale). Pinning the anchor to the first report of the window keeps it
    // moving only on a real detected rollover (`resetDelta > EPSILON` above).
    if (incomingWindow.usedPercentage > currentWindow.usedPercentage) {
      changed = true;
      return { ...currentWindow, usedPercentage: incomingWindow.usedPercentage };
    }
    return currentWindow;
  });

  // Any incoming window whose id the current snapshot has never carried is new.
  for (const remainingWindow of incomingById.values()) {
    mergedWindows.push(remainingWindow);
    changed = true;
  }

  if (!changed) {
    return current;
  }
  return {
    rateLimits: mergedWindows,
    capturedAt: incoming.capturedAt,
    sourceSessionId: incoming.sourceSessionId,
  };
}

/**
 * Elapsed fraction of a rate-limit window, expressed as a 0-100 percentage and
 * clamped to that range.
 *
 * Claude reports only the window's reset time (`resetsAt`) and its used budget,
 * not when the window opened. Because the window length is fixed, the start is
 * `resetsAt - windowDurationSeconds`, and elapsed time follows. This drives the
 * vertical time marker in the usage bar: it sits further right as the reset time
 * draws nearer.
 *
 * Returns `null` when the window has no usable timing anchor (a missing
 * `resetsAt` parses to 0, or a non-positive duration), so callers can skip the
 * marker. `windowDurationSeconds` is optional on RateLimitWindow; the single
 * caller simply does not call this when the adapter omitted it.
 */
export function windowElapsedPercentage(
  resetsAtEpochSeconds: number,
  windowDurationSeconds: number,
  nowMs: number,
): number | null {
  if (
    !Number.isFinite(resetsAtEpochSeconds) ||
    resetsAtEpochSeconds <= 0 ||
    !Number.isFinite(windowDurationSeconds) ||
    windowDurationSeconds <= 0
  ) {
    return null;
  }
  const windowMs = windowDurationSeconds * 1000;
  const remainingMs = resetsAtEpochSeconds * 1000 - nowMs;
  const percentage = (1 - remainingMs / windowMs) * 100;
  return Math.min(100, Math.max(0, percentage));
}
