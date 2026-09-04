/**
 * PR connector registry - the platform-agnostic dispatch layer. The rest of the
 * codebase calls these functions without knowing which providers are registered:
 *
 *   matchesPRCommand(detail)  - flag a Bash command as a PR command (activity)
 *   detectPR(scrollback)      - extract a PR URL from terminal scrollback
 *   resolvePR*(...)           - authoritative provider lookups (CLI / API)
 *
 * To add a provider: implement the `PRConnector` contract under
 * `adapters/<provider>/`, then import it and add it to the `connectors` array
 * below. Keep all provider-specific logic inside its adapter - no provider-name
 * branching here (mirrors .claude/rules/agent-adapters-boundary.md).
 *
 * `matchesRemote` is REQUIRED on the contract and is the reason a second
 * provider can exist at all: the `resolvePR*` functions dispatch only to the
 * connectors that OWN the repo's remote, so a connector whose CLI is missing
 * can neither pre-empt the owner nor let an unowned repo report a clean
 * "no PR" - which `pr-linking.ts` would act on by CLEARING the task's link.
 * The dispatch rules live in `shared/pr-dispatch.ts`; read its header before
 * changing them.
 */

import type { PRConnector, DetectedPR, ResolvedPR } from './shared/pr-connector';
import { dispatchResolve, type ResolveKind } from './shared/pr-dispatch';
import { readRemoteUrls } from '../git/git-remotes';
import { gitHubPRConnector } from './adapters/github/github-connector';
import { azureDevOpsPRConnector } from './adapters/azure-devops/azure-devops-connector';

// Re-export the contract + errors so consumers have a single import surface.
export type { PRConnector, DetectedPR, ResolvedPR, PRState } from './shared/pr-connector';
export { PRResolverUnavailableError, PRResolverTransientError } from './shared/pr-errors';

// --- Registry: add new providers here ---
const connectors: PRConnector[] = [
  gitHubPRConnector,
  azureDevOpsPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector
];

/**
 * The registered connectors, read-only, so `tests/unit/pr-connector-gate.test.ts`
 * can assert over the REAL array rather than a hand-maintained copy. That guard
 * is the CI backstop for `matchesRemote`: the contract can require the member
 * but not that it discriminates, and a connector that claims every remote
 * silently re-opens the clean-miss link wipe this whole layer prevents.
 * Not for dispatch - callers use the functions below.
 */
export const registeredPRConnectors: readonly PRConnector[] = connectors;

// --- Platform-agnostic API ---

/** Check if a Bash command detail matches any registered PR connector. */
export function matchesPRCommand(commandDetail: string): boolean {
  return connectors.some((connector) => connector.matchesCommand(commandDetail));
}

/**
 * Try all registered connectors against scrollback, return first match.
 *
 * Deliberately NOT remote-gated: it takes no cwd, it is the DEGRADATION
 * fallback used precisely when the resolver could not run (often because the
 * remotes were unreadable, so there would be nothing to gate on), and it only
 * ever ADDS a link - which blocks the link-clearing path rather than arming it.
 * Connectors' URL patterns are host-specific and disjoint, so first-match is
 * unambiguous.
 */
export function detectPR(scrollback: string): DetectedPR | null {
  for (const connector of connectors) {
    const result = connector.extract(scrollback);
    if (result) return result;
  }
  return null;
}

/** Shared plumbing for the three resolve functions: read the remotes once, then dispatch. */
async function resolveVia(
  repoCwd: string,
  kind: ResolveKind,
  invoke: (connector: PRConnector) => Promise<ResolvedPR | null>,
): Promise<ResolvedPR | null> {
  return dispatchResolve({
    connectors,
    remoteUrls: await readRemoteUrls(repoCwd),
    repoCwd,
    kind,
    invoke,
  });
}

/**
 * Authoritatively resolve the PR for a branch via the connectors that own this
 * repo's remote. Throws `PRResolverUnavailableError` / `PRResolverTransientError`
 * when no owning connector could complete a check, so the caller degrades to
 * `detectPR` instead of treating it as "no PR".
 */
export async function resolvePRForBranch(
  repoCwd: string,
  branchName: string,
  baseBranch?: string,
): Promise<ResolvedPR | null> {
  // Non-null asserted: dispatchResolve only invokes connectors it filtered on `kind`.
  return resolveVia(repoCwd, 'resolveForBranch', (connector) =>
    connector.resolveForBranch!(repoCwd, branchName, baseBranch),
  );
}

/** Resolve a PR by number via the connectors that own this repo's remote. */
export async function resolvePRByNumber(repoCwd: string, prNumber: number): Promise<ResolvedPR | null> {
  return resolveVia(repoCwd, 'resolveByNumber', (connector) => connector.resolveByNumber!(repoCwd, prNumber));
}

/** Resolve the PR associated with a commit SHA via the connectors that own this repo's remote. */
export async function resolvePRByCommit(
  repoCwd: string,
  commitSha: string,
  branchHint?: string,
): Promise<ResolvedPR | null> {
  return resolveVia(repoCwd, 'resolveByCommit', (connector) =>
    connector.resolveByCommit!(repoCwd, commitSha, branchHint),
  );
}
