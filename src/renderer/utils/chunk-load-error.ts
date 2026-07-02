/**
 * Detect a dynamic-import ("chunk load") failure from a caught error.
 *
 * When a code-split module fails to fetch (a dev-server mid-invalidation, a
 * transform error, or a stale chunk URL after a deploy), the browser rejects the
 * `import()` with a message like "Failed to fetch dynamically imported module".
 * Crucially, the browser then CACHES that failure in the page's module map for
 * the lifetime of the document: re-importing the same URL returns the same cached
 * rejection without a new fetch. So a remount / fresh `React.lazy` cannot recover
 * a chunk-load failure - only a full page reload (which starts a fresh module
 * map) can. This predicate lets an error boundary tell a chunk-load failure
 * (needs reload) apart from an ordinary render error (a remount may recover).
 *
 * Messages vary by engine, so match a set of known substrings case-insensitively.
 */
const CHUNK_LOAD_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
  'loading chunk',
  'loading css chunk',
];

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (!message) return false;
  const normalized = message.toLowerCase();
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}
