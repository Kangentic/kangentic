import type { ProjectPathProbe } from '../../shared/types';

/**
 * In-flight de-dupe + short TTL cache for `project:probePath`, keyed by PATH.
 *
 * The branch hint in the New Task dialog and the task-detail edit form asks
 * whether the project can have a worktree at all (is it a git repo, is it
 * itself a worktree, does it have a commit yet) so it can stop promising one
 * the worktree manager cannot create. Opening either surface would otherwise
 * fire a fresh probe (a `git rev-parse` shell-out) per mount; this collapses
 * concurrent callers into one round trip and serves a brief cache.
 *
 * Keyed by path rather than by the current project id, unlike
 * `git-branches.ts`: `probePath` is explicitly parameterized, so a task hosted
 * outside its own board (the Agent Monitor) probes its OWN project and never
 * the open one. That is also why this reads `window.electronAPI` directly and
 * not the project store, which the task-detail decoupling scan forbids.
 */
const PROBE_CACHE_TTL_MS = 15_000;

// hmr-safe: transient short-TTL cache; a reset-on-HMR just triggers a re-probe.
const inFlightProbes = new Map<string, Promise<ProjectPathProbe>>();
// hmr-safe: see inFlightProbes.
const cachedProbes = new Map<string, { probe: ProjectPathProbe; fetchedAtMs: number }>();

/**
 * Probe a project folder, sharing an in-flight request and a fresh cache
 * across concurrent callers for the same path. Rejections are never cached,
 * so a failed probe is retried on the next call.
 */
export function fetchProjectProbe(projectPath: string): Promise<ProjectPathProbe> {
  const now = Date.now();
  const cached = cachedProbes.get(projectPath);
  if (cached && now - cached.fetchedAtMs < PROBE_CACHE_TTL_MS) {
    return Promise.resolve(cached.probe);
  }

  const inFlight = inFlightProbes.get(projectPath);
  if (inFlight) return inFlight;

  const promise = window.electronAPI.projects.probePath(projectPath)
    .then((probe) => {
      cachedProbes.set(projectPath, { probe, fetchedAtMs: Date.now() });
      return probe;
    })
    .finally(() => {
      if (inFlightProbes.get(projectPath) === promise) inFlightProbes.delete(projectPath);
    });

  inFlightProbes.set(projectPath, promise);
  return promise;
}

/** Test-only: drop the cache and any in-flight markers. */
export function invalidateProjectProbeCache(): void {
  inFlightProbes.clear();
  cachedProbes.clear();
}
