/**
 * Tiny TTL cache for task titles resolved on the activity-event hot path.
 *
 * The session-activity IPC handler attaches a task title to every activity
 * transition (including the very frequent `thinking` signal), but the renderer
 * only uses it for the occasional cross-project notification. Querying
 * `TaskRepository.getById` per event is a synchronous DB round-trip plus a
 * repository allocation on the main loop, dozens of times per active session.
 *
 * A short TTL keeps the lookup to at most once per task per `TTL_MS`, with no
 * external invalidation hooks to keep in sync (a rename shows the old title for
 * up to the TTL in a notification label, which is harmless). Self-maintaining:
 * any new rename path is automatically picked up within the TTL.
 */

const TTL_MS = 5000;
/** Drop the whole cache past this many entries. It is a best-effort perf cache
 *  that rebuilds lazily, so a coarse clear is simpler than per-entry eviction
 *  and bounds memory across a long-lived process. */
const MAX_ENTRIES = 1000;

interface CacheEntry {
  title: string | undefined;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Return the cached title for `taskId`, or call `load()` (a single DB lookup)
 * and cache its result when missing or expired. `now` is injected so callers
 * can pass `Date.now()` (and tests can pass a fixed clock).
 */
export function getCachedTaskTitle(
  taskId: string,
  now: number,
  load: () => string | undefined,
): string | undefined {
  const hit = cache.get(taskId);
  if (hit && now - hit.at < TTL_MS) return hit.title;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  const title = load();
  cache.set(taskId, { title, at: now });
  return title;
}

/** Test helper: clear all cached titles. */
export function resetTaskTitleCacheForTest(): void {
  cache.clear();
}
