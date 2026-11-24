/**
 * Which agents the inventory starts a CLI for.
 *
 * Listing the agents used to start every installed CLI three or four times at
 * every launch, and one slow CLI among them held other terminals' input for
 * seconds while it answered. The rule under test: an agent nothing has started
 * this launch is listed from the probe store and no process is started for it,
 * and an agent in use is read from its CLI, after the launch has settled.
 *
 * What a user loses if this breaks: typing lags at every launch again, or the
 * list keeps showing an agent they use as it was days ago. The real
 * `agent-list.ts`, the real settle signal on a fake clock, and the real probe
 * store on a temp file. The adapters are stand-ins, since each real one starts
 * its own CLI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities } from '../../src/shared/types';
import type { AgentInfo, DetectOptions } from '../../src/main/agent/agent-adapter';

interface StandInAdapter {
  name: string;
  displayName: string;
  permissions: { mode: string; label: string }[];
  defaultPermission: string;
  runtime: { reportsTurnEnd: boolean };
  detect: (overridePath?: string | null, options?: DetectOptions) => Promise<AgentInfo>;
  probeAuth: (cliPath: string) => Promise<boolean | null>;
  discoverCapabilities: (cliPath: string, forceRefresh?: boolean) => Promise<AgentCapabilities>;
  invalidateDetectionCache: () => void;
}

let adapters: StandInAdapter[] = [];

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => adapters.map((adapter) => adapter.name),
    getOrThrow: (name: string) => {
      const adapter = adapters.find((candidate) => candidate.name === name);
      if (!adapter) throw new Error(`No adapter for ${name}`);
      return adapter;
    },
    get: (name: string) => adapters.find((candidate) => candidate.name === name) ?? null,
  },
}));

import { agentNowInUse, invalidateAgentListCache, listAgents, resetAgentListForTests, setAgentListHooks } from '../../src/main/agent/agent-list';
import {
  enableAgentProbeStore,
  flushAgentProbeStoreForTests,
  resetAgentProbeStoreForTests,
} from '../../src/main/agent/shared/agent-probe-store';
import { BOOT_SETTLE_FLOOR_MS, beginBoot, isBootSettled, noteWindowLoaded, resetBootSettleForTests } from '../../src/main/boot-settle';

/** One CLI on this machine, as its adapter sees it. The test changes these between launches. */
interface StandInCli {
  path: string;
  version: string;
  signedIn: boolean;
  models: string[];
}

let root: string;
let storePath: string;
let clis: Map<string, StandInCli>;
/** What each CLI file answered the last time it was really probed: the detectors' share of the probe store. */
let lastProbedVersion: Map<string, string>;
/** The agents something has started this launch: a live detection exists for them. */
let inUse: Set<string>;
/** How long a capability discovery takes, on the fake clock. Zero answers at once. */
let discoverMs: number;
let discoveriesRunning: number;
let mostDiscoveriesAtOnce: number;

function standIn(name: string, cli: StandInCli | null): StandInAdapter {
  if (cli) clis.set(name, cli);
  return {
    name,
    displayName: name,
    permissions: [{ mode: 'default', label: 'Default' }],
    defaultPermission: 'default',
    runtime: { reportsTurnEnd: false },
    detect: vi.fn(async (overridePath?: string | null, options?: DetectOptions): Promise<AgentInfo> => {
      const installed = clis.get(name);
      if (!installed) return { found: false, path: null, version: null };
      const cliPath = overridePath ?? installed.path;
      // What the detector does: with nothing live, a file it probed on an
      // earlier launch is answered with what it said then, and nothing starts.
      const saidBefore = lastProbedVersion.get(`${name}\n${cliPath}`);
      if (options?.allowRemembered && !inUse.has(name) && saidBefore !== undefined) {
        return { found: true, path: cliPath, version: saidBefore, remembered: true };
      }
      lastProbedVersion.set(`${name}\n${cliPath}`, installed.version);
      return { found: true, path: cliPath, version: installed.version };
    }),
    probeAuth: vi.fn(async () => clis.get(name)?.signedIn ?? null),
    discoverCapabilities: vi.fn(async () => {
      discoveriesRunning += 1;
      mostDiscoveriesAtOnce = Math.max(mostDiscoveriesAtOnce, discoveriesRunning);
      if (discoverMs > 0) await new Promise((resolve) => setTimeout(resolve, discoverMs));
      discoveriesRunning -= 1;
      return { supportsModelOverride: true, models: [...(clis.get(name)?.models ?? [])] };
    }),
    invalidateDetectionCache: vi.fn(),
  };
}

function cli(name: string, overrides: Partial<StandInCli> = {}): StandInCli {
  return { path: path.join(root, 'bin', name), version: '1.0.0', signedIn: true, models: ['fast-1'], ...overrides };
}

function adapterNamed(name: string): StandInAdapter {
  const adapter = adapters.find((candidate) => candidate.name === name);
  if (!adapter) throw new Error(`No stand-in for ${name}`);
  return adapter;
}

/** How many times each agent's CLI was started for its sign-in state or capabilities. */
function cliReads(): Record<string, number> {
  return Object.fromEntries(adapters.map((adapter) => [
    adapter.name,
    vi.mocked(adapter.probeAuth).mock.calls.length + vi.mocked(adapter.discoverCapabilities).mock.calls.length,
  ]));
}

/** A launch with nothing to remember: every agent is read from its CLI, and the answers are kept. */
async function firstLaunch(cliPathOverrides: Record<string, string> = {}): Promise<void> {
  await listAgents(cliPathOverrides);
  await flushAgentProbeStoreForTests();
}

/** The next launch: a new process, the same store on disk, nothing started yet, not settled. */
function nextLaunch(): void {
  resetAgentListForTests();
  resetAgentProbeStoreForTests();
  enableAgentProbeStore(storePath);
  for (const adapter of adapters) {
    vi.mocked(adapter.detect).mockClear();
    vi.mocked(adapter.probeAuth).mockClear();
    vi.mocked(adapter.discoverCapabilities).mockClear();
  }
  inUse = new Set();
  mostDiscoveriesAtOnce = 0;
  beginBoot();
  noteWindowLoaded();
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(BOOT_SETTLE_FLOOR_MS);
  // A deferred read runs on the timers the stand-in discoveries set.
  await vi.advanceTimersByTimeAsync(10_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-list-boot-'));
  storePath = path.join(root, 'config', 'agent-probe-cache.json');
  clis = new Map();
  lastProbedVersion = new Map();
  inUse = new Set();
  discoverMs = 0;
  discoveriesRunning = 0;
  mostDiscoveriesAtOnce = 0;
  resetAgentListForTests();
  resetBootSettleForTests();
  resetAgentProbeStoreForTests();
  enableAgentProbeStore(storePath);
});

afterEach(() => {
  resetAgentListForTests();
  resetBootSettleForTests();
  resetAgentProbeStoreForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent inventory', () => {
  it('lists an agent nothing has started from the last launch, and starts no CLI for it', async () => {
    adapters = [standIn('alpha', cli('alpha', { signedIn: false, models: ['fast-1', 'deep-2'] })), standIn('missing', null)];
    await firstLaunch();

    nextLaunch();
    const list = await listAgents({});

    expect(list.map((entry) => [entry.name, entry.found, entry.version])).toEqual([['alpha', true, '1.0.0'], ['missing', false, null]]);
    expect(list[0].authenticated).toBe(false);
    expect(list[0].capabilities).toEqual({ supportsModelOverride: true, models: ['fast-1', 'deep-2'] });
    expect(adapterNamed('alpha').detect).toHaveBeenCalledWith(null, { allowRemembered: true });
    expect(cliReads()).toEqual({ alpha: 0, missing: 0 });
  });

  it('never starts a CLI nobody is using, at the launch, once it settles, or on a later list', async () => {
    adapters = ['used-one', 'used-two', 'idle-one', 'idle-two'].map((name) => standIn(name, cli(name)));
    await firstLaunch();

    nextLaunch();
    // The launch resumes two agents: their spawns detect them for real.
    inUse = new Set(['used-one', 'used-two']);
    await listAgents({});
    // While the launch settles, the agents in use are answered by the store too.
    expect(cliReads()).toEqual({ 'used-one': 0, 'used-two': 0, 'idle-one': 0, 'idle-two': 0 });

    await settle();
    expect(cliReads()).toEqual({ 'used-one': 2, 'used-two': 2, 'idle-one': 0, 'idle-two': 0 });

    // A config save drops the list. The next one still starts nothing for an agent not in use.
    invalidateAgentListCache();
    await listAgents({});
    expect(cliReads()['idle-one']).toBe(0);
    expect(cliReads()['idle-two']).toBe(0);
  });

  it('reads an agent in use that the store answered when the build began before the launch settled and ended after', async () => {
    adapters = [standIn('alpha', cli('alpha'))];
    await firstLaunch();
    // Installed since, so the store holds nothing for it and its read goes to the CLI.
    const slow = standIn('slow', cli('slow'));
    adapters = [...adapters, slow];
    let finishSlowRead: () => void = () => undefined;
    const slowRead = new Promise<void>((resolve) => {
      finishSlowRead = resolve;
    });
    vi.mocked(slow.discoverCapabilities).mockImplementation(async () => {
      await slowRead;
      return { supportsModelOverride: true, models: ['fast-1'] };
    });

    nextLaunch();
    inUse = new Set(['alpha', 'slow']);
    const building = listAgents({});
    // The store answers the agent in use while the launch is unsettled, and the slow read keeps the build open.
    // The store file is read from disk in real time, so wait on the slow agent's read starting.
    await vi.waitFor(() => expect(vi.mocked(slow.discoverCapabilities)).toHaveBeenCalledTimes(1));
    expect(isBootSettled()).toBe(false);
    expect(cliReads().alpha).toBe(0);

    // The launch settles with the build still running, then the slow read ends it.
    await vi.advanceTimersByTimeAsync(BOOT_SETTLE_FLOOR_MS);
    expect(isBootSettled()).toBe(true);
    expect(cliReads().alpha).toBe(0);
    finishSlowRead();
    await building;
    // No agentNowInUse call: the build itself saw that it held an agent in use.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(cliReads().alpha).toBe(2);
  });

  it('reads the agents in use two at a time', async () => {
    adapters = ['one', 'two', 'three', 'four', 'five'].map((name) => standIn(name, cli(name)));
    await firstLaunch();

    nextLaunch();
    inUse = new Set(['one', 'two', 'three', 'four', 'five']);
    discoverMs = 200;
    await listAgents({});
    await settle();

    expect(cliReads()).toEqual({ one: 2, two: 2, three: 2, four: 2, five: 2 });
    expect(mostDiscoveriesAtOnce).toBe(2);
  });

  // All at once, a forced read of twelve installed CLIs came back with three of them degraded,
  // and what a read returns is kept for later launches.
  it('reads four agents at a time when it has to read them all', async () => {
    adapters = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((name) => standIn(name, cli(name)));
    discoverMs = 200;

    const forced = listAgents({}, true);
    await vi.advanceTimersByTimeAsync(5_000);
    const list = await forced;

    expect(list.map((entry) => entry.name)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
    expect(cliReads()).toEqual({ one: 2, two: 2, three: 2, four: 2, five: 2, six: 2, seven: 2 });
    expect(mostDiscoveriesAtOnce).toBe(4);
  });

  it('never answers one CLI path with what another path said', async () => {
    adapters = [standIn('alpha', cli('alpha'))];
    await firstLaunch({ alpha: path.join(root, 'project-a', 'alpha') });

    nextLaunch();
    // Another project points the agent at its own CLI, same version.
    await listAgents({ alpha: path.join(root, 'project-b', 'alpha') });

    const alpha = adapterNamed('alpha');
    expect(alpha.discoverCapabilities).toHaveBeenCalledTimes(1);
    expect(alpha.discoverCapabilities).toHaveBeenCalledWith(path.join(root, 'project-b', 'alpha'), false);
  });

  it('stays quiet when the read of an agent in use matches what was listed, and installs it', async () => {
    adapters = [standIn('alpha', cli('alpha'))];
    await firstLaunch();
    const onChanged = vi.fn();

    nextLaunch();
    setAgentListHooks({ onChanged });
    inUse = new Set(['alpha']);
    const listed = await listAgents({});
    await settle();

    expect(cliReads()).toEqual({ alpha: 2 });
    expect(onChanged).not.toHaveBeenCalled();
    await expect(listAgents({})).resolves.toEqual(listed);
    // Served from the installed read: the next caller started nothing.
    expect(cliReads()).toEqual({ alpha: 2 });
  });

  it('tells the windows when the read of an agent in use differs from what was listed', async () => {
    adapters = [standIn('alpha', cli('alpha', { signedIn: true }))];
    await firstLaunch();
    const onChanged = vi.fn();

    nextLaunch();
    setAgentListHooks({ onChanged });
    inUse = new Set(['alpha']);
    // Signed out, and a model added, while the app was closed.
    clis.set('alpha', cli('alpha', { signedIn: false, models: ['fast-1', 'new-3'] }));
    await expect(listAgents({})).resolves.toMatchObject([{ name: 'alpha', authenticated: true }]);

    await settle();

    expect(onChanged).toHaveBeenCalledTimes(1);
    await expect(listAgents({})).resolves.toMatchObject([
      { name: 'alpha', authenticated: false, capabilities: { models: ['fast-1', 'new-3'] } },
    ]);
  });

  it('reads an agent the first time something starts it', async () => {
    adapters = [standIn('alpha', cli('alpha')), standIn('later', cli('later', { signedIn: true }))];
    await firstLaunch();
    const onChanged = vi.fn();

    nextLaunch();
    setAgentListHooks({ onChanged });
    await listAgents({});
    await settle();
    expect(cliReads()).toEqual({ alpha: 0, later: 0 });

    // An hour in, a task starts on the second agent. Its spawn detects it for real.
    clis.set('later', cli('later', { signedIn: false }));
    inUse.add('later');
    agentNowInUse();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(cliReads()).toEqual({ alpha: 0, later: 2 });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await expect(listAgents({})).resolves.toMatchObject([{ name: 'alpha' }, { name: 'later', authenticated: false }]);
  });

  it('installs nothing over a list that was invalidated while the read ran', async () => {
    adapters = [standIn('alpha', cli('alpha', { signedIn: true }))];
    await firstLaunch();
    const onChanged = vi.fn();

    nextLaunch();
    setAgentListHooks({ onChanged });
    inUse = new Set(['alpha']);
    clis.set('alpha', cli('alpha', { signedIn: false }));
    discoverMs = 500;
    await listAgents({});
    await vi.advanceTimersByTimeAsync(BOOT_SETTLE_FLOOR_MS);
    // A config save lands while the read is waiting on the CLI.
    invalidateAgentListCache();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onChanged).not.toHaveBeenCalled();
    const readsBefore = cliReads().alpha;
    const rebuilt = listAgents({});
    await vi.advanceTimersByTimeAsync(1_000);
    // The next caller built its own list: the read's result was not put in its place.
    await expect(rebuilt).resolves.toMatchObject([{ name: 'alpha', authenticated: false }]);
    expect(cliReads().alpha).toBe(readsBefore + 2);
  });

  it('reads every agent where nothing is remembered, and on a forced refresh', async () => {
    adapters = [standIn('alpha', cli('alpha'))];

    // A first launch has no store to read: every agent is asked.
    nextLaunch();
    await listAgents({});
    const alpha = adapterNamed('alpha');
    expect(alpha.discoverCapabilities).toHaveBeenCalledTimes(1);
    await flushAgentProbeStoreForTests();

    // Re-detect reads the CLI, whatever the store holds and whoever is using it.
    nextLaunch();
    await listAgents({}, true);
    expect(alpha.detect).toHaveBeenLastCalledWith(null);
    expect(alpha.discoverCapabilities).toHaveBeenCalledWith(cli('alpha').path, true);
  });
});
