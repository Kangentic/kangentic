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
 * This module builds the inventory once per set of CLI paths and caches the
 * whole result, collapsing concurrent bootstrap callers onto a single build
 * (see `createCachedSingleton`). CLI paths are per project, so two projects
 * pointing an agent at different CLIs get different inventories, and projects
 * with the same paths share one. There is no TTL: the caches are cleared on
 * agent-config change (`invalidateAgentListCache`, wired into the `CONFIG_SET`
 * handler) or by an explicit `forceRefresh` (the Agent settings "re-detect"
 * button), which also re-probes detection so an externally-installed or
 * authenticated CLI is picked up.
 */

import { createCachedSingleton, type CachedSingleton } from '../shared/cached-singleton';
import { agentRegistry } from './agent-registry';
import { invalidateWslDistroFacts } from './shared/wsl-distro';
import { canBeWorkflowAgent } from './shared/workflow-agent-capability';
import type { AgentDetectionInfo } from '../../shared/types';

type CliPathOverrides = Record<string, string | null | undefined>;

/** One cached inventory per distinct set of configured CLI paths, least recently used first. */
const agentListCaches = new Map<string, CachedSingleton<AgentDetectionInfo[]>>();

/**
 * How many inventories stay cached. A project-override write invalidates
 * nothing, and the Agent tab asks for another project's list as its CLI path
 * is typed, so every keystroke can name a new set of paths.
 */
const MAX_AGENT_LIST_CACHES = 8;

/** A stable key for a set of CLI paths: the configured ones, sorted by agent. */
function cliPathsKey(cliPathOverrides: CliPathOverrides): string {
  const configured = Object.entries(cliPathOverrides)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .sort(([firstAgent], [secondAgent]) => firstAgent.localeCompare(secondAgent));
  return JSON.stringify(configured);
}

function agentListCacheFor(cliPathOverrides: CliPathOverrides): CachedSingleton<AgentDetectionInfo[]> {
  const key = cliPathsKey(cliPathOverrides);
  let cache = agentListCaches.get(key);
  if (cache) {
    // Re-inserted, so the map's first key stays the least recently used.
    agentListCaches.delete(key);
  } else {
    cache = createCachedSingleton<AgentDetectionInfo[]>();
    const oldestKey = agentListCaches.size >= MAX_AGENT_LIST_CACHES ? agentListCaches.keys().next().value : undefined;
    if (oldestKey !== undefined) {
      agentListCaches.get(oldestKey)?.invalidate();
      agentListCaches.delete(oldestKey);
    }
  }
  agentListCaches.set(key, cache);
  return cache;
}

function invalidateAllAgentListCaches(): void {
  for (const cache of agentListCaches.values()) cache.invalidate();
  agentListCaches.clear();
}

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
        // The CLI this project detected, which its own CLI path may name.
        info.found && info.path && adapter.probeAuth
          ? adapter.probeAuth(info.path).catch(() => null)
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
        cliTarget: info.cliTarget,
        detectionError: info.detectionError,
        unsupportedTarget: info.unsupportedTarget,
        supportsWslCli: adapter.supportsWslCli === true,
        authenticated,
        permissions: adapter.permissions,
        defaultPermission: adapter.defaultPermission,
        liveTelemetryUnsupported: adapter.liveTelemetryUnsupported,
        reportsRateLimits: adapter.reportsRateLimits,
        pastedImageNativeExtensions: adapter.pastedImageNativeExtensions,
        pastedImageReferenceTemplate: adapter.pastedImageReferenceTemplate,
        supportsSummarize: typeof adapter.summarize === 'function',
        reportsTurnEnd: adapter.runtime.reportsTurnEnd,
        supportsAnswerFromContext: typeof adapter.answerFromContext === 'function',
        answerCapabilities: adapter.answerCapabilities,
        kangenticMcp: adapter.kangenticMcp,
        supportsWorkflowAgent: canBeWorkflowAgent(adapter),
        supportsPlanAutoApproval: adapter.supportsPlanAutoApproval === true,
        capabilities,
        remoteExecution: adapter.remoteExecution?.info,
        launchOptions: adapter.launchOptions,
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
    // A WSL distro's facts too: Re-detect is how a user picks up a CLI they just
    // installed there or a PATH their .bashrc now sets.
    invalidateWslDistroFacts();
    // Every inventory was built from the detections just dropped.
    invalidateAllAgentListCaches();
  }
  return agentListCacheFor(cliPathOverrides).get(() => buildAgentList(cliPathOverrides, forceRefresh), forceRefresh);
}

/**
 * Label the model ids the app learned from live telemetry
 * (`config.discoveredModelsByAgent`) that an agent's own discovery did not
 * list. The pickers union those ids into every list, and an id with no entry
 * in `capabilities.modelDisplayNames` renders raw. Each label comes from the
 * adapter's optional `modelDisplayName`, so naming stays in the adapter; a
 * name discovery already gave wins.
 *
 * Applied per call on top of the cached inventory, never inside it: an id
 * learned after the build is named on the next call without a rebuild. It
 * returns new entry objects and leaves the cached ones untouched. An entry with
 * no `capabilities` (CLI not found) stays as it is.
 */
export function nameLearnedModels(
  agents: AgentDetectionInfo[],
  learnedModelsByAgent: Record<string, string[]> | undefined,
): AgentDetectionInfo[] {
  if (!learnedModelsByAgent) return agents;
  return agents.map((entry) => {
    const learnedModels = learnedModelsByAgent[entry.name];
    const capabilities = entry.capabilities;
    if (!learnedModels || learnedModels.length === 0 || !capabilities) return entry;
    const adapter = agentRegistry.get(entry.name);
    if (!adapter?.modelDisplayName) return entry;
    const discoveredNames = capabilities.modelDisplayNames ?? {};
    const addedNames: Record<string, string> = {};
    for (const modelId of learnedModels) {
      if (discoveredNames[modelId]) continue;
      const displayName = adapter.modelDisplayName(modelId);
      if (displayName) addedNames[modelId] = displayName;
    }
    if (Object.keys(addedNames).length === 0) return entry;
    return {
      ...entry,
      capabilities: { ...capabilities, modelDisplayNames: { ...addedNames, ...discoveredNames } },
    };
  });
}

/** Clear every cached inventory so the next `listAgents` rebuilds it. */
export function invalidateAgentListCache(): void {
  invalidateAllAgentListCaches();
}

/** Test-only: clear the caches between cases. */
export function resetAgentListForTests(): void {
  invalidateAllAgentListCaches();
}
