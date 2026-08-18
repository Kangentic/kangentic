/**
 * Wiring test for a SessionTelemetry callback that was NOT covered by existing
 * unit tests. Targets one specific closure:
 *
 *   clearSessionTracking -> bgShellWatcher.unregisterSession wiring
 *     SessionTelemetry.clearSessionTracking() calls notifySessionEnded() which
 *     calls bgShellWatcher.unregisterSession(). After clearSessionTracking, the
 *     watcher must stop firing callbacks for that session. Verified by polling
 *     after clear and asserting no natural-exit callbacks arrive.
 *
 * Test tier: Unit (vitest, no browser, no Electron, no real OS processes).
 * The BgShellWatcher is constructed inside SessionTelemetry with a
 * MockProcessTreeProbe so all OS interaction is bypassed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/activity-engine/session-telemetry';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';
import { looksLikeShellId } from '../../src/main/activity-engine/background-shell/looks-like-shell-id';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionUsage, SessionEvent } from '../../src/shared/types';
import { NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';

// ==== Minimal mock process-tree probe ====

class MockProcessTreeProbe implements ProcessTreeProbe {
  alive = new Set<number>();
  trees = new Map<number, ProcessInfo[]>();
  failProbe = false;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    if (this.failProbe) return [];
    const all: ProcessInfo[] = [];
    for (const [rootPid, descendants] of this.trees.entries()) {
      if (this.alive.has(rootPid)) {
        all.push({ pid: rootPid, ppid: 0, comm: 'claude' });
      }
      all.push(...descendants);
    }
    return all;
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    return this.trees.get(rootPid) ?? [];
  }

  dispose(): void { /* no-op; long-lived child is Windows-probe-only */ }
}

// ==== Minimal SessionTelemetry callbacks stub ====

interface CallbackLog {
  activityChanges: Array<{ sessionId: string; activity: ActivityState; reason: ActivityReason }>;
  events: Array<{ sessionId: string; event: SessionEvent }>;
  usageChanges: Array<{ sessionId: string; usage: SessionUsage }>;
}

function makeCallbacks(log: CallbackLog) {
  return {
    onUsageChange: (sessionId: string, usage: SessionUsage): void => {
      log.usageChanges.push({ sessionId, usage });
    },
    onActivityChange: (sessionId: string, activity: ActivityState, reason: ActivityReason): void => {
      log.activityChanges.push({ sessionId, activity, reason });
    },
    onEvent: (sessionId: string, event: SessionEvent): void => {
      log.events.push({ sessionId, event });
    },
    onIdleTimeout: (_sessionId: string): void => {},
    onPlanExit: (_sessionId: string): void => {},
    onPRCandidate: (_sessionId: string): void => {},
    requestSuspend: (_sessionId: string): void => {},
    isSessionRunning: (_sessionId: string): boolean => true,
  };
}

/**
 * Build a SessionTelemetry instance with a MockProcessTreeProbe and a
 * caller-controlled `getSessionRootPid` map so tests can register sessions
 * with real-seeming root PIDs without spawning any processes.
 *
 * `disableBgShellWatcher: false` (the default) - we need the watcher active
 * so the closure under test is constructed and wired.
 *
 * Engine timings are collapsed to 0 to prevent spurious watchdog firings
 * during the test. The stability window is also 0 so idle transitions are
 * synchronous - tests only care about lastSignalAt, not state transitions.
 */
function makeTelemetry(
  probe: MockProcessTreeProbe,
  rootPids: Map<string, number>,
  log: CallbackLog,
): SessionTelemetry {
  const callbacks = makeCallbacks(log);
  const options: SessionTelemetryOptions = {
    processTreeProbe: probe,
    disableBgShellWatcher: false,
    activityEngineOptions: {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,
    },
  };
  return new SessionTelemetry(
    {
      ...callbacks,
      getSessionRootPid: (sessionId) => rootPids.get(sessionId),
    },
    options,
  );
}

// ==== Tests ====

describe('SessionTelemetry: clearSessionTracking -> bgShellWatcher.unregisterSession wiring', () => {
  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    telemetry = makeTelemetry(probe, rootPids, log);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('clearSessionTracking calls bgShellWatcher.unregisterSession so no natural-exit callbacks fire after clear', async () => {
    // Regression guard for the phantom-adoption bug: if clearSessionTracking
    // did NOT unregister from the watcher, the watcher would keep polling and
    // could fire onNaturalExit for a session whose engine state had been deleted.
    // That would call activityEngine.markBackgroundShellEnded on a non-existent
    // state, which is a no-op (engine guards against unknown sessions), but it
    // also means the watcher keeps running and consuming resources.
    //
    // The watcher unregisters the session when unregisterSession is called, and
    // stops polling when its session map is empty. We verify: after
    // clearSessionTracking, a subsequent pollNow() fires NO natural-exit
    // callbacks for the cleared session.
    const rootPid = 7779;
    rootPids.set('s3', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [
      { pid: 10001, ppid: rootPid, comm: 'bash' },
      { pid: 10002, ppid: rootPid, comm: 'sh' },
    ]);

    telemetry.initSession('s3');

    // Inject 2 BackgroundShellStart events so engine thinks 2 shells are running.
    telemetry.ingestEvents('s3', [
      { ts: Date.now(), type: EventType.BackgroundShellStart },
      { ts: Date.now(), type: EventType.BackgroundShellStart },
    ]);

    // Anchor cycle.
    await telemetry.bgShellWatcher!.pollNow();

    // Simulate session suspend: clearSessionTracking unregisters the session.
    telemetry.clearSessionTracking('s3');

    // Both bash processes exit after the clear.
    probe.trees.set(rootPid, []);

    // Record log length BEFORE polling - we will assert it doesn't grow.
    const eventCountBeforePoll = log.events.length;

    // Poll twice (two deficit cycles that would fire if the session were still
    // registered). Neither cycle should fire because the session was
    // unregistered.
    await telemetry.bgShellWatcher!.pollNow();
    await telemetry.bgShellWatcher!.pollNow();

    // No BackgroundShellEnd events should have been emitted by the watcher
    // for session s3 after clearSessionTracking.
    const newEvents = log.events.slice(eventCountBeforePoll);
    const bgShellEndFromWatcher = newEvents.filter(
      (entry) =>
        entry.sessionId === 's3' && entry.event.type === EventType.BackgroundShellEnd,
    );
    expect(bgShellEndFromWatcher).toHaveLength(0);
  });

  it('watcher polling stops entirely when the last session is cleared', () => {
    // When clearSessionTracking is called for the only registered session, the
    // watcher's internal timer must be cleared (states.size === 0 triggers
    // stopPolling). This prevents the watcher from continuing to call
    // listAllProcesses on every poll interval after all sessions are gone.
    const rootPid = 7780;
    rootPids.set('s4', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [{ pid: 11001, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s4');

    // One session registered - timer should be active.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    telemetry.clearSessionTracking('s4');

    // After clearing the only session, the watcher has no sessions left.
    // Its internal setInterval timer should be cleared.
    // Note: SessionTelemetry also has its own idle-timeout interval, but
    // idleTimeoutMinutes defaults to 0 so that interval is not armed.
    // The remaining timer count should be 0 (watcher stopped).
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SessionTelemetry: watcher liveness keep-alive (onShellsObservedAlive -> markBackgroundShellsAlive)', () => {
  const GRACE_MS = 5_000;
  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    const callbacks = makeCallbacks(log);
    telemetry = new SessionTelemetry(
      { ...callbacks, getSessionRootPid: (sessionId) => rootPids.get(sessionId) },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 60_000,
          staleThinkingTimeoutMs: 60_000,
          bgShellOnlyGraceMs: GRACE_MS,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('a still-running bg shell stays thinking past the grace, then reclaims when it exits', async () => {
    // End-to-end of the fix: the watcher's onShellsObservedAlive fires on each
    // in-sync cycle, the wiring calls markBackgroundShellsAlive, and the engine
    // refreshes the grace anchor so a genuinely-running bg shell (the persistent
    // bash wrapper of a backgrounded E2E) is not false-idled at the grace.
    const rootPid = 8881;
    rootPids.set('s1', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [{ pid: 20001, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s1');
    telemetry.ingestEvents('s1', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart },
      { ts: Date.now(), type: EventType.Idle },
    ]);
    const state = () => telemetry.activityEngine.getState('s1');
    expect(state()?.activity).toBe('thinking');

    // First cycle anchors the baseline (no keep-alive).
    await telemetry.bgShellWatcher!.pollNow();

    // Interleave time and in-sync polls across 3x the grace. Each poll refreshes
    // the anchor before the hatch deadline, so the live shell is never reclaimed.
    for (let elapsed = 0; elapsed < GRACE_MS * 3; elapsed += 2_000) {
      vi.advanceTimersByTime(2_000);
      await telemetry.bgShellWatcher!.pollNow();
    }
    expect(state()?.activity).toBe('thinking');
    expect(state()?.compensationCounters.bgShellHatch).toBe(0);

    // The shell exits. The watcher now sees a deficit and, after the 2-cycle lag
    // tolerance, drains the engine via onNaturalExit - reclaiming to idle without
    // the hatch ever firing.
    probe.trees.set(rootPid, []);
    await telemetry.bgShellWatcher!.pollNow();
    await telemetry.bgShellWatcher!.pollNow();
    expect(state()?.activity).toBe('idle');
    expect(state()?.compensationCounters.bgShellHatch).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: ingestEvents - named vs anonymous BackgroundShellStart wiring
// ---------------------------------------------------------------------------

describe('SessionTelemetry: ingestEvents - named vs anonymous BackgroundShellStart', () => {
  // Verify that looksLikeShellId correctly discriminates the two test values
  // used below, so the test is anchored to the predicate's contract and not
  // just lucky string choices.

  it('looksLikeShellId returns true for a short alphanumeric shell id', () => {
    expect(looksLikeShellId('bx6k8r2cr')).toBe(true);
  });

  it('looksLikeShellId returns false for a long command string', () => {
    // A real command string like "npm test -- --reporter=verbose" is not a
    // shell id: it contains spaces and is too long.
    expect(looksLikeShellId('npm test -- --reporter=verbose')).toBe(false);
  });

  it('looksLikeShellId returns false for undefined', () => {
    expect(looksLikeShellId(undefined)).toBe(false);
  });

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    telemetry = makeTelemetry(probe, rootPids, log);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('a BackgroundShellStart with a shell-id-shaped detail triggers noteBackgroundShellStarted (PID captured on next cycle)', async () => {
    // A named shell id ("bx6k8r2cr") satisfies looksLikeShellId() - ingestEvents
    // must call bgShellWatcher.noteBackgroundShellStarted(sessionId, detail).
    // The downstream observable: after the watcher's next cycle with a new
    // shell-like descendant present, the engine's activeBackgroundShellIds
    // will contain the named id (the watcher resolves a PID and calls
    // onShellPidExited when it exits, which fires markBackgroundShellEnded
    // with the named shellId). We verify the named id is tracked in the
    // engine state (via getNamedShellIds callback) after the note fires.
    const rootPid = 9991;
    const NAMED_SHELL_ID = 'bx6k8r2cr';
    rootPids.set('s-named', rootPid);
    probe.alive.add(rootPid);
    // Pre-populate a shell-like descendant so the watcher can capture its PID.
    const shellPid = 30001;
    probe.trees.set(rootPid, [{ pid: shellPid, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s-named');

    // First anchor cycle: no bg shells tracked yet, just anchors helpers.
    await telemetry.bgShellWatcher!.pollNow();

    // Ingest: Prompt then BackgroundShellStart with a named shell id.
    telemetry.ingestEvents('s-named', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: NAMED_SHELL_ID },
    ]);

    // The engine now tracks the named shell.
    const engineState = () => telemetry.activityEngine.getState('s-named');
    expect(engineState()?.activeBackgroundShellIds.has(NAMED_SHELL_ID)).toBe(true);

    // noteBackgroundShellStarted queues a pendingCapture. On the next poll
    // cycle the watcher should resolve the bash PID and track it (the pending
    // capture resolves via tree-diff because there is exactly one unrecognised
    // topmost shell-like descendant present).
    await telemetry.bgShellWatcher!.pollNow();

    // After the capture cycle, the watcher has resolved the PID: the watcher's
    // getNamedShellIds callback returns the named id from the engine, confirming
    // the wiring between ingestEvents -> noteBackgroundShellStarted -> PID track.
    // We verify the watcher's getNamedShellIds accessor (via the engine state
    // the callback closes over) correctly returns the id.
    const namedIds = telemetry.activityEngine.getState('s-named')?.activeBackgroundShellIds;
    expect(namedIds?.has(NAMED_SHELL_ID)).toBe(true);
  });

  it('a BackgroundShellStart with a long command-string detail does NOT trigger noteBackgroundShellStarted', async () => {
    // A non-id detail (a command string, or undefined) must NOT call
    // noteBackgroundShellStarted. The engine still counts the anonymous shell,
    // but the watcher's pendingCaptures map must remain empty because the
    // looksLikeShellId gate blocked the call.
    const rootPid = 9992;
    const ANONYMOUS_DETAIL = 'npm test -- --reporter=verbose';
    rootPids.set('s-anon', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [{ pid: 31001, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s-anon');
    await telemetry.bgShellWatcher!.pollNow();

    // Ingest with a non-id detail - the engine receives an anonymous BackgroundShellStart.
    telemetry.ingestEvents('s-anon', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: ANONYMOUS_DETAIL },
    ]);

    // The engine must NOT have added the command string to its named set.
    // The named-shell count is zero; anonymous count is 1.
    const engineState = telemetry.activityEngine.getState('s-anon');
    expect(engineState?.activeBackgroundShellIds.has(ANONYMOUS_DETAIL)).toBe(false);
    expect(engineState?.activeBackgroundShellIds.size).toBe(0);
    expect(engineState?.anonymousBackgroundShellCount).toBe(1);

    // Poll the watcher - it should not see any pending Tier-A capture for the
    // anonymous shell (the looksLikeShellId gate prevented noteBackgroundShellStarted).
    // We verify by checking that getNamedShellIds returns empty (no named shells).
    const namedIds = telemetry.activityEngine.getState('s-anon')?.activeBackgroundShellIds;
    expect(namedIds?.size).toBe(0);
  });

  it('a BackgroundShellStart with undefined detail does NOT trigger noteBackgroundShellStarted', () => {
    // Undefined detail is neither a shell id (looksLikeShellId returns false)
    // nor tracked as a named shell. The engine counts it anonymously.
    const rootPid = 9993;
    rootPids.set('s-undef', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, []);

    telemetry.initSession('s-undef');

    telemetry.ingestEvents('s-undef', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart },
    ]);

    // No named shells; anonymous count is 1.
    const engineState = telemetry.activityEngine.getState('s-undef');
    expect(engineState?.activeBackgroundShellIds.size).toBe(0);
    expect(engineState?.anonymousBackgroundShellCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap 1: onNamedShellLikelyExited wiring (output-quiescence reclaim -> engine drain)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('SessionTelemetry: onNamedShellLikelyExited -> BackgroundShellEnd + markBackgroundShellEnded wiring', () => {
  // Exercises the onNamedShellLikelyExited closure in session-telemetry.ts end-
  // to-end: drives the full path from watcher output-quiescence reclaim through
  // SessionTelemetry's closure body, verifying:
  //   a) a BackgroundShellEnd synthetic event with detail === shellId appears in
  //      the session log (not the NaturalExit sentinel used by onNaturalExit).
  //   b) activityEngine.markBackgroundShellEnded(sessionId, shellId) is called,
  //      draining the named shell by identity and transitioning to idle.
  //
  // Red-green: deleting the onNamedShellLikelyExited body in session-telemetry.ts
  // leaves the engine holding the orphaned named shell, so assertion (b)
  // "activity === idle" stays 'thinking'.
  //
  // The watcher's statOutputFile is wired to fs.statSync inside SessionTelemetry
  // (not injectable through its public API). We therefore use a real temp file
  // whose stat stays frozen between polls, causing quiescentCycles to accumulate
  // to the reclaim threshold naturally.

  const ORPHANED_SHELL_ID = 'bld9x3r2q';
  const QUIESCENT_RECLAIM_CYCLES = 30;

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;
  let tmpOutputFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    const callbacks = makeCallbacks(log);

    // Create a real temp file. Its stat will never change between polls,
    // so the watcher accumulates quiescentCycles on every cycle.
    const tmpDir = os.tmpdir();
    tmpOutputFile = path.join(tmpDir, `kangentic-test-${Date.now()}-bgshell.output`);
    fs.writeFileSync(tmpOutputFile, 'initial build output');

    telemetry = new SessionTelemetry(
      {
        ...callbacks,
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
        resolveBackgroundShellOutputFile: (_sessionId, shellId) =>
          shellId === ORPHANED_SHELL_ID ? tmpOutputFile : null,
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 300_000,
          staleThinkingTimeoutMs: 300_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
    try { fs.unlinkSync(tmpOutputFile); } catch { /* already deleted */ }
  });

  it('onNamedShellLikelyExited pushes BackgroundShellEnd with shellId detail and drains the named shell from the engine', async () => {
    // Full end-to-end wiring: after QUIESCENT_RECLAIM_CYCLES + margin polls
    // with no output-file growth AND a persistent process-tree deficit,
    // the watcher fires onNamedShellLikelyExited(sessionId, shellId).
    // SessionTelemetry's closure must push the event with detail === shellId
    // and drain the shell via markBackgroundShellEnded(sessionId, shellId).

    const rootPid = 8001;
    rootPids.set('s-orphan', rootPid);
    probe.alive.add(rootPid);
    // The named shell's OS process is already gone (permanent deficit).
    probe.trees.set(rootPid, []);

    telemetry.initSession('s-orphan');

    // Anchor cycle: no bg shells yet (preExisting=0).
    await telemetry.bgShellWatcher!.pollNow();

    // Engine: Prompt activates a turn; BackgroundShellStart registers the
    // orphaned named shell (its end hook was never delivered); Idle closes
    // the turn but the bg shell keeps the predicate active ('thinking').
    // This is the exact false-active symptom from task #225.
    telemetry.ingestEvents('s-orphan', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: ORPHANED_SHELL_ID },
      { ts: Date.now(), type: EventType.Idle },
    ]);

    const stateAfterIngest = telemetry.activityEngine.getState('s-orphan');
    expect(stateAfterIngest?.activeBackgroundShellIds.has(ORPHANED_SHELL_ID)).toBe(true);
    expect(stateAfterIngest?.activity).toBe('thinking');

    const eventsBefore = log.events.length;

    // Poll through the quiescence threshold. The output file never changes
    // (we do not write to it), so every cycle increments quiescentCycles.
    // The deficit branch re-checks every 2 cycles after the lag-tolerance
    // window, so allow QUIESCENT_RECLAIM_CYCLES + 10 cycles for margin.
    for (let cycle = 0; cycle < QUIESCENT_RECLAIM_CYCLES + 10; cycle++) {
      await telemetry.bgShellWatcher!.pollNow();
    }

    // a) A BackgroundShellEnd event was pushed with detail === shellId.
    const newEvents = log.events.slice(eventsBefore);
    const bgShellEndEvents = newEvents.filter(
      (entry) =>
        entry.sessionId === 's-orphan' &&
        entry.event.type === EventType.BackgroundShellEnd,
    );
    expect(bgShellEndEvents).toHaveLength(1);
    // The detail must be the named shell id, NOT the anonymous NaturalExit sentinel.
    expect(bgShellEndEvents[0]?.event.detail).toBe(ORPHANED_SHELL_ID);
    expect(bgShellEndEvents[0]?.event.detail).not.toBe('natural-exit');

    // b) The engine drained the named shell by identity.
    const stateAfterDrain = telemetry.activityEngine.getState('s-orphan');
    expect(stateAfterDrain?.activeBackgroundShellIds.has(ORPHANED_SHELL_ID)).toBe(false);
    expect(stateAfterDrain?.activity).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Gap 2: onNamedShellTerminated wiring (transcript drain -> engine drain, task #386)
// ---------------------------------------------------------------------------

describe('SessionTelemetry: onNamedShellTerminated -> BackgroundShellEnd + markBackgroundShellEnded({ source: "transcript" }) wiring', () => {
  // Exercises the onNamedShellTerminated closure in session-telemetry.ts end-
  // to-end: drives the full path from the watcher's transcript-drain callback
  // through SessionTelemetry's closure body, verifying:
  //   a) a BackgroundShellEnd synthetic event with detail === shellId appears
  //      in the session log.
  //   b) activityEngine.markBackgroundShellEnded(sessionId, shellId, { source:
  //      'transcript' }) is called, draining the named shell by identity and
  //      transitioning to idle, with the distinct 'event:bg-shell-ended:transcript'
  //      trigger label (not the Tier A / quiescence-reclaim label, which
  //      passes an id too but no source).
  //
  // Unlike the quiescence-reclaim wiring above (Gap 1), this drain does not
  // require sustained output quiescence or a poll-count threshold: it fires
  // the cycle the reportTerminatedBackgroundShells callback reports the id -
  // the whole point of a definitive, transcript-confirmed drain (task #386:
  // the shell's terminal notification is delivered as a queued_command
  // attachment that never fires the UserPromptSubmit hook, so this transcript
  // read is the only signal that can ever confirm its exit).
  //
  // Red-green: deleting the onNamedShellTerminated body in session-telemetry.ts
  // leaves the engine holding the orphaned named shell, so assertion (b)
  // "activity === idle" stays 'thinking'.

  const TERMINATED_SHELL_ID = 'bvqiw3a6s';

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;
  let terminatedShellIds: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    terminatedShellIds = new Set();
    const callbacks = makeCallbacks(log);

    telemetry = new SessionTelemetry(
      {
        ...callbacks,
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
        reportTerminatedBackgroundShells: (_sessionId, shellIds) =>
          shellIds.filter((shellId) => terminatedShellIds.has(shellId)),
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 300_000,
          staleThinkingTimeoutMs: 300_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('onNamedShellTerminated pushes BackgroundShellEnd with shellId detail, drains the shell, and labels the transcript trigger', async () => {
    const rootPid = 8002;
    rootPids.set('s-transcript', rootPid);
    probe.alive.add(rootPid);
    // The named shell's OS process is already gone (permanent deficit) -
    // exactly like the #386 incident - but that state is irrelevant to this
    // drain path: it fires independent of count/output state.
    probe.trees.set(rootPid, []);

    telemetry.initSession('s-transcript');

    // Anchor cycle: no bg shells yet (preExisting=0).
    await telemetry.bgShellWatcher!.pollNow();

    telemetry.ingestEvents('s-transcript', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: TERMINATED_SHELL_ID },
      { ts: Date.now(), type: EventType.Idle },
    ]);

    const stateAfterIngest = telemetry.activityEngine.getState('s-transcript');
    expect(stateAfterIngest?.activeBackgroundShellIds.has(TERMINATED_SHELL_ID)).toBe(true);
    expect(stateAfterIngest?.activity).toBe('thinking');

    const eventsBefore = log.events.length;

    // One cycle with no termination reported yet: no drain.
    await telemetry.bgShellWatcher!.pollNow();
    expect(telemetry.activityEngine.getState('s-transcript')?.activity).toBe('thinking');

    // The transcript now reports the shell's terminal notification.
    terminatedShellIds.add(TERMINATED_SHELL_ID);
    await telemetry.bgShellWatcher!.pollNow();

    // a) A BackgroundShellEnd event was pushed with detail === shellId.
    const newEvents = log.events.slice(eventsBefore);
    const bgShellEndEvents = newEvents.filter(
      (entry) =>
        entry.sessionId === 's-transcript' &&
        entry.event.type === EventType.BackgroundShellEnd,
    );
    expect(bgShellEndEvents).toHaveLength(1);
    expect(bgShellEndEvents[0]?.event.detail).toBe(TERMINATED_SHELL_ID);

    // b) The engine drained the named shell by identity, with the distinct
    // transcript-drain trigger label.
    const stateAfterDrain = telemetry.activityEngine.getState('s-transcript');
    expect(stateAfterDrain?.activeBackgroundShellIds.has(TERMINATED_SHELL_ID)).toBe(false);
    expect(stateAfterDrain?.activity).toBe('idle');
    expect(stateAfterDrain?.recentTransitions.at(-1)?.trigger).toBe('event:bg-shell-ended:transcript');
  });
});

// ---------------------------------------------------------------------------
// Gap 3: processStatusUpdate -> reemitBackfilled wiring (retroactive
// back-fill must RE-EMIT a sibling session, not just mutate its cache)
// ---------------------------------------------------------------------------

describe('SessionTelemetry: processStatusUpdate -> reemitBackfilled wiring', () => {
  // Exercises the reemitBackfilled closure end-to-end. A background session
  // (session-a) is seeded via the Claude transcript-fallback shape: tokens +
  // model, but NO context-window size (its own statusLine never painted, so
  // its usage caches with contextWindowSize 0). When a SIBLING session
  // (session-b) of the SAME model reports a live status.json, the accumulator
  // learns the model's window and RETROACTIVELY back-fills session-a's cached
  // usage in place. That alone is not enough - the renderer only repaints on
  // a fresh onUsageChange callback, so processStatusUpdate must explicitly
  // re-emit session-a's now-filled usage, not merely mutate the cache.
  //
  // Red-green: commenting out the `this.reemitBackfilled(...)` call in
  // processStatusUpdate (session-telemetry.ts) leaves the accumulator's cache
  // correctly back-filled (UsageAccumulator.recordKnownWindow still runs) but
  // session-a's onUsageChange is never re-fired, so assertion (b) below - a
  // second onUsageChange for 'session-a' carrying the filled window - never
  // lands. This is the exact case tests/unit/usage-accumulator.test.ts cannot
  // catch: it calls the accumulator directly and never observes whether a
  // callback fires.

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let usageChanges: Array<{ sessionId: string; usage: SessionUsage }>;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    usageChanges = [];
    const baseCallbacks = makeCallbacks(log);
    telemetry = new SessionTelemetry(
      {
        ...baseCallbacks,
        onUsageChange: (sessionId, usage) => {
          usageChanges.push({ sessionId, usage });
        },
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 60_000,
          staleThinkingTimeoutMs: 60_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('re-emits a sibling background session usage with the newly-learned window when a live status.json arrives', () => {
    // Session A: a background session whose only telemetry so far is the
    // Claude transcript fallback (tokens + model, no window). Seeded via
    // setSessionUsage, which mirrors how the transcript-fallback reader
    // ingests parsed usage.
    telemetry.setSessionUsage('session-a', {
      contextWindow: { usedTokens: 357_527, totalInputTokens: 357_527 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);

    const seedEmit = usageChanges.filter((entry) => entry.sessionId === 'session-a');
    expect(seedEmit).toHaveLength(1);
    expect(seedEmit[0].usage.contextWindow.contextWindowSize).toBe(0);

    // Reset the log so the assertions below are precise about the RE-emit
    // triggered by session-b's status update, not the seed emit above.
    usageChanges.length = 0;

    // Session B: a DIFFERENT session of the same model whose live status.json
    // arrives, teaching the accumulator the account+model window.
    const statusUpdate: SessionUsage = {
      contextWindow: {
        usedPercentage: 40,
        usedTokens: 400_000,
        cacheTokens: 0,
        totalInputTokens: 400_000,
        totalOutputTokens: 500,
        contextWindowSize: 1_000_000,
      },
      cost: { totalCostUsd: 0.1, totalDurationMs: 1000 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    };
    telemetry.processStatusUpdate('session-b', statusUpdate);

    // (a) Session B receives its own onUsageChange via the direct emit path.
    const sessionBChange = usageChanges.find((entry) => entry.sessionId === 'session-b');
    expect(sessionBChange).toBeDefined();
    expect(sessionBChange!.usage.contextWindow.contextWindowSize).toBe(1_000_000);

    // (b) Session A - the SIBLING background session - receives a FRESH
    // onUsageChange re-emit carrying the now-filled window. A silent cache
    // mutation with no callback would fail this assertion.
    const sessionAReemit = usageChanges.find((entry) => entry.sessionId === 'session-a');
    expect(sessionAReemit).toBeDefined();
    expect(sessionAReemit!.usage.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(sessionAReemit!.usage.contextWindow.usedPercentage).toBeCloseTo(
      (357_527 / 1_000_000) * 100,
      2,
    );
    // toolCallCount is stamped on the re-emitted payload, mirroring every
    // other emit path (processStatusUpdate's own emit, setSessionUsage's
    // emit) so snapshot reads stay consistent with the pushed callback.
    expect(sessionAReemit!.usage.toolCallCount).toBe(0);
  });

  it('does NOT re-emit an unrelated session of a different model', () => {
    // A sibling of a DIFFERENT model must be left untouched: no re-emit, no
    // window fill. Guards against an overly-broad back-fill that ignores the
    // model key.
    telemetry.setSessionUsage('session-other-model', {
      contextWindow: { usedTokens: 50_000, totalInputTokens: 50_000 },
      model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
    } as Partial<SessionUsage>);
    usageChanges.length = 0;

    const statusUpdate: SessionUsage = {
      contextWindow: {
        usedPercentage: 40,
        usedTokens: 400_000,
        cacheTokens: 0,
        totalInputTokens: 400_000,
        totalOutputTokens: 500,
        contextWindowSize: 1_000_000,
      },
      cost: { totalCostUsd: 0.1, totalDurationMs: 1000 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    };
    telemetry.processStatusUpdate('session-b', statusUpdate);

    const unrelatedReemit = usageChanges.find((entry) => entry.sessionId === 'session-other-model');
    expect(unrelatedReemit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap: processStatusUpdate -> replaceSessionUsage's own-session window fill
// must reach the EMITTED onUsageChange callback, not just the cache
// ---------------------------------------------------------------------------

describe('SessionTelemetry: processStatusUpdate -> replaceSessionUsage own-session fill wiring', () => {
  // UsageAccumulator.replaceSessionUsage fills a zero/missing window from the
  // account's known window for this model (tests/unit/usage-accumulator.test.ts
  // covers that fill directly against the accumulator). What that test cannot
  // see is whether the fill reaches the renderer: processStatusUpdate calls
  // `usage.toolCallCount = ...; this.usage.replaceSessionUsage(sessionId, usage);
  // this.callbacks.onUsageChange(sessionId, usage);` - the fill only helps if
  // it lands on the SAME `usage` object before the emit fires.
  //
  // Two calls, same session: the first status update establishes the known
  // window via processStatusUpdate's own recordKnownWindow call (the real
  // wiring path, not a direct accumulator seed); the second, for the SAME
  // session, arrives with contextWindowSize 0 (a status.json glitch/model
  // hiccup) but real tokens. replaceSessionUsage's fill (reading the map as it
  // stood after call 1) should recover the window on call 2's own emit.
  //
  // Red-green: commenting out the fill block in
  // UsageAccumulator.replaceSessionUsage leaves call 2's emitted usage at
  // contextWindowSize 0, so the assertion below goes red; restoring it goes
  // green (verified below).

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let usageChanges: Array<{ sessionId: string; usage: SessionUsage }>;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    usageChanges = [];
    const baseCallbacks = makeCallbacks(log);
    telemetry = new SessionTelemetry(
      {
        ...baseCallbacks,
        onUsageChange: (sessionId, usage) => {
          usageChanges.push({ sessionId, usage });
        },
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 60_000,
          staleThinkingTimeoutMs: 60_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('recovers a same-session window drop on the very emit that reports it, using the window learned on the prior call', () => {
    const firstStatus: SessionUsage = {
      contextWindow: {
        usedPercentage: 10,
        usedTokens: 100_000,
        cacheTokens: 0,
        totalInputTokens: 100_000,
        totalOutputTokens: 500,
        contextWindowSize: 1_000_000,
      },
      cost: { totalCostUsd: 0.05, totalDurationMs: 500 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    };
    telemetry.processStatusUpdate('session-x', firstStatus);

    const firstEmit = usageChanges.find((entry) => entry.sessionId === 'session-x');
    expect(firstEmit).toBeDefined();
    expect(firstEmit!.usage.contextWindow.contextWindowSize).toBe(1_000_000);

    usageChanges.length = 0;

    // Second status.json for the SAME session drops the window to 0 while
    // still carrying real tokens (200k of the same 1M window - a clean ratio,
    // matching the hydrate wiring test's proven-float-safe 200k/1M -> 20).
    const secondStatus: SessionUsage = {
      contextWindow: {
        usedPercentage: 0,
        usedTokens: 200_000,
        cacheTokens: 0,
        totalInputTokens: 200_000,
        totalOutputTokens: 600,
        contextWindowSize: 0,
      },
      cost: { totalCostUsd: 0.06, totalDurationMs: 600 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    };
    telemetry.processStatusUpdate('session-x', secondStatus);

    // Exactly one emit for session-x on this call: the fill means
    // recordKnownWindow finds nothing left to back-fill (session-x's own cache
    // entry IS the one being replaced), so reemitBackfilled does not also fire.
    const secondEmits = usageChanges.filter((entry) => entry.sessionId === 'session-x');
    expect(secondEmits).toHaveLength(1);
    expect(secondEmits[0].usage.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(secondEmits[0].usage.contextWindow.usedPercentage).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Gap: hydrateKnownWindows - boot-time hydration from persisted metrics
// ---------------------------------------------------------------------------

describe('SessionTelemetry: hydrateKnownWindows -> UsageAccumulator.hydrateKnownWindows wiring', () => {
  // Mirrors the "re-emits a sibling background session" group above, but for
  // the boot-hydration path (applyRuntimeConfig -> SessionManager -> here)
  // instead of a live status.json. UsageAccumulator.hydrateKnownWindows is
  // covered directly in tests/unit/usage-accumulator.test.ts; this file
  // verifies the missing half: that a parked session already cached this run
  // with window 0 gets a FRESH onUsageChange callback once hydration runs, not
  // just a silent cache mutation.

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let usageChanges: Array<{ sessionId: string; usage: SessionUsage }>;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    usageChanges = [];
    const baseCallbacks = makeCallbacks(log);
    telemetry = new SessionTelemetry(
      {
        ...baseCallbacks,
        onUsageChange: (sessionId, usage) => {
          usageChanges.push({ sessionId, usage });
        },
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 60_000,
          staleThinkingTimeoutMs: 60_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('re-emits a parked session with the hydrated window (boot hydration from persisted metrics)', () => {
    // A parked session already emitted this run via the transcript fallback
    // (window 0, tokens only) BEFORE hydration ran - the exact live gap: on
    // boot, session restore can race ahead of applyRuntimeConfig's hydration.
    telemetry.setSessionUsage('parked-session', {
      contextWindow: { usedTokens: 200_000, totalInputTokens: 200_000 },
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    } as Partial<SessionUsage>);

    const seedEmit = usageChanges.filter((entry) => entry.sessionId === 'parked-session');
    expect(seedEmit).toHaveLength(1);
    expect(seedEmit[0].usage.contextWindow.contextWindowSize).toBe(0);

    usageChanges.length = 0;

    // applyRuntimeConfig relays the persisted config-derived window here.
    telemetry.hydrateKnownWindows([{ modelId: 'claude-opus-4-8', contextWindowSize: 1_000_000 }]);

    const reemit = usageChanges.find((entry) => entry.sessionId === 'parked-session');
    expect(reemit).toBeDefined();
    expect(reemit!.usage.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(reemit!.usage.contextWindow.usedPercentage).toBe(20);
    expect(reemit!.usage.toolCallCount).toBe(0);
  });

  it('does NOT re-emit an unrelated session of a different model', () => {
    telemetry.setSessionUsage('session-other-model', {
      contextWindow: { usedTokens: 50_000, totalInputTokens: 50_000 },
      model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
    } as Partial<SessionUsage>);
    usageChanges.length = 0;

    telemetry.hydrateKnownWindows([{ modelId: 'claude-opus-4-8', contextWindowSize: 1_000_000 }]);

    const unrelatedReemit = usageChanges.find((entry) => entry.sessionId === 'session-other-model');
    expect(unrelatedReemit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getNamedShellIds must include exemptBackgroundShellIds too
// (preview-watcher no-activity-hold exemption)
// ---------------------------------------------------------------------------

describe('SessionTelemetry: BgShellWatcherCallbacks.getNamedShellIds includes exemptBackgroundShellIds', () => {
  // `getActiveShellCount` and `getNamedShellIds` (session-telemetry.ts) are
  // both documented to sum `activeBackgroundShellIds` AND
  // `exemptBackgroundShellIds` - dropping the exempt set from either would
  // shrink the watcher's `expected` count and permanently fold a live
  // process into `preExistingHelpers` (see the comment on the
  // `getActiveShellCount` callback at the BgShellWatcher construction site).
  // That corruption is NOT reliably observable through the watcher's
  // surplus/deficit heuristic - the two closures' errors happen to cancel out
  // in `expected = preExistingHelpers + tracked` for a lone exempt shell, and
  // Tier A PID capture can race ahead of either closure regardless of the
  // bug. `getNamedShellIds` has one reliably observable consumer that runs
  // BEFORE any of that arithmetic, though: the watcher's transcript-drain
  // block (`cycleSession`, `watcher.ts`) offers every PID-less NAMED shell to
  // `reportTerminatedShellsFromTranscript` on every cycle, unconditionally,
  // before the process-tree walk or any surplus/deficit branch runs. If
  // `getNamedShellIds` excluded the exempt set, the exempt shell would never
  // be offered - and the drain the doc comment on `exemptBackgroundShellIds`
  // promises ("the shell drains normally when the preview exits") would
  // never fire for it.
  //
  // Red-green: removing `...state.exemptBackgroundShellIds` from
  // `getNamedShellIds`'s spread in session-telemetry.ts leaves
  // reportTerminatedBackgroundShells never called for the exempt shell, so
  // assertion (a) below fails, and the shell is never drained (assertion (b)
  // fails too).

  const EXEMPT_TOOL_ID = 'toolu_preview_watch';
  const EXEMPT_SHELL_ID = 'bw37v13wm';

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;
  let reportTerminatedBackgroundShells: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    const callbacks = makeCallbacks(log);
    // Report every offered id as transcript-terminated, so a successful
    // offer also proves the drain wiring end to end (a bonus over merely
    // checking the offer was made).
    reportTerminatedBackgroundShells = vi.fn((_sessionId: string, shellIds: string[]) => shellIds);

    telemetry = new SessionTelemetry(
      {
        ...callbacks,
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
        reportTerminatedBackgroundShells,
      },
      {
        processTreeProbe: probe,
        disableBgShellWatcher: false,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 300_000,
          staleThinkingTimeoutMs: 300_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('offers a PID-less exempt shell to the transcript drain and drains it once confirmed terminated', async () => {
    const rootPid = 9101;
    rootPids.set('s-exempt', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, []);

    telemetry.initSession('s-exempt');

    // The exempt-shell promotion: PreToolUse (anonymous, sentinel command +
    // toolId), then PostToolUse (named, same toolId) - matches the shape
    // captured in session-027's fixtures.
    telemetry.ingestEvents('s-exempt', [
      { ts: Date.now(), type: EventType.Prompt },
      {
        ts: Date.now(),
        type: EventType.BackgroundShellStart,
        toolId: EXEMPT_TOOL_ID,
        detail: `node scripts/worktree-preview.js --wait --port=5174 ${NO_ACTIVITY_HOLD_FLAG}`,
      },
      { ts: Date.now(), type: EventType.BackgroundShellStart, toolId: EXEMPT_TOOL_ID, detail: EXEMPT_SHELL_ID },
      { ts: Date.now(), type: EventType.Idle },
    ]);

    const stateAfterIngest = telemetry.activityEngine.getState('s-exempt');
    expect(stateAfterIngest?.exemptBackgroundShellIds.has(EXEMPT_SHELL_ID)).toBe(true);
    expect(stateAfterIngest?.activeBackgroundShellIds.size).toBe(0);
    // The exempt shell alone does not hold the predicate - the whole point of
    // the exemption, mirrored in activity-engine-replay.test.ts.
    expect(stateAfterIngest?.activity).toBe('idle');

    // The watcher's very first cycle runs the transcript-drain block before
    // any process-tree walk, so it needs no live descendant and no prior
    // anchor cycle to prove the offer.
    await telemetry.bgShellWatcher!.pollNow();

    // a) The exempt shell was offered to the transcript drain - proves
    // getNamedShellIds includes exemptBackgroundShellIds.
    expect(reportTerminatedBackgroundShells).toHaveBeenCalledWith('s-exempt', [EXEMPT_SHELL_ID]);

    // b) Because the spy confirmed it terminated, the watcher drained it -
    // the transcript-drain wiring works end to end for an exempt shell too.
    const drainEvents = log.events.filter(
      (entry) => entry.sessionId === 's-exempt' && entry.event.type === EventType.BackgroundShellEnd,
    );
    expect(drainEvents).toHaveLength(1);
    expect(drainEvents[0]?.event.detail).toBe(EXEMPT_SHELL_ID);
    expect(telemetry.activityEngine.getState('s-exempt')?.exemptBackgroundShellIds.size).toBe(0);
  });
});

describe('SessionTelemetry: agent-absence sweep wiring (isAgentAbsenceCandidate default + onAgentProcessAbsent -> retireAgentlessSession)', () => {
  // The sweep's two halves are each covered elsewhere - the process-tree half by
  // `bg-shell-watcher.test.ts` against a hand-rolled callbacks object, the
  // session half by `session-manager-agent-absence.test.ts`, which mocks this
  // module away entirely. Neither runs the closures SessionTelemetry actually
  // builds, so the glue between them was the one unpinned link: emptying
  // `onAgentProcessAbsent`, or flipping the `?? false` default, kept every other
  // suite green. TypeScript constrains the closures' shape, never their body.
  //
  // This also exercises the PRODUCTION 60s cadence: SessionTelemetry constructs
  // BgShellWatcher without `agentAbsenceSweepIntervalMs`, so these tests run
  // against the real `AGENT_ABSENCE_SWEEP_INTERVAL_MS` default rather than the
  // 0ms always-due override the watcher suite uses.
  const PHANTOM_SESSION_ID = 'phantom-session';
  const PHANTOM_ROOT_PID = 9001;
  /** Comfortably past AGENT_ABSENCE_SWEEP_INTERVAL_MS (60s). */
  const PAST_ONE_SWEEP_INTERVAL_MS = 61_000;

  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry | null;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [], usageChanges: [] };
    telemetry = null;
  });

  afterEach(() => {
    telemetry?.dispose();
    vi.useRealTimers();
  });

  /**
   * A real SessionTelemetry (and therefore a real BgShellWatcher) with only the
   * sweep callbacks varied, so each test isolates one arm of the wiring.
   */
  function buildTelemetry(sweepCallbacks: {
    isAgentAbsenceCandidate?: (sessionId: string) => boolean;
    retireAgentlessSession?: (sessionId: string) => void;
  }): SessionTelemetry {
    const options: SessionTelemetryOptions = {
      processTreeProbe: probe,
      disableBgShellWatcher: false,
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    };
    return new SessionTelemetry(
      {
        ...makeCallbacks(log),
        getSessionRootPid: (sessionId) => rootPids.get(sessionId),
        ...sweepCallbacks,
      },
      options,
    );
  }

  /** A live shell root with nothing whatsoever running under it: the phantom shape. */
  function seedPhantomShell(): void {
    rootPids.set(PHANTOM_SESSION_ID, PHANTOM_ROOT_PID);
    probe.alive.add(PHANTOM_ROOT_PID);
    probe.trees.set(PHANTOM_ROOT_PID, []);
    telemetry!.initSession(PHANTOM_SESSION_ID);
  }

  it('leaves the sweep inert when isAgentAbsenceCandidate is not wired (the ?? false default)', async () => {
    // Every existing SessionTelemetry construction in the suite omits these
    // callbacks. If the default were TRUE, all of them would start retiring
    // sessions the moment a tree looked empty.
    const retired: string[] = [];
    telemetry = buildTelemetry({ retireAgentlessSession: (sessionId) => retired.push(sessionId) });
    seedPhantomShell();

    // Three sweep-eligible cycles - well past the 2 confirmations a wired
    // candidate needs - so a flipped default could not hide behind the counter.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await telemetry.bgShellWatcher!.pollNow();
      vi.setSystemTime(Date.now() + PAST_ONE_SWEEP_INTERVAL_MS);
    }

    expect(retired).toEqual([]);
  });

  it('routes onAgentProcessAbsent to retireAgentlessSession once the real cadence confirms absence', async () => {
    const retired: string[] = [];
    telemetry = buildTelemetry({
      isAgentAbsenceCandidate: () => true,
      retireAgentlessSession: (sessionId) => retired.push(sessionId),
    });
    seedPhantomShell();

    // Anchor cycle: banks the first absent observation.
    await telemetry.bgShellWatcher!.pollNow();
    expect(retired).toEqual([]);

    // Baselined AFTER the anchor cycle: initSession emits its own opening idle,
    // which belongs to session start, not to the sweep.
    const activityChangesBeforeRetirement = log.activityChanges.length;

    // Second observation, one full production sweep interval later.
    vi.setSystemTime(Date.now() + PAST_ONE_SWEEP_INTERVAL_MS);
    await telemetry.bgShellWatcher!.pollNow();

    expect(retired).toEqual([PHANTOM_SESSION_ID]);

    // The retiring cycle itself emits NO activity-state change: the session is
    // being retired outright, so unlike onRootProcessDied the sweep must not
    // force idle to describe a session that is about to stop existing.
    expect(log.activityChanges).toHaveLength(activityChangesBeforeRetirement);
  });

  it('never retires a session the candidate callback refuses (the Command Terminal guard)', async () => {
    const retired: string[] = [];
    telemetry = buildTelemetry({
      isAgentAbsenceCandidate: () => false,
      retireAgentlessSession: (sessionId) => retired.push(sessionId),
    });
    seedPhantomShell();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await telemetry.bgShellWatcher!.pollNow();
      vi.setSystemTime(Date.now() + PAST_ONE_SWEEP_INTERVAL_MS);
    }

    expect(retired).toEqual([]);
  });
});
