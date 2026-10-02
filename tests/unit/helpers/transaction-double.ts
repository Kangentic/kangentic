/**
 * A stand-in for better-sqlite3's `db.transaction(body)` in recording test
 * doubles. It runs `body` with no SQL, and carries the `.deferred`,
 * `.immediate` and `.exclusive` variants, because the app runs every
 * transaction through `writeTransaction`, which calls `.immediate`.
 */
export function passThroughTransaction<Args extends unknown[], Result>(body: (...args: Args) => Result) {
  const run = (...args: Args): Result => body(...args);
  return Object.assign(run, { deferred: run, immediate: run, exclusive: run });
}
