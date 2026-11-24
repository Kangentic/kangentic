/**
 * Runs the dev-only Pattern B re-sync once per burst of Vite updates.
 *
 * A `vite:afterUpdate` handler used to re-fetch every IPC-backed store on each
 * update. A fast-forward of the main checkout sends hundreds of updates in a
 * few seconds, so the dogfood app made 8,935 IPC calls in 12.7 s and main
 * stalled for up to 2.8 s. Nearly every store is instance-pinned (Pattern E in
 * .claude/rules/hmr-patterns.md), so the re-sync reconciles live data and can
 * wait for the burst to end.
 *
 * The scheduler is a trailing debounce with one addition. Each finished update
 * (`vite:afterUpdate`) arms the quiet timer, and each update that starts
 * (`vite:beforeUpdate`) holds a pending ask until that update finishes. The
 * hold is what makes a burst one run: Vite's client applies updates one at a
 * time, with the next starting as the last one ends, and a single update can
 * take longer to apply than any sensible quiet period.
 */

/**
 * How long after the last finished update the re-sync runs, when no other
 * update has started.
 *
 * Measured by replaying a 57-file change (about 100 updates per burst) in a
 * preview: no gap between one update finishing and the next starting passed
 * 50 ms, so this is ten times the idle time a burst showed. The longest
 * single update took 1.4 s to apply, which is why the timer alone ran the
 * re-sync twice per burst and the in-flight hold exists.
 */
export const HMR_RESYNC_QUIET_MS = 500;

/**
 * How long a held ask waits for an update to finish before it runs anyway.
 * Vite fires no `vite:afterUpdate` for an update whose accept callback throws,
 * and a held ask with no ceiling would then wait for the next save.
 */
export const HMR_RESYNC_IN_FLIGHT_CEILING_MS = 10_000;

export interface HmrResyncScheduler {
  /**
   * Ask for a re-sync, from `vite:afterUpdate`. A pending ask is replaced, so a
   * burst runs the newest `run` once, the quiet period after its last update.
   */
  schedule(run: () => void): void;
  /**
   * An update has started, from `vite:beforeUpdate`. A pending ask stops
   * counting quiet time and waits for that update's `schedule`, or for the
   * in-flight ceiling. With nothing pending this does nothing.
   */
  holdWhileUpdating(): void;
}

export interface HmrResyncSchedulerOptions {
  quietMs?: number;
  inFlightCeilingMs?: number;
}

export function createHmrResyncScheduler(options: HmrResyncSchedulerOptions = {}): HmrResyncScheduler {
  const quietMs = options.quietMs ?? HMR_RESYNC_QUIET_MS;
  const inFlightCeilingMs = options.inFlightCeilingMs ?? HMR_RESYNC_IN_FLIGHT_CEILING_MS;
  let pendingRun: (() => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const arm = (delayMs: number): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      // Both cleared first, so a `run` that throws leaves the scheduler usable.
      pendingTimer = null;
      const run = pendingRun;
      pendingRun = null;
      run?.();
    }, delayMs);
  };

  return {
    schedule(run) {
      pendingRun = run;
      arm(quietMs);
    },
    holdWhileUpdating() {
      if (pendingRun === null) return;
      arm(inFlightCeilingMs);
    },
  };
}

/**
 * The main window's scheduler, used by App.tsx's Vite update listeners. It
 * lives in this leaf module so a Fast Refresh of App.tsx keeps the ask an
 * earlier update made. If this module is itself replaced, a timer the old
 * instance armed still fires once, and one extra re-sync is harmless.
 */
// hmr-safe: a re-evaluation builds a new scheduler, and an ask the old one holds runs once more.
export const hmrResyncScheduler = createHmrResyncScheduler();
