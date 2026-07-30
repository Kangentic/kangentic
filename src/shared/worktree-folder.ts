/**
 * Helpers for reading a worktree's directory NAME out of a stored path.
 *
 * These are deliberately separator-agnostic rather than using `path.basename`.
 * A path written on Windows (`C:\...\worktrees\460`) is read back by tests and
 * CI on Linux, where `path.basename` does not split on a backslash and would
 * return the whole string as the "folder name".
 */

/** Split a path on either separator, discarding empty segments. */
function pathSegments(rawPath: string): string[] {
  return rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * The last path segment, or null when there is none. Trailing separators are
 * ignored, so `.../worktrees/460/` and `.../worktrees/460` agree.
 */
export function worktreeFolderFromPath(worktreePath: string | null | undefined): string | null {
  if (!worktreePath) return null;
  const segments = pathSegments(worktreePath);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/** Case-fold on Windows only, where the filesystem is case-insensitive. */
function comparablePath(rawPath: string): string {
  const normalized = pathSegments(rawPath).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * The folder name of `candidatePath`, but ONLY when it is a direct child of
 * `worktreesRoot`. Returns null for the root itself, for a grandchild, and for
 * anything outside the root.
 *
 * The anchor is what makes this safe where a bare `.kangentic/worktrees/` marker
 * search is not: Kangentic can be opened AT a worktree path, in which case the
 * project root already contains the marker and a task that never had a worktree
 * would otherwise appear to own the enclosing worktree's folder.
 */
export function worktreeFolderUnderRoot(
  worktreesRoot: string,
  candidatePath: string | null | undefined,
): string | null {
  if (!candidatePath) return null;
  const rootSegments = comparablePath(worktreesRoot).split('/').filter(Boolean);
  const candidateSegments = comparablePath(candidatePath).split('/').filter(Boolean);
  if (candidateSegments.length !== rootSegments.length + 1) return null;
  for (let index = 0; index < rootSegments.length; index++) {
    if (candidateSegments[index] !== rootSegments[index]) return null;
  }
  // Return the ORIGINAL-case segment, not the comparable one.
  return worktreeFolderFromPath(candidatePath);
}
