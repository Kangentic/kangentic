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

import type { PRState } from '../../../shared/types';

export type { PRState };

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
}

export interface PRConnector {
  /** Platform name for logging (e.g. "GitHub", "GitLab") */
  name: string;

  /** Does this Bash command detail look like a PR command for this platform? */
  matchesCommand(commandDetail: string): boolean;

  /** Extract a PR URL + number from raw PTY scrollback text. */
  extract(scrollback: string): DetectedPR | null;

  /**
   * Extract the single canonical PR reference from authored text (a task
   * description), or null when the text names zero or several distinct PRs.
   * Unlike `extract` - which returns the most recent of many scrollback URLs -
   * this is deliberately conservative: it returns a match only when there is no
   * ambiguity, so a description is never guessed at. Optional per platform.
   */
  extractCanonical?(text: string): DetectedPR | null;

  /**
   * Authoritatively resolve the PR for a branch via the platform API, run from
   * inside the repo/worktree at `repoCwd`. Returns null when no PR matches the
   * head ref; throws `PRResolverUnavailableError` when the CLI is unavailable so
   * the caller can degrade to `extract`. Optional - platforms without an API
   * resolver are skipped.
   */
  resolveForBranch?(repoCwd: string, branchName: string, baseBranch?: string): Promise<ResolvedPR | null>;

  /**
   * Resolve a PR by its number - the most exact anchor, immune to branch renames.
   * Used to refresh an already-linked PR's state. Returns null if the number no
   * longer exists; throws `PRResolverUnavailableError` when the CLI is unavailable.
   */
  resolveByNumber?(repoCwd: string, prNumber: number): Promise<ResolvedPR | null>;

  /**
   * Resolve the PR associated with a commit SHA. An immutable anchor that
   * survives worktree deletion and branch renames - used to backfill Done /
   * no-worktree tasks. `branchHint` (the task's known branch) disambiguates when
   * a commit belongs to several PRs and guards against linking an unrelated PR
   * that merely contains the same commit. Returns null when no PR matches; throws
   * `PRResolverUnavailableError` when the CLI is unavailable.
   */
  resolveByCommit?(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null>;
}
