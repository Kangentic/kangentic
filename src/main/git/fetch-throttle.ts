import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { runGitWithTimeout, isGitTimeoutError } from './git-spawn';

/**
 * Fetch throttle cache - avoids redundant `git fetch` calls for the
 * same project+branch within a short window. In-memory only, resets
 * on app restart.
 *
 * Covers batch moves (5+ tasks dragged in quick succession) without
 * significant staleness risk for spaced-out individual moves.
 *
 * Consumers: WorktreeManager.createWorktree, transient-sessions IPC
 * handler, task-git helper, and the pending-changes probe
 * (fetchAllRemotesIfStale).
 */

const fetchCache = new Map<string, number>();

/**
 * Why a failed fetch is classified: the surfaced classes (timeout / auth /
 * network / other) mean the remote was expected to answer and did not, which
 * is a genuine staleness risk worth telling the user about. The silent classes
 * are either not failures at all (abort) or repos where the local ref was
 * always going to be authoritative (no remote configured, branch not on the
 * remote). Classification reads stderr text rather than probing remote config:
 * the stderr already distinguishes every case without an extra shell-out, and
 * git porcelain errors are not localized by default; an unrecognized message
 * degrades to 'other'.
 */
export type FetchFailureReason =
  | 'timeout'
  | 'auth'
  | 'network'
  | 'other'
  | 'abort'
  | 'no-remote'
  | 'branch-missing';

/** Result of one fetchIfStale call, reported via `options.onOutcome`. */
export type FetchIfStaleOutcome =
  | { kind: 'fetched' }
  | { kind: 'throttled' }
  | { kind: 'failed'; reason: FetchFailureReason; message: string };

/**
 * Classify a rejected fetch by its error message. Exported for unit tests
 * only; production code observes classifications through fetchIfStale's
 * `onOutcome` callback. Keep it that way: several handler tests mock this
 * module with factories that enumerate only the functions they stub, so a new
 * production-imported value export would arrive as `undefined` there.
 */
export function classifyFetchFailure(error: unknown): FetchFailureReason {
  if (isGitTimeoutError(error)) return 'timeout';
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted \(external abort\)|aborted before spawn/.test(message)) return 'abort';
  // A signal-kill from runGitWithTimeout asserts the timeout as its cause
  // (signalKillAssertsTimeout), a shape isGitTimeoutError does not match.
  if (/killed by signal .+ after \d+ms timeout/.test(message)) return 'timeout';
  if (/couldn't find remote ref/i.test(message)) return 'branch-missing';
  if (/does not appear to be a git repository|No such remote/i.test(message)) return 'no-remote';
  // Auth before network: ssh auth failures also print the network-sounding
  // "Could not read from remote repository", and an https 401/403 arrives
  // wrapped in "unable to access". "Permission denied" requires the ssh
  // parenthetical ("(publickey)", "(password)", ...): git-for-Windows emits a
  // bare "Permission denied" for LOCAL file locks too ("unable to unlink old
  // '...pack.idx': Permission denied" under antivirus or a live agent), and
  // toasting "authentication failed" for those would be confidently wrong.
  if (/authentication failed|could not read Username|Permission denied \(|publickey|Invalid username or password|terminal prompts disabled|HTTP 40[13]|returned error: 40[13]/i.test(message)) return 'auth';
  if (/Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|Could not read from remote repository/i.test(message)) return 'network';
  return 'other';
}

/** Deliver an outcome without letting a throwing listener change fetch semantics. */
function reportOutcome(
  onOutcome: ((outcome: FetchIfStaleOutcome) => void) | undefined,
  outcome: FetchIfStaleOutcome,
): void {
  if (!onOutcome) return;
  try {
    onOutcome(outcome);
  } catch {
    // Observers are best-effort; the returned start point is the contract.
  }
}

/** Skip fetch if the same project+branch was fetched within this window. */
const FETCH_THROTTLE_MS = 30 * 1000; // 30 seconds

/**
 * Wall-clock ceiling for the underlying `git fetch`. Real fetches against
 * GitHub/Azure DevOps complete in <1s on a healthy network. The 15s ceiling
 * exists to bound the failure mode where Electron-spawned fetches hang
 * forever waiting on a stale OpenSSH ControlMaster socket, an unreachable
 * proxy, or an invisible credential dialog. On timeout we fall back to the
 * local branch - the same fallback already used for every other failure
 * mode (no remote, branch missing, network error).
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Sentinel cache "branch" for whole-repo (`fetch --all`) refreshes. Git ref
 * names cannot contain `*`, so this never collides with a real branch key
 * written by fetchIfStale.
 */
const ALL_REMOTES_SENTINEL = '*all-remotes*';

/**
 * Tighter ceiling than FETCH_TIMEOUT_MS: the all-remotes fetch gates the
 * Done-drop pending-changes dialog while the user is mid-interaction, so it
 * cannot afford the full 15s hang budget. Healthy fetches finish under 1s; the
 * completion gate tolerates a slow probe (see
 * .claude/rules/board-completing-task-chokepoint.md), so the worst case is the
 * dialog appearing ~5s after the drop.
 */
const PROBE_FETCH_TIMEOUT_MS = 5_000;

/**
 * In-flight all-remotes fetches keyed by repo identity. Batch Done moves probe
 * each task's worktree concurrently; sharing one fetch promise avoids parallel
 * `git fetch` processes contending on the shared repo's ref locks.
 */
const inFlightAllRemoteFetches = new Map<string, Promise<void>>();

/** Clear the fetch throttle cache (for testing). */
export function clearFetchCache(): void {
  fetchCache.clear();
  inFlightAllRemoteFetches.clear();
}

function fetchCacheKey(projectPath: string, branch: string): string {
  const normalizedPath = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  return `${normalizedPath}:${branch}`;
}

/**
 * Fetch from origin if the branch hasn't been fetched recently.
 * Returns the start point to use (`origin/<branch>` or local `<branch>`).
 *
 * Failure semantics: ANY failure (no remote, branch missing, network down,
 * timeout, abort) falls back to the local branch. The cache is only
 * populated on success, so a transient timeout never poisons subsequent
 * calls.
 *
 * The `_git: SimpleGit` parameter is retained on the signature for
 * back-compat with existing callers but is unused (prefixed `_` so
 * eslint accepts it). The timeout path requires `child_process.spawn`
 * directly so we can attach an `AbortSignal` (simple-git's `.raw()`
 * exposes no abort primitive).
 *
 * `options.onOutcome` reports what actually happened - fetched, throttle
 * skip, or a classified failure - because the returned string cannot: a
 * throttle hit returns `origin/<branch>` without fetching, and a failure's
 * bare `<branch>` says nothing about why. Callers that surface staleness
 * (spawn-progress notes, warning toasts) key off the outcome, never the
 * return value.
 */
export async function fetchIfStale(
  _git: SimpleGit,
  projectPath: string,
  branch: string,
  options?: { signal?: AbortSignal; onOutcome?: (outcome: FetchIfStaleOutcome) => void },
): Promise<string> {
  const key = fetchCacheKey(projectPath, branch);
  const lastFetch = fetchCache.get(key);
  if (lastFetch && Date.now() - lastFetch < FETCH_THROTTLE_MS) {
    reportOutcome(options?.onOutcome, { kind: 'throttled' });
    return `origin/${branch}`;
  }

  try {
    await runGitWithTimeout(projectPath, ['fetch', 'origin', branch], {
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: options?.signal,
    });
    fetchCache.set(key, Date.now());
    reportOutcome(options?.onOutcome, { kind: 'fetched' });
    return `origin/${branch}`;
  } catch (error) {
    if (isGitTimeoutError(error)) {
      console.warn(`[FETCH] timed out after ${FETCH_TIMEOUT_MS / 1000}s, falling back to local branch ${branch}`);
    }
    reportOutcome(options?.onOutcome, {
      kind: 'failed',
      reason: classifyFetchFailure(error),
      message: error instanceof Error ? error.message : String(error),
    });
    // No remote, branch not on remote, network unavailable, timeout, or
    // abort: use local branch. Cache intentionally NOT updated so the
    // next call retries.
    return branch;
  }
}

/**
 * Refresh ALL remote-tracking refs for the repo that owns `checkPath` so a
 * subsequent `git rev-list --not --remotes` compares against current remote
 * state rather than stale local refs. Used by the Done-move pending-changes
 * probe, where a stale ref made already-pushed commits look local-only and
 * falsely warned the user about losing work.
 *
 * `--all` (every remote, not just origin) matches `rev-list --not --remotes`,
 * and the observed false positive came from a commit reachable via a different
 * remote branch than the task's. `--prune` drops tracking refs for deleted
 * remote branches; without it a stale ref could mask genuinely unpushed
 * commits (a false negative, which risks silent loss and is worse than the
 * false positive this fixes).
 *
 * Throttled (FETCH_THROTTLE_MS) and deduped by repo identity so batch Done
 * moves of many worktrees pay for one fetch, not one per worktree. Identity is
 * the git common dir (shared across a repo's worktrees), falling back to
 * `checkPath` if it cannot be resolved.
 *
 * Failure semantics: this never rejects. Any failure (no remote, offline,
 * timeout, ref-lock contention) is swallowed so the probe falls back to the
 * existing local refs - the behavior before this refresh existed.
 */
export async function fetchAllRemotesIfStale(checkPath: string): Promise<void> {
  let repoIdentityPath = checkPath;
  try {
    const commonDirOutput = (
      await runGitWithTimeout(checkPath, ['rev-parse', '--git-common-dir'], {
        timeoutMs: PROBE_FETCH_TIMEOUT_MS,
      })
    ).stdout.trim();
    if (commonDirOutput) {
      // `--git-common-dir` can be relative (e.g. ".git"); resolve against the
      // probed path so worktrees of the same repo share one identity.
      repoIdentityPath = path.resolve(checkPath, commonDirOutput);
    }
  } catch {
    // Fall back to checkPath: the throttle degrades to per-worktree, still correct.
  }

  const cacheKey = fetchCacheKey(repoIdentityPath, ALL_REMOTES_SENTINEL);
  const lastFetch = fetchCache.get(cacheKey);
  if (lastFetch && Date.now() - lastFetch < FETCH_THROTTLE_MS) {
    return;
  }

  const inFlight = inFlightAllRemoteFetches.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    try {
      await runGitWithTimeout(checkPath, ['fetch', '--all', '--prune', '--quiet'], {
        timeoutMs: PROBE_FETCH_TIMEOUT_MS,
      });
      fetchCache.set(cacheKey, Date.now());
    } catch (error) {
      if (isGitTimeoutError(error)) {
        console.warn(`[FETCH] all-remotes refresh timed out after ${PROBE_FETCH_TIMEOUT_MS / 1000}s; using existing refs`);
      }
      // Swallow every failure: the probe falls back to existing local refs.
      // Cache intentionally NOT updated so the next probe retries.
    } finally {
      inFlightAllRemoteFetches.delete(cacheKey);
    }
  })();

  inFlightAllRemoteFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}
