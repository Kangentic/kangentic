import { useProjectStore } from '../stores/project-store';

/**
 * In-flight de-dupe + short TTL cache for `git:listBranches`.
 *
 * The handler shells out to git (~900ms). Opening the New Task dialog or the
 * Task Detail dialog fires TWO concurrent `git:listBranches` calls: the dialog's
 * own branch-existence check and the embedded `BranchPicker`'s list fetch. This
 * module collapses concurrent calls into one round-trip and serves a fresh
 * result from a brief cache, keyed by the project whose branches were listed:
 * the one asked for, or the CURRENT project when none is (the main handler
 * routes an unnamed read by the ambient project, so a cross-project cache hit
 * would return the wrong repo's branches).
 */
const BRANCHES_CACHE_TTL_MS = 15_000;

// hmr-safe: transient short-TTL cache; a reset-on-HMR just triggers a refetch.
let inFlightRequest: { projectId: string | null; promise: Promise<string[]> } | null = null;
// hmr-safe: see inFlightRequest.
let cachedResult: { projectId: string | null; branches: string[]; fetchedAtMs: number } | null = null;

/**
 * Fetch a repo's branch list, sharing an in-flight request and a fresh cache
 * across concurrent callers for the same project. `projectId` names another
 * project (a workflow's planned task on its board); omitted, the current one.
 * Rejections are never cached, so a failed fetch is retried on the next call.
 */
export function fetchGitBranches(projectId?: string | null): Promise<string[]> {
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  const targetProjectId = projectId ?? currentProjectId;
  // The open project is asked for by omission, so main keeps routing it by
  // the ambient project exactly as before.
  const requestProjectId = targetProjectId !== currentProjectId ? targetProjectId : null;
  const now = Date.now();

  // Fresh same-project cache: serve it without touching IPC.
  if (
    cachedResult
    && cachedResult.projectId === targetProjectId
    && now - cachedResult.fetchedAtMs < BRANCHES_CACHE_TTL_MS
  ) {
    return Promise.resolve(cachedResult.branches);
  }

  // Same-project request already in flight: join it (this is what collapses the
  // dialog + BranchPicker double-fire into one ~900ms shell-out).
  if (inFlightRequest && inFlightRequest.projectId === targetProjectId) {
    return inFlightRequest.promise;
  }

  const listing = requestProjectId !== null
    ? window.electronAPI.git.listBranches(requestProjectId)
    : window.electronAPI.git.listBranches();
  const promise = listing
    .then((branches) => {
      cachedResult = { projectId: targetProjectId, branches, fetchedAtMs: Date.now() };
      return branches;
    })
    .finally(() => {
      // Clear the in-flight marker only if it is still ours (a project switch
      // mid-flight may have replaced it).
      if (inFlightRequest?.promise === promise) inFlightRequest = null;
    });

  inFlightRequest = { projectId: targetProjectId, promise };
  return promise;
}

/** Test-only: drop the cache and any in-flight marker. */
export function invalidateGitBranchesCache(): void {
  inFlightRequest = null;
  cachedResult = null;
}
