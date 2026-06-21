import simpleGit from 'simple-git';
import { resolvePRByNumber } from '../pr/pr-registry';
import type { PRState } from '../../shared/types';

/** PR context for the merged-state signal (squash-merge, which patch-id cannot detect). */
export interface PrMergeContext {
  prNumber?: number | null;
  prState?: PRState | null;
}

/** Time budget for the best-effort `gh` merged-state lookup; matches the probe's fetch ceiling. */
const PR_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Count commits whose work exists ONLY on this local branch and nowhere
 * recoverable - the commits a worktree/branch deletion would actually destroy.
 * A commit is NOT counted when it is:
 *   - reachable from any remote ref (pushed, so recoverable from the remote), or
 *   - already present in the base branch by patch-id - a rebase, merge-commit,
 *     or cherry-pick re-creates the commit under a new SHA, so it is unreachable
 *     from the remote by SHA yet its work is on the base branch, or
 *   - part of a merged PR - a squash-merge collapses N commits into a single
 *     commit whose patch-id matches none of them, so patch-id alone cannot see
 *     it; the linked PR's merged state is the only robust signal.
 *
 * Best-effort: every failure path returns a count no smaller than the
 * provably-local set, so the result can only drop false positives, never hide
 * genuinely at-risk work.
 */
export async function countLocalOnlyCommits(checkPath: string, pr?: PrMergeContext): Promise<number> {
  const git = simpleGit(checkPath);

  // Commits on HEAD reachable from no remote ref (by SHA). Anything pushed is
  // recoverable from the remote and excluded here.
  const localOnly = (await git.raw(['rev-list', 'HEAD', '--not', '--remotes']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (localOnly.length === 0) return 0;

  // Drop commits already present in the base branch by CONTENT (patch-id). This
  // is what makes a rebase-merged branch read clean: the rebased copies live on
  // origin/<base> under new SHAs, and `git cherry` marks the originals '-'.
  const contentMerged = await contentMergedShas(git);
  const remaining = localOnly.filter((sha) => !contentMerged.has(sha));
  if (remaining.length === 0) return 0;

  // Patch-id cannot prove a squash-merge; fall back to the linked PR's merged
  // state. A stored 'merged' is trusted directly (no network); otherwise a
  // bounded fresh lookup catches "merged just now, stored state not refreshed".
  if (await isPrMerged(checkPath, pr)) return 0;

  return remaining.length;
}

/** SHAs reachable from HEAD whose patch-id already exists in the base branch. */
async function contentMergedShas(git: ReturnType<typeof simpleGit>): Promise<Set<string>> {
  const base = await resolveBaseBranch(git);
  // `origin/<base>` first (current after the probe's fetch), then local `<base>`.
  for (const upstream of [`origin/${base}`, base]) {
    try {
      const output = await git.raw(['cherry', '-v', upstream, 'HEAD']);
      const merged = new Set<string>();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        // `git cherry` prints '+ <sha> <subject>' (absent upstream) or
        // '- <sha> <subject>' (present upstream by patch-id).
        if (!trimmed.startsWith('-')) continue;
        const sha = trimmed.split(/\s+/)[1];
        if (sha) merged.add(sha);
      }
      return merged;
    } catch {
      continue; // Upstream ref missing - try the next, else give up (no false negative).
    }
  }
  return new Set();
}

/** The base branch the worktree forked from, recorded at creation; falls back to 'main'. */
async function resolveBaseBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const configured = (await git.raw(['config', 'kangentic.baseBranch'])).trim();
    if (configured) return configured;
  } catch {
    // Not set (older worktree, or branched outside Kangentic).
  }
  return 'main';
}

/** Whether the task's linked PR is merged (covers squash and any merge strategy). */
async function isPrMerged(checkPath: string, pr?: PrMergeContext): Promise<boolean> {
  if (!pr) return false;
  if (pr.prState === 'merged') return true;
  if (pr.prNumber == null) return false;
  try {
    const resolved = await withTimeout(resolvePRByNumber(checkPath, pr.prNumber), PR_LOOKUP_TIMEOUT_MS);
    return resolved?.state === 'merged';
  } catch {
    return false; // gh missing / unauthenticated / offline / timeout - keep the warning.
  }
}

/** Resolve `promise`, or reject after `timeoutMs`, so a hung `gh` cannot stall the Done dialog. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pr-lookup-timeout')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
