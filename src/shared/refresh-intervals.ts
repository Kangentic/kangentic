/**
 * How often main re-reads git and PR state on its own. Shared so the Settings
 * copy that names the cadence (`settings-registry.ts`) reads it from the same
 * number the schedulers run on, rather than a figure typed twice.
 */

/** How long after the project's last full fetch the next one runs. */
export const AUTO_FETCH_INTERVAL_MS = 5 * 60_000;

/** How long after its last check a PR falls due again. */
export const PR_REFRESH_INTERVAL_MS = 2 * 60_000;
