// Persistent partitions (cookie jars) for the embedded browser pane.
//
// The pane is isolated PER WORKTREE: each task detail runs in its own working
// directory (a git worktree, or the project root for main-cwd tasks), and that
// directory IS the "dev environment". Browser cookies are scoped to HOST, not
// port, so two worktrees running dev servers on localhost:4200 and :4300 would
// clobber each other's `localhost` session under a single shared jar. Keying
// the partition by the worktree path keeps each dev environment's logins
// isolated while still persisting across app restarts (a `persist:` partition),
// and sessions that share a checkout share the jar.
//
// `browserPartitionForWorktree` is imported by both the renderer
// (`<webview partition>`, keyed off the session's `cwd`) and the main process
// (the clear-storage IPC handler, which enumerates the project's worktrees and
// clears each jar), so the two derive the same name from the same input.

/**
 * Legacy single shared partition. Pre-dates per-worktree isolation. Kept so
 * the clear-storage action can also wipe any data left in the old shared jar
 * after the upgrade, and as the fallback when no worktree path is known.
 */
export const BROWSER_PARTITION = 'persist:kangentic-browser';

/**
 * Normalize a worktree path so the renderer (which receives the session `cwd`)
 * and the main process (which builds the path from the worktrees directory)
 * hash to the same partition even if the separators or drive-letter casing
 * differ between the two sources. Same machine, same dir, same key.
 */
function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * FNV-1a 32-bit hash, returned as an 8-char hex string. Pure (no Node crypto)
 * so it runs identically in the renderer and the main process. Collisions
 * across the handful of worktrees a project has are astronomically unlikely,
 * and a collision only means two worktrees would share a cookie jar (the
 * pre-isolation behavior), never a crash.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // 32-bit FNV prime multiply via shifts, kept in the unsigned 32-bit range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Persistent partition name for the embedded browser pane in a given worktree.
 * Returns the legacy shared jar when no worktree path is available so the pane
 * still works (and shares one jar) in that edge case.
 */
export function browserPartitionForWorktree(worktreePath: string | null | undefined): string {
  if (!worktreePath) return BROWSER_PARTITION;
  return `persist:kngbrowser-${fnv1aHex(normalizeWorktreePath(worktreePath))}`;
}
