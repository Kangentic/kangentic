import { useProjectStore } from '../stores/project-store';

/**
 * In-flight de-dupe + short TTL cache for `git:listBranches`.
 *
 * The handler shells out to git (~900ms). Opening the New Task dialog or the
 * Task Detail dialog fires TWO concurrent `git:listBranches` calls: the dialog's
 * own branch-existence check and the embedded `BranchPicker`'s list fetch. This
 * module collapses concurrent calls into one round-trip and serves a fresh
 * result from a brief cache, keyed by the CURRENT project id (the main handler
 * routes by the ambient project, so a cross-project cache hit would return the
 * wrong repo's branches).
 */
const BRANCHES_CACHE_TTL_MS = 15_000;

// hmr-safe: transient short-TTL cache; a reset-on-HMR just triggers a refetch.
let inFlightRequest: { projectId: string | null; promise: Promise<string[]> } | null = null;
// hmr-safe: see inFlightRequest.
let cachedResult: { projectId: string | null; branches: string[]; fetchedAtMs: number } | null = null;

/**
 * Fetch the repo's branch list, sharing an in-flight request and a fresh cache
 * across concurrent callers for the current project. Rejections are never
 * cached, so a failed fetch is retried on the next call.
 */
export function fetchGitBranches(): Promise<string[]> {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  const now = Date.now();

  // Fresh same-project cache: serve it without touching IPC.
  if (
    cachedResult
    && cachedResult.projectId === projectId
    && now - cachedResult.fetchedAtMs < BRANCHES_CACHE_TTL_MS
  ) {
    return Promise.resolve(cachedResult.branches);
  }

  // Same-project request already in flight: join it (this is what collapses the
  // dialog + BranchPicker double-fire into one ~900ms shell-out).
  if (inFlightRequest && inFlightRequest.projectId === projectId) {
    return inFlightRequest.promise;
  }

  const promise = window.electronAPI.git.listBranches()
    .then((branches) => {
      cachedResult = { projectId, branches, fetchedAtMs: Date.now() };
      return branches;
    })
    .finally(() => {
      // Clear the in-flight marker only if it is still ours (a project switch
      // mid-flight may have replaced it).
      if (inFlightRequest?.promise === promise) inFlightRequest = null;
    });

  inFlightRequest = { projectId, promise };
  return promise;
}

/** Test-only: drop the cache and any in-flight marker. */
export function invalidateGitBranchesCache(): void {
  inFlightRequest = null;
  cachedResult = null;
}
