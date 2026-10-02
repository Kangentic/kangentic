/**
 * One-time read of the retired git refresh settings.
 *
 * `prRefreshIntervalMinutes` and `autoFetchIntervalMinutes` were interval
 * pickers (2 / 5 / 10 / 15 minutes, or off as `null`). Both became switches,
 * `prAutoRefresh` and `autoFetch`, with the timing fixed in the schedulers. A
 * saved interval reads as on and a saved off stays off, so nobody who turned a
 * sweep off finds it back on. `prEvaluateBranchPolicies` is dropped outright:
 * Azure DevOps PRs now always get their policies checked.
 *
 * Runs on the global config (where `explicit` is the file as parsed, since the
 * in-memory copy already carries the new keys' defaults) and on each project's
 * `.kangentic/config.json` (sparse, so the object is its own `explicit`).
 */

const RETIRED_TO_CURRENT = [
  ['prRefreshIntervalMinutes', 'prAutoRefresh'],
  ['autoFetchIntervalMinutes', 'autoFetch'],
] as const;

const DROPPED_KEYS = ['prEvaluateBranchPolicies'] as const;

/**
 * What a retired interval meant as a switch. JSON keeps `null` apart from an
 * absent key, and the pickers wrote `null` for off, so `null` is off. Zero and
 * negative numbers are off too: the schedulers always read `<= 0` as off. Any
 * other value was a live interval.
 */
export function legacyIntervalIsOn(value: unknown): boolean {
  if (value === null) return false;
  if (typeof value === 'number') return value > 0;
  return true;
}

/**
 * Rewrite the retired keys on `git` in place. A current key the file already
 * set explicitly wins over a retired one. Returns whether anything changed, so
 * the caller knows to persist the cleaned object.
 */
export function migrateLegacyGitKeys(
  git: Record<string, unknown>,
  explicit: Record<string, unknown> | undefined = git,
): boolean {
  let changed = false;
  for (const [retired, current] of RETIRED_TO_CURRENT) {
    if (!(retired in git)) continue;
    if (!explicit || !(current in explicit)) git[current] = legacyIntervalIsOn(git[retired]);
    delete git[retired];
    changed = true;
  }
  for (const dropped of DROPPED_KEYS) {
    if (!(dropped in git)) continue;
    delete git[dropped];
    changed = true;
  }
  return changed;
}
