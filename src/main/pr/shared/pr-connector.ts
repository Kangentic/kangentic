/**
 * PR connector contract - the platform-agnostic interface every hosting provider
 * (GitHub, GitLab, Bitbucket, Azure DevOps) implements. Kept in a leaf module so
 * both the registry (`pr-registry.ts`) and each provider adapter
 * (`adapters/<provider>/`) can import the types without forming an import cycle.
 *
 * Verb taxonomy across the PR subsystem:
 *   detect*  - parse a PR reference from text / scrollback (no network)
 *   resolve* - authoritative provider lookup (CLI / API)
 *   link*    - resolve + persist to a task (see pr-linking.ts)
 *   refresh* - bulk re-link across a project (see pr-refresh.ts)
 */

import type { PRState, PRMergeReadiness } from '../../../shared/types';

export type { PRState, PRMergeReadiness };

export interface DetectedPR {
  url: string;
  number: number;
}

/**
 * Authoritative resolver result - richer than DetectedPR because it comes from a
 * structured API query (e.g. `gh pr list --json`) rather than scrollback text.
 */
export interface ResolvedPR {
  url: string;
  number: number;
  state: PRState;
  baseRefName?: string;
  updatedAt?: string;
  /**
   * Normalized merge readiness, when THIS resolve could judge it. Omitted means
   * "this tier or connector cannot determine it" and the linker keeps the stored
   * verdict; it never means "not ready". A returned `unknown` is different: the
   * platform was asked and has no verdict yet. The linker holds a determined
   * stored verdict through a bounded re-poll before conceding to it, because
   * GitHub answers `UNKNOWN` for a few seconds after every push while it
   * recomputes, and blanking the card for that window is a flicker, not news.
   * Each connector folds its own platform vocabulary into this enum inside its
   * adapter; the generic layer never sees a raw platform string, which
   * `tests/unit/pr-connector-gate.test.ts` enforces over the real registry.
   */
  mergeReadiness?: PRMergeReadiness;
}

/**
 * Per-resolve options the generic layer forwards from project config. The
 * linker reads them once per resolve (`git.*` in the effective config) and
 * hands the same object to every tier; it never knows which provider will
 * answer, and a connector never reads config itself.
 *
 * Only `resolveForBranch` and `resolveByNumber` take them. `resolveByCommit`
 * does not, deliberately: the commit tier cannot judge merge readiness on any
 * shipped connector (Azure's `pullrequestquery` matches completed PRs only and
 * projects no `mergeStatus`; GitHub's REST commit-pulls payload carries no
 * mergeability fields), so there is nothing an option could change there. Add
 * it to that method when a connector can use it, not before.
 */
export interface PRResolveOptions {
  /**
   * Spend an extra provider call per PR to evaluate branch policies when
   * judging readiness. `git.prEvaluateBranchPolicies`, default off. Azure
   * DevOps is the connector that pays for it (one `az rest` per open PR per
   * sweep); a connector whose verdict already carries policy (GitHub, via
   * `mergeStateStatus`) ignores it.
   */
  evaluateBranchPolicies?: boolean;
  /**
   * Count the viewer's own merge bypass as `ready`. `git.prBypassCountsAsReady`,
   * default on. GitHub is the connector that pays for it: one `gh api graphql`
   * probe per PR whose ONLY block is a missing required review (every check
   * settled green), never one per open PR per sweep, and the answer folds that
   * PR to `ready`. The same probe reads the base branch's required checks, so a
   * failed, in-flight, or not-yet-reported one still reads `blocked` whatever
   * the bypass says. The verdict becomes viewer-relative. Azure DevOps ignores
   * it (its bypass lives in the security namespace and is out of scope).
   */
  bypassCountsAsReady?: boolean;
}

export interface PRConnector {
  /** Platform name for logging (e.g. "GitHub", "GitLab") */
  name: string;

  /**
   * Does this connector OWN the repository behind these git remote fetch URLs?
   * `origin` comes first. Return true when any URL is one this platform hosts.
   * Must be pure: no subprocess, no network.
   *
   * REQUIRED, unlike the resolvers. A connector with no gate is eligible on
   * every remote, and a connector that is eligible everywhere and cleanly
   * misses produces a clean `not-found` - which is exactly what makes
   * `pr-linking.ts` CLEAR a task's PR link. Making this optional with a
   * `?? true` default would re-open that hole.
   *
   * Being required is not the same as being safe: a future connector can still
   * write `matchesRemote: () => true` and type-check. What actually holds the
   * invariant is `dispatchResolve`'s "no owner -> throw" branch and the tier
   * deferral in `pr-linking.ts`; this member is what lets them do their job.
   */
  matchesRemote(remoteUrls: readonly string[]): boolean;

  /** Does this Bash command detail look like a PR command for this platform? */
  matchesCommand(commandDetail: string): boolean;

  /** Extract a PR URL + number from raw PTY scrollback text. */
  extract(scrollback: string): DetectedPR | null;

  /**
   * Authoritatively resolve the PR for a branch via the platform API, run from
   * inside the repo/worktree at `repoCwd`. Returns null when no PR matches the
   * head ref; throws `PRResolverUnavailableError` when the CLI is unavailable so
   * the caller can degrade to `extract`. Optional - platforms without an API
   * resolver are skipped. `options` carries the per-project readiness settings
   * (see `PRResolveOptions`).
   */
  resolveForBranch?(
    repoCwd: string,
    branchName: string,
    baseBranch?: string,
    options?: PRResolveOptions,
  ): Promise<ResolvedPR | null>;

  /**
   * Resolve a PR by its number - the most exact anchor, immune to branch renames.
   * Used to refresh an already-linked PR's state. Returns null if the number no
   * longer exists; throws `PRResolverUnavailableError` when the CLI is unavailable.
   * `options` carries the per-project readiness settings (see `PRResolveOptions`).
   */
  resolveByNumber?(repoCwd: string, prNumber: number, options?: PRResolveOptions): Promise<ResolvedPR | null>;

  /**
   * Resolve the PR associated with a commit SHA. An immutable anchor that
   * survives worktree deletion and branch renames - used to backfill Done /
   * no-worktree tasks. `branchHint` (the task's known branch) disambiguates when
   * a commit belongs to several PRs and guards against linking an unrelated PR
   * that merely contains the same commit. Returns null when no PR matches; throws
   * `PRResolverUnavailableError` when the CLI is unavailable.
   */
  resolveByCommit?(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null>;

  /**
   * Does `resolveByCommit` prove the commit is the returned PR's OWN work,
   * rather than history it merely inherited from its base?
   *
   * This is the question the linker cannot answer for itself. Its
   * commits-ahead-of-base gate is a cheap early-out measured against a base the
   * task may not have recorded, so it can only ever be a filter, never a proof.
   * The proof has to come from the connector, and how it gets there is
   * platform-specific: GitHub filters client-side (a merge-commit check plus a
   * per-candidate base-history probe), while Azure's `pullrequestquery` matches
   * only a PR's own source commits server-side and needs no filter at all.
   *
   * Declare it explicitly. A connector that omits it is treated as NOT
   * self-verifying and the linker SKIPS the commit tier for that repo entirely,
   * which is the safe direction: a missing declaration costs a link that another
   * tier will usually still make, where a wrong one costs a mislink that no
   * later resolve can clear (a hit suppresses the confident-not-found clear
   * permanently). `tests/unit/pr-connector-gate.test.ts` fails on a registered
   * connector that implements `resolveByCommit` without declaring this, so the
   * choice cannot be made by omission.
   */
  verifiesCommitOwnership?: boolean;
}
