/**
 * Azure DevOps PR connector - resolves PRs via the `az` CLI (the `azure-devops`
 * extension, plus two `az rest` calls: the commit tier's `pullrequestquery`
 * and the policy evaluations that decide whether a clean merge preview is
 * `ready`) and detects PR URLs from terminal output.
 *
 * Detects `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`
 * and the legacy `https://{org}.visualstudio.com/...` spelling of the same.
 *
 * Does NOT match a `/_git/{repo}` repo URL, a `/_workitems/edit/{id}` work-item
 * URL, or the `/pullrequestcreate` compose page - none of them names a PR.
 *
 * TIER COVERAGE, which differs from GitHub in one way worth knowing: Azure
 * records a PR's commit associations at COMPLETION, so `resolveByCommit`
 * matches completed PRs only. A task with an ACTIVE PR whose stored branch is
 * not the PR's source branch therefore gets nothing from the commit tier. That
 * is a property of the Azure API, not of this code.
 *
 * An earlier version of this note called that gap narrow because "active PRs
 * normally still have a live worktree". That was wrong twice over. A live
 * worktree rescues the branch tier only when the live branch IS the PR's source
 * branch, which is exactly what fails when an agent pushes under a team
 * convention while the worktree stays on the Kangentic slug. And a task reaches
 * Done with its PR still open routinely: `deleteTaskWorktree` nulls
 * `worktree_path` on that move, and `pr-refresh.ts` treats linked-but-worktree-
 * less as an ordinary refresh case.
 *
 * The ladder's last tier closes most of it without any help from this connector:
 * it finds the remote branch whose tip is the task's HEAD and resolves it BY
 * BRANCH, which Azure supports, instead of by commit, which it does not.
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
  AzureDevOpsImporter,
  AzUnavailableError,
  AzTransientError,
  type AzurePrItem,
  type AzurePolicyEvaluation,
} from '../../../boards/adapters/azure-devops/client';
import { readRemoteUrls } from '../../../git/git-remotes';
import { stripAnsiControlCodes } from '../../../../shared/ansi-strip';
import {
  firstAzureRemote,
  buildAzurePrWebUrl,
  buildAzureCommitWebUrl,
  buildAzureBuildResultsUrl,
  type AzureRemote,
} from './azure-remote';

/**
 * Shared az client. Reuses the board importer's binary detection and error
 * classification; detection is cached on the instance, so a module-level
 * singleton avoids re-probing `az` per call.
 */
const azImporter = new AzureDevOpsImporter();

/**
 * Global cap on concurrent `az` subprocesses across ALL tasks. Lower than the
 * GitHub connector's 3 on purpose: `az` is a Python CLI with a roughly
 * one-second cold start where `gh` is a Go binary that starts in milliseconds,
 * so the same fan-out costs far more wall-clock here.
 */
const AZ_CONCURRENCY = 2;
const azQueue = new PQueue({ concurrency: AZ_CONCURRENCY });

/**
 * Run an az-backed resolve through the limiter, translating the Azure-specific
 * errors into the platform-agnostic ones so the generic layer (`pr-linking.ts`)
 * never imports a provider-specific error type.
 */
async function viaAz<T>(operation: () => Promise<T>): Promise<T> {
  return azQueue.add(async () => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AzUnavailableError) throw new PRResolverUnavailableError(error.message);
      if (error instanceof AzTransientError) throw new PRResolverTransientError(error.message);
      throw error;
    }
  }) as Promise<T>;
}

/**
 * The policy verdict for one chosen item, or undefined when the policy call
 * is not warranted (see `needsPolicyEvaluation`). Called INSIDE the caller's
 * `viaAz` slot, never through a `viaAz` of its own: `azQueue` allows two
 * concurrent slots, and a nested `add` awaited from inside a running slot
 * would let two overlapping resolves hold both slots while each waits on a
 * queued child that can never start.
 */
async function policyVerdictFor(
  item: AzurePrItem,
  remote: AzureRemote,
): Promise<PRMergeReadiness | undefined> {
  if (!needsPolicyEvaluation(item)) return undefined;
  return foldPolicyEvaluations(
    await azImporter.resolvePolicyEvaluations(remote.org, item.projectId, item.number),
  );
}

/**
 * The Azure org/project/repo for this checkout, or null when the repo is not
 * hosted on Azure DevOps.
 *
 * Returning null rather than throwing is load-bearing. Registering this
 * connector must not degrade PR linking on GitHub repos: a throw here would set
 * `degradeStatus` in `pr-linking.ts`, which permanently suppresses the
 * confident-not-found clear, so every GitHub task on a machine without `az`
 * would keep a stale PR link forever and report a resolver failure for tasks
 * that simply have no PR. `readRemoteUrls` is cached, so this costs no extra
 * subprocess per tier.
 */
async function remoteFor(repoCwd: string): Promise<AzureRemote | null> {
  const remoteUrls = await readRemoteUrls(repoCwd);
  return remoteUrls ? firstAzureRemote(remoteUrls) : null;
}

/** Map Azure's status + isDraft to the normalized PRState. */
function mapState(item: AzurePrItem): PRState {
  if (item.state === 'completed') return 'merged';
  if (item.state === 'abandoned') return 'closed';
  return item.isDraft ? 'draft' : 'open';
}

/**
 * Azure policy types whose evaluation waits on PEOPLE rather than on a runner:
 * "Minimum number of reviewers" and "Required reviewers". Both report `queued`
 * while approvals are outstanding, which is a waiting review, not a check in
 * flight, so it folds to `blocked` exactly as GitHub's `REVIEW_REQUIRED` does.
 * Every other blocking evaluation still `queued` / `running` (Build, Status,
 * Automatic Copilot code review, ...) is a check in flight. Type ids are fixed
 * across organizations (`_apis/policy/types`).
 */
const REVIEWER_POLICY_TYPE_IDS: ReadonlySet<string> = new Set([
  'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
  'fd2167ab-b0be-447a-8ec8-39368250530e',
]);

/**
 * The policy types that are CI checks: "Build" (a pipeline run) and "Status"
 * (an external service posting a status, Azure's counterpart of a GitHub
 * status context). These are what the Checks list shows and what a rejection
 * folds to `failing` for. Every other type (reviewers, comment resolution,
 * linked work items, merge strategy, file size) waits on a person or a
 * setting, never on a runner. Ids are fixed across organizations.
 */
const BUILD_POLICY_TYPE_ID = '0609b952-1397-4640-95ec-e00a01b2c241';
const STATUS_POLICY_TYPE_ID = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
const CHECK_POLICY_TYPE_IDS: ReadonlySet<string> = new Set([BUILD_POLICY_TYPE_ID, STATUS_POLICY_TYPE_ID]);

/**
 * Whether the policy call can change this item's verdict at all. Only an
 * active, non-draft PR whose merge preview `succeeded` is worth the second `az`
 * call: a draft never renders readiness, a completed or abandoned PR never
 * changes, every other `mergeStatus` already decides the verdict on its own,
 * and without the project GUID there is no artifact id to ask about. There is
 * no setting in front of this any more (it was `git.prEvaluateBranchPolicies`,
 * off by default), so a clean Azure PR reads ready or blocked like a GitHub
 * one. The refresh queue's pacing bounds what the extra call costs.
 */
function needsPolicyEvaluation(item: AzurePrItem): item is AzurePrItem & { projectId: string } {
  return item.state === 'active'
    && !item.isDraft
    && item.mergeStatus === 'succeeded'
    && typeof item.projectId === 'string'
    && item.projectId.length > 0;
}

/**
 * Fold the PR's branch-policy evaluations into a verdict for a `succeeded`
 * merge preview. Only blocking, enabled, live policies count (a non-blocking
 * policy cannot stop Complete, and a disabled or soft-deleted one is not
 * evaluated). Precedence, highest first:
 *   - a `rejected` or `broken` build or status policy is `failing`, the
 *     counterpart of a failed GitHub check: a broken blocking policy disables
 *     Complete just as a rejection does, and an agent can fix either;
 *   - a `rejected` reviewer policy is `blocked`;
 *   - any non-reviewer evaluation still in flight is `running` (if any is
 *     running) else `queued`: a check in flight, shown as such EVEN IF a review
 *     is also outstanding, so the chip tracks CI while it runs;
 *   - a reviewer policy still waiting for approvals is `blocked`;
 *   - otherwise `ready`: every blocking policy is `approved` / `notApplicable`,
 *     or there are none, and the preview merge already succeeded.
 * `null` (no readable answer from the policy API) and an unrecognized status
 * are `unknown`: Azure was asked, and the answer was not one this code can
 * vouch for.
 */
function foldPolicyEvaluations(evaluations: AzurePolicyEvaluation[] | null): PRMergeReadiness {
  if (evaluations === null) return 'unknown';
  const blocking = evaluations.filter(
    (evaluation) => evaluation.isBlocking && evaluation.isEnabled && !evaluation.isDeleted,
  );
  const rejected = blocking.filter((evaluation) => evaluation.status === 'rejected' || evaluation.status === 'broken');
  // A rejected build or status policy is a failed check, which an agent can
  // fix; any other rejection (a reviewer, unresolved comments, a missing work
  // item link) is a person's call.
  if (rejected.some((evaluation) => CHECK_POLICY_TYPE_IDS.has(evaluation.typeId))) return 'failing';
  if (rejected.length > 0) return 'blocked';
  const inFlight = blocking.filter(
    (evaluation) => evaluation.status === 'queued' || evaluation.status === 'running',
  );
  const checksInFlight = inFlight.filter((evaluation) => !REVIEWER_POLICY_TYPE_IDS.has(evaluation.typeId));
  if (checksInFlight.some((evaluation) => evaluation.status === 'running')) return 'running';
  if (checksInFlight.length > 0) return 'queued';
  if (inFlight.length > 0) return 'blocked';
  const settled = blocking.every(
    (evaluation) => evaluation.status === 'approved' || evaluation.status === 'notApplicable',
  );
  return settled ? 'ready' : 'unknown';
}

/**
 * Fold Azure's `mergeStatus` (the server-side merge preview) into the
 * normalized verdict, or undefined when the item carries none (the commit
 * tier). `succeeded` says only that the preview merge applied cleanly, so it
 * becomes whatever the branch-policy evaluations said (`policyVerdict`), and
 * `unknown` when they were not consulted: `ready` would otherwise promise a
 * Merge click that reviewer minimums or a required build can still refuse.
 * `queued` / `notSet` / null are "no verdict yet", and an unrecognized status
 * is `unknown` too: Azure was asked, and the answer was not one this code
 * understands.
 */
function mapMergeReadiness(
  item: AzurePrItem,
  policyVerdict: PRMergeReadiness | undefined,
): PRMergeReadiness | undefined {
  if (item.mergeStatus === undefined) return undefined;
  switch (item.mergeStatus) {
    case 'conflicts':
      return 'conflicting';
    case 'rejectedByPolicy':
    case 'failure':
      return 'blocked';
    case 'succeeded':
      return policyVerdict ?? 'unknown';
    default:
      // queued, notSet, null, and anything newer than this list.
      return 'unknown';
  }
}

function toResolvedPR(
  item: AzurePrItem,
  remote: AzureRemote,
  policyVerdict: PRMergeReadiness | undefined,
): ResolvedPR {
  const mergeReadiness = mapMergeReadiness(item, policyVerdict);
  return {
    // Constructed, not read: Azure returns null for _links.web.href, remoteUrl
    // AND repository.webUrl on every tier.
    url: buildAzurePrWebUrl(remote, item.number),
    number: item.number,
    state: mapState(item),
    baseRefName: item.baseRefName,
    updatedAt: item.updatedAt,
    // Conditional spread so the commit tier's "cannot judge" stays an absent key.
    ...(mergeReadiness === undefined ? {} : { mergeReadiness }),
  };
}

/**
 * Pick the best PR from a candidate list for inferred (branch- or commit-based)
 * resolution, guarding against mislinks. Ported from the GitHub connector so
 * both providers disambiguate identically.
 *
 * The `else if` below looks like a bug and is not. When `branchHint` matches no
 * candidate, a pool of MORE than one returns null (refuse to guess), but a pool
 * of exactly one FALLS THROUGH and that lone candidate wins. That is the anchor
 * for a task whose stored branch is not the PR's source branch - the case this
 * was written against is exactly that shape, with a worktree slug of
 * `rework-dev-database-011d9fab` against a PR source branch of
 * `bugfix/7927-dev-database-managed-identity`. A
 * "cleaner" port that requires a hint match leaves such a task unlinked forever.
 */
function disambiguate(
  items: AzurePrItem[],
  options: { baseBranch?: string; branchHint?: string } = {},
): AzurePrItem | null {
  const { baseBranch, branchHint } = options;
  let pool = items.filter((item) => !item.isCrossRepository);
  if (pool.length === 0) return null;

  if (branchHint) {
    const matching = pool.filter((item) => item.headRefName === branchHint);
    if (matching.length > 0) {
      pool = matching;
    } else if (pool.length > 1) {
      // Several PRs and none is on this task's branch -> don't guess.
      return null;
    }
  }

  const score = (item: AzurePrItem): number => {
    let value = 0;
    // `active` covers both open and draft, as GitHub's `OPEN` does.
    if (item.state === 'active') value += 100;
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
 * Both hosts. `_git` is required, so a board or work-item URL can never match.
 * The project segment allows percent escapes (`My%20Project`).
 */
const AZURE_PR_URL_PATTERN =
  /https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s.]+\.visualstudio\.com\/(?:[^/\s]+\/)?[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)/g;

/** Maximum bytes to scan from the end of scrollback for performance. */
const SCAN_WINDOW = 4096;

export const azureDevOpsPRConnector: PRConnector = {
  name: 'Azure DevOps',
  // Free here, unlike GitHub: `pullrequestquery` matches only a PR's OWN source
  // commits, so the API answers the ownership question server-side. Probed
  // against a merge product and against a base tip it returns nothing, which is
  // why `resolveByCommit` below ports neither of GitHub's filters - they would
  // be dead weight, not a missing guard.
  verifiesCommitOwnership: true,

  matchesRemote(remoteUrls: readonly string[]): boolean {
    return firstAzureRemote(remoteUrls) !== null;
  },

  commitWebUrl(remoteUrls: readonly string[], sha: string): string | null {
    const remote = firstAzureRemote(remoteUrls);
    return remote ? buildAzureCommitWebUrl(remote, sha) : null;
  },

  matchesCommand(commandDetail: string): boolean {
    // `az repos pr list` is excluded for the same reason `gh pr list` is: a
    // survey is not an act on one PR.
    return /^az\s+repos\s+pr\s+(create|show|update)/.test(commandDetail);
  },

  extract(scrollback: string): DetectedPR | null {
    if (!scrollback) return null;

    // Only scan the tail of the scrollback for performance
    const tail = scrollback.length > SCAN_WINDOW ? scrollback.slice(-SCAN_WINDOW) : scrollback;

    // Uses the shared stripper rather than a local copy of the GitHub
    // connector's pattern. Deliberately `stripAnsiControlCodes`, NOT
    // `stripAnsiEscapes`: the latter also normalizes whitespace and collapses
    // blank lines, which can join two lines and fuse a URL to its neighbour.
    const clean = stripAnsiControlCodes(tail);

    // Find all matches and return the last one (most recent)
    let lastMatch: DetectedPR | null = null;
    let match: RegExpExecArray | null;

    // Module-level /g regexes retain lastIndex across calls; without this reset
    // the second extract() in a process starts mid-string and misses.
    AZURE_PR_URL_PATTERN.lastIndex = 0;
    while ((match = AZURE_PR_URL_PATTERN.exec(clean)) !== null) {
      lastMatch = { url: match[0], number: parseInt(match[1], 10) };
    }

    return lastMatch;
  },

  async resolveForBranch(
    repoCwd: string,
    branchName: string,
    baseBranch?: string,
    // Accepted for contract parity and ignored: the one option is GitHub's
    // merge bypass, and Azure's bypass lives in the security namespace.
    _options?: PRResolveOptions,
  ): Promise<ResolvedPR | null> {
    const remote = await remoteFor(repoCwd);
    if (!remote) return null;
    return viaAz(async () => {
      const items = await azImporter.resolvePRByBranch(remote.org, remote.project, remote.repo, branchName);
      // Every item already matches the source branch; the hint also drops fork
      // PRs that share the branch name.
      const best = disambiguate(items, { baseBranch, branchHint: branchName });
      if (!best) return null;
      // Policies are evaluated for the ONE chosen candidate, after
      // disambiguation, so a branch shared by several PRs costs one call.
      return toResolvedPR(best, remote, await policyVerdictFor(best, remote));
    });
  },

  async resolveByNumber(repoCwd: string, prNumber: number, _options?: PRResolveOptions): Promise<ResolvedPR | null> {
    const remote = await remoteFor(repoCwd);
    if (!remote) return null;
    return viaAz(async () => {
      const item = await azImporter.resolvePRByNumber(remote.org, prNumber);
      // An explicit number is unambiguous within the organization, so the fork
      // guard is bypassed here exactly as it is on the GitHub side.
      if (!item) return null;
      return toResolvedPR(item, remote, await policyVerdictFor(item, remote));
    });
  },

  async resolveByCommit(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null> {
    const remote = await remoteFor(repoCwd);
    if (!remote) return null;
    return viaAz(async () => {
      const items = await azImporter.resolvePRByCommit(remote.org, remote.project, remote.repo, commitSha);
      // The GitHub connector filters this pool twice before disambiguating,
      // because `gh api commits/<sha>/pulls` returns every PR whose head branch
      // CONTAINS the commit - including a sibling that merely branched off the
      // same base tip. Azure's pullrequestquery matches only a PR's own source
      // commits: probed against a merge product and against a base tip it
      // returns nothing, and an open sibling can never appear at all since the
      // API records associations at completion. Both filters would be dead
      // weight here, so neither is ported.
      const best = disambiguate(items, { branchHint });
      // No policy evaluation: these items carry no `mergeStatus` (the
      // projection omits it), so the verdict is omitted whatever the setting.
      return best ? toResolvedPR(best, remote, undefined) : null;
    });
  },

  async listChecks(repoCwd: string, prNumber: number): Promise<PRChecks | null> {
    const remote = await remoteFor(repoCwd);
    if (!remote) return null;
    return viaAz(async () => {
      const projectId = await prProjectId(remote.org, prNumber);
      if (!projectId) return null;
      const evaluations = await azImporter.resolvePolicyEvaluations(remote.org, projectId, prNumber);
      if (evaluations === null) return null;
      const prUrl = buildAzurePrWebUrl(remote, prNumber);
      return { checks: policyChecks(evaluations, remote, prUrl), checksPageUrl: prUrl };
    });
  },

  async fetchCheckLog(repoCwd: string, prNumber: number, check: PRCheck, maxChars: number): Promise<string | null> {
    const buildId = buildIdFromResultsUrl(check.url);
    if (buildId === null) return null;
    const remote = await remoteFor(repoCwd);
    if (!remote) return null;
    return viaAz(async () => {
      const projectId = await prProjectId(remote.org, prNumber);
      if (!projectId) return null;
      const steps = await azImporter.resolveFailedBuildSteps(remote.org, projectId, buildId);
      if (!steps || steps.length === 0) return null;
      // The last failed step is the one the build stopped on.
      const step = steps[steps.length - 1];
      const raw = await azImporter.fetchBuildLog(remote.org, projectId, buildId, step.logId);
      if (raw === null) return null;
      return tailRawLog(raw, stripLogTimestamp, maxChars);
    });
  },
};

/**
 * Each PR's project GUID, by organization and PR number. A PR never moves
 * project, and every policy, timeline and log call needs the GUID, so a send
 * that fetches several logs (and a pending poll) asks Azure for the PR once,
 * not once per check: each `az` call is a cold start of about a second.
 */
const prProjectIds = new Map<string, string>();

async function prProjectId(organization: string, prNumber: number): Promise<string | null> {
  const key = `${organization}\u0000${prNumber}`;
  const known = prProjectIds.get(key);
  if (known) return known;
  const item = await azImporter.resolvePRByNumber(organization, prNumber);
  if (!item || typeof item.projectId !== 'string' || item.projectId.length === 0) return null;
  prProjectIds.set(key, item.projectId);
  return item.projectId;
}

/** The build id in a check row's results URL (`..._build/results?buildId=N`), or null. */
function buildIdFromResultsUrl(url: string): number | null {
  const match = /\/_build\/results\?buildId=(\d+)(?:&|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * A PR's policy evaluations as the Checks list shows them: every enabled, live
 * build or status policy (`CHECK_POLICY_TYPE_IDS`), blocking or optional, as
 * GitHub lists optional checks too. A build policy links to its build and can
 * read its log once it has queued one; a status policy links to the PR.
 */
export function policyChecks(evaluations: AzurePolicyEvaluation[], remote: AzureRemote, prUrl: string): PRCheck[] {
  return evaluations
    .filter((evaluation) => evaluation.isEnabled && !evaluation.isDeleted && CHECK_POLICY_TYPE_IDS.has(evaluation.typeId))
    .map((evaluation, index) => {
      const buildId = evaluation.buildId ?? null;
      const name = evaluation.displayName
        ?? evaluation.buildDefinitionName
        ?? (evaluation.statusName ? [evaluation.statusGenre, evaluation.statusName].filter(Boolean).join('/') : null)
        ?? evaluation.typeName
        ?? 'Policy';
      return {
        id: evaluation.evaluationId ?? `policy-${index}`,
        name,
        group: null,
        url: buildId !== null ? buildAzureBuildResultsUrl(remote, buildId) : prUrl,
        status: policyCheckStatus(evaluation.status),
        hasLog: buildId !== null,
      };
    });
}

function policyCheckStatus(status: AzurePolicyEvaluation['status']): PRCheck['status'] {
  switch (status) {
    case 'approved': return 'passed';
    case 'rejected':
    case 'broken': return 'failed';
    case 'notApplicable': return 'skipped';
    default: return 'pending';
  }
}
