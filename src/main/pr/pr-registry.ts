/**
 * PR connector registry - the platform-agnostic dispatch layer. The rest of the
 * codebase calls these functions without knowing which providers are registered:
 *
 *   matchesPRCommand(detail)  - flag a Bash command as a PR command (activity)
 *   detectPR(scrollback)      - extract a PR URL from terminal scrollback
 *   detectCanonicalPR(text)   - extract the single PR a task description names
 *   resolvePR*(...)           - authoritative provider lookups (CLI / API)
 *
 * To add a provider: implement the `PRConnector` contract under
 * `adapters/<provider>/`, then import it and add it to the `connectors` array
 * below. Keep all provider-specific logic inside its adapter - no provider-name
 * branching here (mirrors .claude/rules/agent-adapters-boundary.md).
 */

import type { PRConnector, DetectedPR, ResolvedPR } from './shared/pr-connector';
import { gitHubPRConnector } from './adapters/github/github-connector';

// Re-export the contract + errors so consumers have a single import surface.
export type { PRConnector, DetectedPR, ResolvedPR, PRState } from './shared/pr-connector';
export { PRResolverUnavailableError, PRResolverTransientError } from './shared/pr-errors';

// --- Registry: add new providers here ---
const connectors: PRConnector[] = [
  gitHubPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector, azureDevOpsPRConnector
];

// --- Platform-agnostic API ---

/** Check if a Bash command detail matches any registered PR connector. */
export function matchesPRCommand(commandDetail: string): boolean {
  return connectors.some((connector) => connector.matchesCommand(commandDetail));
}

/** Try all registered connectors against scrollback, return first match. */
export function detectPR(scrollback: string): DetectedPR | null {
  for (const connector of connectors) {
    const result = connector.extract(scrollback);
    if (result) return result;
  }
  return null;
}

/**
 * Extract a single canonical PR reference from authored text (a task
 * description) via the first connector that recognizes exactly one PR. Returns
 * null when no connector finds an unambiguous match - so a description that
 * names several PRs, or none, is never guessed at.
 */
export function detectCanonicalPR(text: string): DetectedPR | null {
  for (const connector of connectors) {
    if (!connector.extractCanonical) continue;
    const result = connector.extractCanonical(text);
    if (result) return result;
  }
  return null;
}

/**
 * Authoritatively resolve the PR for a branch via the first registered connector
 * that supports `resolveForBranch` and returns a match. Connector errors
 * (`PRResolverUnavailableError`) propagate so the caller can degrade to `detectPR`.
 */
export async function resolvePRForBranch(
  repoCwd: string,
  branchName: string,
  baseBranch?: string,
): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveForBranch) continue;
    const result = await connector.resolveForBranch(repoCwd, branchName, baseBranch);
    if (result) return result;
  }
  return null;
}

/** Resolve a PR by number via the first connector that supports it. */
export async function resolvePRByNumber(repoCwd: string, prNumber: number): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveByNumber) continue;
    const result = await connector.resolveByNumber(repoCwd, prNumber);
    if (result) return result;
  }
  return null;
}

/** Resolve the PR associated with a commit SHA via the first connector that supports it. */
export async function resolvePRByCommit(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveByCommit) continue;
    const result = await connector.resolveByCommit(repoCwd, commitSha, branchHint);
    if (result) return result;
  }
  return null;
}
