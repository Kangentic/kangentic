/**
 * GitHub PR connector - resolves PRs via the `gh` CLI and detects PR URLs from
 * terminal output.
 *
 * Detects from:
 * - `gh pr create` stdout: bare URL on a line
 * - `gh pr view` TTY mode: "View this pull request on GitHub: <url>"
 * - `gh pr view` non-TTY: "url:\t<url>"
 * - `gh pr view --json` output containing URL in JSON value
 *
 * Does NOT match:
 * - `git push` output: /pull/new/branch-name (no numeric ID)
 * - `gh pr merge` output: owner/repo#123 (no full URL)
 */

import PQueue from 'p-queue';
import type {
  PRConnector,
  DetectedPR,
  ResolvedPR,
  PRState,
  PRMergeReadiness,
  PRResolveOptions,
  PRCheck,
  PRChecks,
} from '../../shared/pr-connector';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../shared/pr-errors';
import { stripLogTimestamp, tailRawLog } from '../../shared/ci-log-tail';
import {
  GitHubImporter,
  GhUnavailableError,
  GhTransientError,
  type GhPrListItem,
  type GhMergeable,
  type GhMergeStateStatus,
  type GhCheckRunStatus,
  type GhCheckRunConclusion,
  type GhStatusState,
  type GhStatusCheckRollupItem,
  type GhRulesetBypassMode,
} from '../../../boards/adapters/github-common/gh-client';
import { isShaContainedInRef } from '../../../git/worktree-head';
import { firstGitHubRemote, buildGitHubCommitWebUrl } from './github-remote';

/**
 * Shared gh client for authoritative PR resolution. Reuses the same binary
 * detection + auth plumbing as the board importer; detection is cached on the
 * instance, so a module-level singleton avoids re-probing `gh` per call.
 */
const ghImporter = new GitHubImporter();

/**
 * Global cap on concurrent `gh` subprocesses across ALL tasks. Each ladder tier
 * is a `gh` spawn (~hundreds of ms + an API round-trip); without this, a
 * multi-card drag or board-load burst could fan out into dozens of concurrent
 * processes and stall the event loop / burn the GitHub rate limit.
 */
const GH_CONCURRENCY = 3;
const ghQueue = new PQueue({ concurrency: GH_CONCURRENCY });

/**
 * Run a gh-backed resolve through the global concurrency limiter, translating the
 * GitHub-specific errors into the platform-agnostic ones so the generic layer
 * (`pr-linking.ts`) never imports a provider-specific error type.
 */
async function viaGh<T>(fn: () => Promise<T>): Promise<T> {
  return ghQueue.add(async () => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GhUnavailableError) throw new PRResolverUnavailableError(error.message);
      if (error instanceof GhTransientError) throw new PRResolverTransientError(error.message);
      throw error;
    }
  }) as Promise<T>;
}

/** Map GitHub's API state (OPEN/CLOSED/MERGED + isDraft) to our normalized PRState. */
function mapState(item: GhPrListItem): PRState {
  if (item.state === 'MERGED') return 'merged';
  if (item.state === 'CLOSED') return 'closed';
  return item.isDraft ? 'draft' : 'open';
}

/**
 * Fold GitHub's mergeability triple into the normalized verdict, or undefined
 * when the item carries none (the commit tier's REST payload). The promise is
 * "a Merge click would succeed", read literally: UNSTABLE is `ready` because the
 * button works with failing NON-required checks (required ones report BLOCKED
 * instead), and a `ready` verdict is downgraded to `blocked` only when a review
 * is still REQUIRED. CHANGES_REQUESTED is deliberately not a downgrade: where
 * reviews are required GitHub already reports BLOCKED, and where they are not
 * the button works, so calling it `blocked` would break the promise.
 * `mergeable` is the fallback when `mergeStateStatus` is absent or a value this
 * code does not know. `reviewDecision` is compared against the one named value:
 * gh renders a null decision as ''.
 *
 * BLOCKED is the one state the triple cannot tell apart: a required check
 * still running, a required check that failed, and a review still required all
 * report it. The check rollup splits them (see `classifyRollup`): a failed
 * check reads `failing`, and a check in flight wins over a required review on
 * purpose, so the chip tracks CI while it runs and flips to `blocked` when only
 * the review remains. UNSTABLE with a failed check reads `failing` too, the one
 * departure from the literal Merge-button promise: red means "an agent can fix
 * this" on the chip. A failed check never yields to a running one, and a required check the rollup does not
 * carry yet reads `queued` (`requiredContextMissing`). BEHIND takes the same branch, for the reason
 * `isBypassClearableMergeState` gives: it is the value GitHub reports INSTEAD
 * of BLOCKED once the base moves, so reading the rollup for one and not the
 * other would make the chip flip on a merge somebody else did.
 *
 * `bypass` is what the viewer's own merge bypass came to (see `bypassFor`, for
 * the two signals it reads), and the verdict is read for the VIEWER: the board's
 * Merge column merges a green PR past its missing review with
 * `gh pr merge --admin`, so for a viewer who can do that the literal promise is
 * `ready`. It folds at
 * BOTH sites where branch protection alone would block (the
 * `isBypassClearableMergeState` branch and the `ready` downgrade) and only
 * there, under the conditions `bypassClearsTheBlock` names. DRAFT and DIRTY
 * never fold. Azure DevOps has no counterpart: its bypass is a
 * security-namespace permission, out of scope.
 */
function mapMergeReadiness(
  item: GhPrListItem,
  bypass: ViewerBypass | null,
  requiredContexts: string[] | null,
): PRMergeReadiness | undefined {
  if (item.mergeStateStatus === undefined && item.mergeable === undefined) return undefined;
  if (isBypassClearableMergeState(item.mergeStateStatus)) {
    const rollup = classifyRollup(item.statusCheckRollup);
    // A failed check is something an agent can fix, so it reads `failing`
    // rather than `blocked` (a review wait), and it outranks a running check:
    // nothing still running can unblock one that already failed.
    if (rollup === 'failed') return 'failing';
    if (rollup === 'running' || rollup === 'queued') return rollup;
    // A required check the rollup does not carry at all is one GitHub is
    // still waiting on (see `requiredContextMissing`), so the PR is queued on
    // CI, not blocked by it. A failure already returned above.
    if (requiredContextMissing(item.statusCheckRollup, requiredContexts)) return 'queued';
    return bypassClearsTheBlock(item, bypass) ? 'ready' : 'blocked';
  }
  // UNSTABLE is a failing NON-required check. GitHub would merge it, but the
  // check still failed and an agent can still fix it, so the chip says so.
  if (item.mergeStateStatus === 'UNSTABLE' && classifyRollup(item.statusCheckRollup) === 'failed') return 'failing';
  const verdict = mapMergeStateStatus(item.mergeStateStatus) ?? mapMergeable(item.mergeable);
  if (verdict !== 'ready' || item.reviewDecision !== 'REVIEW_REQUIRED') return verdict;
  return bypassClearsTheBlock(item, bypass) ? 'ready' : 'blocked';
}

/**
 * Whether the viewer's bypass would really merge this PR right now: they can
 * bypass, every block this code can see is one branch protection imposes
 * (`isBlockedOnlyByProtection`), and every check branch protection REQUIRES has
 * reported green (`requiredChecksReported`). All three, because the bypass is
 * a capability rather than a state - it reads `true` on a red PR too.
 */
function bypassClearsTheBlock(item: GhPrListItem, bypass: ViewerBypass | null): boolean {
  if (bypass?.canBypass !== true) return false;
  if (!isBlockedOnlyByProtection(item)) return false;
  return requiredChecksReported(item.statusCheckRollup, bypass.requiredContexts);
}

/**
 * Whether every block the PR's own fields can show is one branch protection
 * imposes and `--admin` lifts: the review is still required, the merge state is
 * one the bypass clears (`isBypassClearableMergeState`, or a `ready` state the
 * downgrade would catch), and every check in the rollup has settled green.
 * Shared by the fold and by the probe gate, so the two cannot drift apart.
 *
 * Named for protection rather than for the review because BEHIND carries a
 * second block, a base the branch fell behind, and the same bypass clears it.
 *
 * Not sufficient on its own, which is what `requiredChecksReported` adds: a
 * `passing` rollup is "nothing here failed", not "everything required ran".
 */
function isBlockedOnlyByProtection(item: GhPrListItem): boolean {
  if (item.reviewDecision !== 'REVIEW_REQUIRED') return false;
  if (!isBypassClearableMergeState(item.mergeStateStatus) && mapMergeStateStatus(item.mergeStateStatus) !== 'ready') return false;
  return classifyRollup(item.statusCheckRollup) === 'passing';
}

/**
 * The merge states `gh pr merge --admin` clears, and so the only two the bypass
 * fold may act on. Both name a condition branch protection imposes: BLOCKED is
 * a required review or check outstanding, BEHIND is a base the branch fell
 * behind where protection requires branches to be up to date.
 *
 * They are ONE predicate because GitHub reports a single `mergeStateStatus` for
 * a PR that is in both conditions at once, and which one it names is decided by
 * whether a sibling PR landed: a green, review-required PR reads BLOCKED until
 * one does and BEHIND immediately after. Splitting them made the chip flip
 * `ready` to `blocked` because somebody else merged, with nothing about the PR
 * itself changing, which is the bug this exists to fix.
 *
 * DRAFT is the author's own switch, not protection, and DIRTY is a real
 * conflict no permission resolves, so neither ever folds. There is deliberately
 * no "does the base require up-to-date branches" condition: GitHub only reports
 * BEHIND where it does, so the condition would be a no-op, and where it somehow
 * did not, being behind would not block the merge at all - which makes folding
 * more obviously right, not less.
 */
function isBypassClearableMergeState(mergeStateStatus: GhMergeStateStatus | undefined): boolean {
  return mergeStateStatus === 'BLOCKED' || mergeStateStatus === 'BEHIND';
}

/**
 * Whether every context the base branch's protection requires is present in
 * the rollup AND passing.
 *
 * This closes the one gap `classifyRollup` cannot see. A required check GitHub
 * still EXPECTS is absent from the rollup entirely, so an all-green rollup can
 * still be missing required checks, and this repo hits that on every PR it
 * opens: the CLA workflow finishes in seconds while CI's runs have not been
 * created yet, leaving a rollup of one green check on a PR whose CI has not
 * started. Without this the fold would read `ready` there. The required list
 * costs nothing extra - it rides the bypass probe's own call.
 *
 * `null` means no list could be read, which on a fold happens only for an admin
 * viewer on a branch with no classic rule. Fall back to the rollup alone rather
 * than refusing every fold on such a repo: that is the behaviour without this
 * check, not a new hazard. The ruleset path always passes a list, because it
 * reads the contexts its rulesets require (`rulesetBypassFor`).
 *
 * The join is by NAME, and its failure direction is deliberate. A required
 * context for an Actions check is the job name, which is the rollup's
 * `CheckRun.name` (measured: this repo's five required contexts match its
 * rollup entries exactly). An integration that registers a context under some
 * other string would read as a required check missing, so the fold refuses and
 * the chip stays `blocked` - the verdict without this check, never a false
 * `ready`.
 */
function requiredChecksReported(
  rollup: GhStatusCheckRollupItem[] | undefined,
  requiredContexts: string[] | null,
): boolean {
  if (requiredContexts === null) return true;
  const passing = passingContextNames(rollup);
  return requiredContexts.every((context) => passing.has(context));
}

/**
 * Whether a context the base branch requires is absent from the rollup
 * entirely, in any state. That is how a just-opened PR looks while CI is
 * starting: its fast CLA workflow is green and CI's workflow has not created
 * its runs yet, so the rollup holds one check and GitHub reports BLOCKED. On
 * the sweep's cadence the card read `blocked` for minutes, and a verdict that
 * is not in flight never starts the linker's 30 s re-poll, so a CI run that
 * finished inside one sweep interval left the card up to a whole interval
 * behind. Reporting `queued` here is also the honest label: GitHub's own page
 * shows the check as "Expected, waiting for status to be reported".
 *
 * The join is by name, and it is the join GitHub itself makes: a required
 * context is satisfied only by a check run or status with that name. So a
 * context missing here is one GitHub is waiting on too. A required check that
 * never reports (a path-filtered workflow, a check only a merge queue runs)
 * therefore reads `queued` for as long as GitHub reads it as expected; the
 * linker's re-poll budget bounds what that costs. `null` (no readable rule) is
 * never missing anything, which keeps a ruleset repo on the verdict it had.
 */
function requiredContextMissing(
  rollup: GhStatusCheckRollupItem[] | undefined,
  requiredContexts: string[] | null,
): boolean {
  if (requiredContexts === null || requiredContexts.length === 0) return false;
  const present = new Set<string>();
  for (const item of rollup ?? []) {
    if (item.__typename === 'CheckRun') present.add(item.name);
    else if (item.__typename === 'StatusContext') present.add(item.context);
  }
  return requiredContexts.some((context) => !present.has(context));
}

/**
 * Names of the rollup entries that individually PASSED. Every caller reaches
 * this only for a `passing` rollup, where that is every entry, but reading per
 * entry keeps the comparison above correct if that gate is ever loosened.
 */
function passingContextNames(rollup: GhStatusCheckRollupItem[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const item of rollup ?? []) {
    if (item.__typename === 'CheckRun') {
      if (item.status === 'COMPLETED' && item.conclusion !== null && PASSING_CHECK_RUN_CONCLUSIONS.has(item.conclusion)) {
        names.add(item.name);
      }
    } else if (item.__typename === 'StatusContext' && item.state === 'SUCCESS') {
      names.add(item.context);
    }
  }
  return names;
}

/**
 * CheckRun conclusions and StatusContext states that mean the check has FAILED,
 * so the merge stays blocked. Typed on the gh unions rather than `string` so a
 * misspelled member fails `tsc` instead of silently never matching.
 */
const FAILED_CHECK_RUN_CONCLUSIONS: ReadonlySet<GhCheckRunConclusion> = new Set<GhCheckRunConclusion>([
  'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
]);
const FAILED_STATUS_STATES: ReadonlySet<GhStatusState> = new Set<GhStatusState>(['ERROR', 'FAILURE']);
/** CheckRun statuses short of IN_PROGRESS that still mean the check has not run yet. */
const WAITING_CHECK_RUN_STATUSES: ReadonlySet<GhCheckRunStatus> = new Set<GhCheckRunStatus>([
  'QUEUED', 'PENDING', 'WAITING', 'REQUESTED',
]);
const WAITING_STATUS_STATES: ReadonlySet<GhStatusState> = new Set<GhStatusState>(['PENDING', 'EXPECTED']);
/**
 * Conclusions that count as a check having PASSED for the bypass fold. STALE
 * and a null conclusion are neither failed nor passed, so a rollup carrying
 * one is `inconclusive` and never folds.
 */
const PASSING_CHECK_RUN_CONCLUSIONS: ReadonlySet<GhCheckRunConclusion> = new Set<GhCheckRunConclusion>([
  'SUCCESS', 'NEUTRAL', 'SKIPPED',
]);

/**
 * What a PR's check rollup says about its checks, highest precedence first:
 * `failed` when ANY check has failed (a failure is what blocks, whatever else
 * is running), `running` when a check run is IN_PROGRESS, `queued` when the
 * only unfinished ones are waiting to start, `passing` when the rollup is
 * non-empty and every entry settled green, and `inconclusive` for everything
 * else: an absent or empty rollup, a completed run with a STALE or null
 * conclusion, or a status, state, or typename this code does not know.
 *
 * `running` / `queued` are the in-flight answers a BLOCKED PR shows instead of
 * `blocked`; `passing` is the ONLY class the bypass fold accepts, and
 * `inconclusive` is deliberately not it. An absent rollup has a concrete
 * meaning here: a required check GitHub still EXPECTS but that has not
 * reported yet is not in the rollup at all, so an empty rollup is "checks
 * about to start", not "no checks".
 *
 * A heuristic, because `gh` carries no `isRequired` on the rollup: a BLOCKED
 * PR whose only unfinished checks are optional reads `running` too, which
 * corrects itself on the next resolve. A required check not yet in the rollup
 * is caught separately, against the branch's required list
 * (`requiredContextMissing`), and reads `queued`; only a branch with no
 * readable rule (rulesets) still reads `blocked` there until CI reports. `passing` is the class that heuristic
 * would make dangerous - a fast workflow can be green before a slower one has
 * created its runs at all - so the bypass fold does not trust it alone and
 * compares against the branch's required contexts (`requiredChecksReported`).
 */
type RollupVerdict = 'failed' | 'running' | 'queued' | 'passing' | 'inconclusive';

function classifyRollup(rollup: GhStatusCheckRollupItem[] | undefined): RollupVerdict {
  if (!rollup || rollup.length === 0) return 'inconclusive';
  let running = false;
  let waiting = false;
  let allPassing = true;
  for (const item of rollup) {
    if (item.__typename === 'CheckRun') {
      if (item.status === 'COMPLETED') {
        if (item.conclusion !== null && FAILED_CHECK_RUN_CONCLUSIONS.has(item.conclusion)) return 'failed';
        if (item.conclusion === null || !PASSING_CHECK_RUN_CONCLUSIONS.has(item.conclusion)) allPassing = false;
      } else if (item.status === 'IN_PROGRESS') {
        running = true;
      } else if (WAITING_CHECK_RUN_STATUSES.has(item.status)) {
        waiting = true;
      } else {
        allPassing = false;
      }
    } else if (item.__typename === 'StatusContext') {
      if (FAILED_STATUS_STATES.has(item.state)) return 'failed';
      if (WAITING_STATUS_STATES.has(item.state)) {
        waiting = true;
      } else if (item.state !== 'SUCCESS') {
        allPassing = false;
      }
    } else {
      allPassing = false;
    }
  }
  if (running) return 'running';
  if (waiting) return 'queued';
  return allPassing ? 'passing' : 'inconclusive';
}

/**
 * Whether the bypass probe can change this item's verdict at all, which is
 * the gate `git.prBypassCountsAsReady` opens. Only an open, non-draft PR still
 * waiting on a required review is worth the GraphQL call: a draft never renders
 * readiness, a merged or closed PR never changes, a failed or in-flight check
 * keeps `blocked` whatever the bypass says, and a green PR with no review
 * outstanding is blocked by something the bypass is not being asked about -
 * which is why an already-approved BEHIND PR does not fold either.
 *
 * Never one probe per open PR per check, which is why the setting can default
 * on. What bounds it is the review-plus-green gate, NOT the merge-state value:
 * admitting BEHIND beside BLOCKED does not add a population, it stops the same
 * PRs dropping out of the gate each time a sibling lands. The probe is
 * uncached, so the cost is one `gh api graphql` per qualifying linked PR per
 * check: about every 2 minutes per PR with `git.prAutoRefresh` on, inside the
 * refresh queue's one-call-per-10-s cap (the 60 s `RESOLVE_TTL_MS` coalesce is
 * shorter than that interval, so it does not lower the rate). If that rate
 * ever matters, the mitigation is a per-base-ref memo of
 * `requiredStatusCheckContexts`; `viewerCanMergeAsAdmin` is per-PR and would
 * still cost a call. The ruleset reads a non-admin viewer falls through to are
 * already memoized per base (`rulesetBypassFor`).
 */
function needsBypassProbe(item: GhPrListItem, options: PRResolveOptions | undefined): boolean {
  return options?.bypassCountsAsReady === true
    && item.state === 'OPEN'
    && !item.isDraft
    && isBlockedOnlyByProtection(item);
}

/**
 * What the viewer's merge bypass comes to for one item: whether they can bypass
 * at all, and the checks that must still have reported green before it counts.
 * `requiredContexts` null means no list could be read, which
 * `requiredChecksReported` answers with the rollup alone.
 */
interface ViewerBypass {
  canBypass: boolean;
  requiredContexts: string[] | null;
}

const CANNOT_BYPASS: ViewerBypass = { canBypass: false, requiredContexts: null };

/**
 * The viewer's merge bypass for one chosen item, or null when the probe is not
 * warranted (see `needsBypassProbe`) or gave no answer. Called INSIDE the
 * caller's `viaGh` slot, never through a `viaGh` of its own: `ghQueue` allows
 * three concurrent slots, and a nested `add` awaited from inside a running
 * slot would let three overlapping resolves hold every slot while each waits
 * on a queued child that can never start. A `null` answer (any probe failure)
 * is "no bypass known", so the verdict stays GitHub's own `blocked`.
 *
 * Two signals, because neither covers both kinds of protection.
 * `viewerCanMergeAsAdmin` is right for classic protection and answers `false`
 * for a ruleset's named bypass actors (measured: GitHub's own page offers such a
 * user the bypass merge while the field reads `false`). The ruleset signal
 * cannot see classic protection at all, so it only runs where the branch has no
 * classic rule. A branch under both keeps `blocked` for a non-admin: a bypassable
 * ruleset does not lift a review that classic protection also requires.
 */
async function bypassFor(
  item: GhPrListItem,
  repoCwd: string,
  options: PRResolveOptions | undefined,
): Promise<ViewerBypass | null> {
  if (!needsBypassProbe(item, options)) return null;
  const probe = await ghImporter.resolveMergeBypass(repoCwd, item.number);
  if (probe === null) return null;
  if (probe.viewerCanMergeAsAdmin) {
    return { canBypass: true, requiredContexts: probe.requiredStatusCheckContexts };
  }
  if (!probe.branchHasNoClassicRule) return CANNOT_BYPASS;
  return rulesetBypassFor(item, repoCwd);
}

/**
 * Required-context lists per repo and base branch. Protection rules change
 * rarely and the list is per BRANCH, so one answer serves every PR on that
 * base: without the cache, every sweep would spend a GraphQL call per
 * BLOCKED-and-settled PR, and the linker's in-flight re-poll one per 30 s.
 * Keyed by the PR's repo URL, not the cwd, so a task's worktree and the main
 * checkout share an entry. A failed read is not cached, so the next resolve
 * asks again. Bounded, evicting the oldest entry.
 */
const BASE_RULE_CACHE_TTL_MS = 10 * 60_000;
const MAX_BASE_RULE_CACHE_ENTRIES = 32;
const requiredChecksByBase = new Map<string, { contexts: string[] | null; fetchedAt: number }>();

/**
 * How long a failed ruleset read is remembered: about one refresh interval, so
 * every PR on a base shares one failed read per sweep instead of each spending
 * its own. A transient failure holds `blocked` that long, which is GitHub's own
 * verdict.
 */
const RULESET_FAILED_READ_TTL_MS = 2 * 60_000;

/**
 * `rulesetBypassFor`'s answer per repo and base branch, with the bound of
 * `requiredChecksByBase`. The answer is the viewer's, so a revoked bypass or a
 * `gh auth switch` can read stale until the entry expires. That only touches the
 * chip: the merge itself still has to succeed.
 */
const rulesetBypassByBase = new Map<string, { bypass: ViewerBypass; expiresAt: number }>();

/** Drop every per-base cached answer. Tests only: the caches are module-level. */
export function resetBaseRuleCachesForTests(): void {
  requiredChecksByBase.clear();
  rulesetBypassByBase.clear();
}

/**
 * The per-base cache key: the PR's repo URL, so a task's worktree and the main
 * checkout share an entry, then the base branch.
 */
function baseCacheKey(item: GhPrListItem, repoCwd: string): string {
  const repoKey = item.url.replace(/\/pull\/\d+$/, '') || repoCwd;
  return `${repoKey}\n${item.baseRefName}`;
}

/**
 * Store `entry`, dropping this key's expired entry first, so it does not count
 * against the bound and evict an unrelated base, and so the refresh lands newest.
 */
function rememberForBase<T>(cache: Map<string, T>, cacheKey: string, entry: T): void {
  cache.delete(cacheKey);
  if (cache.size >= MAX_BASE_RULE_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(cacheKey, entry);
}

/**
 * Whether the required-context list can change this item's verdict: an open,
 * non-draft PR in a merge state the rollup decides (`isBypassClearableMergeState`)
 * whose rollup has not already answered. A failed check keeps `blocked`, and an
 * in-flight one already reads `running` / `queued`, so neither spends a call.
 */
function needsRequiredChecks(item: GhPrListItem): boolean {
  if (item.state !== 'OPEN' || item.isDraft || !item.baseRefName) return false;
  if (!isBypassClearableMergeState(item.mergeStateStatus)) return false;
  const rollup = classifyRollup(item.statusCheckRollup);
  return rollup === 'passing' || rollup === 'inconclusive';
}

/**
 * The base branch's required contexts for `item`, from the cache or one
 * `resolveRequiredStatusChecks` call, or null when the read is not warranted,
 * failed, or found no readable rule. Called INSIDE the caller's `viaGh` slot,
 * never through a nested `add`, for the deadlock reason `bypassFor` gives.
 */
async function requiredChecksFor(item: GhPrListItem, repoCwd: string): Promise<string[] | null> {
  if (!needsRequiredChecks(item)) return null;
  const cacheKey = baseCacheKey(item, repoCwd);
  const now = Date.now();
  const cached = requiredChecksByBase.get(cacheKey);
  if (cached && now - cached.fetchedAt < BASE_RULE_CACHE_TTL_MS) return cached.contexts;
  const answer = await ghImporter.resolveRequiredStatusChecks(repoCwd, item.baseRefName);
  if (answer === null) return null;
  rememberForBase(requiredChecksByBase, cacheKey, { contexts: answer.contexts, fetchedAt: now });
  return answer.contexts;
}

/**
 * The `current_user_can_bypass` values that mean the viewer may bypass. `never`
 * and null do not, and neither does a value GitHub adds later.
 */
const BYPASSING_MODES: ReadonlySet<GhRulesetBypassMode | null> = new Set<GhRulesetBypassMode>([
  'always', 'pull_requests_only', 'exempt',
]);

/**
 * Whether the viewer can bypass all of `rulesetIds`, or null when a read failed.
 * One at a time inside the caller's slot: running them together would spawn more
 * `gh` children than `ghQueue` allows, and the first refusal settles the answer.
 */
async function canBypassEveryRuleset(rulesetIds: number[], repoCwd: string): Promise<boolean | null> {
  for (const rulesetId of rulesetIds) {
    const answer = await ghImporter.resolveRulesetBypass(repoCwd, rulesetId);
    if (answer === null) return null;
    if (!BYPASSING_MODES.has(answer.currentUserCanBypass)) return false;
  }
  return true;
}

/**
 * The viewer's bypass of the rulesets on `item`'s base branch, for a branch with
 * no classic rule. `canBypass` needs at least one ruleset carrying a
 * `pull_request` rule, since that is the block being cleared, and EVERY ruleset
 * that can stop a merge bypassable, because each one blocks it on its own. That
 * covers a `merge_queue` or `required_deployments` rule in a ruleset the viewer
 * cannot bypass, beside a review ruleset they can (`mergeBlockingRulesetIds`).
 *
 * `requiredContexts` is what the rulesets require, which is what keeps the fold
 * honest. A ruleset repo has no classic list, so without it the fold would trust
 * the rollup alone, and a fast check going green before a slower workflow has
 * created its runs would read a false `ready`.
 *
 * Runs inside the caller's `viaGh` slot, for the deadlock reason `bypassFor`
 * gives. Any failed read is `CANNOT_BYPASS`, so the verdict stays GitHub's
 * `blocked`, and is remembered for `RULESET_FAILED_READ_TTL_MS`.
 */
async function rulesetBypassFor(item: GhPrListItem, repoCwd: string): Promise<ViewerBypass> {
  const cacheKey = baseCacheKey(item, repoCwd);
  const now = Date.now();
  const cached = rulesetBypassByBase.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.bypass;
  const answer = await readRulesetBypass(item.baseRefName, repoCwd);
  const bypass = answer ?? CANNOT_BYPASS;
  const lifetime = answer === null ? RULESET_FAILED_READ_TTL_MS : BASE_RULE_CACHE_TTL_MS;
  rememberForBase(rulesetBypassByBase, cacheKey, { bypass, expiresAt: now + lifetime });
  return bypass;
}

/** What the rulesets on `baseRefName` come to for the viewer, or null when a read failed. */
async function readRulesetBypass(baseRefName: string, repoCwd: string): Promise<ViewerBypass | null> {
  const rules = await ghImporter.resolveBranchRules(repoCwd, baseRefName);
  if (rules === null) return null;
  const requiredContexts = rules.requiredStatusCheckContexts;
  if (rules.pullRequestRulesetIds.length === 0) return { canBypass: false, requiredContexts };
  const canBypass = await canBypassEveryRuleset(rules.mergeBlockingRulesetIds, repoCwd);
  return canBypass === null ? null : { canBypass, requiredContexts };
}

/**
 * The un-folded meaning of each state, and only that: `mapMergeReadiness` sends
 * both of `isBypassClearableMergeState`'s values through the check rollup before
 * this switch runs, so neither reaches it from either caller.
 *
 * BLOCKED has no case because it has no meaning on its own - a running check, a
 * failed check, and a required review all report it. BEHIND keeps its case even
 * though the fold now covers it too: unlike BLOCKED it means one definite thing,
 * and dropping it would leave a future caller falling through to `mapMergeable`
 * and answering `unknown` for a PR that is plainly blocked.
 */
function mapMergeStateStatus(mergeStateStatus: GhMergeStateStatus | undefined): PRMergeReadiness | undefined {
  switch (mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return 'ready';
    case 'BEHIND':
    case 'DRAFT':
      return 'blocked';
    case 'DIRTY':
      return 'conflicting';
    case 'UNKNOWN':
      return 'unknown';
    default:
      // Absent or unrecognized: fall back to `mergeable`.
      return undefined;
  }
}

function mapMergeable(mergeable: GhMergeable | undefined): PRMergeReadiness {
  return mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
}

/**
 * Project a raw gh PR item into the platform-agnostic ResolvedPR shape.
 * `bypass` and `requiredContexts` are what `bypassFor` and `requiredChecksFor`
 * answered for THIS item; the commit tier passes null for both, since its
 * items carry no mergeability at all.
 */
function toResolvedPR(item: GhPrListItem, bypass: ViewerBypass | null, requiredContexts: string[] | null): ResolvedPR {
  const mergeReadiness = mapMergeReadiness(item, bypass, requiredContexts);
  return {
    url: item.url,
    number: item.number,
    state: mapState(item),
    baseRefName: item.baseRefName,
    updatedAt: item.updatedAt,
    // Conditional spread, not `mergeReadiness: undefined`: an absent key is what
    // "this tier cannot judge it" looks like to the linker and to exact-shape tests.
    ...(mergeReadiness === undefined ? {} : { mergeReadiness }),
  };
}

/**
 * Pick the best PR from a candidate list for inferred (branch- or commit-based)
 * resolution, guarding against mislinks:
 *   - drop fork (cross-repository) PRs - an inferred match on a shared branch name
 *     or commit is never reliably this task's PR (resolveByNumber bypasses this
 *     guard, since an explicit number is unambiguous),
 *   - when a `branchHint` is given, restrict to PRs whose head ref matches it;
 *     if none match and the list is ambiguous (>1), return null rather than guess,
 *   - then prefer open/draft over merged/closed, then a matching base branch,
 *     then the most recently updated.
 */
function disambiguate(items: GhPrListItem[], opts: { baseBranch?: string; branchHint?: string } = {}): GhPrListItem | null {
  const { baseBranch, branchHint } = opts;
  let pool = items.filter((item) => !item.isCrossRepository);
  if (pool.length === 0) return null;

  if (branchHint) {
    const matching = pool.filter((item) => item.headRefName === branchHint);
    if (matching.length > 0) {
      pool = matching;
    } else if (pool.length > 1) {
      // Multiple PRs contain the commit and none is on this task's branch -> don't guess.
      return null;
    }
  }

  const score = (item: GhPrListItem): number => {
    let value = 0;
    if (item.state === 'OPEN') value += 100;
    if (baseBranch && item.baseRefName === baseBranch) value += 10;
    return value;
  };
  return [...pool].sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    if (scoreDelta !== 0) return scoreDelta;
    return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  })[0];
}

/**
 * Drop every candidate whose OWN base branch already contains the commit we
 * resolved from. `gh api commits/<sha>/pulls` returns every PR whose head branch
 * contains the commit, which includes a sibling PR that merely branched off the
 * same base tip: its head contains the commit only as inherited base history,
 * never as its own work. That is the mislink - a task whose worktree has no
 * commits of its own sits on the base tip and magnets onto whichever open
 * sibling shares it.
 *
 * This generalizes the `mergeCommitOid` filter below from the last-merged PR to
 * any PR sharing base history, and asks the question against the CANDIDATE's
 * known base rather than the task's often-unknown one (a worktree cut from a
 * non-default branch never records a base, which is what made the linker's
 * commits-ahead-of-base guard unsound). `baseRefName` already rides along on the
 * REST response, so there is no extra API call.
 *
 * Two candidates are deliberately kept:
 *
 * - **MERGED.** A merged PR's own commits ARE in its base afterwards, so
 *   containment cannot tell "this task's work, now merged" from "inherited base
 *   history", and rejecting would clear a correct link (a task on a non-default
 *   base whose own PR landed via a real merge commit). The merged shape is
 *   already covered by the `mergeCommitOid` filter. Every other state has at
 *   least one commit between base and head, so containment there proves the
 *   commit is not that PR's work.
 * - **Undetermined** (`null`: the base ref was never fetched locally). Fall back
 *   to the `branchHint` rule in `disambiguate`, so an unfetched ref costs a
 *   mislink guard rather than an existing badge.
 *
 *   KNOWN GAP, not a settled trade-off: because this filter runs before
 *   `disambiguate`, dropping a proven-contained sibling can leave a
 *   kept-undetermined candidate as the LONE survivor, which then slips past the
 *   hint rule's ambiguity guard (it only returns null when MORE than one
 *   non-matching candidate remains). A candidate never verified as its own work
 *   can therefore win a comparison that previously returned null. Deciding
 *   whether an undetermined survivor should still count toward that threshold is
 *   open; see docs/integrations/pull-requests/github.md.
 *
 * The probes are memoized per base ref and awaited sequentially on purpose: this
 * runs inside a `ghQueue` slot, so the cost is throughput, not a deadlock. The
 * git read queue caps EXECUTION at 2 whatever we do here, so a `Promise.all`
 * could not defeat that cap; what it would do is submit every probe at once and
 * deepen that shared queue (up to `GH_CONCURRENCY` resolves can be in flight),
 * delaying the other USER-priority readers on it such as the Done-move confirm
 * probe. Awaiting sequentially holds this call to one slot at a time.
 */
async function dropCandidatesSharingBaseHistory(
  repoCwd: string,
  commitSha: string,
  items: GhPrListItem[],
): Promise<GhPrListItem[]> {
  const containmentByBaseRef = new Map<string, Promise<boolean | null>>();
  const survivors: GhPrListItem[] = [];
  for (const item of items) {
    if (item.state === 'MERGED' || !item.baseRefName) {
      survivors.push(item);
      continue;
    }
    let containment = containmentByBaseRef.get(item.baseRefName);
    if (!containment) {
      containment = isShaContainedInRef(repoCwd, item.baseRefName, commitSha);
      containmentByBaseRef.set(item.baseRefName, containment);
    }
    if ((await containment) !== true) survivors.push(item);
  }
  return survivors;
}

/**
 * Strip all common terminal escape sequences:
 * - CSI sequences: ESC [ ... letter  (colors, cursor, etc.)
 * - OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \  (hyperlinks, title)
 * - Two-byte sequences: ESC + single char  (e.g. ESC M reverse index)
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;
const GITHUB_PR_URL_PATTERN = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g;

/** Maximum bytes to scan from the end of scrollback for performance. */
const SCAN_WINDOW = 4096;

export const gitHubPRConnector: PRConnector = {
  name: 'GitHub',
  // `gh api commits/<sha>/pulls` returns every PR whose head branch CONTAINS
  // the commit, so ownership is not free here - it is established client-side,
  // by the `mergeCommitOid` check and `dropCandidatesSharingBaseHistory` below.
  // The KNOWN GAP documented on that filter (a kept-undetermined lone survivor)
  // is a narrowing of this claim, not a refutation: it needs an un-fetched base
  // ref, and it degrades to the `branchHint` rule rather than to no check.
  verifiesCommitOwnership: true,

  /**
   * Any host label containing `github`, not the literal `github.com`, so a
   * GitHub Enterprise host such as `github.mycorp.com` keeps resolving.
   *
   * KNOWN GAP: GHE hosted on a name with no `github` in it (`ghe.corp.example`)
   * no longer resolves PRs. Before the ownership gate this connector ran on
   * every remote and would have tried; the failure is now at least diagnosable,
   * because the thrown message names the unmatched remote URL. A per-project
   * list of extra hosts is the follow-up.
   */
  matchesRemote(remoteUrls: readonly string[]): boolean {
    return remoteUrls.some((url) => /(^|\/\/|@)[^/:@]*github[^/:@]*[:/]/i.test(url));
  },

  commitWebUrl(remoteUrls: readonly string[], sha: string): string | null {
    const remote = firstGitHubRemote(remoteUrls);
    return remote ? buildGitHubCommitWebUrl(remote, sha) : null;
  },

  matchesCommand(commandDetail: string): boolean {
    return /^gh\s+pr\s+(create|view|merge)/.test(commandDetail);
  },

  extract(scrollback: string): DetectedPR | null {
    if (!scrollback) return null;

    // Only scan the tail of the scrollback for performance
    const tail = scrollback.length > SCAN_WINDOW
      ? scrollback.slice(-SCAN_WINDOW)
      : scrollback;

    // Strip ANSI escape sequences so color codes don't break matching
    const clean = tail.replace(ANSI_ESCAPE_PATTERN, '');

    // Find all matches and return the last one (most recent)
    let lastMatch: DetectedPR | null = null;
    let match: RegExpExecArray | null;

    GITHUB_PR_URL_PATTERN.lastIndex = 0;
    while ((match = GITHUB_PR_URL_PATTERN.exec(clean)) !== null) {
      lastMatch = {
        url: match[0],
        number: parseInt(match[1], 10),
      };
    }

    return lastMatch;
  },

  // `options.bypassCountsAsReady` is read in `bypassFor`. Branch policy needs
  // nothing extra here: GitHub's verdict already carries it through
  // `mergeStateStatus` and `reviewDecision` on the same call.
  async resolveForBranch(
    repoCwd: string,
    branchName: string,
    baseBranch?: string,
    options?: PRResolveOptions,
  ): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const items = await ghImporter.resolvePRByBranch(repoCwd, branchName);
      // Every item already matches head=branchName; the hint also drops fork PRs
      // that share the branch name.
      const best = disambiguate(items, { baseBranch, branchHint: branchName });
      if (!best) return null;
      // The bypass is probed for the ONE chosen candidate, after
      // disambiguation, so a branch shared by several PRs costs one call.
      return toResolvedPR(best, await bypassFor(best, repoCwd, options), await requiredChecksFor(best, repoCwd));
    });
  },

  async resolveByNumber(repoCwd: string, prNumber: number, options?: PRResolveOptions): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const item = await ghImporter.resolvePRByNumber(repoCwd, prNumber);
      // Explicit number lookup is unambiguous: a PR number is unique within the repo,
      // so there is no cross-repo collision risk. Unlike resolveForBranch/resolveByCommit
      // (which drop fork PRs because a fork can share a branch name or commit), trusting a
      // fork PR here is safe - the caller already named the exact PR.
      if (!item) return null;
      return toResolvedPR(item, await bypassFor(item, repoCwd, options), await requiredChecksFor(item, repoCwd));
    });
  },

  async resolveByCommit(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const items = await ghImporter.resolvePRByCommit(repoCwd, commitSha);
      // Drop any PR whose merge product IS the commit we resolved from. A fresh
      // worktree branched from base sits on base's tip, which is the last-merged
      // PR's merge/squash/rebase commit - that commit is shared base history, not
      // this task's work, and `gh api commits/{sha}/pulls` would otherwise magnet
      // the task onto a sibling's merged PR. (An open PR's `merge_commit_sha` is a
      // synthetic test-merge that can never equal a real authored commit, so a
      // task's own PR is never dropped here.) This is the merged half of the
      // backstop for the linker's commits-ahead-of-base guard, which misfires when
      // the task's base branch is wrong or unknown; the filter below covers the
      // rest.
      const candidates = items.filter((item) => item.mergeCommitOid !== commitSha);
      // Then drop any sibling PR that merely branched off the same base tip: its
      // head branch contains the commit as inherited base history, not as work of
      // its own. Runs on the smaller pool, and filters BEFORE disambiguation so a
      // genuine runner-up can still win.
      const survivors = await dropCandidatesSharingBaseHistory(repoCwd, commitSha, candidates);
      // The commit can still belong to several PRs (shared/squashed commits); the
      // branch hint ties it back to this task and ambiguous matches return null.
      const best = disambiguate(survivors, { branchHint });
      // No bypass probe: these items carry no mergeability fields (the REST
      // commit-pulls payload), so the verdict is omitted whatever the setting.
      return best ? toResolvedPR(best, null, null) : null;
    });
  },

  async listChecks(repoCwd: string, prNumber: number): Promise<PRChecks | null> {
    return viaGh(async () => {
      const pr = await ghImporter.viewPullRequestChecks(repoCwd, prNumber);
      if (!pr) return null;
      return { checks: normalizeRollupChecks(pr.statusCheckRollup ?? []), checksPageUrl: `${pr.url}/checks` };
    });
  },

  async fetchCheckLog(repoCwd: string, _prNumber: number, check: PRCheck, maxChars: number): Promise<string | null> {
    const jobId = actionsJobId(check.url);
    if (!jobId) return null;
    return viaGh(async () => {
      const raw = await ghImporter.viewJobFailedLog(repoCwd, jobId);
      if (raw === null) return null;
      return tailRawLog(raw, stripActionsLogPrefix, maxChars);
    });
  },
};

/**
 * The Actions job id in a check run's `detailsUrl`
 * (`.../actions/runs/<run>/job/<job id>`), which is the id `gh run view --job`
 * takes. Null for any other check app's page, which has no log gh can read.
 */
export function actionsJobId(detailsUrl: string): string | null {
  const match = /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(detailsUrl);
  return match ? match[1] : null;
}

/**
 * One `gh run view --log-failed` line without its columns: the job name, the
 * step name (often `UNKNOWN STEP`), a byte-order mark on the first line of a
 * step, and the ISO timestamp. What is left is the line the runner printed.
 */
export function stripActionsLogPrefix(line: string): string {
  const columns = line.split('\t');
  return stripLogTimestamp(columns.length >= 3 ? columns.slice(2).join('\t') : line);
}

/** The host of a check's page, which tells two check apps apart when neither has a workflow. */
function detailsHost(detailsUrl: string | undefined): string {
  if (!detailsUrl) return '';
  try {
    return new URL(detailsUrl).host;
  } catch {
    return '';
  }
}

/**
 * The rollup as the Checks list shows it: one row per check, a re-run replacing
 * the run it superseded (same app, workflow and name, the later `startedAt`
 * kept; GitHub keeps both in the rollup), each folded into the four normalized
 * statuses with the same conclusion sets the merge verdict uses.
 */
export function normalizeRollupChecks(rollup: GhStatusCheckRollupItem[]): PRCheck[] {
  const latest = new Map<string, { item: GhStatusCheckRollupItem; startedAt: string }>();
  for (const item of rollup) {
    let key: string;
    if (item.__typename === 'CheckRun') key = `run\u0000${detailsHost(item.detailsUrl)}\u0000${item.workflowName ?? ''}\u0000${item.name}`;
    else if (item.__typename === 'StatusContext') key = `status\u0000${item.context}`;
    else continue;
    const startedAt = item.startedAt ?? '';
    const seen = latest.get(key);
    if (!seen || startedAt > seen.startedAt) latest.set(key, { item, startedAt });
  }
  const checks: PRCheck[] = [];
  for (const { item } of latest.values()) {
    if (item.__typename === 'CheckRun') {
      const url = item.detailsUrl ?? '';
      const jobId = actionsJobId(url);
      checks.push({
        id: jobId ?? `${item.workflowName ?? ''}/${item.name}`,
        name: item.name,
        group: item.workflowName || null,
        url,
        status: checkRunStatus(item.status, item.conclusion),
        hasLog: jobId !== null,
      });
    } else {
      checks.push({
        id: `status/${item.context}`,
        name: item.context,
        group: null,
        url: item.targetUrl ?? '',
        status: statusContextStatus(item.state),
        hasLog: false,
      });
    }
  }
  return checks;
}

function checkRunStatus(status: GhCheckRunStatus, conclusion: GhCheckRunConclusion | null): PRCheck['status'] {
  if (status !== 'COMPLETED') return 'pending';
  if (conclusion === null) return 'pending';
  if (FAILED_CHECK_RUN_CONCLUSIONS.has(conclusion)) return 'failed';
  if (conclusion === 'SKIPPED' || conclusion === 'STALE') return 'skipped';
  return 'passed';
}

function statusContextStatus(state: GhStatusState): PRCheck['status'] {
  if (FAILED_STATUS_STATES.has(state)) return 'failed';
  if (state === 'SUCCESS') return 'passed';
  return 'pending';
}
