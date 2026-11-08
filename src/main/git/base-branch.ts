import { execFileAsync } from '../utility-process/off-main-exec';
import { gitAt } from './git-client';
import { hasCommits } from './git-checks';
import { fetchIfStale, type FetchFailureReason } from './fetch-throttle';
import { classifyBaseRef, fetchTagFromOrigin, fixedBaseStartPoint, peelToCommit, preferredBranchStartPoint } from './base-ref';


/**
 * Cap on the branch list surfaced in an unresolvable-base error message. A
 * repo with hundreds of branches would otherwise produce an unreadable toast;
 * the point is to give the user a few real names to recognize, not a full
 * inventory.
 */
const MAX_LISTED_BRANCHES = 10;

/** A branch fetch that failed this way never reached origin, so a tag fetch would not either. */
const ORIGIN_UNREACHABLE: ReadonlySet<FetchFailureReason> = new Set(['no-remote', 'network', 'timeout', 'auth', 'abort']);

/**
 * Outcome of resolving a task's worktree base branch against a repo's actual
 * refs.
 *
 * - `no-commits`: the repo has an unborn HEAD (see `hasCommits`). Nothing to
 *   branch from yet; the caller runs the task in the project directory, same
 *   as before this module existed.
 * - `resolved`: a usable ref was found. `baseBranch` is the logical name
 *   (what the `kangentic.baseBranch` git config write records); `startPoint`
 *   is the EXACT ref form that was observed to resolve (`master` or
 *   `origin/master`) - the two differ only when a base was fetched but never
 *   checked out locally.
 * - `unresolvable`: nothing in the candidate list resolves, even after a
 *   fetch retry. `explicit` distinguishes a task-chosen base (never
 *   substituted - see `resolveWorktreeBase`) from an unconfigured project
 *   default (which does fall back through `main` / `master`).
 */
export type WorktreeBaseResolution =
  | { kind: 'no-commits' }
  | { kind: 'resolved'; baseBranch: string; startPoint: string }
  | { kind: 'unresolvable'; attempted: string[]; explicit: boolean; availableBranches: string[] };

/**
 * True if `ref` resolves to a commit in `projectPath`, without touching the
 * network. Peels with `^{commit}`: a bare `rev-parse --verify` exits 0 for
 * any 40-hex string, whether or not the object exists.
 */
export async function refResolvesLocally(projectPath: string, ref: string): Promise<boolean> {
  return (await peelToCommit(projectPath, ref)) !== null;
}

/**
 * The start point `base` resolves to here with no network, or null. A branch
 * cuts from `origin/<base>` unless the local branch is ahead of it; a tag cuts
 * from its full ref (so a branch of the same name cannot shadow it); a commit
 * from its full SHA.
 */
async function localStartPoint(projectPath: string, base: string): Promise<string | null> {
  const baseRef = await classifyBaseRef(projectPath, base);
  switch (baseRef.kind) {
    case 'branch': return preferredBranchStartPoint(projectPath, base, baseRef);
    case 'tag':
    case 'commit': return fixedBaseStartPoint(baseRef);
    case 'unresolved': return null;
  }
}

/** Local branch names, most useful for an error message that names what the repo actually has. */
async function listBranches(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--format=%(refname:short)'],
      { cwd: projectPath, windowsHide: true },
    );
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_LISTED_BRANCHES);
  } catch {
    return [];
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Resolve the base branch a worktree should be created from, verifying it
 * against the repo's actual refs instead of handing `git worktree add` a
 * name that may not exist.
 *
 * Candidate order is the crux of the design:
 *
 * - A per-task `taskBaseBranch` is a deliberate choice for THAT task. It is
 *   the only candidate tried (`explicit: true`) - silently substituting
 *   `main` for a base the user picked would run the agent against the wrong
 *   code with no signal, which is worse than failing loudly.
 * - With no per-task override, `[defaultBaseBranch, 'main', 'master']`
 *   (deduped) are tried in order. `defaultBaseBranch` is an unconfigured
 *   project default in the common case (nobody ever set
 *   `git.defaultBaseBranch`, so it is the hardcoded `'main'`), so falling
 *   through to `master` for the very common repo whose only branch is
 *   `master` is the right default, not a guess the user needs to approve.
 *
 * Every candidate is checked locally first (no network). Only if NONE
 * resolve locally does this fetch - one candidate at a time, in order - and
 * accept the first one whose fetch succeeds. This mirrors
 * `WorktreeManager.createWorktree`'s own success/failure signal
 * (`fetchIfStale` returns `origin/<branch>` on success, bare `<branch>` on
 * failure) rather than re-deriving it, so this resolver and the worktree
 * creation it gates can never disagree about which ref actually resolved.
 */
export async function resolveWorktreeBase(
  projectPath: string,
  taskBaseBranch: string | null,
  defaultBaseBranch: string,
  options?: { signal?: AbortSignal },
): Promise<WorktreeBaseResolution> {
  if (!(await hasCommits(projectPath))) {
    return { kind: 'no-commits' };
  }

  // Narrow once and derive both `candidates` and `explicit` from the same value, so
  // the two can never disagree about whether a per-task base was supplied.
  const trimmedTaskBaseBranch = taskBaseBranch?.trim() || null;
  const explicit = trimmedTaskBaseBranch !== null;
  const candidates = trimmedTaskBaseBranch !== null
    ? [trimmedTaskBaseBranch]
    : dedupe([defaultBaseBranch, 'main', 'master']);

  // Local pass: no network, and this is the common case (the base branch
  // exists and was already fetched or created locally). A base is a branch, a
  // tag or a commit (`base-ref.ts`), classified in that order. A branch cuts
  // from origin unless the local branch is ahead; a tag or commit is its own
  // start point.
  for (const candidate of candidates) {
    const startPoint = await localStartPoint(projectPath, candidate);
    if (startPoint) return { kind: 'resolved', baseBranch: candidate, startPoint };
  }

  // Fetch pass: every candidate missed locally. A base that exists only on
  // origin and was never fetched works today (createWorktree fetches before
  // using the ref), so skipping this would regress repos that currently
  // succeed.
  const git = gitAt(projectPath);
  for (const candidate of candidates) {
    // Each candidate fetch is capped at fetchIfStale's own timeout, so an unreachable
    // remote could otherwise hold a cancelled task move for the full chain. Forwarding
    // the caller's signal lets an abort cut the chain short rather than run it out.
    options?.signal?.throwIfAborted();
    // A ref object rather than a plain let: an assignment inside the callback
    // never widens the let's narrowing to null.
    const fetchFailure: { reason: FetchFailureReason | null } = { reason: null };
    const fetched = await fetchIfStale(git, projectPath, candidate, {
      signal: options?.signal,
      onOutcome: (outcome) => { fetchFailure.reason = outcome.kind === 'failed' ? outcome.reason : null; },
    });
    // Don't trust fetchIfStale's return string alone: it reports `origin/<branch>` on fetch
    // PROCESS success, which is not the same as the ref actually landing in
    // refs/remotes/origin/<branch> (a non-default remote.origin.fetch refspec, or a fetch that
    // only populated FETCH_HEAD, would both report success here). Re-verify locally before
    // trusting it as a startPoint.
    if (fetched === `origin/${candidate}` && await refResolvesLocally(projectPath, fetched)) {
      return { kind: 'resolved', baseBranch: candidate, startPoint: fetched };
    }
    // Not a branch on origin. A tag that exists only on origin needs its own
    // refspec: `git fetch origin <tag>` above writes FETCH_HEAD and nothing else.
    // Only a task's own base is tried as a tag (a project default is a branch),
    // and never after a fetch that could not reach origin at all: a second
    // 15-second wait on a dead remote would only delay the same error.
    const originReachable = fetchFailure.reason === null || !ORIGIN_UNREACHABLE.has(fetchFailure.reason);
    if (explicit && originReachable && await fetchTagFromOrigin(projectPath, candidate, { signal: options?.signal })) {
      return { kind: 'resolved', baseBranch: candidate, startPoint: `refs/tags/${candidate}` };
    }
    // A full SHA the fetch above brought in (a server that serves a reachable
    // commit by id) now resolves locally as a commit.
    const fetchedStartPoint = await localStartPoint(projectPath, candidate);
    if (fetchedStartPoint) return { kind: 'resolved', baseBranch: candidate, startPoint: fetchedStartPoint };
  }

  return {
    kind: 'unresolvable',
    attempted: candidates,
    explicit,
    availableBranches: await listBranches(projectPath),
  };
}

function formatBranchList(names: string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
}

/**
 * Written explanation for an `unresolvable` resolution, following the house
 * style set by `staleWorktreeError` in `worktree-manager.ts`: what failed,
 * why, and what to do about it. Never used for `no-commits` (that case is a
 * silent fallback, not an error).
 */
export function describeUnresolvableBase(
  failure: Extract<WorktreeBaseResolution, { kind: 'unresolvable' }>,
): string {
  const branchesClause = failure.availableBranches.length > 0
    ? ` Branches found: ${failure.availableBranches.join(', ')}.`
    : '';

  if (failure.explicit) {
    return `Cannot create worktree: this task's base '${failure.attempted[0]}' is not a branch, `
      + `tag or commit, locally or on origin. Pick a different base for the task, or create the `
      + `branch.${branchesClause}`;
  }

  return `Cannot create worktree: this repository has no branch named ${formatBranchList(failure.attempted)}. `
    + `Set Default Base Branch in Settings > Git to a branch this repository has.${branchesClause}`;
}
