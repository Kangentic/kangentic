import type { SimpleGit } from 'simple-git';

/**
 * Fetch throttle cache - avoids redundant `git fetch` calls for the
 * same project+branch within a short window. In-memory only, resets
 * on app restart.
 *
 * Covers batch moves (5+ tasks dragged in quick succession) without
 * significant staleness risk for spaced-out individual moves.
 *
 * Consumers: WorktreeManager.createWorktree, transient-sessions IPC
 * handler, task-git helper.
 */

const fetchCache = new Map<string, number>();

/** Skip fetch if the same project+branch was fetched within this window. */
const FETCH_THROTTLE_MS = 30 * 1000; // 30 seconds

/** Clear the fetch throttle cache (for testing). */
export function clearFetchCache(): void {
  fetchCache.clear();
}

function fetchCacheKey(projectPath: string, branch: string): string {
  const normalizedPath = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  return `${normalizedPath}:${branch}`;
}

/**
 * Fetch from origin if the branch hasn't been fetched recently.
 * Returns the start point to use (`origin/<branch>` or local `<branch>`).
 */
export async function fetchIfStale(
  git: SimpleGit,
  projectPath: string,
  branch: string,
): Promise<string> {
  const key = fetchCacheKey(projectPath, branch);
  const lastFetch = fetchCache.get(key);
  if (lastFetch && Date.now() - lastFetch < FETCH_THROTTLE_MS) {
    return `origin/${branch}`;
  }

  try {
    await git.raw(['fetch', 'origin', branch]);
    fetchCache.set(key, Date.now());
    return `origin/${branch}`;
  } catch {
    // No remote, branch not on remote, or network unavailable -- use local branch
    return branch;
  }
}
