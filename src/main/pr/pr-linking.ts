import { IPC } from '../../shared/ipc-channels';
import { withTaskLock } from '../ipc/task-lifecycle-lock';
import { readWorktreeHead, hasCommitsAheadOfBase, readRefsPointingAtSha } from '../git/worktree-head';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { sendToRenderer } from '../ipc/send-to-renderer';
import {
  resolvePRForBranch,
  resolvePRByNumber,
  resolvePRByCommit,
  commitAnchorSelfVerifies,
  detectPR,
  PRResolverUnavailableError,
  PRResolverTransientError,
} from './pr-registry';
import { createDeferredDegrade } from './shared/pr-dispatch';
import { trackFeatureUsed } from '../analytics/usage';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { Task, PRState, PRMergeReadiness, PRLinkStatus, TaskUpdateInput } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

export interface PRLinkResult {
  status: PRLinkStatus;
  task: Task | null;
  /** Human-readable detail for `resolver-unavailable` / `transient-error`. */
  message?: string;
}

/**
 * One-hint-per-reason guard so the "resolver unavailable" hint isn't logged on
 * every move.
 *
 * Keyed by reason rather than a single boolean: a project whose remote no
 * connector owns would otherwise burn a process-lifetime latch on the first
 * sweep and permanently suppress a genuinely different later hint (say, "gh is
 * not installed") for every other project. Bounded so a message that varies by
 * path cannot grow it without limit, evicting the OLDEST entry rather than
 * clearing the whole set: a wholesale clear discards every already-warned
 * message at once, so the next sweep re-warns all of them and a workspace that
 * keeps crossing the cap settles into a clear-then-restorm cycle instead of the
 * one-hint-per-reason behaviour this guard exists to provide. `Set` preserves
 * insertion order, so oldest-first is just its first key (same eviction shape
 * as `git-remotes.ts`'s `pruneExpired`).
 */
const resolverUnavailableHintsShown = new Set<string>();
const MAX_RESOLVER_HINTS = 32;

/**
 * Per-task throttle: timestamp (ms) of the last resolve. Auto triggers within
 * this window coalesce so a multi-card drag or rapid moves don't spawn a `gh`
 * storm. Manual / MCP resolves bypass it (force=true). Bounded by task count.
 */
const lastResolveAt = new Map<string, number>();
const RESOLVE_TTL_MS = 60_000;

/**
 * Hold-and-re-poll for a PENDING merge verdict. GitHub answers `UNKNOWN` for a
 * few seconds after every push while it recomputes mergeability, and Azure's
 * `succeeded` is `unknown` until branch policies are evaluated. Writing that
 * over a determined `ready` / `blocked` / `conflicting` on first sight blanks
 * the card's chip for a whole sweep interval and then restores it: a flicker,
 * not news. So a resolve that meets a pending answer on a determined verdict
 * KEEPS the stored value and asks again after each of these delays; only when
 * the budget is spent does `unknown` land. That final write is what lets an
 * Azure PR that left `conflicting` clear its chip, since Azure never answers
 * anything stronger than `unknown` this pass. Bounded per task, one timer in
 * flight at a time, `unref()`'d so it never holds a quit, and cleared by the
 * refresh scheduler on project switch / shutdown.
 */
const PENDING_VERDICT_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000];
const pendingVerdictRepolls = new Map<string, { attempt: number; timer: NodeJS.Timeout | null }>();

function isDeterminedVerdict(value: PRMergeReadiness | null): boolean {
  return value === 'ready' || value === 'blocked' || value === 'conflicting';
}

function schedulePendingVerdictRepoll(taskId: string, deps: PRLinkDeps): void {
  const existing = pendingVerdictRepolls.get(taskId);
  // One in flight is enough: a sweep landing while a re-poll is pending must
  // not consume the budget or move the deadline.
  if (existing?.timer) return;
  const attempt = existing?.attempt ?? 0;
  const delay = PENDING_VERDICT_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    const entry = pendingVerdictRepolls.get(taskId);
    if (entry) entry.timer = null;
    // Forced: the re-poll must bypass the 60s coalesce that would otherwise
    // swallow it. It runs outside the task lock the scheduling resolve held.
    // A rejection never reaches the clear at the end of `linkPRForTask`, so
    // drop the entry here: an orphaned `{ attempt, timer: null }` would carry
    // a half-spent budget into the next hold for this task.
    void linkPRForTask(taskId, { ...deps, force: true }).catch((error) => {
      clearPendingVerdictRepoll(taskId);
      console.error(`[pr-linking] merge-readiness re-poll failed for task ${taskId.slice(0, 8)}:`, error);
    });
  }, delay);
  timer.unref();
  pendingVerdictRepolls.set(taskId, { attempt: attempt + 1, timer });
}

function clearPendingVerdictRepoll(taskId: string): void {
  const entry = pendingVerdictRepolls.get(taskId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingVerdictRepolls.delete(taskId);
}

/** Drop every pending merge-verdict re-poll (project switch, delete, shutdown). */
export function cancelPendingVerdictRepolls(): void {
  for (const taskId of [...pendingVerdictRepolls.keys()]) clearPendingVerdictRepoll(taskId);
}

export interface PRLinkDeps {
  tasks: TaskRepository;
  /** Repo root used as the resolver `cwd` when the task has no worktree of its own. */
  projectPath: string | null;
  /**
   * Project default base branch (from config), used to resolve the task's base
   * for the Tier-3 commits-ahead-of-base guard when `task.base_branch` is unset.
   * Falls back to 'main' when absent.
   */
  defaultBaseBranch?: string;
  /**
   * Notify the renderer that the task's PR link or state changed. Every
   * production caller routes this to the toast-free TASK_PR_LINK_CHANGED: the
   * linker only ever runs because the APP decided to reconcile, so announcing
   * it as "Task updated by agent" was both untrue and, for a sweep touching
   * several tasks, a burst of toasts. Fires on a link AND on the
   * confident-not-found clear.
   */
  onLinked: (task: Task) => void;
  /** Optional raw PTY scrollback for the degradation fallback when the resolver is unavailable. */
  getScrollback?: () => string | undefined;
  /**
   * Bypass the TTL coalesce + terminal-state skip. Set by explicit user/agent
   * actions (kebab refresh, MCP link_pr) where a fresh check is always wanted.
   */
  force?: boolean;
  /**
   * Bypass the TTL coalesce only, keeping the terminal-state skip. Set by the
   * `pr-candidate` signal: the agent's own PR command just finished, which is
   * the strongest hint there is, and it routinely lands inside the 60s window
   * an idle resolve stamped after the push that preceded it (push, turn ends,
   * `gh pr create`). Coalescing it away left the card unlinked until the next
   * idle or sweep. Unlike `force`, a merged or closed PR is still left alone:
   * a `gh pr view` on a finished PR is not news.
   */
  bypassThrottle?: boolean;
  /**
   * Suppress the confident-not-found clear. Set by link-time triggers, whose
   * whole job is to fill in the state for a link that was JUST written: a
   * resolve fired BY a write must never undo that write. A URL that resolves to
   * nothing here (typo, cross-repo, private) keeps its pill with no state chip,
   * exactly as it did before link-time resolving existed, and the non-force
   * background sweep still clears it on a later pass. An explicit "resolve now"
   * (kebab refresh, MCP link_pr) leaves this unset so it can still clear.
   */
  preserveLinkOnNotFound?: boolean;
}

/**
 * A PR linked to a task: the subset of `ResolvedPR` the linker persists. `state`
 * is nullable here (unlike `ResolvedPR.state`) because the scrollback degradation
 * fallback links url+number even when the PR's state cannot be confirmed.
 * `mergeReadiness` stays optional: `undefined` means the tier that answered
 * cannot judge it (the commit tier, a connector without the field, the
 * scrollback scraper), and the linker decides below whether that preserves the
 * stored verdict (same PR) or starts from null (a different PR).
 */
type LinkedPR = { url: string; number: number; state: PRState | null; mergeReadiness?: PRMergeReadiness };

/**
 * Told the moment Tier 6 establishes which remote branch a task's work lives
 * on, rather than carried out on the return value.
 *
 * The ladder RETHROWS a deferred degrade when no tier resolved, and a return
 * value dies with that throw. The branch identity does not depend on the
 * provider at all - a remote tip equal to HEAD, that tip not being base's, and
 * commits of the task's own are all local git state - so discarding it because
 * `gh` was missing loses it in exactly the window the capture rule exists for:
 * the CLI comes back after the task has committed past the pushed tip, and by
 * then no remote ref matches `head_sha` any more.
 */
type RecordPushedBranch = (branchName: string) => void;

/**
 * Another task on this board already holding a PR number, or already holding a
 * remote branch name as its `branch_name` or `pushed_branch`, if any. Asked by
 * the INFERRED tiers (3 and 6) before they answer, never by the per-task
 * anchors (1, 2, 4, 5). Built by `linkPRForTask` from the repository's
 * `listByPRNumber` / `listByBranchOrPushedBranch`, archived rows included (a
 * Done task keeps its link), excluding the task being resolved.
 */
type FindOtherTaskHoldingPR = (prNumber: number) => Task | undefined;
type FindOtherTaskHoldingBranch = (branchName: string) => Task | undefined;

/**
 * How many remote branches may share the task's HEAD tip before Tier 6 gives up.
 * The no-guess rule means every survivor has to be queried (short-circuiting on
 * the first hit would silently pick one of several ambiguous PRs), so this is a
 * hard multiplier on provider calls, and `az` is a Python CLI with a roughly one
 * second cold start. Three or more branches on one tip is also ambiguous enough
 * that the distinct-number check below would usually refuse to answer anyway.
 */
const MAX_TIP_BRANCH_CANDIDATES = 2;

/**
 * The confidence ladder - resolve a task's PR via the strongest available anchor
 * first, short-circuiting on the first hit:
 *   1. pr_number  -> exact, branch-independent (best for refreshing state)
 *   2. worktree HEAD branch -> the real branch while actively worked
 *   3. commit SHA -> immutable, survives Done/worktree deletion and renames
 *   4. stored slug branch -> a reclaimed worktree whose branch was captured on
 *      Done, or a no-worktree task created with a custom branch
 *   5. stored pushed branch -> the branch the agent's own `git push` named, or
 *      the name Tier 6 recorded; the one anchor a no-worktree task can earn
 *   6. remote branch at the HEAD tip -> infers that name when nothing recorded it
 * A degrade error from any tier is REMEMBERED rather than propagated, so the
 * tiers below it still run; it is rethrown unchanged only if none of them
 * resolved, and the caller degrades then. A hit at an INFERRED tier (3 or 6)
 * that another task on the board already holds, by PR number or by branch
 * name, is refused and treated as a miss (see `refusedAsHeldByAnotherTask`).
 *
 * Every anchor is git state or an explicitly stored number. A PR URL written into
 * the task DESCRIPTION is deliberately not an anchor: a URL cited as background
 * ("this follows on from <that PR's url>") is textually identical to one naming
 * the task's own PR, so scraping prose stamped citations onto unrelated tasks -
 * and because that tier always produced a link, the confident-not-found clear
 * below could never fire, making the wrong link permanent. A review task
 * names its PR through the structured `pr_url` / `pr_number` fields instead (the
 * task-detail edit form, `kangentic_create_task`, or `kangentic_update_task`),
 * which lands on Tier 1.
 */
async function resolvePRViaLadder(args: {
  task: Task;
  cwd: string;
  projectPath: string | null;
  branch: string | null;
  effectiveSha: string | null;
  baseBranch: string;
  baseBranchIsKnown: boolean;
  recordPushedBranch: RecordPushedBranch;
  findOtherTaskHoldingPR: FindOtherTaskHoldingPR;
  findOtherTaskHoldingBranch: FindOtherTaskHoldingBranch;
}): Promise<LinkedPR | null> {
  const {
    task, cwd, projectPath, branch, effectiveSha, baseBranch, baseBranchIsKnown, recordPushedBranch,
    findOtherTaskHoldingPR, findOtherTaskHoldingBranch,
  } = args;
  /**
   * The base to hand the branch resolvers for `disambiguate`'s base-match bonus.
   * Deliberately NOT `baseBranch`: that one falls back to the project default
   * and finally to 'main', and scoring a bonus against a guessed base would
   * favour the wrong PR. Only an explicit choice or an observed resolution
   * counts here; absent means no bonus, as before.
   */
  const knownBase = task.base_branch || task.resolved_base_branch || undefined;

  // A degrade at one tier must not discard the tiers below it. The registry now
  // throws when no connector OWNS the repo's remote, or when the owner has no
  // resolver of that kind, so without this a Tier-3 throw would kill Tiers 4
  // and 5 - and those are the tiers that rescue a task whose worktree is gone
  // or never existed (a captured branch, a custom branch, or the branch its
  // own push named). Errors
  // are remembered and rethrown UNCHANGED below if no tier resolves, so the
  // `instanceof` test in `linkPRForTask`'s catch still sets `degradeStatus`.
  const degrade = createDeferredDegrade();

  /**
   * The board fact git cannot see. A task fast-forwarded onto a sibling's PR
   * branch has the sibling's commits as its own HEAD: `hasOwnCommits` counts
   * them, the commit tier answers with the sibling's PR (the connector keeps a
   * lone candidate whose head does not match the hint ON PURPOSE, for the
   * "pushed my tip under another name" shape), and the remote-tip tier finds
   * the sibling's branch at that tip. Both shapes are byte-identical in git.
   * The DB separates them: the sibling links first in the normal flow, so it
   * already holds the number, and its push was captured as `pushed_branch`
   * before its PR even existed. A hit held by ANOTHER task is a miss for this
   * one: the ladder keeps descending (a refused commit hit must still let
   * Tier 5 link this task's own PR) and the confident-not-found clear still
   * applies. Asked by the inferred tiers only; the per-task anchors are never
   * refused, so two tasks that legitimately share a PR (a review task and its
   * author) both link through Tier 1. A board fact rather than a provider
   * one, so Azure gets it identically. One log line per refusal, naming both
   * tasks.
   */
  const refusedAsHeldByAnotherTask = (pr: LinkedPR, tier: 'by commit' | 'by remote tip'): boolean => {
    const holder = findOtherTaskHoldingPR(pr.number);
    if (!holder) return false;
    console.log(`[pr-linking] Refused PR #${pr.number} ${tier} for "${task.title}" (#${task.display_id}): already linked to "${holder.title}" (#${holder.display_id})`);
    return true;
  };
  const refusedAsAnotherTasksBranch = (candidate: string): boolean => {
    const holder = findOtherTaskHoldingBranch(candidate);
    if (!holder) return false;
    console.log(`[pr-linking] Refused remote branch "${candidate}" at the tip of "${task.title}" (#${task.display_id}): it belongs to "${holder.title}" (#${holder.display_id})`);
    return true;
  };

  if (task.pr_number != null) {
    const byNumber = await degrade.attempt(() => resolvePRByNumber(cwd, task.pr_number as number));
    if (byNumber) return byNumber;
  }
  if (task.worktree_path && branch) {
    const byBranch = await degrade.attempt(() => resolvePRForBranch(cwd, branch, knownBase));
    if (byBranch) return byBranch;
  }
  // Kept lazy, and its answer remembered for Tier 6's capture rule: computing it
  // eagerly would make every Tier-1/2 hit pay for a git read it never needs.
  const hasOwnCommits = effectiveSha
    ? await hasCommitsAheadOfBase(projectPath ?? cwd, baseBranch, effectiveSha)
    : false;
  // The commit tier runs only when BOTH gates agree. `hasOwnCommits` is the
  // linker's cheap early-out; `commitAnchorSelfVerifies` is the connector's own
  // declaration that a hit means the commit is that PR's work rather than
  // history it inherited. The second gate can only ever TIGHTEN the first: a
  // connector that does not declare it (or a future one that forgets) loses the
  // commit tier instead of silently relying on a base-relative check that
  // cannot see a mislink. Evaluated second so the common skip costs no
  // remote read, and given the SAME repoCwd as the dispatch it gates: the
  // remote cache keys on that path, so the two share one read rather than
  // deciding ownership from two different vantage points.
  if (effectiveSha && hasOwnCommits && (await commitAnchorSelfVerifies(projectPath ?? cwd))) {
    // Run from the main repo (projectPath) so it works even when the worktree is
    // gone. Pass the known branch as a hint so a commit shared by several PRs
    // ties back to this task (ambiguous matches resolve to null, not a guess).
    // Only run when the commit has work of its own beyond base: a fresh worktree
    // branched from base sits on base's tip (== the last-merged PR's commit), and
    // that PR is never this task's work. This also catches the single-parent
    // commits `gh pr merge --rebase`/`--squash` produce, which a parent-count
    // merge check misses.
    const byCommit = await degrade.attempt(() =>
      resolvePRByCommit(projectPath ?? cwd, effectiveSha, branch ?? undefined),
    );
    if (byCommit && !refusedAsHeldByAnotherTask(byCommit, 'by commit')) return byCommit;
  }
  if (!task.worktree_path && branch) {
    const bySlug = await degrade.attempt(() => resolvePRForBranch(cwd, branch, knownBase));
    if (bySlug) return bySlug;
  }
  // Tier 5: the branch we already established this task's work was PUSHED to,
  // when that differs from the local one. Free (no git read) and, unlike Tier 6,
  // it keeps working after the task commits past what it pushed and after the
  // remote branch is deleted, because a PR keeps its source branch name.
  if (task.pushed_branch && task.pushed_branch !== branch) {
    const byPushed = await degrade.attempt(() =>
      resolvePRForBranch(cwd, task.pushed_branch as string, knownBase),
    );
    if (byPushed) return byPushed;
  }
  // Tier 6: a REMOTE branch whose tip is EXACTLY this task's HEAD commit.
  //
  // The shape every tier above misses: the local worktree branch is the
  // Kangentic slug, the branch pushed as the PR source carries a team-convention
  // name, and nothing reconciled them. Tiers 2 and 4 query the slug and miss;
  // Tier 3 is gated off once the PR merged into base, because `rev-list --count
  // <base>..<sha>` is 0 by then. Platform-agnostic, and it is the only tier that
  // can rescue an ACTIVE Azure PR whose worktree is gone, since Azure records
  // commit associations only at completion.
  //
  // LAST on purpose, and not because a tip match is weak. It is strictly more
  // selective than Tier 3's containment match, but it is far less DEFENDED:
  // `resolvePRForBranch` hands `disambiguate` a branchHint that every returned
  // item already matches by construction, so its ambiguity escape hatch can
  // never fire, and there is no per-candidate base-history filter like the
  // commit tier's. A hit at any tier suppresses the confident-not-found clear
  // permanently, so the least-guarded tier is the one that must only ever turn a
  // not-found into a link, never displace a stronger tier's answer.
  if (effectiveSha && baseBranchIsKnown) {
    // From the MAIN repo, like the commit tier: refs/remotes lives in the common
    // ref store, so this still answers after the worktree is reclaimed on Done.
    const pointingAt = await readRefsPointingAtSha(projectPath ?? cwd, effectiveSha, baseBranch);
    // The sha is a base tip, so a fresh worktree is sitting on it and every
    // branch there belongs to whatever last landed on base. Same magnet the
    // Tier-3 guard exists to prevent, but this form keeps working after the PR
    // merges: it asks "is my sha base's TIP", not "is my sha contained in base".
    const candidates = pointingAt.pointsAtBaseTip
      ? []
      // Tiers 2, 4, and 5 already tried these; re-querying spends a round trip
      // on an answer we have.
      : pointingAt.remoteBranches.filter((name) => name !== branch && name !== task.pushed_branch);
    if (candidates.length > 0 && candidates.length <= MAX_TIP_BRANCH_CANDIDATES) {
      const hits: Array<{ candidate: string; pr: LinkedPR }> = [];
      for (const candidate of candidates) {
        const hit = await degrade.attempt(() =>
          resolvePRForBranch(cwd, candidate, knownBase),
        );
        if (hit) hits.push({ candidate, pr: hit });
      }
      // Every survivor is queried rather than short-circuiting on the first hit:
      // two branches on one tip carrying two different PRs is ambiguous, and a
      // wrong link here is permanent. Same rule `disambiguate` applies when
      // nothing ties the candidates back to this task. The holder refusals come
      // AFTER the distinct check on purpose: an ambiguous pair never consults
      // the board, and a refused sole hit stays in `hits`, so the record-only
      // path below cannot see an empty list and store the sibling's branch.
      if (
        new Set(hits.map((hit) => hit.pr.number)).size === 1
        && !refusedAsAnotherTasksBranch(hits[0].candidate)
        && !refusedAsHeldByAnotherTask(hits[0].pr, 'by remote tip')
      ) {
        recordPushedBranch(hits[0].candidate);
        return hits[0].pr;
      }
      // No PR yet, but the identity is still worth recording: the agent pushes
      // the branch BEFORE opening the PR, and if we wait for a PR to appear the
      // task may commit past the pushed tip first, after which no remote ref
      // matches head_sha and this tier goes quiet for good.
      //
      // Two gates on THIS path. `hasOwnCommits` excludes the follow-on shape
      // against a MERGED neighbour: a task cut from another task's branch with
      // zero commits sits on that branch's tip, and once the neighbour merged
      // the count is 0. It is base-relative, so it is blind to a neighbour that
      // has NOT merged: a follower fast-forwarded onto a sibling's unmerged
      // branch counts the sibling's commits as its own (the incident this
      // guard was written for: 2 ahead of main, none of them the task's). The
      // holder refusal covers that half from the board side, refusing a
      // candidate another task recorded as its branch. The link path above is
      // gated by `pointsAtBaseTip` plus the two holder refusals; without the
      // DB it could still link a zero-commit task to a neighbour branch that
      // merged by squash or rebase (its tip contained in base without being
      // base's tip). Hoisting `hasOwnCommits` up to the link path is not the
      // fix: for a merged neighbour every discriminator built from "commits
      // ahead of base" or "is the PR merged" is already true in exactly the
      // bad case, and the hoist costs the merged-PR rescue this tier exists
      // for. Reviewers keep proposing it.
      //
      // The condition is also only as sound as `baseBranch`, which is why the
      // base is recorded at worktree creation.
      if (
        hits.length === 0 && candidates.length === 1 && hasOwnCommits
        && !refusedAsAnotherTasksBranch(candidates[0])
      ) {
        recordPushedBranch(candidates[0]);
      }
    }
  }
  // Nothing resolved: a tier that could not CHECK outranks the tiers that
  // merely missed, so the caller degrades instead of clearing the link. Note
  // this throws PAST any return value, which is why the branch identity above
  // is reported through `recordPushedBranch` rather than returned.
  const pendingDegrade = degrade.pending();
  if (pendingDegrade) throw pendingDegrade;
  return null;
}

/**
 * Resolve a task's PR and persist it - the single backbone all triggers funnel
 * through. Wrapped in `withTaskLock` because it crosses an await boundary and
 * mutates per-task state (see .claude/rules/task-lifecycle-lock.md). Writes only on change.
 *
 * Also opportunistically persists the worktree HEAD SHA so the commit anchor is
 * available later, after the worktree is reclaimed on Done.
 */
export async function linkPRForTask(taskId: string, deps: PRLinkDeps): Promise<PRLinkResult> {
  return withTaskLock(taskId, async (): Promise<PRLinkResult> => {
    const task = deps.tasks.getById(taskId);
    if (!task) {
      // A task deleted mid-hold still fires its re-poll timer; nothing below
      // runs, so the entry it left behind is dropped here rather than lingering
      // until the next project switch clears every re-poll at once.
      clearPendingVerdictRepoll(taskId);
      return { status: 'no-anchor', task: null };
    }

    // Auto triggers: skip terminal PRs (merged/closed can't change) and coalesce
    // rapid re-resolves. Explicit user/agent actions (force) always run fresh;
    // the PR-command signal (bypassThrottle) skips only the coalesce.
    if (!deps.force) {
      if (task.pr_state === 'merged' || task.pr_state === 'closed') {
        return { status: 'unchanged', task };
      }
      const last = lastResolveAt.get(taskId);
      if (!deps.bypassThrottle && last != null && Date.now() - last < RESOLVE_TTL_MS) {
        return { status: 'unchanged', task };
      }
    }
    const resolveNow = Date.now();
    // Prune entries past the throttle window before recording this one. An
    // entry older than RESOLVE_TTL_MS no longer coalesces anything, so the map
    // can stay bounded to tasks resolved in the last minute instead of growing
    // for the life of the process across every task ever resolved.
    for (const [id, ts] of lastResolveAt) {
      if (resolveNow - ts >= RESOLVE_TTL_MS) lastResolveAt.delete(id);
    }
    lastResolveAt.set(taskId, resolveNow);

    const cwd = task.worktree_path ?? deps.projectPath;

    // Live worktree HEAD (branch + sha) when a worktree exists.
    let worktreeBranch: string | null = null;
    let freshSha: string | null = null;
    if (task.worktree_path) {
      const head = await readWorktreeHead(task.worktree_path);
      worktreeBranch = head.branch;
      freshSha = head.sha;
    }
    const branch = worktreeBranch ?? task.branch_name;
    const effectiveSha = freshSha ?? task.head_sha;
    // `resolved_base_branch` sits between the user's explicit choice and the
    // project default on purpose: it is the base this task's worktree was
    // OBSERVED to be cut from, so it is right where `base_branch` is null (most
    // tasks) and the project default would otherwise be a guess. That guess is
    // what made the commits-ahead-of-base guard unsound for a worktree cut from
    // a long-lived integration branch.
    // `||` all the way down, matching `resolveEffectiveBaseBranch`. `??` would
    // let an empty string from any layer win, and an empty base silently
    // disables the base-tip bail: none of its three ref forms can match
    // `refs/heads/` or `refs/remotes/<remote>/` with nothing after the prefix,
    // so a fresh worktree on base's tip would stop bailing and Tier 6 would
    // magnet onto whatever last landed on base. No writer produces `''` today;
    // this is here so none can.
    const baseBranch = task.base_branch || task.resolved_base_branch || deps.defaultBaseBranch || 'main';

    // Nothing to resolve from at all. Mirrors `autoLinkPRForTask`'s gate: a task
    // with no stored number and no git state has no anchor, whatever its
    // description happens to mention. `pushed_branch` counts: for a task with
    // no worktree it is the only anchor the app can record (from the agent's
    // own push), and Tier 5 needs no worktree to resolve from it.
    if (!cwd || (task.pr_number == null && !branch && !effectiveSha && !task.pushed_branch)) {
      // Still persist a freshly-read SHA if we have one (rare: detached HEAD worktree).
      if (freshSha && freshSha !== task.head_sha) {
        return { status: 'no-anchor', task: deps.tasks.update({ id: task.id, head_sha: freshSha }) };
      }
      return { status: 'no-anchor', task };
    }

    let next: LinkedPR | null = null;
    // When the resolver could not actually check (gh missing/unauth, or a
    // transient network/5xx/timeout), record the degraded status so we report
    // the real reason and never overwrite an existing link with "not found".
    let degradeStatus: 'resolver-unavailable' | 'transient-error' | undefined;
    let degradeMessage: string | undefined;
    /**
     * An UNEXPECTED exception escaped the ladder. "An owning connector ran
     * cleanly" is false in that case, so the confident-not-found clear below
     * must not fire: without this flag a resolver bug silently wipes the task's
     * PR link, and so would a future regression in `readRemoteUrls`'s
     * never-rejects contract.
     */
    let resolveFailed = false;
    /** Branch identity Tier 6 established, persisted alongside `head_sha`. */
    let discoveredPushedBranch: string | null = null;

    try {
      const found = await resolvePRViaLadder({
        task, cwd, projectPath: deps.projectPath, branch, effectiveSha, baseBranch,
        // Deliberately WIDER than `knownBase` above, which refuses the project
        // default. The two answer different questions. `knownBase` decides
        // whether to SCORE a base-match bonus, where a guess actively favours
        // the wrong PR; this decides whether the base-tip bail has anything at
        // all to measure against, where a guess that is right (one base named
        // `main`, which is the overwhelming majority) makes the bail work and a
        // guess that is wrong leaves it no worse than not running.
        //
        // Do NOT narrow this to match `knownBase`. It reads like the obviously
        // consistent thing to do and it makes the whole tier inert: the task
        // this was written for has `base_branch` NULL and predates
        // `resolved_base_branch`, so it would never reach Tier 6 at all. The
        // residual that narrowing would close is documented in
        // docs/pr-integration.md and is not closable this way, because a task
        // sitting on a long-lived branch's tip is byte-identical in git to one
        // sitting on its own pushed tip.
        // Falsy, not nullish, so this agrees with `baseBranch` above on what
        // counts as a base. Under `!= null` an empty string at any layer would
        // report the base as KNOWN while `baseBranch` itself fell through to the
        // hardcoded 'main', and Tier 6 would then measure its bail against a
        // branch nothing here was cut from. Same reason that line is `||`: no
        // writer produces '' today, and this keeps the two from disagreeing if
        // one ever does. It does NOT narrow the three layers, which the note
        // above forbids.
        baseBranchIsKnown: Boolean(
          task.base_branch || task.resolved_base_branch || deps.defaultBaseBranch,
        ),
        // Assigned as Tier 6 discovers it, so a deferred degrade rethrown out of
        // the ladder still leaves the identity here to persist below.
        recordPushedBranch: (branchName) => { discoveredPushedBranch = branchName; },
        // "Another task" is a board fact, so it is read from the repository
        // rather than from git. The task's own row is excluded so a task
        // re-confirming its own number by commit is never refused.
        findOtherTaskHoldingPR: (prNumber) =>
          deps.tasks.listByPRNumber(prNumber).find((other) => other.id !== task.id),
        findOtherTaskHoldingBranch: (branchName) =>
          deps.tasks.listByBranchOrPushedBranch(branchName).find((other) => other.id !== task.id),
      });
      if (found) next = { url: found.url, number: found.number, state: found.state, mergeReadiness: found.mergeReadiness };
    } catch (error) {
      if (error instanceof PRResolverUnavailableError || error instanceof PRResolverTransientError) {
        degradeStatus = error instanceof PRResolverTransientError ? 'transient-error' : 'resolver-unavailable';
        degradeMessage = error.message;
        // Degrade to the scrollback scraper (url+number only; preserve a known
        // state when the URL is unchanged). Merge readiness is left undefined:
        // the same-PR rule below preserves it exactly as the state is preserved
        // here, and nulls it when the scrape names a different PR.
        const scraped = deps.getScrollback ? detectPR(deps.getScrollback() ?? '') : null;
        if (scraped) {
          next = { url: scraped.url, number: scraped.number, state: scraped.url === task.pr_url ? task.pr_state : null };
        }
        if (degradeStatus === 'resolver-unavailable' && !resolverUnavailableHintsShown.has(error.message)) {
          if (resolverUnavailableHintsShown.size >= MAX_RESOLVER_HINTS) {
            const oldestHint = resolverUnavailableHintsShown.keys().next();
            if (!oldestHint.done) resolverUnavailableHintsShown.delete(oldestHint.value);
          }
          resolverUnavailableHintsShown.add(error.message);
          console.warn(`[pr-linking] ${error.message}\nPR auto-linking is degraded to terminal scraping until a PR resolver is available.`);
        }
      } else {
        resolveFailed = true;
        console.error(`[pr-linking] resolve failed for task ${taskId.slice(0, 8)}:`, error);
      }
    }

    // Merge readiness has three rules of its own, none of which `pr_state`
    // needs, because every tier can determine a state and not every tier can
    // determine readiness:
    //  - PRESERVE on undetermined. A tier whose connector cannot judge it (the
    //    commit tier on both providers, the scrollback scraper) says nothing
    //    about the stored verdict, so `undefined` keeps it: the `pushed_branch`
    //    rule below, applied to a column. A link that moved to a DIFFERENT PR
    //    starts from null instead, since the old verdict describes the old PR.
    //  - HOLD through a pending answer (see `PENDING_VERDICT_RETRY_DELAYS_MS`):
    //    a platform `unknown` on a determined verdict of the SAME open PR keeps
    //    the stored value and schedules a bounded re-poll; only when the budget
    //    is spent does `unknown` land. A terminal PR is never held: the chip
    //    does not render readiness there, and GitHub never recomputes it.
    //  - Everything else writes, including `unknown` over null, so "asked, no
    //    verdict yet" is recorded and distinguishable from never checked.
    const samePr = next != null && next.url === task.pr_url && next.number === task.pr_number;
    const holdsPendingVerdict = next != null
      && next.mergeReadiness === 'unknown'
      && samePr
      && (next.state === 'open' || next.state === 'draft')
      && isDeterminedVerdict(task.pr_merge_readiness)
      && (pendingVerdictRepolls.get(taskId)?.attempt ?? 0) < PENDING_VERDICT_RETRY_DELAYS_MS.length;
    let nextMergeReadiness: PRMergeReadiness | null;
    if (next == null) {
      nextMergeReadiness = task.pr_merge_readiness;
    } else if (next.mergeReadiness === undefined || holdsPendingVerdict) {
      nextMergeReadiness = samePr ? task.pr_merge_readiness : null;
    } else {
      nextMergeReadiness = next.mergeReadiness;
    }

    // Build a single update for any changed PR fields and/or the freshly-read SHA.
    const patch: TaskUpdateInput = { id: task.id };
    const prChanged = next != null
      && (task.pr_url !== next.url || task.pr_number !== next.number || task.pr_state !== next.state
        || task.pr_merge_readiness !== nextMergeReadiness);
    if (prChanged && next) {
      patch.pr_url = next.url;
      patch.pr_number = next.number;
      patch.pr_state = next.state;
      patch.pr_merge_readiness = nextMergeReadiness;
    }
    // Confident not-found: the resolver ran cleanly (no transient / unavailable
    // degrade) and matched no PR, yet the task still carries a link. Clear it so
    // a stale `merged` (or any orphaned link) never lingers - pr_number, pr_url,
    // pr_state, and pr_merge_readiness always agree, written atomically in the
    // same update below. A degraded resolve never clears (the link is preserved,
    // as before), and neither does a link-time resolve
    // (`preserveLinkOnNotFound`), which would otherwise undo the very write that
    // triggered it.
    const hadLink = task.pr_number != null || task.pr_url != null || task.pr_state != null
      || task.pr_merge_readiness != null;
    const prCleared = next == null && !degradeStatus && !resolveFailed && hadLink && !deps.preserveLinkOnNotFound;
    if (prCleared) {
      patch.pr_url = null;
      patch.pr_number = null;
      patch.pr_state = null;
      patch.pr_merge_readiness = null;
    }
    const shaChanged = freshSha != null && freshSha !== task.head_sha;
    if (shaChanged) patch.head_sha = freshSha;
    // Never cleared here, only corrected: a resolve that simply did not reach
    // Tier 6 (a Tier-1 hit, a base-tip bail) says nothing about whether the
    // recorded branch is still right. Cleanup paths null it with `branch_name`.
    const pushedBranchChanged = discoveredPushedBranch != null && discoveredPushedBranch !== task.pushed_branch;
    if (pushedBranchChanged) patch.pushed_branch = discoveredPushedBranch;

    let updatedTask = task;
    if (prChanged || prCleared || shaChanged || pushedBranchChanged) {
      updatedTask = deps.tasks.update(patch);
    }
    // A held verdict re-asks on a timer; any other outcome (a determined
    // verdict, a preserve, a clear, a miss) ends the hold and drops the budget.
    if (holdsPendingVerdict) {
      schedulePendingVerdictRepoll(taskId, deps);
    } else {
      clearPendingVerdictRepoll(taskId);
    }
    if (prChanged && next) {
      const readinessNote = nextMergeReadiness ? `, merge ${nextMergeReadiness}` : '';
      console.log(`[pr-linking] Linked PR #${next.number} (${next.state ?? 'unknown'}${readinessNote}) to "${task.title}": ${next.url}`);
      // Adoption signal on a real or refreshed link only: the automatic sweeps
      // that return early above and the stale-link clear below are not uses.
      // Main dedups to once per day.
      trackFeatureUsed('pull_request');
      deps.onLinked(updatedTask);
    } else if (prCleared) {
      console.log(`[pr-linking] Cleared stale PR link from "${task.title}" (no PR resolves for its branch)`);
      deps.onLinked(updatedTask);
    }

    if (!next && degradeStatus) {
      return { status: degradeStatus, task: updatedTask, message: degradeMessage };
    }
    if (!next) {
      return { status: 'not-found', task: updatedTask };
    }
    return { status: prChanged ? 'linked' : 'unchanged', task: updatedTask };
  });
}

interface LinkPROptions {
  projectId?: string | null;
  taskId?: string;
  sessionId?: string;
  branchName?: string;
  scrollback?: string;
  /** Bypass the TTL coalesce + terminal-skip (explicit user/agent refresh). */
  force?: boolean;
  /** Bypass the TTL coalesce only (the `pr-candidate` signal; see `PRLinkDeps`). */
  bypassThrottle?: boolean;
  /** Keep a link the resolver could not match (see `PRLinkDeps`). */
  preserveLinkOnNotFound?: boolean;
}

/**
 * The project's default base branch for the ladder's base-relative guards.
 * Board default first, then the effective config, matching
 * `resolveEffectiveBaseBranch` (ipc/helpers/task-git.ts), which is what decides
 * the base a worktree is actually cut from. Reading the config alone reported
 * `main` for a project whose kangentic.json says `develop`, so the linker
 * measured against a base no worktree here was ever cut from. Only reachable
 * for a task with neither `base_branch` nor `resolved_base_branch`, since both
 * outrank this.
 *
 * `||`, not `??`, to match `resolveEffectiveBaseBranch` exactly: an empty
 * string in either layer has to fall through to the next one. Under `??` it
 * would win, and an empty base defeats the base-tip bail outright, since none
 * of its three ref forms can match `refs/heads/` or `refs/remotes/<remote>/`
 * with nothing after the prefix.
 */
function resolveProjectDefaultBaseBranch(context: IpcContext, projectPath: string | null): string | undefined {
  try {
    return projectPath
      ? context.boardConfigManager.getDefaultBaseBranchForPath(projectPath)
        || context.configManager.getEffectiveConfig(projectPath).git.defaultBaseBranch
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the branch a session's own `git push` named as its destination onto
 * the session's task, as `pushed_branch`.
 *
 * This is the per-task PR anchor for a task with no worktree: every other
 * anchor is written from a worktree read, and the shared checkout's HEAD is
 * not per task (three concurrent no-worktree tasks share it). The push command
 * belongs to exactly one session, so its destination belongs to exactly one
 * task. Tier 5 then resolves the PR from it with no git read at all.
 *
 * Recorded only; nothing resolves from here. The push precedes the PR, and a
 * non-force resolve now would stamp the 60s per-task throttle that the
 * `pr-candidate` resolve seconds later would then be coalesced by.
 *
 * Refused for three names. The task's own local branch is Tier 2's / Tier 4's
 * anchor already (and `pushed_branch` is documented as "when that differs").
 * The stored `pushed_branch` is a no-op. The task's effective base is the one
 * name that could link WRONGLY: a merge-back's `git push origin HEAD:develop`
 * would otherwise make Tier 5 answer with the base branch's own PR.
 *
 * The patch is only `{ id, pushed_branch }` against a row re-read under the
 * task lock, so it cannot clobber a concurrent PR-link write.
 */
export async function recordPushedBranchForSession(
  context: IpcContext,
  sessionId: string,
  branch: string,
): Promise<void> {
  const projectId = context.sessionManager.getSessionProjectId(sessionId) ?? context.currentProjectId;
  if (!projectId) return;
  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, projectId);
  } catch {
    return;
  }
  const { tasks } = repos;
  const task = tasks.getBySessionId(sessionId);
  if (!task) return;

  const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
  const defaultBaseBranch = resolveProjectDefaultBaseBranch(context, projectPath);

  await withTaskLock(task.id, async () => {
    const fresh = tasks.getById(task.id);
    if (!fresh) return;
    const effectiveBase = fresh.base_branch || fresh.resolved_base_branch || defaultBaseBranch;
    if (branch === fresh.branch_name || branch === fresh.pushed_branch || branch === effectiveBase) return;
    tasks.update({ id: fresh.id, pushed_branch: branch });
  });
}

/**
 * IPC-side wrapper around `linkPRForTask`: resolves the project + task (by id,
 * else live session, else branch name) and wires the renderer notification.
 * Mapping by branch/session means exited or suspended sessions and human-created
 * PRs still link.
 */
export async function linkPR(context: IpcContext, options: LinkPROptions): Promise<PRLinkResult> {
  const projectId = options.projectId
    ?? (options.sessionId ? context.sessionManager.getSessionProjectId(options.sessionId) : null)
    ?? context.currentProjectId;
  if (!projectId) return { status: 'no-anchor', task: null };

  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, projectId);
  } catch {
    return { status: 'no-anchor', task: null };
  }
  const { tasks } = repos;

  const task = options.taskId ? tasks.getById(options.taskId)
    : options.sessionId ? tasks.getBySessionId(options.sessionId)
    : options.branchName ? tasks.getByBranchName(options.branchName)
    : undefined;
  if (!task) return { status: 'no-anchor', task: null };

  const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
  const defaultBaseBranch = resolveProjectDefaultBaseBranch(context, projectPath);

  return linkPRForTask(task.id, {
    tasks,
    projectPath,
    defaultBaseBranch,
    force: options.force,
    bypassThrottle: options.bypassThrottle,
    preserveLinkOnNotFound: options.preserveLinkOnNotFound,
    getScrollback: options.scrollback != null ? () => options.scrollback : undefined,
    onLinked: (linked) => {
      // Quiet channel, not TASK_UPDATED_BY_AGENT. Every caller that reaches
      // here is the app reconciling a PR link on its own: the refresh sweep,
      // `autoLinkPRForTask`, a `pr-candidate` scrollback hit, or the task-detail
      // "Link / refresh PR" control (which already toasts off this call's own
      // return value, so the push would only duplicate it). Announcing those as
      // "Task updated by agent" was both untrue and, for a sweep that changed
      // several tasks, a burst of toasts. An agent's own tool call still goes
      // out on TASK_UPDATED_BY_AGENT from the command context.
      //
      // Covers the `prCleared` branch above too: noticing a stale link is the
      // same kind of housekeeping.
      sendToRenderer(context.mainWindow, IPC.TASK_PR_LINK_CHANGED, projectId);
      // Unchanged: the monitor and the mobile bridge's board-event bus consume
      // this, and they still need to hear a PR link change.
      context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [linked.id] });
    },
  });
}

/**
 * Fire-and-forget best-effort auto-resolve of a task's PR, gated on the task
 * being in a post-To Do lane (To Do resets the task, so there is no PR to link
 * there). Keeps platform logic in the connector; here we only gate on having a
 * branch/worktree and a non-To Do lane.
 *
 * The shared auto-link entry point for every implicit trigger: a task-move
 * (called from inside `handleTaskMove`'s own announce block, which runs after
 * every one of its task locks has released, so the timing is unchanged from
 * when each call site fired this itself), and a session going idle (a PR was
 * likely just created). The move case now covers all four origins, including
 * the agent and mobile ones that never reached here before.
 * All run NON-force, so the per-task 60s throttle in `linkPRForTask` coalesces
 * them.
 */
export function autoLinkPRForTask(context: IpcContext, taskId: string, projectId: string | null): void {
  try {
    const { tasks, swimlanes } = getProjectRepos(context, projectId);
    const task = tasks.getById(taskId);
    if (
      !task
      || (!task.branch_name && !task.worktree_path && !task.head_sha && !task.pushed_branch && task.pr_number == null)
    ) return;
    const lane = swimlanes.getById(task.swimlane_id);
    if (!lane || lane.role === 'todo') return;
    void linkPR(context, { projectId, taskId }).catch((error) => {
      console.error(`[pr-linking] post-move resolve failed for task ${taskId.slice(0, 8)}:`, error);
    });
  } catch {
    // Best-effort; never block a move on PR resolution.
  }
}
