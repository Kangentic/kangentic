/**
 * A tiny main-process value cache with in-flight deduplication.
 *
 * Some main-process probes are expensive (the full `agents.list()` build; the
 * shell enumeration that shells out to `wsl --list`) yet are requested
 * repeatedly and often concurrently - e.g. app bootstrap, the welcome screen,
 * and a Settings/column-manager open all call `agents.list()` within the same
 * tick. Without dedup, each caller triggers its own subprocess storm.
 *
 * This helper caches the resolved value and, crucially, collapses concurrent
 * cold calls onto a single in-flight promise. It is deliberately TTL-free:
 * staleness is handled by explicit `invalidate()` (on config change) or a
 * caller-driven `forceRefresh`, so there are no background timers or jobs to
 * reason about.
 *
 * The builder is passed at `get` time (used only on a miss), so callers whose
 * inputs vary per call - but whose cache is cleared whenever those inputs
 * change - can close over the current inputs without the cache key needing to.
 */
export interface CachedSingleton<T> {
  /**
   * Return the cached value, the in-flight build, or run `builder`. When
   * `forceRefresh` is true, any cached value and in-flight build are discarded
   * first so `builder` runs fresh.
   */
  get(builder: () => Promise<T>, forceRefresh?: boolean): Promise<T>;
  /** Discard the cached value and any in-flight build. */
  invalidate(): void;
}

export function createCachedSingleton<T>(): CachedSingleton<T> {
  let cache: { value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  // Monotonic id stamped on each build. A forceRefresh or invalidate() that
  // supersedes an in-flight build bumps this, so when the abandoned build later
  // resolves it can detect that it is stale and decline to publish - otherwise a
  // slow superseded build could overwrite the fresher value the newer build
  // already cached.
  let buildSequence = 0;

  return {
    get(builder: () => Promise<T>, forceRefresh = false): Promise<T> {
      if (forceRefresh) {
        cache = null;
        inFlight = null;
        buildSequence += 1;
      }
      if (cache) return Promise.resolve(cache.value);
      if (inFlight) return inFlight;
      const thisBuild = buildSequence;
      inFlight = builder().then(
        (value) => {
          // Only publish if this build is still the current one. A superseding
          // forceRefresh/invalidate bumped buildSequence, so a late-resolving
          // abandoned build must not clobber the newer cached value.
          if (thisBuild === buildSequence) {
            cache = { value };
            inFlight = null;
          }
          return value;
        },
        (error) => {
          // Clear the slot so a rejection never strands future callers, but only
          // when this build still owns it (a superseding build owns it otherwise).
          if (thisBuild === buildSequence) {
            inFlight = null;
          }
          throw error;
        },
      );
      return inFlight;
    },
    invalidate(): void {
      cache = null;
      inFlight = null;
      buildSequence += 1;
    },
  };
}
