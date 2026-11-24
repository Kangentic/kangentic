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
 *
 * An unforced build starts a CLI only for an agent in use. Building the
 * inventory used to start every found CLI three or four times (`--version`, the
 * sign-in check, `--help`, a model list), all of them at once, in a launch's
 * first seconds. Measured in a preview with six agents resuming, the build ran
 * for 19 to 22 s. Measured one CLI at a time against an idle agent, eleven of
 * the twelve installed CLIs left that agent answering a key in 4 to 17 ms, and
 * one, which takes 6 s to print its version, held the agent's answer for up to
 * 4 s per key while it ran. Which CLI is slow differs by machine, so the rule
 * names none:
 *
 * - An agent nothing has started this launch is listed from the probe store: a
 *   remembered detection (`AgentDetector.detect`), and the sign-in state and
 *   capabilities read at that path and version. No process is started for it.
 *   It is read again when its file changes, when the user asks (Re-detect, the
 *   Welcome screen's Refresh, a model dropdown opening), or when something
 *   starts it.
 * - An agent in use (a live detection exists: a spawn, an account read or a
 *   headless run probed it) is read from its CLI. While a launch is settling
 *   (`boot-settle.ts`) that read waits and the store answers meanwhile, so it
 *   does not land on the seconds the agents are starting in.
 * - A first launch, an agent the store holds nothing for, and every forced
 *   refresh read everything, as before.
 *
 * When a deferred read differs from what was shown, main tells the renderer.
 */

import PQueue from 'p-queue';
import { createCachedSingleton, type CachedSingleton } from '../shared/cached-singleton';
import { isBootSettled, whenBootSettled } from '../boot-settle';
import { agentRegistry } from './agent-registry';
import { isAgentProbeStoreEnabled, recordInventory, rememberedInventory } from './shared/agent-probe-store';
import { invalidateWslDistroFacts } from './shared/wsl-distro';
import { canBeWorkflowAgent } from './shared/workflow-agent-capability';
import { canReadTurnUserMessages } from './shared/transcript-reader-capability';
import type { AgentAdapter, AgentInfo } from './agent-adapter';
import type { ChokepointReporter } from '../analytics/handled-report';
import type { HostAgentProbe } from '../remote/host-agent-probe';
import type { AgentCapabilities, AgentDetectionInfo } from '../../shared/types';

type CliPathOverrides = Record<string, string | null | undefined>;

/** How many agents one build reads at a time. */
const LIST_BUILD_CONCURRENCY = 4;
/** How many agents a deferred read runs at a time. */
const IN_USE_READ_CONCURRENCY = 2;
/**
 * How long after an agent is first started its entry is read. The spawn that
 * detected it runs the same discovery for its own command, so by then the
 * adapter answers from what that read left. For a CLI that takes longer than
 * this to answer, the entry's read joins the spawn's and starts no second
 * process: Cursor's and Antigravity's discovery share an unforced read that is
 * still running.
 */
const IN_USE_READ_DELAY_MS = 5_000;

/** Who to tell about a deferred read, set by main. */
export interface AgentListHooks {
  /** A deferred read found something other than what was shown. */
  onChanged?: () => void;
  /** Reports a defect in a deferred read. Absent: nothing is sent. */
  failureReporter?: Pick<ChokepointReporter, 'report'>;
}

let hooks: AgentListHooks = {};

/** Main's listeners for a deferred read. A later call replaces them. */
export function setAgentListHooks(next: AgentListHooks): void {
  hooks = next;
}

/** An inventory with entries answered from the probe store, and which agents those are. */
interface StoreServedInventory {
  cliPathOverrides: CliPathOverrides;
  list: AgentDetectionInfo[];
  agentNames: Set<string>;
}

/** The cached inventories that hold store-answered entries, by their CLI paths. */
const storeServed = new Map<string, StoreServedInventory>();
let inUseReadScheduled = false;
/** Bumped by every invalidation, so a read an invalidation overtook installs nothing. */
let inventoryEpoch = 0;

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
      storeServed.delete(oldestKey);
    }
  }
  agentListCaches.set(key, cache);
  return cache;
}

function invalidateAllAgentListCaches(): void {
  inventoryEpoch += 1;
  for (const cache of agentListCaches.values()) cache.invalidate();
  agentListCaches.clear();
  // The next build says again which of its entries the store answered.
  storeServed.clear();
}

/** Adapters already told to drop the inventory when a read lands late. */
const watchedAdapters = new WeakSet<AgentAdapter>();

/**
 * An inventory has no TTL, so one built while a capability read was still
 * running stays without it. Main's own readers (MCP validation, the workflow
 * agent) then rebuild on their next call, and the renderer does on the rescan a
 * dropdown fires when it opens.
 */
function watchLateCapabilities(adapter: AgentAdapter): void {
  if (watchedAdapters.has(adapter)) return;
  watchedAdapters.add(adapter);
  adapter.onCapabilitiesChanged?.(invalidateAllAgentListCaches);
}

interface AgentRead {
  entry: AgentDetectionInfo;
  /** The entry's sign-in state and capabilities came from the probe store, not from the CLI just now. */
  fromStore: boolean;
  /** Something has started this agent this launch: its detection is a live one. */
  inUse: boolean;
}

/**
 * The detection an unforced build lists with: a live one where something has
 * started the agent this launch, else what its file said on an earlier launch.
 * One argument where there is no store, which is every probe, as before.
 */
function detectForList(adapter: AgentAdapter, overridePath: string | null): Promise<AgentInfo> {
  return isAgentProbeStoreEnabled()
    ? adapter.detect(overridePath, { allowRemembered: true })
    : adapter.detect(overridePath);
}

/** An agent's sign-in state and capabilities, read from its CLI now and kept for the next launch. */
async function readFromCli(
  agentName: string,
  adapter: AgentAdapter,
  info: AgentInfo,
  forceRefresh: boolean,
): Promise<{ authenticated: boolean | null | undefined; capabilities: AgentCapabilities | undefined }> {
  let discoveryFailed = false;
  const [authenticated, capabilities] = await Promise.all([
    // The CLI this project detected, which its own CLI path may name.
    info.found && info.path && adapter.probeAuth
      ? adapter.probeAuth(info.path).catch(() => null)
      : Promise.resolve(undefined),
    info.found && info.path && adapter.discoverCapabilities
      ? adapter.discoverCapabilities(info.path, forceRefresh).catch(() => {
        discoveryFailed = true;
        return undefined;
      })
      : Promise.resolve(undefined),
  ]);
  // Not a discovery that threw: a later launch would list the agent with no models.
  if (info.found && info.path && !discoveryFailed) {
    recordInventory({
      agent: agentName,
      path: info.path,
      version: info.version,
      ...(authenticated === undefined ? {} : { authenticated }),
      ...(capabilities === undefined ? {} : { capabilities }),
      readAt: new Date().toISOString(),
    });
  }
  return { authenticated, capabilities };
}

function entryOf(
  agentName: string,
  adapter: AgentAdapter,
  info: AgentInfo,
  authenticated: boolean | null | undefined,
  capabilities: AgentCapabilities | undefined,
): AgentDetectionInfo {
  return {
    ...adapterFacts(agentName, adapter),
    found: info.found,
    path: info.path,
    version: info.version,
    cliTarget: info.cliTarget,
    detectionError: info.detectionError,
    unsupportedTarget: info.unsupportedTarget,
    authenticated,
    capabilities,
  };
}

/**
 * One agent's entry: detect, then its sign-in state and capabilities together.
 * The steps stay sequential because capability discovery needs the path detect
 * resolved. See the rule at the top of this file for which entries start a CLI.
 */
async function readAgent(agentName: string, cliPathOverrides: CliPathOverrides, forceRefresh: boolean): Promise<AgentRead> {
  const adapter = agentRegistry.getOrThrow(agentName);
  watchLateCapabilities(adapter);
  const overridePath = cliPathOverrides[agentName] ?? null;
  const info = forceRefresh ? await adapter.detect(overridePath) : await detectForList(adapter, overridePath);
  // Nothing has started this agent, or the launch is still starting what it uses.
  const storeMayAnswer = !forceRefresh && (info.remembered === true || !isBootSettled());
  const stored = storeMayAnswer && info.found && info.path
    ? await rememberedInventory({ agent: agentName, path: info.path, version: info.version })
    : null;
  const inUse = info.remembered !== true;
  if (stored) {
    return { entry: entryOf(agentName, adapter, info, stored.authenticated, stored.capabilities), fromStore: true, inUse };
  }
  const read = await readFromCli(agentName, adapter, info, forceRefresh);
  return { entry: entryOf(agentName, adapter, info, read.authenticated, read.capabilities), fromStore: false, inUse };
}

async function buildAgentList(
  cliPathOverrides: CliPathOverrides,
  forceRefresh = false,
): Promise<AgentDetectionInfo[]> {
  // Each adapter probes an independent CLI binary - detect spawns
  // `<binary> --version`, probeAuth spawns auth introspection, and
  // discoverCapabilities spawns `--help` plus an async session-history walk.
  // A few agents at a time: the wall time is still roughly the slowest single
  // agent's, and a store-answered agent takes no slot's worth of time. All at
  // once, a forced read of twelve installed CLIs came back with some of them
  // degraded (a discovery timed out to its defaults, a version probe gave
  // nothing), and what a read returns is kept for later launches.
  const agentNames = agentRegistry.list();
  const queue = new PQueue({ concurrency: LIST_BUILD_CONCURRENCY });
  const reads = await Promise.all(agentNames.map((agentName) => (
    queue.add(() => readAgent(agentName, cliPathOverrides, forceRefresh))
  )));
  const list = reads.map((read) => read.entry);
  const answeredByStore = reads.filter((read) => read.fromStore);
  const key = cliPathsKey(cliPathOverrides);
  if (answeredByStore.length === 0) {
    storeServed.delete(key);
    return list;
  }
  storeServed.set(key, {
    cliPathOverrides: { ...cliPathOverrides },
    list,
    agentNames: new Set(answeredByStore.map((read) => read.entry.name)),
  });
  // Before the launch settles an agent in use was answered by the store too. Read those once it
  // has. Asked of the reads as well as of the clock: a build that began before the launch settled
  // and ended after it holds such an agent, and nothing else would read it.
  if (!isBootSettled() || answeredByStore.some((read) => read.inUse)) scheduleInUseRead(0);
  return list;
}

/**
 * Something has started an agent this launch had only remembered: its entry is
 * read from its CLI. Main wires this to the detectors (`setFirstLiveDetectionListener`).
 */
export function agentNowInUse(): void {
  scheduleInUseRead(IN_USE_READ_DELAY_MS);
}

function scheduleInUseRead(delayMs: number): void {
  if (inUseReadScheduled) return;
  inUseReadScheduled = true;
  void whenBootSettled().then(() => {
    const timer = setTimeout(() => void readAgentsNowInUse(), delayMs);
    timer.unref?.();
  });
}

/** JSON with every object's keys sorted, so two inventories compare by content. An absent field and an undefined one read the same. */
function contentOf(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
  });
}

/**
 * Read, from its CLI, each store-answered agent that something has started
 * since. An agent still only remembered is left as it is: no process is started
 * to check on a CLI nobody is using. This is what corrects, for an agent in
 * use, a version that moved under an unchanged file (a version manager's shim),
 * a sign-in that changed while the app was closed, and a model list that grew.
 */
async function readAgentsNowInUse(): Promise<void> {
  inUseReadScheduled = false;
  for (const [key, tracked] of [...storeServed]) {
    const startedAt = Date.now();
    const epoch = inventoryEpoch;
    try {
      const queue = new PQueue({ concurrency: IN_USE_READ_CONCURRENCY });
      const fresh = new Map<string, AgentDetectionInfo>();
      await Promise.all([...tracked.agentNames].map((agentName) => queue.add(async () => {
        const adapter = agentRegistry.getOrThrow(agentName);
        const info = await detectForList(adapter, tracked.cliPathOverrides[agentName] ?? null);
        if (info.remembered) return;
        const read = await readFromCli(agentName, adapter, info, false);
        fresh.set(agentName, entryOf(agentName, adapter, info, read.authenticated, read.capabilities));
      })));
      // A Re-detect or a config save since the read began dropped the caches:
      // the next caller builds its own, and this one may be for paths no longer set.
      if (fresh.size === 0 || epoch !== inventoryEpoch) continue;
      for (const agentName of fresh.keys()) tracked.agentNames.delete(agentName);
      if (tracked.agentNames.size === 0) storeServed.delete(key);
      const next = tracked.list.map((entry) => fresh.get(entry.name) ?? entry);
      const changed = contentOf(next) !== contentOf(tracked.list);
      tracked.list = next;
      agentListCacheFor(tracked.cliPathOverrides).replace(next);
      console.log(`[agent-list] read ${fresh.size} agents in use in ${Date.now() - startedAt} ms: ${changed ? 'changed' : 'as shown'}`);
      if (changed) hooks.onChanged?.();
    } catch (error) {
      // Every step inside catches its own CLI failure, so what reaches here is a defect.
      console.warn('[agent-list] a deferred read failed:', error instanceof Error ? error.name : 'unknown');
      hooks.failureReporter?.report(error, { tags: { stage: 'in_use_read' } });
    }
  }
}

/** What an adapter declares about itself, the same whichever machine its CLI is looked for on. */
function adapterFacts(agentName: string, adapter: AgentAdapter): Omit<AgentDetectionInfo, 'found' | 'path' | 'version'> {
  return {
    name: agentName,
    displayName: adapter.displayName,
    supportsWslCli: adapter.supportsWslCli === true,
    permissions: adapter.permissions,
    defaultPermission: adapter.defaultPermission,
    liveTelemetryUnsupported: adapter.liveTelemetryUnsupported,
    reportsRateLimits: adapter.reportsRateLimits,
    pastedImageNativeExtensions: adapter.pastedImageNativeExtensions,
    pastedImageReferenceTemplate: adapter.pastedImageReferenceTemplate,
    supportsSummarize: typeof adapter.summarize === 'function',
    reportsTurnEnd: adapter.runtime.reportsTurnEnd,
    reportsUserMessages: canReadTurnUserMessages(adapter),
    supportsAnswerFromContext: typeof adapter.answerFromContext === 'function',
    answerCapabilities: adapter.answerCapabilities,
    kangenticMcp: adapter.kangenticMcp,
    supportsWorkflowAgent: canBeWorkflowAgent(adapter),
    supportsPlanAutoApproval: adapter.supportsPlanAutoApproval === true,
    remoteExecution: adapter.remoteExecution?.info,
    launchOptions: adapter.launchOptions,
  };
}

/** One cached inventory per host, read off the host itself. */
const hostAgentListCaches = new Map<string, CachedSingleton<AgentDetectionInfo[]>>();

/**
 * The inventory for a remote project: each agent's CLI looked for on the host, never on this computer.
 * Capabilities (the model list, auth) come from running the CLI, so a host's agents carry none and the
 * pickers fall back to free-form input. Only a whole answer is cached: an agent the host could not
 * be asked about (the link is down) leaves the inventory uncached, so the next read asks again.
 */
export async function listAgentsOnHost(
  hostId: string,
  probe: (cliName: string) => Promise<HostAgentProbe>,
  forceRefresh = false,
): Promise<AgentDetectionInfo[]> {
  let cache = hostAgentListCaches.get(hostId);
  if (!cache) {
    cache = createCachedSingleton<AgentDetectionInfo[]>();
    hostAgentListCaches.set(hostId, cache);
  }
  const list = await cache.get(() => buildHostAgentList(hostId, probe), forceRefresh);
  if (list.some((entry) => entry.hostStatus === 'unknown')) cache.invalidate();
  return list;
}

async function buildHostAgentList(hostId: string, probe: (cliName: string) => Promise<HostAgentProbe>): Promise<AgentDetectionInfo[]> {
  return Promise.all(
    agentRegistry.list().map(async (agentName): Promise<AgentDetectionInfo> => {
      const adapter = agentRegistry.getOrThrow(agentName);
      const facts = { ...adapterFacts(agentName, adapter), hostId };
      if (!adapter.remoteCliName) {
        return { ...facts, found: false, path: null, version: null, unsupportedOnHost: true };
      }
      const answer = await probe(adapter.remoteCliName);
      return {
        ...facts,
        found: answer.status === 'found',
        // The CLI's name on the host, which its login shell resolves: the field shows it as the default.
        path: adapter.remoteCliName,
        version: answer.version,
        hostStatus: answer.status,
        ...(answer.detail ? { detectionError: answer.detail } : {}),
      };
    }),
  );
}

/** A host's link came up, or its CLIs may have changed: the next read asks the host again. */
export function invalidateHostAgentList(hostId: string): void {
  hostAgentListCaches.get(hostId)?.invalidate();
  hostAgentListCaches.delete(hostId);
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
  for (const hostId of [...hostAgentListCaches.keys()]) invalidateHostAgentList(hostId);
  storeServed.clear();
  inUseReadScheduled = false;
  hooks = {};
}
