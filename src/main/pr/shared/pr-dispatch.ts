/**
 * Connector dispatch for the PR registry - the part that decides WHICH
 * connector may answer, and what a miss is allowed to mean.
 *
 * Kept in a leaf module that takes the connector list as a parameter so the
 * algorithm is testable without exporting a mutable seam from `pr-registry.ts`,
 * which stays a thin binding over this.
 *
 * The invariant this module exists to hold:
 *
 *   A clean `not-found` may only be reported when a connector that actually
 *   OWNS this remote ran cleanly. Any path where an unavailable connector is
 *   skipped and the surviving connectors all miss must still return a degraded
 *   status, never a clean miss.
 *
 * It matters because a clean miss is destructive. `pr-linking.ts` treats
 * `null` + no degrade as "confidently no PR" and CLEARS the task's
 * `pr_url` / `pr_number` / `pr_state`. Catch-and-continue on its own would
 * therefore wipe a manually pasted PR link the moment the owning connector's
 * CLI was missing.
 */

import type { PRConnector, ResolvedPR } from './pr-connector';
import { PRResolverUnavailableError, PRResolverTransientError } from './pr-errors';

/** The three optional resolver members a connector may implement. */
export type ResolveKind = 'resolveForBranch' | 'resolveByNumber' | 'resolveByCommit';

type DegradeError = PRResolverUnavailableError | PRResolverTransientError;

function isDegradeError(error: unknown): error is DegradeError {
  return error instanceof PRResolverUnavailableError || error instanceof PRResolverTransientError;
}

export interface DeferredDegrade {
  /**
   * Run `attemptFn`; on a degrade error remember it and resolve null so the
   * caller can try the next candidate instead of aborting.
   */
  attempt<T>(attemptFn: () => Promise<T | null>): Promise<T | null>;
  /** What to rethrow when nothing resolved: the first transient, else the first unavailable. */
  pending(): DegradeError | undefined;
}

/**
 * The shared defer-and-continue primitive, used by both this module's
 * connector loop and `pr-linking.ts`'s tier ladder so the ranking rule exists
 * in exactly one place.
 *
 * RANKING: the first TRANSIENT outranks the first UNAVAILABLE. Both block the
 * link-clearing path identically, so this is a message-quality choice only. A
 * transient proves a real owning connector reached the network, which is
 * strictly more informative than "something could not run" - and because the
 * synthetic gate errors below (unreadable remotes, no owner, unsupported kind)
 * are all `unavailable`, letting those win would permanently drown real
 * transients and drive the renderer's "install the CLI" toast, which is an
 * actively misleading instruction when the truth is "try again".
 */
export function createDeferredDegrade(): DeferredDegrade {
  let firstUnavailable: PRResolverUnavailableError | undefined;
  let firstTransient: PRResolverTransientError | undefined;

  return {
    async attempt<T>(attemptFn: () => Promise<T | null>): Promise<T | null> {
      try {
        return await attemptFn();
      } catch (error) {
        // An unknown exception is not ours to classify or swallow: swallowing
        // it would turn a programming error into a silent clean miss.
        if (!isDegradeError(error)) throw error;
        if (error instanceof PRResolverTransientError) {
          firstTransient ??= error;
        } else {
          firstUnavailable ??= error;
        }
        return null;
      }
    },
    pending(): DegradeError | undefined {
      return firstTransient ?? firstUnavailable;
    },
  };
}

/**
 * The connectors that own this repository.
 *
 * Ownership is decided on the PRIMARY remote first (`readRemoteUrls` puts
 * `origin` first). With an Azure `origin` and a GitHub `upstream` both
 * connectors would otherwise claim, registry array order would silently pick
 * the winner, and `resolvePRByNumber(42)` could return UPSTREAM's PR #42 - a
 * mislink, which is strictly worse than a miss. Falling back to the full list
 * keeps a repo whose primary remote is unrecognized working when a secondary
 * remote is claimed.
 */
export function selectOwningConnectors(
  connectors: readonly PRConnector[],
  remoteUrls: readonly string[],
  options: { allowSecondaryFallback?: boolean } = {},
): PRConnector[] {
  const byPrimary = connectors.filter((connector) => connector.matchesRemote(remoteUrls.slice(0, 1)));
  if (byPrimary.length > 0) return byPrimary;
  // The secondary fallback is itself a guess: if the primary remote belongs to
  // an unregistered host, a claimed `upstream` is not evidence that THIS repo's
  // PRs live there. It is allowed for the inferred tiers, which are guarded by
  // `disambiguate` (branch hint, fork drop, base match), and refused for
  // `resolveByNumber`, which deliberately bypasses every guard because an
  // explicit number is unambiguous WITHIN one repo. Resolving a number against
  // a merely-plausible owner returns that owner's PR of the same number, which
  // is a mislink and strictly worse than a miss.
  if (options.allowSecondaryFallback === false) return [];
  return connectors.filter((connector) => connector.matchesRemote(remoteUrls));
}

export interface DispatchResolveArgs {
  connectors: readonly PRConnector[];
  /** Read by the caller so this module stays git-free. `null` = could not be read at all. */
  remoteUrls: readonly string[] | null;
  /** Only used to make the thrown messages name the repo. */
  repoCwd: string;
  kind: ResolveKind;
  invoke: (connector: PRConnector) => Promise<ResolvedPR | null>;
}

/**
 * Dispatch one resolve to the owning connectors, upholding the invariant above.
 *
 * Returns `null` on exactly one path: at least one owning, capable connector
 * ran and NO owning connector degraded. Every other outcome throws, so the
 * linker degrades rather than clearing a link.
 */
export async function dispatchResolve(args: DispatchResolveArgs): Promise<ResolvedPR | null> {
  const { connectors, remoteUrls, repoCwd, kind, invoke } = args;

  if (remoteUrls == null) {
    throw new PRResolverUnavailableError(
      `Could not read the git remotes for ${repoCwd}, so no PR connector can be shown to own it.`,
    );
  }

  const owning = selectOwningConnectors(connectors, remoteUrls, {
    allowSecondaryFallback: kind !== 'resolveByNumber',
  });
  if (owning.length === 0) {
    throw new PRResolverUnavailableError(
      remoteUrls.length === 0
        ? `No git remote is configured for ${repoCwd}, so no PR connector owns it.`
        : `No PR connector matches the remote ${remoteUrls[0]}.`,
    );
  }

  // Owns the remote but implements no resolver of this kind: nothing RAN, so
  // "there is no PR" was never established and a clean miss would be a lie.
  const capable = owning.filter((connector) => connector[kind] != null);
  if (capable.length === 0) {
    throw new PRResolverUnavailableError(
      `${owning.map((connector) => connector.name).join(', ')} owns this remote but has no ${kind} resolver.`,
    );
  }

  const degrade = createDeferredDegrade();
  for (const connector of capable) {
    const result = await degrade.attempt(() => invoke(connector));
    if (result) return result;
  }

  const pendingError = degrade.pending();
  if (pendingError) throw pendingError;
  // Every owning, capable connector ran cleanly and matched nothing. This is
  // the ONLY legal clean not-found.
  return null;
}
