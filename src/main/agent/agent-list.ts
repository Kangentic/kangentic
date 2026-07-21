/**
 * Cached `agents.list()` build.
 *
 * The renderer asks for the full agent inventory (per agent: detected CLI path,
 * version, auth state, and capabilities/models) at app bootstrap, on the
 * welcome screen, and every time Settings or the column manager opens. Building
 * it probes every registered adapter (`detect` + `probeAuth` +
 * `discoverCapabilities`), which spawns subprocesses and reads session history.
 * Re-running that on every open is what froze the UI.
 *
 * This module builds the inventory once and caches the whole result, collapsing
 * concurrent bootstrap callers onto a single build (see `createCachedSingleton`).
 * There is no TTL: the cache is cleared on agent-config change
 * (`invalidateAgentListCache`, wired into the `CONFIG_SET` handler) or by an
 * explicit `forceRefresh` (the Agent settings "re-detect" button), which also
 * re-probes detection so an externally-installed/authenticated CLI is picked up.
 */

import { createCachedSingleton } from '../shared/cached-singleton';
import { agentRegistry } from './agent-registry';
import type { AgentDetectionInfo } from '../../shared/types';

type CliPathOverrides = Record<string, string | null | undefined>;

const agentListCache = createCachedSingleton<AgentDetectionInfo[]>();

async function buildAgentList(
  cliPathOverrides: CliPathOverrides,
  forceRefresh = false,
): Promise<AgentDetectionInfo[]> {
  // Each adapter probes an independent CLI binary - detect spawns
  // `<binary> --version`, probeAuth spawns auth introspection, and
  // discoverCapabilities spawns `--help` plus an async session-history walk.
  // Running per-adapter pipelines in parallel cuts the wall time to roughly the
  // slowest single agent. Within an agent the steps stay sequential because
  // capability discovery requires the resolved path from detect.
  return Promise.all(
    agentRegistry.list().map(async (agentName): Promise<AgentDetectionInfo> => {
      const adapter = agentRegistry.getOrThrow(agentName);
      const info = await adapter.detect(cliPathOverrides[agentName] ?? null);
      const [authenticated, capabilities] = await Promise.all([
        info.found && adapter.probeAuth
          ? adapter.probeAuth().catch(() => null)
          : Promise.resolve(undefined),
        info.found && info.path && adapter.discoverCapabilities
          ? adapter.discoverCapabilities(info.path, forceRefresh).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      return {
        name: agentName,
        displayName: adapter.displayName,
        found: info.found,
        path: info.path,
        version: info.version,
        authenticated,
        permissions: adapter.permissions,
        defaultPermission: adapter.defaultPermission,
        liveTelemetryUnsupported: adapter.liveTelemetryUnsupported,
        reportsRateLimits: adapter.reportsRateLimits,
        pastedImageReferenceTemplate: adapter.pastedImageReferenceTemplate,
        supportsSummarize: typeof adapter.summarize === 'function',
        capabilities,
        remoteExecution: adapter.remoteExecution?.info,
      };
    }),
  );
}

/**
 * Return the cached agent inventory, building it on a cold cache. Concurrent
 * callers share one build. When `forceRefresh` is true, every adapter's
 * detection cache is invalidated first (so `--version` re-probes), the list is
 * rebuilt from scratch, and `forceRefresh` is threaded into capability
 * discovery so adapter-internal caches (Claude's 12h /model picker probe) are
 * bypassed too - the on-demand rescan a model dropdown fires when it opens.
 */
export async function listAgents(
  cliPathOverrides: CliPathOverrides,
  forceRefresh = false,
): Promise<AgentDetectionInfo[]> {
  if (forceRefresh) {
    for (const agentName of agentRegistry.list()) {
      agentRegistry.getOrThrow(agentName).invalidateDetectionCache();
    }
  }
  return agentListCache.get(() => buildAgentList(cliPathOverrides, forceRefresh), forceRefresh);
}

/** Clear the cached inventory so the next `listAgents` rebuilds it. */
export function invalidateAgentListCache(): void {
  agentListCache.invalidate();
}

/** Test-only: clear the cache between cases. */
export function resetAgentListForTests(): void {
  agentListCache.invalidate();
}
