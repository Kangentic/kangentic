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
