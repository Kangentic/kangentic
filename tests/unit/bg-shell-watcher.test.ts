/**
 * Tests for BgShellWatcher with a MockProcessTreeProbe so we can
 * deterministically simulate process trees and OS state without
 * spawning real children.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BgShellWatcher,
  AGENT_ABSENCE_CONFIRM_CYCLES,
  NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES,
  POLL_BACKOFF_STAGE_ONE_TREE_CYCLES,
  POLL_BACKOFF_STAGE_TWO_TREE_CYCLES,
  type BgShellWatcherCallbacks,
  type OutputFileSample,
} from '../../src/main/activity-engine/background-shell/watcher';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';

class MockProcessTreeProbe implements ProcessTreeProbe {
  alive = new Set<number>();
  /**
   * Map of rootPid -> ProcessInfo[] for direct lookup. The fixtures
   * use disjoint pid ranges per session so the union of all entries
   * is a valid `listAllProcesses` result and `walkDescendants` from
   * each rootPid finds only that session's subtree.
   */
  trees = new Map<number, ProcessInfo[]>();
  /**
   * When true, `listAllProcesses` returns []. Simulates a real probe
   * failure (PowerShell timeout, etc.). The watcher's snapshot-health
   * guard uses an empty result OR a snapshot missing rootPid as the
   * "skip this cycle" signal.
   */
  failProbe = false;
  /** Call counters for performance regression assertions. */
  listAllCalls = 0;
  listDescendantsCalls = 0;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    this.listAllCalls += 1;
    if (this.failProbe) return [];
    const all: ProcessInfo[] = [];
    // Real `listAllProcesses` enumerates every process on the host -
    // which by definition includes the rootPid for each registered
    // session. The watcher uses rootPid presence as its probe-health
    // discriminator, so the mock must reflect that contract. `ppid`
    // and `comm` for the rootPid entry are placeholders: nothing in
    // the watcher reads them (walkDescendants returns descendants
    // only, and 'claude' is not in the shell-like allowlist).
    for (const [rootPid, descendants] of this.trees.entries()) {
      if (this.alive.has(rootPid)) {
        all.push({ pid: rootPid, ppid: 0, comm: 'claude' });
      }
      all.push(...descendants);
    }
    return all;
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    this.listDescendantsCalls += 1;
    return this.trees.get(rootPid) ?? [];
  }

  /** Track dispose calls so the BgShellWatcher.dispose() wiring can be asserted. */
  disposeCalls = 0;
  dispose(): void {
    this.disposeCalls += 1;
  }
}

interface CallbackLog {
  naturalExits: Array<{ sessionId: string; exitedCount: number }>;
  shellPidExited: Array<{ sessionId: string; shellId: string }>;
  namedShellLikelyExited: Array<{ sessionId: string; shellId: string }>;
  namedShellTerminated: Array<{ sessionId: string; shellId: string }>;
  rootDied: string[];
  observedAlive: string[];
  agentAbsent: string[];
}

function makeWatcher(opts?: {
  pollIntervalMs?: number;
  rootPidMap?: Map<string, number>;
  shellCountMap?: Map<string, number>;
  pendingToolMap?: Map<string, number>;
  namedShellMap?: Map<string, string[]>;
  outputPathMap?: Map<string, string>;
  mockFiles?: Map<string, OutputFileSample>;
  /**
   * Scripted transcript-drain reader keyed by shell id. Defaults to empty so
   * `reportTerminatedShellsFromTranscript` returns [] and the transcript-drain
   * path stays inert for every existing test. A test opts in by adding an id
   * to this set, then asserting `log.namedShellTerminated`.
   */
  terminatedShellIds?: Set<string>;
  /**
   * Sessions the agent-absence sweep is allowed to judge. Defaults to EMPTY, so
   * `isAgentAbsenceCandidate` returns false and the sweep stays completely
   * inert for every pre-existing test - mirroring production, where an
   * unwired SessionTelemetry callback defaults to false.
   */
  agentAbsenceCandidates?: Set<string>;
  agentAbsenceSweepIntervalMs?: number;
}) {
  const probe = new MockProcessTreeProbe();
  const log: CallbackLog = {
    naturalExits: [],
    shellPidExited: [],
    namedShellLikelyExited: [],
    namedShellTerminated: [],
    rootDied: [],
    observedAlive: [],
    agentAbsent: [],
  };
  const agentAbsenceCandidates = opts?.agentAbsenceCandidates ?? new Set<string>();
  const rootPids = opts?.rootPidMap ?? new Map<string, number>();
  const shellCounts = opts?.shellCountMap ?? new Map<string, number>();
  const pendingTools = opts?.pendingToolMap ?? new Map<string, number>();
  // Named shell ids per session. Defaults to empty, so `getActiveShellCount`
  // entries are all treated as anonymous (matching the pre-Tier-A behavior
  // every existing test relies on).
  const namedShells = opts?.namedShellMap ?? new Map<string, string[]>();
  // Output-file liveness (Incident B). `outputPaths` maps a shell id to its
  // resolved output path; defaults to empty so `resolveShellOutputFile` returns
  // null and the file-growth path stays inert for every existing test.
  // `mockFiles` maps a resolved path to its current size/mtime sample.
  const outputPaths = opts?.outputPathMap ?? new Map<string, string>();
  const mockFiles = opts?.mockFiles ?? new Map<string, OutputFileSample>();
  const terminatedShellIds = opts?.terminatedShellIds ?? new Set<string>();

  const callbacks: BgShellWatcherCallbacks = {
    onNaturalExit(sessionId, exitedCount) {
      log.naturalExits.push({ sessionId, exitedCount });
    },
    onShellPidExited(sessionId, shellId) {
      log.shellPidExited.push({ sessionId, shellId });
    },
    onNamedShellLikelyExited(sessionId, shellId) {
      log.namedShellLikelyExited.push({ sessionId, shellId });
    },
    onNamedShellTerminated(sessionId, shellId) {
      log.namedShellTerminated.push({ sessionId, shellId });
    },
    onRootProcessDied(sessionId) {
      log.rootDied.push(sessionId);
    },
    onShellsObservedAlive(sessionId) {
      log.observedAlive.push(sessionId);
    },
    resolveShellOutputFile(_sessionId, shellId) {
      return outputPaths.get(shellId) ?? null;
    },
    reportTerminatedShellsFromTranscript(_sessionId, shellIds) {
      return shellIds.filter((shellId) => terminatedShellIds.has(shellId));
    },
    getRootPid(sessionId) {
      return rootPids.get(sessionId);
    },
    getActiveShellCount(sessionId) {
      return shellCounts.get(sessionId) ?? 0;
    },
    getNamedShellIds(sessionId) {
      return namedShells.get(sessionId) ?? [];
    },
    getPendingToolCount(sessionId) {
      return pendingTools.get(sessionId) ?? 0;
    },
    isAgentAbsenceCandidate(sessionId) {
      return agentAbsenceCandidates.has(sessionId);
    },
    onAgentProcessAbsent(sessionId) {
      log.agentAbsent.push(sessionId);
    },
  };

  const watcher = new BgShellWatcher({
    callbacks,
    probe,
    pollIntervalMs: opts?.pollIntervalMs ?? 100,
    statOutputFile: (filePath) => mockFiles.get(filePath) ?? null,
    // 0 = "always due", so a test driving cycles with pollNow() under frozen
    // fake timers sweeps on every cycle. Cadence tests override it.
    agentAbsenceSweepIntervalMs: opts?.agentAbsenceSweepIntervalMs ?? 0,
  });

  return { watcher, probe, log, rootPids, shellCounts, pendingTools, namedShells, outputPaths, mockFiles, terminatedShellIds, agentAbsenceCandidates };
}

describe('BgShellWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start polling until a session is registered', () => {
    const { watcher } = makeWatcher();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('registers a session and captures rootPid', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');
    // Polling timer should now be armed
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    watcher.dispose();
  });

  it('refuses to register a session without a valid rootPid', () => {
    const { watcher, rootPids } = makeWatcher();
    rootPids.set('s1', 0);
    watcher.registerSession('s1');
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('detects Claude CLI death and fires onRootProcessDied', async () => {
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    // Now Claude CLI dies
    probe.alive.delete(1234);
    await watcher.pollNow();

    expect(log.rootDied).toContain('s1');
    watcher.dispose();
  });

  it('Tier B: reports natural exit when shell-like descendant count drops', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // 2 shell-like children (e.g. two `bash -c "..."` wrappers)
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    // Anchor baseline at 2
    await watcher.pollNow();

    // One shell exits
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);

    // Lag-tolerance grace: deficit must persist 2 cycles before firing.
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Tier B: caps reported delta at engine tracked count', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
      { pid: 5003, ppid: 1234, comm: 'cmd' },
    ]);
    shellCounts.set('s1', 1); // engine only thinks 1 shell exists

    watcher.registerSession('s1');
    await watcher.pollNow();

    // 2 of 3 disappear (leaves shellLikeCount=1).
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);

    await watcher.pollNow();
    await watcher.pollNow();

    // Cap at engine's tracked count (1)
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Tier B: does not fire when engine reports 0 active shells', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 0); // engine knows of no shells

    watcher.registerSession('s1');
    await watcher.pollNow();

    probe.trees.set(1234, []);
    await watcher.pollNow();

    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B: ignores non-shell-like descendants', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'mcp-server' },
      { pid: 5002, ppid: 1234, comm: 'chrome.exe' },
    ]);
    shellCounts.set('s1', 0);

    watcher.registerSession('s1');
    await watcher.pollNow();

    // MCP server dies - should NOT fire natural exit
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'chrome.exe' },
    ]);

    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier A: reports specific shell PID exit', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    watcher.registerShellPid('s1', 'bash_42', 5001);
    await watcher.pollNow();

    // bash_42's PID disappears. Engine reports tracked count drops from 2 to
    // 1 (set entry was removed when onShellPidExited fired); update mock.
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 1);

    await watcher.pollNow();

    // Tier A fires once for bash_42.
    expect(log.shellPidExited).toEqual([{ sessionId: 's1', shellId: 'bash_42' }]);
    // Tier B does NOT also fire - the watcher decremented baselineShellCount
    // when Tier A reported, so the delta calculation now correctly says zero.
    expect(log.naturalExits).toEqual([]);
    watcher.dispose();
  });

  it('Tier A + Tier B do not double-count when one tracked PID exits among anonymous shells', async () => {
    // Regression test for the prior double-counting bug: if engine has
    // 1 tracked shell (bash_42) + 1 anonymous, and bash_42 dies, only
    // ONE exit should be reported. Pre-fix: Tier A reports bash_42 AND
    // Tier B reports a natural exit for the same descendant, draining
    // the anonymous count to zero even though the anonymous shell is
    // still alive.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },     // bash_42 (Tier A)
      { pid: 5002, ppid: 1234, comm: 'sh' },       // anonymous
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    watcher.registerShellPid('s1', 'bash_42', 5001);
    await watcher.pollNow();

    // bash_42 dies. Engine processes the Tier A onShellPidExited
    // callback synchronously, dropping its tracked count from 2 to 1.
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 1);

    await watcher.pollNow();

    // EXACTLY one Tier A; ZERO Tier B fires. The anonymous shell is
    // still alive and stays uncounted.
    expect(log.shellPidExited).toHaveLength(1);
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('multi-session isolation', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 100);
    rootPids.set('s2', 200);
    probe.alive.add(100);
    probe.alive.add(200);

    probe.trees.set(100, [
      { pid: 1001, ppid: 100, comm: 'bash' },
      { pid: 1002, ppid: 100, comm: 'bash' },
    ]);
    probe.trees.set(200, [{ pid: 2001, ppid: 200, comm: 'sh' }]);
    shellCounts.set('s1', 2);
    shellCounts.set('s2', 1);

    watcher.registerSession('s1');
    watcher.registerSession('s2');
    // First pollNow anchors preExisting for BOTH sessions.
    await watcher.pollNow();

    // One of s1's shells dies; s2 unchanged.
    probe.trees.set(100, [{ pid: 1001, ppid: 100, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits.filter((e) => e.sessionId === 's1')).toHaveLength(1);
    expect(log.naturalExits.filter((e) => e.sessionId === 's2')).toHaveLength(0);
    watcher.dispose();
  });

  it('shares one OS query across all sessions per cycle (perf regression guard)', async () => {
    // The watcher's cycle calls `listAllProcesses` exactly once and walks
    // each session's subtree from the shared snapshot. Without this, N
    // sessions would trigger N PowerShell spawns per cycle on Windows -
    // a real perf cliff at scale (10+ tasks).
    //
    // This test would fail if cycleSession reverted to calling
    // `probe.listDescendants(rootPid)` per session.
    const { watcher, probe, rootPids } = makeWatcher();
    for (let i = 1; i <= 5; i++) {
      const rootPid = 1000 + i;
      const sessionId = `s${i}`;
      rootPids.set(sessionId, rootPid);
      probe.alive.add(rootPid);
      probe.trees.set(rootPid, [{ pid: 5000 + i, ppid: rootPid, comm: 'bash' }]);
      watcher.registerSession(sessionId);
    }

    probe.listAllCalls = 0;
    probe.listDescendantsCalls = 0;
    await watcher.pollNow();

    expect(probe.listAllCalls).toBe(1);
    expect(probe.listDescendantsCalls).toBe(0);
    watcher.dispose();
  });

  it('unregisterSession stops polling when last session removed', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    watcher.unregisterSession('s1');
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('dispose() is idempotent and clears all sessions', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => watcher.dispose()).not.toThrow();
    // Post-dispose, register is a no-op
    watcher.registerSession('s2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('first cycle anchors baseline against current shell-like descendants without firing callbacks', async () => {
    // Pre-existing helpers (Claude's MCP servers, statusline workers
    // running as long-lived bash wrappers) must not be adopted as
    // background work. The first cycle establishes the baseline
    // silently; subsequent cycles only react to deltas.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);

    watcher.registerSession('s1');
    await watcher.pollNow();

    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases helper baseline up when shell-like descendants appear post-anchor (no adoption)', async () => {
    // Empirical bug regression: agent's MCP server / statusline worker
    // restarts mid-session and spawns a persistent shell-like child.
    // Pre-fix the watcher adopted it as anonymous bg work; the resulting
    // phantom counter stuck the session in `thinking` indefinitely.
    // Post-fix the watcher silently rebases `preExistingHelpers` up so the
    // helper is treated as part of the baseline, not user-initiated bg work.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExistingHelpers=0

    // Cycle 2: 2 helpers materialize after the anchor (e.g. MCP server
    // restart + npm.cmd wrapper).
    probe.trees.set(1234, [
      { pid: 6001, ppid: 1234, comm: 'bash' },
      { pid: 6002, ppid: 1234, comm: 'sh' },
    ]);
    await watcher.pollNow();

    // No adoption: the engine's bg-shell counters are untouched.
    // Real bg shells fire `background_shell_start` hooks which the
    // engine ingests directly via processEvent.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: same shape - in balance with the rebased baseline.
    // No spurious deficit firing, no spurious adoption.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: one helper exits. Rebase baseline DOWN (existing
    // deficit-side behavior). Still no natural-exit fire because
    // tracked=0 (no real bg shells the engine knew about).
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('does not rebase up while engine has pending tools (foreground bash transient)', async () => {
    // Regression: a foreground `Bash` / `BashOutput` / `BashList`
    // invocation spawns a short-lived direct-child bash. The watcher
    // must NOT bake that transient into `preExistingHelpers`; if it
    // did, the bash exit would not register as a deficit and
    // hook-tracked bg-shell exits later in the session would be
    // miscounted.
    const { watcher, probe, rootPids, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor

    // Simulate ToolStart(Bash) -> engine bumps pendingToolCount.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();

    // ToolEnd fires -> pendingToolCount drops. Bash exits same cycle.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, []);
    await watcher.pollNow();

    // No spurious natural exit: tracked stayed at 0 throughout.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases up only after pending tools clear (defers helper attribution)', async () => {
    // Once a foreground tool completes and a persistent shell-like
    // child remains (e.g. MCP server child still running), the
    // watcher should rebase that into `preExistingHelpers` so future
    // cycles treat it as baseline.
    const { watcher, probe, rootPids, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();

    // Foreground tool spawns bash, watcher polls mid-tool -> skip rebase.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();

    // Tool completes; a separate persistent helper remains.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 6002, ppid: 1234, comm: 'sh' }]);
    await watcher.pollNow();

    // No adoption fires (real bg shells go through hooks). And the
    // baseline now includes the helper so subsequent in-balance cycles
    // are silent.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: still in balance with the rebased preExistingHelpers.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('lag race: hook fires before bash spawns - waits one cycle before firing natural exit', async () => {
    // Regression: hooked `background_shell_start` increments engine
    // tracked synchronously, but the OS bash takes 50-500ms to
    // materialize. A watcher cycle landing in that lag window would
    // false-fire natural exit. The fix waits for deficit to persist
    // through 2 consecutive cycles before firing.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExisting=0

    // Hook fires - engine bumps tracked. OS bash NOT yet visible.
    shellCounts.set('s1', 1);
    probe.trees.set(1234, []);
    await watcher.pollNow();
    // Cycle 1: deficit observed but suppressed (lag tolerance).
    expect(log.naturalExits).toHaveLength(0);

    // Bash finally spawns before next cycle. Deficit resolved.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    // Cycle 2: in sync, no false-fire.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('lag race: persistent deficit fires natural exit on the 2nd cycle', async () => {
    // After the lag-tolerance grace, real natural exits still fire.
    // Without this, a stuck deficit would never be reported.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow();

    // One bash exits, the other still alive.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    // Cycle 1 of deficit - suppressed.
    expect(log.naturalExits).toHaveLength(0);

    // Still 1 bash on next cycle - deficit persists.
    await watcher.pollNow();
    // Cycle 2 of deficit - fires.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('foreground tool conflation: defers natural exit while pendingTools > 0', async () => {
    // Regression: a foreground bash and a real bg shell can be alive
    // simultaneously. When the bg shell exits, shellLikeCount stays
    // the same (foreground bash is still there). When the foreground
    // bash exits, shellLikeCount drops. The watcher must NOT attribute
    // that drop to the still-running bg shell - it defers natural
    // exit until pendingTools hits 0.
    const { watcher, probe, rootPids, log, shellCounts, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Start with 2 bg shells so we can simulate one bg shell exiting
    // while the other plus a foreground bash remain alive.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: shellLikeCount=2, tracked=2, preExisting=0

    // Foreground tool starts, spawns its own bash.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // bg shell A
      { pid: 5002, ppid: 1234, comm: 'bash' }, // bg shell B
      { pid: 5003, ppid: 1234, comm: 'bash' }, // foreground bash
    ]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Foreground bash exits but tool is still pending (e.g. processing
    // output). Both bg shells still alive. shellLikeCount drops to 2,
    // equal to expected - no decrement fires.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Foreground tool ends; one bg shell also exits.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    // Cycle 1: deficit observed, suppressed by lag tolerance.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    // Cycle 2: deficit persists, fires.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('hooked starts + foreground tool spawns: count stays in sync with reality (user-reported regression)', async () => {
    // Reproduces the user-reported bug: agent fires multiple
    // `Bash(run_in_background:true)` (hooked) interleaved with
    // foreground `Bash` calls. Without the bug fix, baseline got
    // anchored to OS state during foreground windows, causing false
    // natural-exit fires that decremented engine count incorrectly.
    // Now baseline is derived from engine state directly each cycle,
    // so foreground bashes can come and go without affecting the
    // engine's bg shell tracking.
    const { watcher, probe, rootPids, log, shellCounts, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExisting=0

    // Hooked bg shell A starts. Engine -> tracked=1. OS spawns bash.
    shellCounts.set('s1', 1);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow(); // shellLikeCount=1, expected=1, no change
    expect(log.naturalExits).toHaveLength(0);

    // Foreground Bash B runs - adds a transient bash. pendingToolCount=1.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // A still alive
      { pid: 5002, ppid: 1234, comm: 'bash' }, // B foreground
    ]);
    await watcher.pollNow(); // surplus=1 but pendingTools>0, skip
    expect(log.naturalExits).toHaveLength(0);

    // Foreground B finishes, its bash exits. A still running.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow(); // shellLikeCount=1, expected=1, no false exit fires
    expect(log.naturalExits).toHaveLength(0);

    // Hooked bg shell C starts (second hooked start while A still alive).
    shellCounts.set('s1', 2);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // A
      { pid: 5003, ppid: 1234, comm: 'bash' }, // C
    ]);
    await watcher.pollNow(); // shellLikeCount=2, expected=2, no change
    expect(log.naturalExits).toHaveLength(0);

    // A exits naturally. C still running.
    probe.trees.set(1234, [{ pid: 5003, ppid: 1234, comm: 'bash' }]);
    // Lag-tolerance grace: deficit must persist 2 cycles.
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('probe-health guard: empty snapshot from listAllProcesses is treated as probe failure', async () => {
    // PowerShell on Windows can intermittently exceed our 1.5s probe
    // timeout under load. listAllProcesses returns [] in that case
    // (per process-tree.ts:51 contract). Without this guard, the
    // watcher would treat the empty result as "all tracked shells
    // exited at once" and false-fire natural-exit for every tracked
    // shell. Critical user-visible bug: real bg shells alive but
    // engine reports idle.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
      { pid: 5003, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 3);
    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle anchored preExisting=0, shellLikeCount=3, tracked=3.

    // Probe times out and returns empty. Without the snapshot-health
    // guard, the watcher would see deficit=3 and (after 2 cycles of
    // grace) fire 3 natural-exits.
    probe.failProbe = true;
    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Explicitly assert that consecutiveDeficitCycles was NOT advanced
    // by any of the three probe-failed cycles. We verify this by proxy:
    // when the probe recovers with shells still alive, the first cycle
    // is in balance (no deficit) and fires no callbacks. If probe-failed
    // cycles had incremented the counter, cycle 1 of recovery might
    // spuriously fire or leave residual counter state that fires early.
    probe.failProbe = false;
    // Cycle 1 of recovery: shells still present, count matches expected.
    // consecutiveDeficitCycles must be 0 (not accumulated from failed
    // cycles), so no false deficit logic runs.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B: drains anonymous count when all shells exit at once with healthy probe', async () => {
    // Regression for the activity-engine bg-shell leak: when shells
    // truly exit while the engine still holds an
    // anonymousBackgroundShellCount (from real hook-driven
    // BackgroundShellStart events without a shell_id), the watcher
    // must drain the count via onNaturalExit. The previous
    // count-shape probe-failure guard mis-classified this exact
    // post-exit state as probe failure and skipped every cycle
    // indefinitely, leaving the session pinned in 'thinking' until
    // the 5-min bg-shell-hatch watchdog fired.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Engine has 2 anonymous bg shells from prior unhooked adoption.
    // Probe sees the corresponding 2 OS-level shell-like descendants.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle anchored: preExisting = max(0, 2 - 2) = 0, tracked=2.

    // Both bashes exit naturally between cycles. Snapshot remains
    // healthy (Claude CLI is alive, listAllProcesses succeeds).
    probe.trees.set(1234, []);

    // Lag-tolerance grace: deficit must persist 2 cycles before firing.
    await watcher.pollNow();
    await watcher.pollNow();

    // Should fire ONE onNaturalExit call reporting all 2 exits.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('Tier B: probe recovery after empty-snapshot failure resumes natural-exit detection', async () => {
    // After a transient probe failure, when the probe recovers and
    // sees that shells genuinely exited, the watcher must fire
    // onNaturalExit. The new snapshot-health guard correctly
    // distinguishes "probe failed" from "shells exited" and only
    // suppresses the former.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Probe fails for one cycle (the bashes have already exited but
    // we don't know that yet).
    probe.failProbe = true;
    probe.trees.set(1234, []);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Probe recovers: snapshot healthy, descendants empty.
    probe.failProbe = false;

    // First post-recovery cycle: deficit=2, consecutiveDeficitCycles=1,
    // suppressed by lag tolerance.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Second post-recovery cycle: deficit persists, fires.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('Tier B: regression for activity-engine bg-shell leak (idle tasks shown as Thinking)', async () => {
    // Reproduces the symptom from the bug ticket: engine holds
    // anonymousBackgroundShellCount=2 from real hook-driven
    // BackgroundShellStart events (no shell_id), all OS bashes
    // exited cleanly, no pending tools, no turn active. Sidebar
    // showed "Thinking - 2 background shells" until the 5-min
    // bg-shell-hatch fired. After this fix, the watcher drains the
    // leak within ~2 cycles.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Step 1: agent fired hook BackgroundShellStart events for 2 bg
    // shells (no shell_id, so they tracked anonymously). We jump
    // straight to the post-spawn steady state.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Step 2: agent finishes its turn, every bash exits naturally.
    // Probe is healthy throughout (Claude CLI is alive).
    probe.trees.set(1234, []);

    // Within 2 cycles (~4 sec at 2-sec poll cadence) the watcher
    // must drain the engine's anonymous count to 0.
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('Windows agent CLI launched via cmd shim: bashes under claude still count', async () => {
    // Regression: `claude` on Windows installs as `claude.cmd` (an
    // npm shim). Running it from pwsh produces `pwsh -> cmd[shim] ->
    // node[claude]`. When claude spawns bg shells, the tree is
    // `pwsh -> cmd[shim] -> node[claude] -> bash[bg]`. A naive
    // "skip if any ancestor is shell-like" rule would see the shim
    // cmd as a shell-like ancestor of every bash and skip them all,
    // producing bg=0 even when 3 bashes are running. The fix uses
    // immediate-parent only, so bashes whose parent is the non-shell
    // agent CLI are correctly counted.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 1500, ppid: 1234, comm: 'cmd' },     // npm shim wrapping claude.cmd
      { pid: 2000, ppid: 1500, comm: 'claude' },  // node-based agent CLI
      { pid: 3001, ppid: 2000, comm: 'bash' },    // bg shell 1 - parent is non-shell
      { pid: 3002, ppid: 2000, comm: 'bash' },    // bg shell 2
      { pid: 3003, ppid: 2000, comm: 'bash' },    // bg shell 3
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // shellLikeCount should be 4 (1 shim cmd + 3 bashes), tracked=3,
    // so preExisting = 4 - 3 = 1 (the shim). On subsequent cycles
    // expected stays 4 and shellLikeCount stays 4 - in sync.
    expect(log.naturalExits).toHaveLength(0);

    // One bg shell exits.
    probe.trees.set(1234, [
      { pid: 1500, ppid: 1234, comm: 'cmd' },
      { pid: 2000, ppid: 1500, comm: 'claude' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    await watcher.pollNow();
    await watcher.pollNow(); // lag tolerance
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Windows npm wrapper: bash -> cmd -> node counts as 1 (topmost shell only, no double-count)', async () => {
    // The user-reported bug: agent runs `Bash(run_in_background:true)
    // "npm test"`. On Windows, `npm` is `npm.cmd` which executes via
    // cmd.exe. So the tree is bash -> cmd -> node. Both bash AND cmd
    // match the shell-like allowlist, but cmd is a wrapper inside
    // bash, not a separate logical bg shell. Counting both yields
    // 2 per bg shell. With 3 bg shells: count = 6 (user's screenshot).
    // The fix: skip shells that have a shell-like ancestor in the
    // descendant tree.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      // pwsh's only direct child: the agent CLI (non-shell)
      { pid: 2000, ppid: 1234, comm: 'claude' },
      // 3 bg shells (each Bash run_in_background)
      { pid: 3001, ppid: 2000, comm: 'bash' },
      { pid: 3101, ppid: 3001, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3201, ppid: 3101, comm: 'node' },    // node doesn't match anyway
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3102, ppid: 3002, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3202, ppid: 3102, comm: 'node' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
      { pid: 3103, ppid: 3003, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3203, ppid: 3103, comm: 'node' },
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle: shellLikeCount = 3 (the 3 bashes - cmds skipped),
    // tracked = 3, preExisting = 0. In sync.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('counts shells nested 2 levels deep (rootPid is PTY shell, agent CLI is the level between)', async () => {
    // The user-reported bug: rootPid is the PTY shell wrapper (pwsh),
    // the agent CLI (claude/codex) is a child of pwsh, and the
    // bashes Claude spawns for `Bash(run_in_background:true)` are
    // children of the agent CLI - 2 levels under rootPid. A
    // direct-children-only filter would miss them entirely; the
    // transitive descendant walk catches them.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      // pwsh's only direct child: the agent CLI (node-based, doesn't
      // match the shell-only allowlist).
      { pid: 2000, ppid: 1234, comm: 'claude' },
      // claude spawned 3 bg shells - each is grandchild of pwsh.
      { pid: 3001, ppid: 2000, comm: 'bash' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle: shellLikeCount=3, tracked=3 -> preExisting=0, in sync.
    expect(log.naturalExits).toHaveLength(0);

    // One bg shell exits.
    probe.trees.set(1234, [
      { pid: 2000, ppid: 1234, comm: 'claude' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    await watcher.pollNow();
    await watcher.pollNow(); // lag-tolerance grace
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('shell-like allowlist excludes subprocess chains (npm/node/python under a bash do not double-count)', async () => {
    // One logical bg shell (`bash -c "npm test"`) creates a process
    // tree like bash -> npm -> node -> vitest. The narrow allowlist
    // (bash, sh, cmd, pwsh, etc. - NOT node/npm/python) filters the
    // descendants down to just the top-level shell, so the count
    // matches the agent's logical bg-shell count of 1.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },     // matches allowlist
      { pid: 5002, ppid: 5001, comm: 'npm' },      // does NOT match
      { pid: 5003, ppid: 5002, comm: 'node' },     // does NOT match
      { pid: 5004, ppid: 5003, comm: 'node' },     // does NOT match
      { pid: 5005, ppid: 5003, comm: 'node' },     // does NOT match
    ]);

    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor
    await watcher.pollNow(); // would adopt if surplus

    // Pre-existing helpers count = 1 (just the bash). Subsequent
    // cycles see no delta. Zero adoptions, zero false natural exits.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases surplus only once - does not re-rebase the same persistent helper across cycles', async () => {
    // After a helper appears post-anchor, the watcher rebases
    // `preExistingHelpers` up by the surplus on the cycle that
    // detects it. Subsequent cycles with the same shape see expected
    // == shellLikeCount (in balance) and do nothing. Without correct
    // rebase, the surplus would be detected on every cycle and
    // ratchet preExistingHelpers indefinitely.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();

    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();

    // No real bg shells (engine-tracked=0) and no helper exits =>
    // zero natural-exit fires. Watcher state stayed in balance after
    // the rebase; subsequent cycles are silent.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('preExistingHelpers tracks helper churn symmetrically (rebase down on exit, rebase up on entry)', async () => {
    // The watcher's helper baseline rebases in BOTH directions:
    //   - exit (deficit branch with tracked=0): preExistingHelpers -= delta
    //   - entry (surplus branch with pendingTools=0): preExistingHelpers += surplus
    // Neither produces engine-state mutation when tracked=0; both
    // keep `expected` aligned with reality so subsequent cycles are silent.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    // shellCounts defaults to 0 for 's1' (not set in map) -> tracked=0.

    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: preExistingHelpers=2, tracked=0

    // One pre-existing helper exits. After the 2-cycle deficit lag,
    // the deficit's `else` branch shrinks preExistingHelpers to 1.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Second helper exits. preExistingHelpers shrinks to 0.
    probe.trees.set(1234, []);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // A new helper spawns. Surplus branch rebases preExistingHelpers
    // up to 1. NO adoption fires (real bg shells go through hooks).
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Confirm balance: subsequent cycles with the same shape are silent.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('consecutiveDeficitCycles resets to 0 on surplus (not just on balance), so a subsequent deficit restarts the lag-tolerance counter', async () => {
    // The deficit-counter reset on the surplus path is what prevents
    // a leftover deficit-cycle count from adding to a fresh deficit
    // and firing prematurely. With the surplus branch now rebasing
    // preExistingHelpers (instead of adopting), the reset still
    // matters: a deficit -> surplus -> deficit transition must give
    // the second deficit a full 2-cycle lag grace.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor with 2 shells - engine tracks 2, preExisting=0.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Cycle 1: one shell exits -> deficit=1, consecutiveDeficitCycles=1.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 2: a helper materializes while the original tracked shell
    // is still gone. shellLikeCount=2, expected=preExisting(0)+tracked(2)=2:
    // wait, that's actually balance - the missing shell and the new
    // helper cancel out. Let me arrange it more clearly:
    //   - tracked=2 (engine still thinks 2 hook shells exist)
    //   - preExisting=0
    //   - shellLikeCount=3 (1 original tracked + 2 new helpers)
    //   - expected=2, surplus=1 -> rebase preExistingHelpers to 1
    //   - consecutiveDeficitCycles reset to 0
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 6001, ppid: 1234, comm: 'sh' },
      { pid: 6002, ppid: 1234, comm: 'bash' },
    ]);
    await watcher.pollNow();
    // No adoption (rebased silently). No natural exit (surplus path).
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: balance with rebased preExistingHelpers=1, tracked=2,
    // expected=3. shellLikeCount=3 -> no deficit, no surplus.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Fresh deficit: drop one helper. shellLikeCount=2, expected=3.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 6001, ppid: 1234, comm: 'sh' },
    ]);

    // Cycle 4: deficit=1, consecutiveDeficitCycles=1 (NOT 2 - reset
    // was honored on cycle 2). Lag tolerance suppresses the fire.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 5: deficit persists -> 2 consecutive cycles -> tracked>0
    // path fires natural-exit (capped at tracked count).
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('surplus rebase-up while tracked > 0: rebased helper does not produce spurious second exit when real bg shell exits', async () => {
    // Regression guard: watcher anchors with tracked=1 (one real bg shell),
    // then a helper materializes post-anchor (surplus=1, tracked=1, pendingTools=0).
    // The surplus branch rebases preExistingHelpers up from 0 to 1.
    // When the REAL bg shell subsequently exits (not the helper), exactly one
    // onNaturalExit fires. The rebased helper does NOT produce a second exit.
    //
    // Pre-fix: the surplus was adopted (engine.adoptAnonymousBackgroundShells
    // was called), so the engine believed there were TWO bg shells - the real one
    // AND the phantom helper. When the real shell exited, TWO onNaturalExit calls
    // fired (one per watcher cycle decrement), not one. That double-decrement
    // caused the anonymous counter to underflow, falsely reporting idle.
    //
    // Post-fix: the surplus path rebases preExistingHelpers and returns without
    // touching the engine counter. Only ONE onNaturalExit fires when the real
    // bg shell exits.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor with ONE real bg shell, preExisting=0.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    shellCounts.set('s1', 1);

    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor: preExistingHelpers = max(0, 1-1) = 0

    // Helper materializes post-anchor. shellLikeCount=2, expected=1+1=2? No:
    // expected = preExistingHelpers(0) + tracked(1) = 1. shellLikeCount=2.
    // surplus=1, pendingTools=0 -> rebase preExistingHelpers to 1.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // the real bg shell
      { pid: 6001, ppid: 1234, comm: 'sh' },   // new helper (MCP server restart, etc.)
    ]);
    await watcher.pollNow(); // surplus path: preExistingHelpers=1, no naturalExit
    expect(log.naturalExits).toHaveLength(0);

    // Now the REAL bg shell exits. Helper still alive.
    // shellLikeCount=1, expected=preExisting(1)+tracked(1)=2. deficit=1.
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'sh' }]);

    // Lag-tolerance grace: deficit must persist 2 cycles.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    await watcher.pollNow();

    // EXACTLY one natural exit for the one real bg shell. The rebased helper
    // (preExistingHelpers=1) is correctly excluded from the tracked drain.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('pendingTools > 0 surplus-skip: consecutiveDeficitCycles resets to 0 when pendingTools surplus branch fires', async () => {
    // Documents the precise semantic: when a surplus-while-pending cycle fires,
    // the code runs `state.consecutiveDeficitCycles = 0` BEFORE returning.
    // This means a prior deficit that was building lag tolerance gets WIPED.
    // A subsequent fresh deficit therefore restarts the 2-cycle grace from zero.
    //
    // Scenario: cycle 1 deficit (consecutiveDeficitCycles=1), cycle 2
    // surplus-while-pending (resets consecutiveDeficitCycles to 0), cycle 3
    // clean surplus (preExistingHelpers rebased, consecutiveDeficitCycles=0),
    // cycle 4 fresh deficit -> suppressed (cycle 1 of new deficit grace).
    // cycle 5 deficit persists -> fires.
    //
    // If consecutiveDeficitCycles was NOT reset in the pending-surplus path,
    // cycle 4 would be cycle 2 of the deficit and fire prematurely.
    const { watcher, probe, rootPids, shellCounts, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor: 2 tracked bg shells, no helpers.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: preExistingHelpers=0

    // Cycle 1: one shell exits -> deficit=1. consecutiveDeficitCycles becomes 1.
    // Lag tolerance suppresses.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 2: surplus-while-pending. A foreground bash appears while
    // pendingTools=1. shellLikeCount=2, expected=0+2=2. Wait, with only 1
    // tracked shell visible + foreground bash = 2. tracked still reports 2
    // (the engine has not received a decrement yet). Hmm - let's set
    // shellCounts back to 2 to simulate the engine still thinking both alive.
    //
    // More precisely: the ENGINE still thinks 2 bg shells exist (no
    // onNaturalExit was fired yet because lag tolerance suppressed cycle 1).
    // A foreground Bash tool starts (pendingTools=1) and adds 1 bash.
    // shellLikeCount=2, expected=preExisting(0)+tracked(2)=2. Balanced -
    // no surplus, no deficit. That's not what we want to test.
    //
    // Rework: set up a scenario where shellLikeCount > expected while
    // pendingTools>0. Requires preExistingHelpers < shellLikeCount - tracked.
    // With preExisting=0, tracked=2 (from engine): if we have 3 shell-like
    // procs visible and pendingTools=1, then surplus=1 with pending tools.
    // deficit from cycle 1 was: tracked=2, visible=1, so deficit=1,
    // consecutiveDeficitCycles=1. Now cycle 2: visible=3, tracked=2,
    // expected=0+2=2, surplus=1, pendingTools=1 -> reset consecutiveDeficitCycles=0, return.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // bg shell (visible)
      { pid: 5002, ppid: 1234, comm: 'sh' },   // bg shell comes back? or
      { pid: 7001, ppid: 1234, comm: 'bash' }, // foreground bash
    ]);
    pendingTools.set('s1', 1);
    await watcher.pollNow();
    // consecutiveDeficitCycles should now be 0 (reset by surplus-while-pending path).
    // Verify by proxy: the NEXT deficit gives a fresh 2-cycle grace,
    // not a truncated 1-cycle grace.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: foreground tool ends, its bash exits, surplus helper remains.
    // pendingTools=0. shellLikeCount=2, expected=0+2=2. Balanced.
    // Wait, the scenario is getting complex - let's verify the key property:
    // after the reset in cycle 2, a new deficit from cycle 3 gets FULL grace.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    // shellLikeCount=2, expected=0+2=2. In balance -> consecutiveDeficitCycles=0.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: one bg shell exits again (fresh deficit after reset).
    // consecutiveDeficitCycles increments from 0 to 1. Suppressed.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 5: deficit persists. consecutiveDeficitCycles=2. FIRES.
    // This confirms the full 2-cycle grace was granted, not a truncated 1.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('dispose() calls probe.dispose() exactly once', () => {
    // BgShellWatcher.dispose() must release the probe's long-lived
    // resources (Windows persistent PowerShell child). Without this
    // call, `pwsh.exe` would survive as an orphan after app shutdown,
    // paying .NET startup cost on the next launch instead of on the
    // next query. The `disposeCalls` counter on MockProcessTreeProbe
    // exists precisely to verify this wiring.
    const { watcher, probe, rootPids } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    expect(probe.disposeCalls).toBe(0);
    watcher.dispose();
    expect(probe.disposeCalls).toBe(1);
  });

  it('dispose() calls probe.dispose() exactly once (idempotent - second dispose is a no-op)', () => {
    // BgShellWatcher.dispose() is itself idempotent (guarded by `this.disposed`).
    // The probe must receive exactly one dispose call regardless of how many
    // times watcher.dispose() is called. A double-dispose on the probe would
    // be a bug if the probe's teardown is not itself idempotent.
    const { watcher, probe } = makeWatcher();

    watcher.dispose();
    watcher.dispose();
    expect(probe.disposeCalls).toBe(1);
  });

  it('cycle is non-overlapping (setInterval drops ticks while polling)', async () => {
    // The `polling` guard inside the setInterval handler prevents
    // overlapping cycles when the OS probe is slow. Verify this by
    // advancing fake timers through two ticks while a pollNow() call
    // is still "in flight" (simulated by having probe.listAllProcesses
    // resolve only after we advance time). The probe call count must
    // remain 1 for the first tick window, confirming the second tick
    // was dropped.
    const { watcher, probe, rootPids, shellCounts } = makeWatcher({ pollIntervalMs: 100 });
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    // Give the session a tracked bg shell so every cycle needs the process
    // tree (otherwise the per-cycle laziness gate skips the enumeration and the
    // overlap guard under test is never reached).
    shellCounts.set('s1', 1);

    // Anchor first cycle synchronously so the guard state is clean.
    await watcher.pollNow();
    probe.listAllCalls = 0;

    // Simulate the setInterval firing twice in the same tick window
    // by advancing timers while the watcher is inside a pollNow().
    // Because pollNow() drives cycle() directly (bypassing the
    // setInterval guard), we instead verify the interval path by
    // checking that a second vi.advanceTimersByTime does not cause a
    // second listAllProcesses call while polling is still true.
    //
    // We gate the probe's listAllProcesses behind a manual resolver so
    // we can hold the first poll open and advance the timer mid-flight.
    let resolveProbe!: () => void;
    const blocker = new Promise<ProcessInfo[]>((resolve) => {
      resolveProbe = () => resolve([{ pid: 1234, ppid: 0, comm: 'claude' }]);
    });
    const originalList = probe.listAllProcesses.bind(probe);
    probe.listAllProcesses = async () => {
      probe.listAllCalls += 1;
      return blocker;
    };

    // Start a cycle via the interval (not pollNow - we want the guard).
    vi.advanceTimersByTime(100); // fires first tick
    // Advance timer again - second tick should be dropped by `polling` guard.
    vi.advanceTimersByTime(100);

    // Now release the probe. The first cycle completes; the second tick
    // was already dropped (its setInterval callback exited via `return`).
    resolveProbe();
    // Drain microtasks so the cycle fully finishes.
    await Promise.resolve();
    await Promise.resolve();

    // Restore probe for dispose.
    probe.listAllProcesses = originalList;

    // Exactly one listAllProcesses call despite two ticks firing.
    expect(probe.listAllCalls).toBe(1);
    watcher.dispose();
  });

  describe('per-cycle laziness (skips OS enumeration when no session needs the tree)', () => {
    it('skips listAllProcesses once every session is idle-anchored', async () => {
      // A registered-but-idle session (no tracked bg shells, no pending tools,
      // helper baseline already anchored) has no descendant-tracking work, so
      // the cycle must not pay for the OS enumeration.
      const { watcher, probe, rootPids, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);

      watcher.registerSession('s1');
      await watcher.pollNow(); // first-cycle anchor needs the tree
      expect(probe.listAllCalls).toBe(1);

      probe.listAllCalls = 0;
      await watcher.pollNow();
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(0); // idle: enumeration skipped
      expect(log.rootDied).toHaveLength(0);
      expect(log.observedAlive).toHaveLength(0);
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('still detects root death on a skipped cycle via the cheap isAlive probe', async () => {
      const { watcher, probe, rootPids, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);

      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor
      probe.listAllCalls = 0;

      // Claude CLI dies while the session is otherwise idle.
      probe.alive.delete(1234);
      await watcher.pollNow();

      expect(log.rootDied).toEqual(['s1']);
      expect(probe.listAllCalls).toBe(0); // root death found without enumerating
      watcher.dispose();
    });

    it('resumes the full enumeration once a foreground tool or bg shell appears', async () => {
      const { watcher, probe, rootPids, shellCounts, pendingTools } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);

      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor
      probe.listAllCalls = 0;

      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(0); // idle: skipped

      // A foreground tool starts: the auto-background memo path needs the tree.
      pendingTools.set('s1', 1);
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(1);

      // Tool ends, but a tracked bg shell remains: still needs the tree.
      pendingTools.set('s1', 0);
      shellCounts.set('s1', 1);
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(2);
      watcher.dispose();
    });

    it('skips for an idle session but enumerates when a sibling session is active', async () => {
      // The gate is whole-fleet: one active session keeps the shared
      // enumeration on for the cycle (the snapshot is shared anyway).
      const { watcher, probe, rootPids, shellCounts } = makeWatcher();
      rootPids.set('idle', 1000);
      rootPids.set('busy', 2000);
      probe.alive.add(1000);
      probe.alive.add(2000);
      probe.trees.set(1000, []);
      probe.trees.set(2000, [{ pid: 2001, ppid: 2000, comm: 'bash' }]);
      shellCounts.set('busy', 1);

      watcher.registerSession('idle');
      watcher.registerSession('busy');
      await watcher.pollNow(); // anchor both
      probe.listAllCalls = 0;

      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(1); // 'busy' keeps the cycle enumerating
      watcher.dispose();
    });

    it('keeps a non-zero helper baseline fresh so a helper exit cannot later false-fire a natural exit', async () => {
      // Regression guard for the laziness gate: a shell-like helper that exits
      // while the session looks idle must still be reconciled. The gate must NOT
      // skip while preExistingHelpers > 0 - otherwise the stale-high baseline
      // makes the next bg-shell cycle see a phantom deficit and drains the
      // just-started shell (a false natural exit that flips the session idle).
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1000);
      probe.alive.add(1000);
      probe.alive.add(5000);
      probe.trees.set(1000, [{ pid: 5000, ppid: 1000, comm: 'bash' }]); // one shell-like helper

      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExistingHelpers = 1

      // Helper exits while the session has no bg shells and no pending tools.
      // preExistingHelpers > 0 keeps the gate open, so the deficit rebases the
      // baseline down to 0 (no tracked shells -> no natural exit fired).
      probe.alive.delete(5000);
      probe.trees.set(1000, []);
      await watcher.pollNow();
      await watcher.pollNow(); // deficit acts on the 2nd consecutive cycle
      expect(log.naturalExits).toEqual([]);

      // An anonymous bg shell now starts and its bash appears in the tree.
      shellCounts.set('s1', 1);
      probe.alive.add(6000);
      probe.trees.set(1000, [{ pid: 6000, ppid: 1000, comm: 'bash' }]);
      await watcher.pollNow();
      await watcher.pollNow();

      // In sync against the corrected (0) baseline: the bg shell is NOT drained.
      expect(log.naturalExits).toEqual([]);
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });
  });

  describe('onShellsObservedAlive (positive-liveness keep-alive)', () => {
    it('fires on an in-sync cycle when the engine has tracked bg shells', async () => {
      // A genuinely-running bg shell (e.g. a backgrounded `npx playwright
      // test`) stays present in the OS tree cycle after cycle. The watcher
      // confirms liveness so the engine can refresh the 30s grace anchor.
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      shellCounts.set('s1', 1);

      watcher.registerSession('s1');
      await watcher.pollNow(); // first-cycle anchor: preExisting=0, tracked=1, no keep-alive
      expect(log.observedAlive).toHaveLength(0);

      // Steady state: shellLikeCount(1) === expected(0 + 1). In sync.
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.observedAlive).toEqual(['s1', 's1']);
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT fire on the first-cycle anchor', async () => {
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      shellCounts.set('s1', 1);

      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor returns early before `expected`
      expect(log.observedAlive).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT fire on a deficit cycle (a possible exit must not refresh the grace)', async () => {
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [
        { pid: 5001, ppid: 1234, comm: 'bash' },
        { pid: 5002, ppid: 1234, comm: 'bash' },
      ]);
      shellCounts.set('s1', 2);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      // One bg shell exits -> deficit. The deficit branch (and its 2-cycle
      // lag window) must never emit a liveness keep-alive.
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow(); // deficit cycle 1 (suppressed)
      await watcher.pollNow(); // deficit cycle 2 (fires onNaturalExit)
      expect(log.observedAlive).toHaveLength(0);
      expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
      watcher.dispose();
    });

    it('does NOT fire on a probe failure', async () => {
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      shellCounts.set('s1', 1);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      // Probe times out: snapshot-health guard returns before `expected`.
      probe.failProbe = true;
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.observedAlive).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT fire when the engine has no tracked bg shells (helpers only)', async () => {
      const { watcher, probe, rootPids, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      // Two pre-existing helpers, engine tracks 0 (shellCounts unset -> 0).
      probe.trees.set(1234, [
        { pid: 5001, ppid: 1234, comm: 'bash' },
        { pid: 5002, ppid: 1234, comm: 'sh' },
      ]);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor preExisting=2, tracked=0
      await watcher.pollNow(); // in sync but tracked=0 -> no keep-alive
      expect(log.observedAlive).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT fire on a surplus cycle (helper birth is not confirmed shell liveness)', async () => {
      const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      shellCounts.set('s1', 1);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0, tracked=1

      // A helper appears post-anchor: surplus branch rebases and returns
      // early, before the in-sync keep-alive site.
      probe.trees.set(1234, [
        { pid: 5001, ppid: 1234, comm: 'bash' },
        { pid: 6001, ppid: 1234, comm: 'sh' },
      ]);
      await watcher.pollNow(); // surplus cycle: no keep-alive
      expect(log.observedAlive).toHaveLength(0);

      // Next cycle is back in balance (helper folded into preExisting) -> fires.
      await watcher.pollNow();
      expect(log.observedAlive).toEqual(['s1']);
      watcher.dispose();
    });
  });

  describe('Tier A PID capture and churn-proof liveness (bug A)', () => {
    it('captures a named bg shell PID by tree-diff and confirms liveness even on an out-of-sync (surplus) cycle', async () => {
      // Reproduces the empirical fix: a backgrounded `npx playwright test`
      // spawns its own app-under-test shells (surplus), which the old
      // in-sync-only keep-alive could not confirm liveness through. With Tier
      // A the named shell's own PID is ground truth, so liveness is confirmed
      // regardless of the count math.
      const { watcher, probe, rootPids, shellCounts, namedShells, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []); // no pre-existing helpers
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0, helperPids={}

      // Hook: a named bg shell starts; engine tracks it; OS spawns its bash.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      watcher.noteBackgroundShellStarted('s1', 'bgA');
      probe.trees.set(1234, [{ pid: 6000, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow(); // captures 6000; in sync -> keep-alive
      expect(log.observedAlive).toContain('s1');
      expect(log.naturalExits).toHaveLength(0);

      log.observedAlive.length = 0;

      // Churn: the bg shell spawns an app-under-test shell (surplus). The old
      // path would NOT confirm liveness on a surplus cycle; Tier A does,
      // because the named PID 6000 is still in the tree.
      probe.trees.set(1234, [
        { pid: 6000, ppid: 1234, comm: 'bash' },
        { pid: 7000, ppid: 1234, comm: 'bash' },
      ]);
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('adopts the foreground-tool PID memo when a tool auto-backgrounds', async () => {
      // The captured path: a long foreground tool (pendingTools>0) spawns one
      // shell; when Claude auto-backgrounds it, the start hook arrives and the
      // watcher adopts the memoized PID directly (a fresh tree-diff would be
      // ambiguous by then due to app churn).
      const { watcher, probe, rootPids, shellCounts, namedShells, pendingTools, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      // Foreground tool running; its bash (PID 6000) appears.
      pendingTools.set('s1', 1);
      probe.alive.add(6000);
      probe.trees.set(1234, [{ pid: 6000, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow(); // surplus-while-pending: memoize 6000

      // Tool auto-backgrounds: engine promotes to named 'bgA', tool clears.
      pendingTools.set('s1', 0);
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      watcher.noteBackgroundShellStarted('s1', 'bgA'); // adopts memo 6000

      // App churn surplus, but Tier A confirms liveness via the captured PID.
      probe.trees.set(1234, [
        { pid: 6000, ppid: 1234, comm: 'bash' },
        { pid: 7000, ppid: 1234, comm: 'bash' },
      ]);
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('deficit drains anonymous shells only, never a named shell (the engine guard refuses that anyway)', async () => {
      // A named shell whose PID was never captured and whose OS shell exited
      // (lost end hook): the count heuristic sees a deficit but must NOT fire
      // a natural-exit, because an anonymous (count-based) decrement against a
      // named shell is refused by the engine. The 5-min named cap reclaims it.
      const { watcher, probe, rootPids, shellCounts, namedShells, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor preExisting=0

      // Named shell tracked by the engine, no PID captured by the watcher.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      probe.trees.set(1234, [{ pid: 6000, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow(); // in sync

      // The bg shell's OS process exits but the engine still tracks the named
      // id (lost end hook). Deficit, but anonCount === 0.
      probe.trees.set(1234, []);
      await watcher.pollNow();
      await watcher.pollNow(); // through the lag-tolerance window
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('ambiguous tree-diff (more than one new candidate) gives up without firing or throwing', async () => {
      const { watcher, probe, rootPids, shellCounts, namedShells, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      watcher.noteBackgroundShellStarted('s1', 'bgA');
      // Two new shells at once: the diff cannot attribute the PID.
      probe.trees.set(1234, [
        { pid: 6000, ppid: 1234, comm: 'bash' },
        { pid: 7000, ppid: 1234, comm: 'bash' },
      ]);
      // Poll well past the retry budget: no capture, no natural-exit fire,
      // no throw. The named shell falls back to the 5-min cap.
      for (let cycle = 0; cycle < 5; cycle++) {
        await watcher.pollNow();
      }
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });
  });

  describe('output-file liveness for a PID-less named shell (bug B)', () => {
    /**
     * Incident B: a backgrounded `npx playwright test --project=electron` is
     * alive, but its app-under-test churn keeps the shell-like count desynced
     * (here modeled as a permanent deficit) and its OS PID was never captured,
     * so neither Tier A nor the count heuristic confirms liveness. Without the
     * output-file signal the engine reclaims it at the 5-min cap (false idle).
     * Growth of the shell's output file is ground-truth liveness.
     */
    function setupPidlessNamedShell() {
      const outputPaths = new Map<string, string>([['bgB', '/mock/tmp/bgB.output']]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgB.output', { sizeBytes: 100, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles });
      harness.rootPids.set('s1', 1234);
      harness.probe.alive.add(1234);
      harness.probe.trees.set(1234, []); // no pre-existing helpers
      return { ...harness, outputPaths, mockFiles };
    }

    it('confirms liveness when the named shell output file grows (Incident B)', async () => {
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Named shell tracked, no PID captured; its OS shell is gone from the
      // top-level count (permanent churn desync) -> deficit, anonCount===0.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // first file sample is a BASELINE, no growth
      expect(log.observedAlive).not.toContain('s1');

      // The suite writes more output: the file grows. Liveness confirmed.
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 4096, mtimeMs: 2000 });
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      // And it never drains the named shell on the deficit.
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('does not confirm liveness once the output file stops growing (short horizon: no reclaim yet)', async () => {
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 4096, mtimeMs: 2000 });
      await watcher.pollNow(); // grows -> alive
      expect(log.observedAlive).toContain('s1');

      log.observedAlive.length = 0;
      // No further writes: size and mtime unchanged. No new confirmation, and at
      // this SHORT horizon (2 quiescent cycles, far below the reclaim threshold)
      // the shell is NOT reclaimed either - it stays governed by the caps. The
      // longer-horizon output-quiescence reclaim is covered by the next test.
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.observedAlive).not.toContain('s1');
      expect(log.namedShellLikelyExited).toHaveLength(0);
      watcher.dispose();
    });

    it('reclaims a PID-less named shell after sustained output quiescence + a persistent deficit (this bug)', async () => {
      // The task #225 incident: a named `npm run build` was auto-backgrounded,
      // its Tier A PID capture stayed ambiguous (never tracked), its
      // `background_shell_end` hook was dropped, and the build exited in seconds.
      // Its output file froze while the engine held the task "thinking" on its
      // corpse. The watcher now reclaims it once the output has been quiescent
      // past NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES (30) AND the process tree shows
      // a persistent deficit (the build's shell is gone). Red-green: disabling
      // the reclaim block leaves namedShellLikelyExited empty forever.
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Named shell tracked, no PID captured; its OS shell is gone -> permanent
      // deficit (expected=1, shellLikeCount=0), anonCount===0, pendingTools=0.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline output sample (quiescentCycles=0)

      // The build's output is frozen at the baseline; poll well past the
      // threshold (the deficit branch only re-checks every other cycle, so allow
      // margin). The reclaim fires once; the engine's id drain is simulated by
      // the watcher dropping its cached sample, and the test window stays below
      // a second re-accrual past the threshold.
      for (let i = 0; i < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES + 10; i++) {
        await watcher.pollNow();
      }

      // Reclaimed exactly once, by id; never via the anonymous or PID paths.
      expect(log.namedShellLikelyExited).toEqual([{ sessionId: 's1', shellId: 'bgB' }]);
      expect(log.naturalExits).toHaveLength(0);
      expect(log.shellPidExited).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT reclaim a quiescent named shell while its OS process is still present (no deficit)', async () => {
      // A genuinely quiet-but-alive named shell (e.g. a backgrounded server that
      // logs nothing while idle) keeps its shell process in the tree, so the
      // count is in sync (no deficit). Output quiescence alone must NOT reclaim
      // it - only quiescence corroborated by a process-tree deficit does. This
      // shell stays held (by the in-sync liveness path + the 5-min cap), exactly
      // as before this fix.
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Named shell tracked AND its shell process is present: shellLikeCount=1,
      // expected=preExisting(0)+tracked(1)=1 -> in sync, no deficit.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow(); // baseline output sample

      // Output frozen far past the threshold, but the process never leaves.
      for (let i = 0; i < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES + 10; i++) {
        await watcher.pollNow();
      }

      // Never reclaimed: the in-sync branch keeps confirming liveness instead.
      expect(log.namedShellLikelyExited).toHaveLength(0);
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });

    it('treats an mtime-only advance (no size change) as growth', async () => {
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline {100, 1000}

      // A rewrite that keeps the byte count but bumps mtime still proves life.
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 100, mtimeMs: 5000 });
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });

    it('is inert when the resolver returns no path (behaves exactly as today)', async () => {
      // No output path registered for the shell: resolveShellOutputFile returns
      // null, so the file-growth path never fires and the named-shell deficit
      // is governed solely by the existing heuristics + 5-min cap.
      const { watcher, probe, rootPids, shellCounts, namedShells, log } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.observedAlive).not.toContain('s1');
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('re-resolves the path after the output file vanishes', async () => {
      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline {100, 1000}

      // File disappears (e.g. temp cleanup): the cached entry is dropped.
      mockFiles.delete('/mock/tmp/bgB.output');
      await watcher.pollNow();
      expect(log.observedAlive).not.toContain('s1');

      // File reappears and grows: re-resolved, baseline, then growth.
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 50, mtimeMs: 3000 });
      await watcher.pollNow(); // re-baseline
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 80, mtimeMs: 4000 });
      await watcher.pollNow(); // growth
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });

    // -------------------------------------------------------------------------
    // Gap 2 (sibling): still-growing sibling survives while quiescent one is
    // reclaimed; growing sibling's quiescentCycles resets to 0 on output growth.
    // -------------------------------------------------------------------------

    it('reclaims only the quiescent-past-threshold shell when a sibling is still growing (sibling survives, quiescentCycles resets)', async () => {
      // Task #225 scenario with TWO named bg shells:
      //   bgDead: fast `npm run build` - exited; output frozen for many cycles.
      //   bgLive: a backgrounded `npx playwright test` that keeps writing output.
      //
      // The fix must reclaim only bgDead (output quiescent + deficit), NOT bgLive
      // (output still growing; quiescentCycles resets to 0 on each growth cycle).
      // Red-green: removing the `entry.quiescentCycles < threshold continue` guard
      // reclaims both shells, making this test fail with length 2 instead of 1.

      const outputPaths = new Map<string, string>([
        ['bgDead', '/mock/tmp/bgDead.output'],
        ['bgLive', '/mock/tmp/bgLive.output'],
      ]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgDead.output', { sizeBytes: 500, mtimeMs: 1000 }],
        ['/mock/tmp/bgLive.output', { sizeBytes: 500, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles });
      const { watcher, probe, shellCounts, namedShells, log } = harness;
      harness.rootPids.set('s1', 1234);
      harness.probe.alive.add(1234);
      harness.probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Both named shells tracked; OS process tree shows deficit of 2
      // (both builds' shells are gone). anonCount=0, pendingTools=0.
      shellCounts.set('s1', 2);
      namedShells.set('s1', ['bgDead', 'bgLive']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline samples for both files

      // Poll many cycles: bgDead's file stays frozen (accumulates quiescentCycles);
      // bgLive grows on every cycle (quiescentCycles resets to 0 each time).
      for (let cycle = 0; cycle < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES + 10; cycle++) {
        // bgLive produces new output each cycle.
        const currentLiveSize = mockFiles.get('/mock/tmp/bgLive.output')!.sizeBytes;
        mockFiles.set('/mock/tmp/bgLive.output', {
          sizeBytes: currentLiveSize + 100,
          mtimeMs: 2000 + cycle * 10,
        });
        await watcher.pollNow();
      }

      // Only bgDead is reclaimed (quiescent + in deficit).
      // bgLive is NOT reclaimed: its output kept growing so its quiescentCycles
      // never reached the threshold.
      expect(log.namedShellLikelyExited).toHaveLength(1);
      expect(log.namedShellLikelyExited[0]).toEqual({ sessionId: 's1', shellId: 'bgDead' });
      // The growing sibling fires observedAlive every cycle (it grows each time).
      expect(log.observedAlive).toContain('s1');
      // Anonymous exit path must not fire (both shells are named).
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    // -------------------------------------------------------------------------
    // Gap 3: most-quiescent-first sort with delta=1 (only one OS process
    // vanished) reclaims the MORE-quiescent candidate in the SAME reclaim call.
    // -------------------------------------------------------------------------

    it('reclaims the most-quiescent candidate first when delta=1 and two candidates qualify', async () => {
      // Two named shells both past the quiescence threshold simultaneously,
      // and the process tree lost only ONE shell (delta=1). The sort must pick
      // the MORE-quiescent candidate in that single reclaim call.
      //
      // Setup:
      //   Phase 1: count is in sync (no deficit) so no reclaim fires, but both
      //   shells' quiescentCycles accrue freely. bgOld starts accruing at the
      //   baseline poll. bgNew grows for the first 5 cycles (resets its count),
      //   then freezes. After 35 more cycles with both frozen:
      //     bgOld.quiescentCycles = 35 + 5(initial) = 40
      //     bgNew.quiescentCycles = 35
      //   Both are past the 30-cycle threshold.
      //   Phase 2: introduce a deficit of 1 for the first time. Both are now
      //   simultaneously in `reclaimable` (both quiescent >= 30). delta=1.
      //   reclaimable.sort(descending).slice(0, 1) -> picks bgOld (40 cycles).
      //
      // Red-green: reversing the sort to ascending reclaims bgNew (35 cycles)
      // first, making log.namedShellLikelyExited[0].shellId === 'bgNew'.
      //
      // NOTE: Phase 1 requires in-sync count so no deficit fires. We achieve
      // this by keeping shellCounts=2 and probe.trees with BOTH bash processes
      // present (shellLike=2 = expected=2, no deficit). The quiescentCycles
      // accrual happens in sampleNamedShellOutputGrowth which runs BEFORE the
      // surplus/deficit check (whenever !livenessConfirmed && namedIds.length>0),
      // so quiescentCycles still accumulate even when the count is in sync.

      const outputPaths = new Map<string, string>([
        ['bgOld', '/mock/tmp/bgOld3.output'],
        ['bgNew', '/mock/tmp/bgNew3.output'],
      ]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgOld3.output', { sizeBytes: 200, mtimeMs: 1000 }],
        ['/mock/tmp/bgNew3.output', { sizeBytes: 200, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles });
      const { watcher, probe, shellCounts, namedShells, log } = harness;
      harness.rootPids.set('s1', 1234);
      harness.probe.alive.add(1234);
      harness.probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Phase 1: count in sync so no deficit fires. Both shells tracked,
      // both bash processes present: expected=2, shellLike=2, in sync.
      shellCounts.set('s1', 2);
      namedShells.set('s1', ['bgOld', 'bgNew']);
      probe.trees.set(1234, [
        { pid: 5001, ppid: 1234, comm: 'bash' },
        { pid: 5002, ppid: 1234, comm: 'bash' },
      ]);
      await watcher.pollNow(); // baseline for both files; in sync (no deficit)

      // bgNew grows for 5 cycles; bgOld stays frozen. In-sync, no deficit.
      for (let cycle = 0; cycle < 5; cycle++) {
        const currentSize = mockFiles.get('/mock/tmp/bgNew3.output')!.sizeBytes;
        mockFiles.set('/mock/tmp/bgNew3.output', { sizeBytes: currentSize + 10, mtimeMs: 2000 + cycle });
        await watcher.pollNow();
      }
      // bgOld.quiescentCycles=5; bgNew.quiescentCycles=0. Still in sync.

      // Both files now frozen. Both accumulate. Poll 35 more cycles.
      // bgOld reaches 40; bgNew reaches 35. Both past threshold. No deficit yet.
      for (let cycle = 0; cycle < 35; cycle++) {
        await watcher.pollNow();
      }
      // No reclaim has fired yet (in-sync throughout).
      expect(log.namedShellLikelyExited).toHaveLength(0);

      // Phase 2: introduce a deficit of 1 for the first time. Remove one bash.
      // shellLike=1, expected=2, delta=1. Both bgOld and bgNew are in
      // reclaimable (bgOld.quiescentCycles=40, bgNew.quiescentCycles=35).
      // First deficit cycle: consecutiveDeficitCycles=1 (lag grace, no fire).
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
      await watcher.pollNow();
      // Second deficit cycle: consecutiveDeficitCycles=2, fires.
      await watcher.pollNow();

      // The sort (descending by quiescentCycles) must have picked bgOld (40).
      expect(log.namedShellLikelyExited).toHaveLength(1);
      expect(log.namedShellLikelyExited[0]).toEqual({ sessionId: 's1', shellId: 'bgOld' });
      watcher.dispose();
    });

    // -------------------------------------------------------------------------
    // Gap 4: trackedShellPids skip-guard - a named shell WITH a live Tier A PID
    // must not also be reclaimed by the quiescence path.
    // -------------------------------------------------------------------------

    it('does NOT reclaim a named shell that has a captured Tier A PID (skip-guard)', async () => {
      // The skip-guard at the top of the deficit named arm:
      //   `if (state.trackedShellPids.has(shellId)) continue;`
      // must prevent a Tier A-owned shell from being reclaimed via the quiescence
      // path even when its output file has been frozen past the threshold.
      //
      // The guard can only be exercised when `livenessConfirmed = false` (so the
      // output-file sampling path runs at all). The Tier A allNamedAlive check
      // at the top of cycleSession sets livenessConfirmed=true only when EVERY
      // named shell has an alive PID. Using two named shells - one with a Tier A
      // PID alive, one without - keeps allNamedAlive=false and lets the sampling
      // path accumulate quiescentCycles for both shells.
      //
      // Setup:
      //   - Two named shells: bgTracked (has Tier A PID 6001 alive in tree)
      //     and bgNoPid (no captured PID).
      //   - Both shell output files are frozen (no growth -> quiescentCycles climbs).
      //   - Persistent deficit: OS tree has zero bash descendants after anchor.
      //   - After NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES cycles, both shells are
      //     quiescent past the threshold, but only bgNoPid should be reclaimed.
      //
      // Red-green: commenting out the guard causes bgTracked to also appear in
      // `reclaimable` and be reclaimed via onNamedShellLikelyExited. The assertion
      // `namedShellLikelyExited` has only bgNoPid fails because bgTracked is also
      // present.

      const outputPathsGuard = new Map<string, string>([
        ['bgTracked', '/mock/tmp/bgTracked4.output'],
        ['bgNoPid', '/mock/tmp/bgNoPid4.output'],
      ]);
      const mockFilesGuard = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgTracked4.output', { sizeBytes: 300, mtimeMs: 1000 }],
        ['/mock/tmp/bgNoPid4.output', { sizeBytes: 300, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPathsGuard, mockFiles: mockFilesGuard });
      const { watcher, probe, shellCounts, namedShells, log } = harness;
      harness.rootPids.set('s1', 1234);
      probe.alive.add(1234);
      // Anchor: bgTracked's bash (PID 6001) is present so it gets captured.
      // anonCount = max(0, 1 - 0) = 1 at anchor -> preExistingHelpers = 1.
      probe.trees.set(1234, [
        { pid: 6001, ppid: 1234, comm: 'bash' },
      ]);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExistingHelpers=1

      // Report both named shells. Register bgTracked's Tier A PID.
      shellCounts.set('s1', 2);
      namedShells.set('s1', ['bgTracked', 'bgNoPid']);
      probe.alive.add(6001);
      watcher.registerShellPid('s1', 'bgTracked', 6001);

      await watcher.pollNow(); // baseline output sample for both shells

      // OS tree: bgTracked's bash (6001) still alive; bgNoPid never had one.
      // allNamedAlive check: bgTracked has PID 6001 alive, bgNoPid has no PID
      // -> allNamedAlive=false -> livenessConfirmed=false -> sampling path runs.
      // Count: shellLikeCount=1 (only 6001), expected=preExisting(1)+tracked(2)=3
      // -> delta=2, anonCount=max(0,1-2)=0 -> named arm fires.
      // In the reclaimable loop: bgTracked has trackedShellPids entry -> SKIP.
      // bgNoPid has no PID and quiescentCycles past threshold -> reclaimed.
      probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
      for (let cycle = 0; cycle < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES + 10; cycle++) {
        await watcher.pollNow();
      }

      // Only bgNoPid is reclaimed. bgTracked (Tier A PID still alive) is NOT.
      expect(log.namedShellLikelyExited).toEqual([{ sessionId: 's1', shellId: 'bgNoPid' }]);
      // Tier A path did NOT fire (PID 6001 is still alive in the tree).
      expect(log.shellPidExited).toHaveLength(0);
      // No anonymous drain (anonCount=0 throughout the deficit cycles).
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    // -------------------------------------------------------------------------
    // Gap 5: file-vanish mid-accrual resets quiescentCycles; reclaim is
    // deferred until the file returns AND the deficit persists.
    // -------------------------------------------------------------------------

    it('file vanish mid-accrual resets quiescentCycles; reclaim deferred until file returns and deficit persists', async () => {
      // The shell's output file disappears mid-accrual (e.g. /tmp cleanup
      // or agent restarts its output). The watcher drops the cached entry
      // (quiescentCycles included) and forces a re-resolve on the next cycle
      // where the path is found again. After the file reappears, the
      // quiescentCycles counter starts from zero, so premature reclaim is
      // impossible until the new threshold is met.
      //
      // Red-green: removing the `mockFiles.delete` (file never vanishes) would
      // cause quiescentCycles to reach the threshold without interruption,
      // triggering onNamedShellLikelyExited BEFORE the vanish/reappear cycle.
      // With the vanish the first reclaim attempt is discarded and a full
      // new quiescence window must elapse.

      const { watcher, probe, shellCounts, namedShells, mockFiles, log } = setupPidlessNamedShell();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Named shell tracked, no PID captured; OS process gone (persistent deficit).
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline output sample at {100, 1000}

      // Accrue quiescentCycles to just below the threshold.
      const partialAccrual = NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES - 5;
      for (let cycle = 0; cycle < partialAccrual; cycle++) {
        await watcher.pollNow();
      }
      // Not yet at the threshold: no reclaim yet.
      expect(log.namedShellLikelyExited).toHaveLength(0);

      // File vanishes mid-accrual: the watcher drops its cached entry.
      // This resets quiescentCycles (the entry is gone from shellOutputFiles).
      mockFiles.delete('/mock/tmp/bgB.output');
      await watcher.pollNow(); // entry dropped (file gone)
      expect(log.namedShellLikelyExited).toHaveLength(0);

      // File reappears with fresh content.
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 999, mtimeMs: 9999 });
      await watcher.pollNow(); // re-baseline (quiescentCycles restarted at 0)
      // Still no reclaim: the counter restarted, so even though the deficit
      // persists we need ANOTHER full quiescence window.
      expect(log.namedShellLikelyExited).toHaveLength(0);

      // Now poll past the threshold AGAIN (file stays frozen).
      for (let cycle = 0; cycle < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES + 10; cycle++) {
        await watcher.pollNow();
      }

      // After the second full window, the reclaim fires exactly once.
      expect(log.namedShellLikelyExited).toEqual([{ sessionId: 's1', shellId: 'bgB' }]);
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('re-added named shell tracks growth correctly after all named shells were absent', async () => {
      // Exercises the `else if (namedIds.length === 0 && state.shellOutputFiles.size > 0)
      // state.shellOutputFiles.clear()` branch in cycleSession (reached when the
      // engine drops all named shell ids to zero).
      //
      // The clear branch and the prune loop inside sampleNamedShellOutputGrowth
      // both clean up stale entries - the clear is the eager path (fires immediately
      // when namedIds drops to zero), and the prune loop is the deferred path (fires
      // on the next sampleNamedShellOutputGrowth call when namedIds is non-empty again).
      // Both paths update the entry to current values on re-add, so both produce
      // identical observable behavior through the observedAlive callback.
      //
      // This test covers the end-to-end behavior: a re-added named shell always starts
      // from a fresh baseline after being absent, and subsequent growth correctly fires
      // observedAlive. It exercises both the clear branch (step 2) and the re-registration
      // path (step 3) without redundant gaps in coverage.
      const outputPaths = new Map<string, string>([['bgA', '/mock/tmp/bgA.output']]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgA.output', { sizeBytes: 1000, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles });
      const { watcher, probe, shellCounts, namedShells, log } = harness;
      harness.rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      // Step 1: bgA tracked. First poll establishes the baseline.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // cache bgA at {sizeBytes:1000, mtimeMs:1000} (baseline)

      // Advance to a very high watermark so the stale cache entry holds max values.
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 999999, mtimeMs: 999999 });
      await watcher.pollNow(); // grows -> observedAlive fires; cache now at max watermark
      expect(log.observedAlive).toContain('s1');
      log.observedAlive.length = 0;

      // Step 2: engine drops all named shells (end hook received + count cleared).
      // The stale cache entry for bgA now has {sizeBytes:999999, mtimeMs:999999}.
      shellCounts.set('s1', 0);
      namedShells.set('s1', []);
      await watcher.pollNow(); // namedIds.length === 0 -> cache cleared
      expect(log.observedAlive).not.toContain('s1');

      // Step 3: re-add bgA with a file value far below the stale watermark.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgA']);
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 100, mtimeMs: 1 });
      await watcher.pollNow();
      // With a cleared cache: fresh baseline at {sizeBytes:100, mtimeMs:1}.
      // First observation is always a baseline: no observedAlive.
      expect(log.observedAlive).not.toContain('s1');

      // Step 4: modest increase. Fires observedAlive ONLY if the cache was
      // cleared (fresh baseline 100 -> 200 is growth). If the stale {999999,999999}
      // entry survived, 200 < 999999 and 2 < 999999 -> no growth -> no observedAlive.
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 200, mtimeMs: 2 });
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });

    it('surviving named shell keeps firing observedAlive when one named shell ends', async () => {
      // Tests the partial-prune loop in sampleNamedShellOutputGrowth:
      // `for (const shellId of [...state.shellOutputFiles.keys()])
      //   if (!trackedNamedShellIdSet.has(shellId)) state.shellOutputFiles.delete(shellId)`.
      //
      // When bgA ends (removed from namedIds) while bgB survives, the prune loop
      // deletes the bgA cache entry so stale data does not accumulate. bgB's entry
      // is kept and its continued growth still fires observedAlive.
      //
      // The decisive assertion for bgB: observedAlive fires after bgA ends.
      // For bgA re-add: both the prune-then-re-baseline path and a hypothetical
      // stale-entry-updated path produce the same observable result (entry reset
      // to current values on first access). The test documents the end-to-end
      // behavior and exercises the prune loop path without claiming to distinguish
      // the two paths through the public callback API.
      const outputPaths = new Map<string, string>([
        ['bgA', '/mock/tmp/bgA.output'],
        ['bgB', '/mock/tmp/bgB.output'],
      ]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bgA.output', { sizeBytes: 500, mtimeMs: 1000 }],
        ['/mock/tmp/bgB.output', { sizeBytes: 500, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles });
      const { watcher, probe, shellCounts, namedShells, log } = harness;
      harness.rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor

      // Step 1: both shells tracked; establish baselines.
      shellCounts.set('s1', 2);
      namedShells.set('s1', ['bgA', 'bgB']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baselines for bgA {500,1000} and bgB {500,1000}

      // Advance bgA to a very high watermark so the stale entry holds max values.
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 999999, mtimeMs: 999999 });
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 1000, mtimeMs: 2000 });
      await watcher.pollNow(); // bgA: cache at {999999, 999999}; bgB grows -> observedAlive
      expect(log.observedAlive).toContain('s1');
      log.observedAlive.length = 0;

      // Step 2: bgA ends. Engine drops bgA from the named list.
      // Stale bgA entry: {sizeBytes:999999, mtimeMs:999999}.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bgB']);
      // bgB keeps growing - confirms it survives the partial-prune.
      mockFiles.set('/mock/tmp/bgB.output', { sizeBytes: 2000, mtimeMs: 3000 });
      await watcher.pollNow();
      // bgA pruned from cache (not in namedIds). bgB grows -> observedAlive.
      expect(log.observedAlive).toContain('s1');
      log.observedAlive.length = 0;

      // Step 3: re-add bgA with a file value far below the stale watermark.
      namedShells.set('s1', ['bgB', 'bgA']);
      shellCounts.set('s1', 2);
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 100, mtimeMs: 1 });
      await watcher.pollNow();
      // With a pruned cache: fresh baseline at {sizeBytes:100, mtimeMs:1}.
      // First observation is always a baseline: no growth signal from bgA.
      // bgB is still in sync here (no change in this poll) -> clear the log.
      log.observedAlive.length = 0;

      // Step 4: modest increase from the fresh baseline. Fires observedAlive ONLY
      // if bgA's stale entry was pruned (fresh baseline 100 -> 200 is growth).
      // If the stale {999999, 999999} entry survived: 200 < 999999 and 2 < 999999
      // -> no growth on bgA -> observedAlive would NOT fire on this cycle (bgB is
      // unchanged too). This is the decisive assertion.
      mockFiles.set('/mock/tmp/bgA.output', { sizeBytes: 200, mtimeMs: 2 });
      await watcher.pollNow();
      expect(log.observedAlive).toContain('s1');
      watcher.dispose();
    });
  });

  describe('transcript drain for a PID-less named shell (task #386)', () => {
    /**
     * Task #386: a background shell's terminal <task-notification> is
     * delivered as a `queued_command` attachment, never a hooked user turn,
     * so neither the KillBash hook nor the removed task-notification hook
     * directive can ever fire for it. The watcher instead asks the adapter
     * directly whether the transcript shows the tracked shell terminated -
     * definitive proof of completion, independent of the process-tree count
     * or the shell's output-file growth state.
     */
    function setupPidlessNamedShellForTranscript(terminatedShellIds?: Set<string>) {
      const outputPaths = new Map<string, string>([['bvqiw3a6s', '/mock/tmp/bvqiw3a6s.output']]);
      const mockFiles = new Map<string, OutputFileSample>([
        ['/mock/tmp/bvqiw3a6s.output', { sizeBytes: 100, mtimeMs: 1000 }],
      ]);
      const harness = makeWatcher({ outputPathMap: outputPaths, mockFiles, terminatedShellIds });
      harness.rootPids.set('s1', 1234);
      harness.probe.alive.add(1234);
      harness.probe.trees.set(1234, []); // no pre-existing helpers
      return { ...harness, outputPaths, mockFiles };
    }

    it('drains the cycle the transcript reports termination, with frozen output and a persistent deficit (task #386 shape)', async () => {
      const { watcher, probe, shellCounts, namedShells, log, terminatedShellIds } = setupPidlessNamedShellForTranscript();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      // Named shell tracked, no PID captured; its OS shell is gone from the
      // top-level count (permanent deficit, matching the #386 incident),
      // output frozen at baseline. None of that matters to the transcript
      // drain - it fires (or doesn't) purely on what the transcript says.
      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bvqiw3a6s']);
      probe.trees.set(1234, []);
      await watcher.pollNow(); // baseline output sample; transcript not yet reporting termination
      expect(log.namedShellTerminated).toHaveLength(0);

      // The transcript now shows the shell's terminal <task-notification>.
      terminatedShellIds.add('bvqiw3a6s');
      await watcher.pollNow();

      expect(log.namedShellTerminated).toEqual([{ sessionId: 's1', shellId: 'bvqiw3a6s' }]);
      // Drained on the FIRST cycle the transcript reports it - not after
      // NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES, and not via the count/PID paths
      // (proves count-independence: no deficit resolution was needed).
      expect(log.namedShellLikelyExited).toHaveLength(0);
      expect(log.shellPidExited).toHaveLength(0);
      expect(log.naturalExits).toHaveLength(0);
      watcher.dispose();
    });

    it('never fires while the transcript reports no termination (a live shell emits no terminal notification)', async () => {
      const { watcher, shellCounts, namedShells, log } = setupPidlessNamedShellForTranscript();
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bvqiw3a6s']);
      for (let i = 0; i < 10; i++) {
        await watcher.pollNow();
      }

      expect(log.namedShellTerminated).toHaveLength(0);
      watcher.dispose();
    });

    it('ignores a reported id that is not one of the tracked shell ids (structural rejection of subagent completions)', async () => {
      // Production filters the transcript's captured ids to the caller's
      // `shellIds` argument, so an unrelated notification (a subagent/Task
      // completion's long-hex id) can never match a tracked shell. Model
      // that at the watcher boundary: even if the reader callback reported
      // an id, the watcher only acts on ids that were actually asked about.
      const terminatedShellIds = new Set<string>(['aa01903e41d755d26']); // a subagent id, not tracked
      const { watcher, shellCounts, namedShells, log } = setupPidlessNamedShellForTranscript(terminatedShellIds);
      watcher.registerSession('s1');
      await watcher.pollNow();

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bvqiw3a6s']);
      await watcher.pollNow();

      expect(log.namedShellTerminated).toHaveLength(0);
      watcher.dispose();
    });

    it('drains the transcript even when the process-tree probe fails this cycle (the probe-health guard must not gate the transcript drain)', async () => {
      const { watcher, probe, shellCounts, namedShells, log, terminatedShellIds } =
        setupPidlessNamedShellForTranscript();
      watcher.registerSession('s1');
      await watcher.pollNow(); // anchor: preExisting=0

      shellCounts.set('s1', 1);
      namedShells.set('s1', ['bvqiw3a6s']);
      await watcher.pollNow(); // baseline output sample; transcript not yet reporting termination
      expect(log.namedShellTerminated).toHaveLength(0);

      // Simulate exactly the host-load spell task #386 targets: the
      // process-tree probe times out (listAllProcesses returns []) on the
      // very cycle the transcript reports the shell's terminal notification.
      // The drain callback needs neither the descendant walk nor a healthy
      // process snapshot, so it must still fire even though the probe-health
      // guard in cycleSession would otherwise skip the whole cycle. The root
      // process itself is still alive (isAlive is a separate, cheap per-PID
      // check) - only the full-tree enumeration fails.
      probe.failProbe = true;
      terminatedShellIds.add('bvqiw3a6s');
      await watcher.pollNow();

      expect(log.namedShellTerminated).toEqual([{ sessionId: 's1', shellId: 'bvqiw3a6s' }]);
      watcher.dispose();
    });
  });

  describe('public-API guards and lifecycle (coverage completeness)', () => {
    it('re-registering an existing session updates rootPid without double-arming polling', () => {
      const { watcher, rootPids, probe } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      watcher.registerSession('s1');
      const timerCount = vi.getTimerCount();
      // Re-register (hits the states.has branch: update rootPid + return).
      rootPids.set('s1', 5678);
      probe.alive.add(5678);
      watcher.registerSession('s1');
      expect(vi.getTimerCount()).toBe(timerCount); // no second interval armed
      watcher.dispose();
    });

    it('unregistering the last session stops polling', () => {
      const { watcher, rootPids, probe } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      watcher.registerSession('s1');
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      watcher.unregisterSession('s1');
      expect(vi.getTimerCount()).toBe(0);
      watcher.dispose();
    });

    it('registerShellPid ignores unknown sessions, invalid pids, and post-dispose calls', () => {
      const { watcher, rootPids, probe } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      watcher.registerSession('s1');
      expect(() => {
        watcher.registerShellPid('ghost', 'sh', 100); // unknown session
        watcher.registerShellPid('s1', 'sh', 0);       // invalid pid (<= 0)
        watcher.registerShellPid('s1', 'sh', -5);      // invalid pid
        watcher.registerShellPid('s1', 'sh', 1.5);     // non-integer pid
      }).not.toThrow();
      watcher.dispose();
      expect(() => watcher.registerShellPid('s1', 'sh', 100)).not.toThrow(); // post-dispose
    });

    it('noteBackgroundShellStarted ignores unknown sessions, already-tracked ids, and post-dispose calls', () => {
      const { watcher, rootPids, probe } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      watcher.registerSession('s1');
      watcher.registerShellPid('s1', 'sh', 999); // now Tier-A tracked
      expect(() => {
        watcher.noteBackgroundShellStarted('ghost', 'sh'); // unknown session
        watcher.noteBackgroundShellStarted('s1', 'sh');    // already tracked -> return
      }).not.toThrow();
      watcher.dispose();
      expect(() => watcher.noteBackgroundShellStarted('s1', 'sh2')).not.toThrow(); // post-dispose
    });

    it('a cycle is a no-op after dispose', async () => {
      const { watcher, rootPids, probe } = makeWatcher();
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      watcher.registerSession('s1');
      watcher.dispose();
      await expect(watcher.pollNow()).resolves.toBeUndefined();
    });
  });

  describe('adaptive poll backoff', () => {
    // A "needy" session keeps `sessionNeedsTree` true every cycle (via a pending
    // tool), with an empty tree so no shell-count deficit machinery engages.
    function makeNeedySession(pollIntervalMs = 100) {
      const harness = makeWatcher({ pollIntervalMs });
      const { watcher, probe, rootPids, pendingTools } = harness;
      rootPids.set('s1', 2000);
      probe.alive.add(2000);
      probe.trees.set(2000, []); // no shell-like descendants -> no deficit
      pendingTools.set('s1', 1); // keeps the session needy every cycle
      watcher.registerSession('s1');
      return harness;
    }

    it('stretches the interval to 2x after stage-one consecutive tree cycles', async () => {
      expect(POLL_BACKOFF_STAGE_ONE_TREE_CYCLES).toBe(5);
      const { watcher, probe } = makeNeedySession();
      probe.listAllCalls = 0;

      // Five needy cycles at the 100ms base.
      await vi.advanceTimersByTimeAsync(5 * 100);
      expect(probe.listAllCalls).toBe(5);

      // Now stretched to 2x (200ms): a single 100ms advance produces nothing...
      await vi.advanceTimersByTimeAsync(100);
      expect(probe.listAllCalls).toBe(5);
      // ...but a further 100ms (200 total since the last cycle) fires one.
      await vi.advanceTimersByTimeAsync(100);
      expect(probe.listAllCalls).toBe(6);
      watcher.dispose();
    });

    it('caps the interval at 3x after stage-two consecutive tree cycles', async () => {
      expect(POLL_BACKOFF_STAGE_TWO_TREE_CYCLES).toBe(15);
      const { watcher, probe } = makeNeedySession();
      probe.listAllCalls = 0;

      // Cycles 1-5 at 100ms (t=100..500), 5-15 at 200ms (t=500..2500). By
      // t=2500 exactly 15 cycles have run; the next is armed at t=2800 (3x).
      await vi.advanceTimersByTimeAsync(2500);
      expect(probe.listAllCalls).toBe(15);

      // At 3x spacing (300ms), a 200ms advance yields nothing...
      await vi.advanceTimersByTimeAsync(200);
      expect(probe.listAllCalls).toBe(15);
      // ...and the next 100ms (300 total) yields exactly one.
      await vi.advanceTimersByTimeAsync(100);
      expect(probe.listAllCalls).toBe(16);
      watcher.dispose();
    });

    it('resets to the base cadence when a deficit is observed, and natural exit still fires', async () => {
      const harness = makeWatcher({ pollIntervalMs: 100 });
      const { watcher, probe, rootPids, shellCounts, log } = harness;
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, [
        { pid: 5001, ppid: 1234, comm: 'bash' },
        { pid: 5002, ppid: 1234, comm: 'sh' },
      ]);
      shellCounts.set('s1', 2); // needy every cycle; baseline anchors at 2
      watcher.registerSession('s1');

      // Reach the stretched (2x) state with a stable tree (no deficit).
      await vi.advanceTimersByTimeAsync(5 * 100);
      expect(probe.listAllCalls).toBeGreaterThanOrEqual(5);
      expect(log.naturalExits).toHaveLength(0);

      // One shell exits -> the next cycle observes a deficit.
      probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);

      // Next cycle is armed at 2x (200ms): it observes deficit #1 and snaps the
      // cadence back to base.
      await vi.advanceTimersByTimeAsync(200);
      expect(log.naturalExits).toHaveLength(0); // needs 2 deficit cycles

      // Base cadence restored: a single 100ms advance fires deficit cycle #2,
      // which reports the natural exit. If the reset had NOT happened the next
      // cycle would still be 200ms out and this would fire nothing.
      await vi.advanceTimersByTimeAsync(100);
      expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
      watcher.dispose();
    });

    it('re-arms at base cadence when a new background shell is noted while stretched', async () => {
      const { watcher, probe } = makeNeedySession();
      probe.listAllCalls = 0;

      // Reach the stretched (2x) state; next cycle would be armed 200ms out.
      await vi.advanceTimersByTimeAsync(5 * 100);
      expect(probe.listAllCalls).toBe(5);

      // A new bg shell is a transition: it re-arms the timer at the base delay.
      watcher.noteBackgroundShellStarted('s1', 'shell-a');

      // A single 100ms advance now fires a cycle (base), not the stretched 200ms.
      await vi.advanceTimersByTimeAsync(100);
      expect(probe.listAllCalls).toBe(6);
      watcher.dispose();
    });

    it('does not accrue backoff across cheap skip cycles', async () => {
      // A session with no needy signal after its baseline anchors: cycle 1 is
      // needy (to anchor), every cycle after is a cheap skip.
      const harness = makeWatcher({ pollIntervalMs: 100 });
      const { watcher, probe, rootPids, pendingTools } = harness;
      rootPids.set('s1', 3000);
      probe.alive.add(3000);
      probe.trees.set(3000, []); // no shell-like descendants
      watcher.registerSession('s1');

      // Run many cycles: cycle 1 anchors (one listAllProcesses), the rest skip.
      await vi.advanceTimersByTimeAsync(1000);
      const callsAfterSkips = probe.listAllCalls;
      expect(callsAfterSkips).toBe(1); // only the anchoring cycle enumerated

      // Now make it needy. If skip cycles had accrued backoff we would already
      // be stretched; instead the next five needy cycles run at the 100ms base.
      pendingTools.set('s1', 1);
      await vi.advanceTimersByTimeAsync(5 * 100);
      expect(probe.listAllCalls).toBe(callsAfterSkips + 5);
      watcher.dispose();
    });
  });

  /**
   * The agent-absence sweep.
   *
   * A session's PTY root is the SHELL (getRootPid is pty.pid) and Kangentic
   * writes the agent CLI command to that shell's stdin, so the agent CLI is a
   * DESCENDANT. When the CLI exits on its own - a user `/exit`, a crash, a
   * launch that failed - the shell survives, the PTY never fires onExit, and
   * nothing marks the session finished: the record stays `running`, the status
   * bar counts a phantom agent, and the bottom panel keeps a tab.
   *
   * `onRootProcessDied` cannot see this, because the root is alive.
   */
  describe('agent-absence sweep', () => {
    /** A candidate session whose shell is alive with the given descendants. */
    function makeAbsenceSession(descendants: ProcessInfo[], options?: {
      pollIntervalMs?: number;
      agentAbsenceSweepIntervalMs?: number;
      shellCount?: number;
    }) {
      const harness = makeWatcher({
        agentAbsenceCandidates: new Set(['s1']),
        pollIntervalMs: options?.pollIntervalMs,
        agentAbsenceSweepIntervalMs: options?.agentAbsenceSweepIntervalMs,
      });
      const { watcher, probe, rootPids, shellCounts } = harness;
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, descendants);
      if (options?.shellCount !== undefined) shellCounts.set('s1', options.shellCount);
      watcher.registerSession('s1');
      return harness;
    }

    it('retires a session after the confirmation cycles when nothing runs under its shell', async () => {
      expect(AGENT_ABSENCE_CONFIRM_CYCLES).toBe(2);
      const { watcher, log } = makeAbsenceSession([]);

      await watcher.pollNow();
      expect(log.agentAbsent).toHaveLength(0); // one observation is not enough

      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']);
      // The root is ALIVE throughout - this is not the root-death path.
      expect(log.rootDied).toHaveLength(0);
      watcher.dispose();
    });

    it('retires when the ONLY descendant is a Windows console host', async () => {
      // Defense in depth. Measured live, ConPTY session shells parent their
      // conhost to the Electron caller, so a real bare shell's descendant set
      // is empty. But console-host parenting is an unspecified Windows detail
      // that varies by console host and launch path, and one stray conhost
      // would silently disable the sweep for that session forever.
      const { watcher, log } = makeAbsenceSession([
        { pid: 14028, ppid: 1234, comm: 'conhost' },
      ]);

      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']);
      watcher.dispose();
    });

    it('does NOT retire while a real process is running under the shell', async () => {
      const { watcher, log } = makeAbsenceSession([
        { pid: 48848, ppid: 1234, comm: 'claude' },
        { pid: 46448, ppid: 48848, comm: 'conhost' },
      ]);

      await watcher.pollNow();
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('requires the observations to be CONSECUTIVE (a live descendant resets the count)', async () => {
      const { watcher, probe, log } = makeAbsenceSession([]);

      await watcher.pollNow(); // absent #1
      probe.trees.set(1234, [{ pid: 48848, ppid: 1234, comm: 'claude' }]);
      await watcher.pollNow(); // agent present again -> reset
      probe.trees.set(1234, []);
      await watcher.pollNow(); // absent #1 again, not #2

      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT retire on a probe failure (empty snapshot)', async () => {
      // An empty descendant set that came from a FAILED probe is
      // indistinguishable from a genuinely empty tree by shape alone, so the
      // watcher's snapshot-health guard is what separates them. Marking a live
      // agent dead is worse than leaving the phantom.
      const { watcher, probe, log } = makeAbsenceSession([]);
      probe.failProbe = true;

      await watcher.pollNow();
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('does NOT retire when the snapshot is non-empty but is missing the root pid', async () => {
      // A healthy enumeration lists every process on the host, so it must
      // contain the root we just verified alive. Missing it means the snapshot
      // is partial and cannot be trusted.
      const { watcher, probe, rootPids, log } = makeWatcher({
        agentAbsenceCandidates: new Set(['s1']),
      });
      rootPids.set('s1', 1234);
      probe.alive.add(1234); // isAlive passes, so the root-death path is not taken
      // No `trees` entry for 1234, so the mock never emits it into the snapshot.
      // An unrelated live tree keeps the snapshot non-empty.
      probe.alive.add(9000);
      probe.trees.set(9000, [{ pid: 9001, ppid: 9000, comm: 'node' }]);
      watcher.registerSession('s1');

      await watcher.pollNow();
      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('never judges a session that is not a candidate (the transient Command Terminal guard)', async () => {
      // A Command Terminal is a bare shell BY DESIGN and is registered with the
      // watcher exactly like a task agent, so its tree is legitimately empty.
      // Without the candidate gate the sweep would retire every one of them the
      // moment it opened - the highest-cost false positive in this design.
      const { watcher, probe, rootPids, log } = makeWatcher(); // no candidates
      rootPids.set('command-terminal', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []); // a bare shell: nothing under it, ever
      watcher.registerSession('command-terminal');

      await watcher.pollNow();
      await watcher.pollNow();
      await watcher.pollNow();

      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('resets the count on an enumerated cycle where the session is no longer a candidate', async () => {
      const harness = makeAbsenceSession([]);
      const { watcher, log, agentAbsenceCandidates, pendingTools } = harness;
      // Keep every cycle enumerating, so the non-candidate cycle is a real
      // observation rather than a skipped one. A pending tool (rather than a
      // shell count) also suppresses the deficit branch, keeping this focused.
      pendingTools.set('s1', 1);

      await watcher.pollNow(); // absent #1
      agentAbsenceCandidates.delete('s1');
      await watcher.pollNow(); // observed, not a candidate -> reset
      agentAbsenceCandidates.add('s1');
      await watcher.pollNow(); // absent #1 again, not #2

      expect(log.agentAbsent).toHaveLength(0);
      watcher.dispose();
    });

    it('counts consecutive OBSERVATIONS, so a skipped cycle is neutral rather than a reset', async () => {
      // Load-bearing, and easy to "fix" wrongly. The sweep observes at its own
      // 60s cadence while the poll runs at 2s, so ~29 of every 30 cycles are
      // skips. If a skip reset the counter it could never reach the
      // confirmation threshold and the sweep would never fire at all.
      const { watcher, probe, log } = makeAbsenceSession([], {
        agentAbsenceSweepIntervalMs: 1000,
      });

      await watcher.pollNow(); // anchoring cycle: enumerates, absent #1
      probe.listAllCalls = 0;

      // Several skip cycles: not due, and no bg-shell work.
      await watcher.pollNow();
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(0);
      expect(log.agentAbsent).toHaveLength(0);

      // The next real observation is #2, undisturbed by the skips between.
      vi.setSystemTime(new Date(Date.now() + 1000));
      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']);
      watcher.dispose();
    });

    it('clears a banked observation when the session is re-registered onto a new PTY', async () => {
      // registerSession is idempotent and a RESUME mutates rootPid in place.
      // An observation banked against the OLD tree must not carry over, or one
      // more absent cycle would retire a freshly spawned agent.
      const { watcher, probe, rootPids, log } = makeAbsenceSession([]);

      await watcher.pollNow(); // absent #1 against the old root

      rootPids.set('s1', 5678); // resumed onto a new PTY
      probe.alive.add(5678);
      probe.trees.set(5678, []);
      watcher.registerSession('s1');

      await watcher.pollNow(); // absent #1 against the NEW root, not #2
      expect(log.agentAbsent).toHaveLength(0);

      await watcher.pollNow(); // now #2
      expect(log.agentAbsent).toEqual(['s1']);
      watcher.dispose();
    });

    it('unregisters the session on retirement so it cannot fire twice', async () => {
      const { watcher, log } = makeAbsenceSession([]);

      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']);

      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']); // still exactly one
      watcher.dispose();
    });

    it('evaluates for free on a cycle the bg-shell path already enumerated', async () => {
      // The sweep interval is effectively infinite here, so the ONLY reason a
      // snapshot is taken is the tracked bg shell. The sweep still gets to run.
      const { watcher, log } = makeAbsenceSession([], {
        agentAbsenceSweepIntervalMs: 10 * 60_000,
        shellCount: 1,
      });

      await watcher.pollNow();
      await watcher.pollNow();
      expect(log.agentAbsent).toEqual(['s1']);
      watcher.dispose();
    });

    it('does not enumerate more often than its own interval on an otherwise-idle board', async () => {
      // The cost control: `listAllProcesses` is a ~200ms PowerShell CIM query on
      // Windows, and the bg-shell watcher deliberately skips it on idle cycles.
      // A live descendant keeps this session from ever retiring, so enumeration
      // count is driven purely by the sweep cadence.
      const { watcher, probe } = makeAbsenceSession(
        [{ pid: 48848, ppid: 1234, comm: 'claude' }],
        { agentAbsenceSweepIntervalMs: 1000 },
      );

      await watcher.pollNow(); // anchoring cycle enumerates and stamps the sweep
      probe.listAllCalls = 0;

      await watcher.pollNow();
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(0); // not due, and no bg-shell work

      vi.setSystemTime(new Date(Date.now() + 1000));
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(1); // due: exactly one snapshot
      watcher.dispose();
    });

    it('does not pay for a snapshot when no session is a candidate', async () => {
      const { watcher, probe, rootPids } = makeWatcher(); // no candidates
      rootPids.set('s1', 1234);
      probe.alive.add(1234);
      probe.trees.set(1234, []);
      watcher.registerSession('s1');

      await watcher.pollNow(); // anchor
      probe.listAllCalls = 0;
      await watcher.pollNow();
      await watcher.pollNow();
      expect(probe.listAllCalls).toBe(0);
      watcher.dispose();
    });

    it('sweep-only cycles do not accrue the bg-shell poll backoff', async () => {
      // The sweep runs on its own cadence; letting it feed the backoff meant for
      // bg-shell churn would stretch bg-shell detection for an unrelated reason.
      // A live descendant keeps the session from retiring, and interval 0 makes
      // every cycle sweep-driven.
      const { watcher, probe } = makeAbsenceSession(
        [{ pid: 48848, ppid: 1234, comm: 'claude' }],
        { pollIntervalMs: 100, agentAbsenceSweepIntervalMs: 0 },
      );
      probe.listAllCalls = 0;

      // Ten base-cadence cycles fit in 1000ms. Had these accrued backoff, the
      // interval would have stretched to 200ms after five and produced ~7.
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.listAllCalls).toBeGreaterThanOrEqual(9);
      watcher.dispose();
    });
  });
});
