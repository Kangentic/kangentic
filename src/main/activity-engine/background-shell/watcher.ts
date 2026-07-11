import fs from 'node:fs';
import {
  filterTopmostShellLikeDescendants,
  indexByParent,
  isShellLike,
  walkDescendantsFromIndex,
  type ProcessIndexByParent,
  type ProcessTreeProbe,
} from './process-tree';

/**
 * The watcher periodically enumerates the OS process tree rooted at
 * each session's Claude CLI PID and infers when a background shell
 * has exited naturally. Two tiers compose:
 *
 * **Tier A (PID-aware)**: When `registerShellPid(sessionId, shellId, pid)`
 * is called (from a hook directive that extracted a real OS PID from
 * `tool_response`), the watcher tracks `shellId -> pid` and probes
 * `isAlive(pid)` per cycle. When dead, fires `onShellPidExited`.
 * Precise per-shell. Currently dormant - Subsystem C will populate
 * this when empirical capture confirms the PID-bearing field.
 *
 * **Tier B (count-based heuristic, always-on)**: At every background-
 * shell lifecycle event (the engine reports a tracked-shell-count
 * change), the watcher snapshots the count of "shell-like"
 * descendants of the session's root PID. On each cycle, if the live
 * shell-like descendant count drops below the snapshot AND the engine
 * reports non-zero tracked shells, fires `onNaturalExit(delta)` for
 * the difference. Works without knowing PIDs.
 *
 * Failure modes:
 *   - Probe times out -> empty descendants -> no signal this cycle.
 *   - Claude CLI itself dies -> isAlive(rootPid) false -> watcher
 *     unregisters the session and forces idle via callbacks.
 *   - Shell-like filter misses (e.g. python test runner) -> Tier B
 *     under-counts -> falls back to the engine's escape hatch.
 *
 * Polling runs while any session is registered, but each cycle is lazy: when no
 * session has descendant-tracking work (no shell-like helper baseline, no
 * tracked bg shells, no in-flight PID capture, no running foreground tool), the
 * cycle skips the OS process enumeration and does only a cheap per-PID
 * root-death probe. The full tree walk runs only on cycles where at least one
 * session needs it. Polling stops when all sessions unregister.
 */

export interface BgShellWatcherCallbacks {
  /**
   * Called when Tier B detects that K bg shells appear to have exited
   * naturally. The engine should drain `K` from its anonymous bg shell
   * counter (or, if PID-aware tracking is also active, from the
   * untracked surplus).
   */
  onNaturalExit(sessionId: string, exitedCount: number): void;
  /** Tier A: a tracked shell PID is no longer alive. */
  onShellPidExited(sessionId: string, shellId: string): void;
  /**
   * A NAMED bg shell with no captured Tier A PID has been reclaimed by the
   * output-quiescence path: its on-disk output file has not grown for
   * `NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES` consecutive cycles AND the OS process
   * tree shows a persistent deficit (its shell process is gone). This is the
   * dropped-`background_shell_end` case (a fast command like `npm run build`
   * that exited without the engine ever draining its named id). The engine
   * should drain the named shell by id. Distinct from `onShellPidExited` (no OS
   * PID was ever tracked) and from `onNaturalExit` (whose anonymous count drain
   * deliberately refuses named ids).
   */
  onNamedShellLikelyExited(sessionId: string, shellId: string): void;
  /**
   * A NAMED bg shell's terminal state was observed directly in the agent's
   * durable session transcript (task #386's definitive drain) - not a
   * process-tree inference. Distinct from `onNamedShellLikelyExited` (a
   * heuristic reclaim requiring output quiescence AND a process-tree
   * deficit): this fires the instant the transcript confirms completion,
   * regardless of output/count state. The engine should drain the named
   * shell by id.
   */
  onNamedShellTerminated(sessionId: string, shellId: string): void;
  /** Called when the Claude CLI itself dies. Engine should forceIdle. */
  onRootProcessDied(sessionId: string): void;
  /**
   * Tier B positive-liveness: every engine-tracked bg shell is present in
   * the OS tree this cycle (`shellLikeCount === preExistingHelpers + tracked`
   * with `tracked > 0`). The engine refreshes the bg-shell sole-holder grace
   * anchor so a genuinely-running long bg shell is not reclaimed at the 30s
   * grace. Fires ONLY on the in-sync branch - never on a deficit (possible
   * exit), a surplus (helper churn), a probe failure, or the first-cycle
   * anchor - so a phantom (which shows a deficit) is still reclaimed.
   */
  onShellsObservedAlive(sessionId: string): void;
  /**
   * Resolve the on-disk output file for a NAMED background shell, or null
   * when the agent has no such file or it cannot be located. The watcher
   * stats it each cycle; growth is ground-truth liveness for a named shell
   * with no captured OS PID (Incident B). Agent-specific path knowledge
   * stays behind this generic callback (agent-adapters-boundary).
   */
  resolveShellOutputFile(sessionId: string, shellId: string): string | null;
  /**
   * Report which of `shellIds` (a set of NAMED, PID-less tracked shells) have
   * a terminal notification in the agent's durable transcript - definitive
   * proof of completion (task #386). Returns the subset observed terminated.
   * Agent-specific transcript knowledge stays behind this generic callback
   * (agent-adapters-boundary); an agent without such a signal returns [].
   */
  reportTerminatedShellsFromTranscript(sessionId: string, shellIds: string[]): string[];
  /**
   * Read accessors for the watcher to introspect engine state. The
   * watcher does not own counters - it observes them.
   */
  getRootPid(sessionId: string): number | undefined;
  getActiveShellCount(sessionId: string): number;
  /**
   * The engine's currently-tracked NAMED background shell ids (from
   * `background_shell_start` hooks with a shell_id). The watcher derives the
   * anonymous count as `getActiveShellCount - getNamedShellIds().length` and
   * uses the named ids to drive Tier A PID liveness. The watcher does not own
   * these - it observes them.
   */
  getNamedShellIds(sessionId: string): string[];
  /**
   * In-flight tool count from the engine. The watcher uses this to
   * suppress baseline rebasing while a foreground tool is executing -
   * a `Bash`, `BashList`, or `BashOutput` invocation spawns a
   * short-lived direct-child bash that we don't want to fold into
   * `preExistingHelpers`. Once the tool ends and pendingToolCount
   * drops to zero, any persistent shell-like children are treated
   * as helpers and rebased up.
   */
  getPendingToolCount(sessionId: string): number;
}

/** A point-in-time sample of a background shell's output file. */
export interface OutputFileSample {
  sizeBytes: number;
  mtimeMs: number;
}

export interface BgShellWatcherOptions {
  callbacks: BgShellWatcherCallbacks;
  probe: ProcessTreeProbe;
  /** Polling cadence. Default 2000ms. */
  pollIntervalMs?: number;
  /**
   * Filter for "shell-like" descendants. Default uses the
   * `SHELL_LIKE_COMM_PATTERNS` allowlist. Override for tests.
   */
  isShellLike?: (comm: string) => boolean;
  /**
   * Stat a background shell's output file. Default wraps `fs.statSync` and
   * returns null on any error (missing file, permission, etc.). Override for
   * tests so the file-growth liveness path is exercised without real I/O.
   */
  statOutputFile?: (filePath: string) => OutputFileSample | null;
}

/** Default output-file stat: size + mtime, or null on any filesystem error. */
function defaultStatOutputFile(filePath: string): OutputFileSample | null {
  try {
    const stats = fs.statSync(filePath);
    return { sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

interface SessionWatchState {
  /** Root PID (Claude CLI) for this session. */
  rootPid: number;
  /**
   * Count of pre-existing direct shell-like descendants captured on
   * the first cycle. These are background helpers the agent CLI itself
   * spawns (Claude's MCP servers, statusline workers, etc.) that pass
   * the shell-like allowlist but should NOT be tracked as bg work.
   *
   * `null` until the first cycle anchors against the live probe.
   *
   * Combined with `engine.getActiveShellCount()` to compute expected
   * shells each cycle: `expected = preExistingHelpers + engineTracked`.
   * Comparing `shellLikeCount` to `expected` (instead of a stored
   * baseline) keeps the watcher's view always derived from the
   * engine's current truth - foreground tool bashes never inflate the
   * baseline.
   */
  preExistingHelpers: number | null;
  /** Tier A: per-shellId tracked OS PIDs. */
  trackedShellPids: Map<string, number>;
  /**
   * Topmost shell-like descendant PIDs that are NOT background work: the
   * pre-existing helpers captured at the first-cycle anchor (agent CLI's
   * MCP servers, statusline workers) plus any helper that materializes
   * post-anchor on a `pendingTools === 0` surplus rebase. Used to exclude
   * helpers when diffing the tree to capture a new bg shell's PID (Tier A).
   * Pruned to live PIDs on healthy cycles (Windows reuses PIDs aggressively).
   * Over-inclusive at resume (resumed bg shells are anonymous and never
   * Tier-A capture candidates), which is acceptable.
   */
  helperPids: Set<number>;
  /**
   * Named bg shells (from `noteBackgroundShellStarted`) awaiting OS-PID
   * capture, mapped to remaining retry cycles. Resolved by tree-diff: when
   * exactly one topmost shell-like descendant is neither a helper nor
   * already tracked, it is that shell's PID. Cleared on capture, on giving
   * up (retries exhausted or persistently ambiguous), or when the engine
   * stops reporting the id.
   */
  pendingCaptures: Map<string, number>;
  /**
   * A single new topmost shell-like PID observed while a foreground tool was
   * running (`pendingTools > 0`). When that foreground tool auto-backgrounds
   * (Claude promotes a long `Bash`/`PowerShell` to a background shell), its
   * `background_shell_start` arrives via `noteBackgroundShellStarted` and we
   * adopt this memo as the shell's PID immediately - the empirical
   * auto-background path, where by promotion time app-under-test churn has
   * made a fresh tree-diff ambiguous. Null when zero or several new shells
   * are present (ambiguous), or after it is consumed.
   */
  candidateForegroundShellPid: number | null;
  /**
   * Number of consecutive cycles where we've observed
   * `shellLikeCount < expected`. Used to delay natural-exit firing
   * by one cycle - guards against the bash-spawn-lag race where a
   * `background_shell_start` hook fires (engine increments tracked)
   * but the OS bash takes 50-500ms to appear in the process tree.
   * Without this, a watcher cycle landing in the lag window would
   * see deficit and false-fire a natural exit.
   */
  consecutiveDeficitCycles: number;
  /**
   * Per-named-shell output-file samples. The resolved path is cached after the
   * first hit (the session-id segment is globbed, which is the costly part);
   * growth in size or mtime since the previous cycle is positive liveness for
   * a named shell whose OS PID was never captured (Incident B). `quiescentCycles`
   * counts consecutive cycles with NO growth (reset to 0 on any growth); once it
   * reaches `NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES` and the process tree also
   * shows a persistent deficit, the shell is reclaimed as a dropped-end-hook
   * orphan. Entries are pruned when the engine stops tracking the shell, and
   * dropped (to force a re-resolve) if the file vanishes.
   */
  shellOutputFiles: Map<string, { filePath: string; sizeBytes: number; mtimeMs: number; quiescentCycles: number }>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * How many poll cycles a `noteBackgroundShellStarted` PID-capture attempt
 * survives before giving up. Covers the 50-500ms OS spawn lag (a couple of
 * 2s cycles). On give-up the shell is governed by the count heuristic plus
 * the engine's 5-min named-shell cap.
 */
const PID_CAPTURE_RETRY_CYCLES = 3;

/**
 * How many consecutive poll cycles a NAMED bg shell's output file must show NO
 * growth (size and mtime both unchanged) before it becomes eligible for the
 * output-quiescence reclaim. This is the slow, safe half of the discriminator;
 * the fast half is a persistent process-tree deficit (the shell's OS process is
 * gone). A dead PID-less named shell whose `background_shell_end` hook was
 * dropped is the ONLY state that is BOTH quiescent AND in deficit, so requiring
 * both protects a genuinely-quiet-but-alive shell (process still present, so no
 * deficit) and a live-but-churning shell (#216 Incident B, output still
 * growing). At the 2s default poll cadence ~30 cycles is ~60s: 5x faster than
 * the 5-min named cap and far safer than either signal alone. Must stay > 2 so
 * the short-horizon "stops growing, falls back to caps" behavior is unchanged.
 */
export const NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES = 30;

/**
 * Adaptive poll backoff. The full host-process enumeration (`listAllProcesses`,
 * a ~200ms PowerShell CIM query on Windows) fires every cycle where any session
 * "needs tree" - which, with several agents running tools, is nearly
 * continuous. Under that sustained load the sweep burns CPU exactly when the
 * machine is already saturated. So after a run of consecutive tree cycles the
 * poll interval stretches (2s -> 4s -> 6s), and any background-shell lifecycle
 * transition (a new capture, an observed deficit, a (re)registered session)
 * snaps it back to the base cadence so detection latency stays tight when
 * something is actually changing. Cost trade-off: Tier B natural-exit detection
 * can lag up to one stretched interval before the 2-cycle deficit confirmation
 * (which itself runs at base cadence once a deficit is seen), so worst-case
 * ~8s vs ~4s today - well within the 5-min watchdog backstop. Multipliers are
 * applied to `pollIntervalMs` so a test's small base interval scales too.
 */
export const POLL_BACKOFF_STAGE_ONE_TREE_CYCLES = 5;
export const POLL_BACKOFF_STAGE_TWO_TREE_CYCLES = 15;
const POLL_BACKOFF_STAGE_ONE_MULTIPLIER = 2;
const POLL_BACKOFF_STAGE_TWO_MULTIPLIER = 3;

export class BgShellWatcher {
  private readonly callbacks: BgShellWatcherCallbacks;
  private readonly probe: ProcessTreeProbe;
  private readonly pollIntervalMs: number;
  private readonly isShellLikeFn: (comm: string) => boolean;
  private readonly statOutputFileFn: (filePath: string) => OutputFileSample | null;
  private readonly states = new Map<string, SessionWatchState>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private disposed = false;
  // Consecutive cycles that ran the full OS enumeration (reset by a skip cycle
  // or any bg-shell lifecycle transition). Drives the adaptive poll backoff.
  private consecutiveTreeCycles = 0;

  constructor(options: BgShellWatcherOptions) {
    this.callbacks = options.callbacks;
    this.probe = options.probe;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.isShellLikeFn = options.isShellLike ?? isShellLike;
    this.statOutputFileFn = options.statOutputFile ?? defaultStatOutputFile;
  }

  /**
   * Register a session for watching. Idempotent. Captures the root
   * PID from callbacks once available and resets the baseline.
   */
  registerSession(sessionId: string): void {
    if (this.disposed) return;
    const rootPid = this.callbacks.getRootPid(sessionId);
    if (!rootPid || rootPid <= 0) return;
    if (this.states.has(sessionId)) {
      this.states.get(sessionId)!.rootPid = rootPid;
      // A resume is a transition too: watch the new tree at base cadence.
      this.resetPollBackoff();
      return;
    }
    this.resetPollBackoff();
    this.states.set(sessionId, {
      rootPid,
      // Anchored on the first cycle from the live probe.
      preExistingHelpers: null,
      trackedShellPids: new Map(),
      helperPids: new Set(),
      pendingCaptures: new Map(),
      candidateForegroundShellPid: null,
      consecutiveDeficitCycles: 0,
      shellOutputFiles: new Map(),
    });
    this.maybeStartPolling();
  }

  /** Remove a session from watching. */
  unregisterSession(sessionId: string): void {
    this.states.delete(sessionId);
    if (this.states.size === 0) this.stopPolling();
  }

  /**
   * Subsystem C entry point: a hook directive extracted a real OS PID
   * for a tracked shell. Adds to Tier A tracking.
   */
  registerShellPid(sessionId: string, shellId: string, pid: number): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (!Number.isInteger(pid) || pid <= 0) return;
    state.trackedShellPids.set(shellId, pid);
    // A newly-tracked shell PID is a transition: poll at base while it settles.
    this.resetPollBackoff();
  }

  /**
   * A `background_shell_start` hook with a shell_id arrived (wired from
   * `SessionTelemetry.ingestEvents`). Attempt to capture the shell's OS PID
   * for Tier A liveness:
   *   - If a foreground-tool shell PID was memoized this cycle window and is
   *     still alive, that IS this shell (the auto-background path) - adopt it.
   *   - Otherwise queue a tree-diff capture over the next few cycles.
   * Either way Tier A liveness (`onShellsObservedAlive` even when the count
   * heuristic is out of sync) only kicks in once the PID is captured; until
   * then the count heuristic and the 5-min named cap govern.
   */
  noteBackgroundShellStarted(sessionId: string, shellId: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.trackedShellPids.has(shellId)) return;
    // A new bg shell is the key transition: snap to base cadence so the
    // PID_CAPTURE_RETRY_CYCLES budget operates on its designed ~2s window
    // instead of a stretched interval.
    this.resetPollBackoff();
    const memoPid = state.candidateForegroundShellPid;
    if (memoPid !== null && this.probe.isAlive(memoPid)) {
      state.trackedShellPids.set(shellId, memoPid);
      state.candidateForegroundShellPid = null;
      state.pendingCaptures.delete(shellId);
      return;
    }
    state.pendingCaptures.set(shellId, PID_CAPTURE_RETRY_CYCLES);
  }

  /** Force one cycle of polling. Used by tests. */
  async pollNow(): Promise<void> {
    await this.cycle();
  }

  /** Tear down. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.states.clear();
    // Release the probe's long-lived resources (Windows persistent
    // PowerShell child). Synchronous so it slots into the
    // before-quit shutdown contract.
    this.probe.dispose();
  }

  // ==== Internal ====

  private maybeStartPolling(): void {
    if (this.timer !== null) return;
    if (this.disposed) return;
    if (this.states.size === 0) return;
    // A self-scheduling setTimeout chain (rather than a fixed setInterval) lets
    // the next delay vary with the adaptive backoff. The chain never overlaps
    // itself: the next tick is armed only after the current cycle resolves.
    this.scheduleNextCycle(this.pollIntervalMs);
  }

  private scheduleNextCycle(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledCycle();
    }, delayMs);
    this.timer.unref();
  }

  private async runScheduledCycle(): Promise<void> {
    if (this.disposed || this.states.size === 0) return;
    // Preserve the overlap-drop semantics for a concurrent pollNow() (tests):
    // skip this scheduled cycle if one is already running, but still re-arm.
    if (!this.polling) {
      try {
        await this.cycle();
      } catch {
        // Probe failures are already handled inside cycle(); this catch
        // is just defense against unexpected throws.
      }
    }
    // A lifecycle transition during the await may have already armed a fresh
    // base-delay timer (resetPollBackoff); don't double-arm over it.
    if (this.disposed || this.states.size === 0 || this.timer !== null) return;
    this.scheduleNextCycle(this.computeNextPollDelayMs());
  }

  private computeNextPollDelayMs(): number {
    if (this.consecutiveTreeCycles >= POLL_BACKOFF_STAGE_TWO_TREE_CYCLES) {
      return this.pollIntervalMs * POLL_BACKOFF_STAGE_TWO_MULTIPLIER;
    }
    if (this.consecutiveTreeCycles >= POLL_BACKOFF_STAGE_ONE_TREE_CYCLES) {
      return this.pollIntervalMs * POLL_BACKOFF_STAGE_ONE_MULTIPLIER;
    }
    return this.pollIntervalMs;
  }

  /**
   * Snap the poll cadence back to base on a bg-shell lifecycle transition. Zeroes
   * the backoff counter, and if a stretched timer is currently armed, re-arms it
   * at the base delay so a fresh transition is not left waiting out a 4-6s gap.
   * When called mid-cycle (timer already consumed to null) it only zeroes the
   * counter; runScheduledCycle then re-arms at base via computeNextPollDelayMs.
   */
  private resetPollBackoff(): void {
    this.consecutiveTreeCycles = 0;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.scheduleNextCycle(this.pollIntervalMs);
    }
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async cycle(): Promise<void> {
    if (this.disposed) return;
    this.polling = true;
    try {
      // Snapshot session ids first - cycle is async and registrations
      // can change in flight.
      const sessionIds = Array.from(this.states.keys());
      if (sessionIds.length === 0) return;

      // Per-cycle laziness: when NO session has descendant-tracking work this
      // cycle (no shell-like helper baseline, no tracked bg shells, no in-flight
      // PID capture, no running foreground tool - see `sessionNeedsTree`), skip
      // the expensive OS enumeration entirely and do only the cheap per-PID
      // root-death probe. `isAlive` is a native process.kill(pid, 0);
      // `listAllProcesses` spawns a PowerShell CIM query (~200ms) on Windows.
      // Any path to a new bg shell first raises pendingToolCount or
      // activeShellCount (engine state updates synchronously on the event), so
      // the next cycle re-enters the full path before the watcher must act -
      // bg-shell detection was already 2s-granular, so this adds no delay.
      const anyNeedsTree = sessionIds.some((sessionId) => {
        const state = this.states.get(sessionId);
        return state !== undefined && this.sessionNeedsTree(sessionId, state);
      });
      if (!anyNeedsTree) {
        // A skip cycle costs nothing, so it resets the backoff: the moment work
        // resumes we start from the base cadence again.
        this.consecutiveTreeCycles = 0;
        for (const sessionId of sessionIds) this.skipCycleSession(sessionId);
        return;
      }

      // A needy cycle ran the OS enumeration; count it toward the backoff. A
      // probe that later times out to [] still cost a spawn, so it counts.
      this.consecutiveTreeCycles += 1;

      // Single OS query shared across all sessions in this cycle.
      // Without this, each session's cycleSession would call
      // `listDescendants` which spawns its own PowerShell on Windows.
      // For 10 sessions that's 10 PowerShell spawns × ~200ms = ~2s
      // per cycle, saturating one CPU core. With the shared snapshot,
      // it's one ~200ms spawn per cycle regardless of session count.
      const allProcesses = await this.probe.listAllProcesses();
      // Precompute pids once per cycle for the snapshot-health check
      // in cycleSession. Avoids an O(N) linear scan per session
      // (O(M*N) total) when the host has many processes.
      const allProcessPids = new Set(allProcesses.map((process) => process.pid));
      // Group processes by parent PID ONCE per cycle. Every session's subtree
      // walk reuses this shared index; rebuilding it per session would repeat
      // the O(P) grouping S times against the identical snapshot.
      const byParent = indexByParent(allProcesses);

      for (const sessionId of sessionIds) {
        await this.cycleSession(sessionId, byParent, allProcessPids);
      }

      // A live deficit is a state transition worth watching closely: snap back
      // to the base cadence so the Tier B 2-cycle natural-exit confirmation runs
      // at full resolution instead of a stretched interval.
      const anyDeficit = sessionIds.some((sessionId) => {
        const state = this.states.get(sessionId);
        return state !== undefined && state.consecutiveDeficitCycles > 0;
      });
      if (anyDeficit) this.resetPollBackoff();
    } finally {
      this.polling = false;
    }
  }

  /**
   * Does this session have any tracking work that requires the full process
   * tree this cycle? Root-death detection does NOT (it uses the cheap
   * `isAlive(rootPid)` probe); everything else needs the enumeration. The arms:
   *
   * - `preExistingHelpers !== 0`: the baseline is unanchored (`null`, first
   *   cycle) OR there ARE shell-like helpers (`> 0`). A non-zero baseline must
   *   be kept fresh every cycle: if a helper exits during a skip gap the stale
   *   high count would make the next bg-shell cycle see a phantom deficit and
   *   false-fire a natural exit. Only a zero baseline (no shell-like helpers to
   *   lose) is safe to skip - a deficit is then impossible and a new helper is a
   *   benign surplus reconciled when the tree is next walked.
   * - tracked bg shells / in-flight PID captures: Tier A and the count
   *   heuristic need the tree to confirm liveness and detect exits.
   * - `pendingToolCount > 0`: the surplus branch memoizes a foreground bash PID
   *   for the auto-background Tier A path, and every route to a new bg shell
   *   passes through a running foreground tool first, so keeping the tree warm
   *   while one runs keeps `helperPids` pruned and the memo fresh.
   */
  private sessionNeedsTree(sessionId: string, state: SessionWatchState): boolean {
    return (
      state.preExistingHelpers !== 0
      || state.pendingCaptures.size > 0
      || state.trackedShellPids.size > 0
      || this.callbacks.getActiveShellCount(sessionId) > 0
      || this.callbacks.getPendingToolCount(sessionId) > 0
    );
  }

  /**
   * Per-session work for a skipped (no-enumeration) cycle. The full
   * `cycleSession` is not run, so do the two things it would that do not need
   * the tree: clear the foreground-shell memo (only valid while a foreground
   * tool runs, and we skip only when every session has `pendingToolCount === 0`,
   * mirroring cycleSession's own clear), and the cheap `isAlive(rootPid)`
   * root-death probe (fires `onRootProcessDied` + unregisters, as cycleSession
   * does).
   */
  private skipCycleSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.candidateForegroundShellPid = null;
    if (!this.probe.isAlive(state.rootPid)) {
      this.callbacks.onRootProcessDied(sessionId);
      this.unregisterSession(sessionId);
    }
  }

  private async cycleSession(
    sessionId: string,
    byParent: ProcessIndexByParent,
    allProcessPids: Set<number>,
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    // Detect Claude CLI death first.
    if (!this.probe.isAlive(state.rootPid)) {
      this.callbacks.onRootProcessDied(sessionId);
      this.unregisterSession(sessionId);
      return;
    }

    // Definitive drain (task #386): a NAMED shell whose OS PID was never
    // captured is invisible to Tier A (which only drains shells with a known
    // PID). Ask the adapter whether that shell's terminal <task-notification>
    // has appeared in the durable transcript - a signal a hook can never
    // deliver for it (Claude sends the notification as a queued_command
    // attachment, not a hooked user turn), but which IS definitive proof of
    // completion once observed. This runs BEFORE the process-tree probe-health
    // guard below, because it needs neither the descendant walk nor a healthy
    // process snapshot: gating it on the probe would suppress the drain during
    // exactly the host-load spells that both time out the probe AND leave a
    // named shell PID-less (task #386's target scenario). A live shell has
    // emitted no such notification, so this path can never drain one early.
    // `trackedShellPids` still holds the previous cycle's captures here (Tier A
    // prunes below); a shell that just exited is therefore excluded from this
    // set but is drained by Tier A this same cycle, so nothing is missed.
    const pidlessNamedIds = this.callbacks
      .getNamedShellIds(sessionId)
      .filter((shellId) => !state.trackedShellPids.has(shellId));
    if (pidlessNamedIds.length > 0) {
      const terminatedIds = this.callbacks.reportTerminatedShellsFromTranscript(sessionId, pidlessNamedIds);
      for (const shellId of terminatedIds) {
        state.shellOutputFiles.delete(shellId);
        this.callbacks.onNamedShellTerminated(sessionId, shellId);
      }
    }

    // Walk the per-session subtree from the shared cycle index. In-memory
    // only; sub-millisecond regardless of process count.
    const descendants = walkDescendantsFromIndex(byParent, state.rootPid);
    const topmostShellLike = filterTopmostShellLikeDescendants(descendants, this.isShellLikeFn);
    const shellLikeCount = topmostShellLike.length;

    // PROBE-HEALTH GUARD: process-tree.ts:listAllProcesses returns []
    // on probe failure (PowerShell timeout, child crash, permission
    // error). A successful poll enumerates every process on the host,
    // which by definition includes rootPid (verified alive above).
    // When the snapshot is empty or doesn't contain rootPid the poll
    // is untrustworthy - skip the cycle so we don't false-fire
    // natural-exits for shells that may still be running.
    //
    // The previous guard tried to detect probe failure with a
    // count-shape heuristic (`shellLikeCount==0 && previously>0 &&
    // tracked>0`) which produced the same signature as a genuine
    // post-exit state, trapping leaked anonymous bg-shell counts in
    // an indefinite skip loop until the 5-min bg-shell-hatch fired.
    // Snapshot health is the actual, precise discriminator.
    if (allProcessPids.size === 0 || !allProcessPids.has(state.rootPid)) {
      return;
    }

    // We capture tracked HERE (before Tier A might fire) because Tier
    // A's onShellPidExited callbacks decrement engine state - a fresh
    // read after Tier A is taken below to compute `expected`.
    const trackedAtCycle = this.callbacks.getActiveShellCount(sessionId);

    // First-cycle anchor: capture pre-existing direct shell-like
    // descendants (Claude's MCP servers, statusline workers, etc.) so
    // we don't adopt them as background work. Subtract any shells the
    // engine already tracks (resumed sessions can have non-zero
    // tracked count at register time) so they don't get double-attributed
    // to "pre-existing" AND "engine-tracked". `trackedAtCycle` was
    // captured above and the engine state hasn't mutated since.
    const liveDescendantPids = new Set(descendants.map((descendant) => descendant.pid));

    if (state.preExistingHelpers === null) {
      state.preExistingHelpers = Math.max(0, shellLikeCount - trackedAtCycle);
      // Anchor the helper-PID baseline: every topmost shell-like descendant
      // present before any bg work is, by definition, a pre-existing helper
      // (over-inclusive at resume - see the field doc). New bg shells appear
      // post-anchor and are diffed against this set for Tier A capture.
      state.helperPids = new Set(topmostShellLike.map((descendant) => descendant.pid));
      return;
    }

    // Prune helper PIDs to those still alive (Windows reuses PIDs eagerly, so
    // a dead helper's PID must not linger and shadow a future bg shell).
    if (state.helperPids.size > 0) {
      for (const pid of [...state.helperPids]) {
        if (!liveDescendantPids.has(pid)) state.helperPids.delete(pid);
      }
    }

    // Tier A: check tracked shell PIDs. Each Tier A exit corresponds
    // to a shell-like descendant disappearing. Engine.tracked drops
    // accordingly when onShellPidExited fires (engine deletes the id),
    // so the next `expected` calculation reflects the change.
    if (state.trackedShellPids.size > 0) {
      for (const [shellId, pid] of state.trackedShellPids.entries()) {
        if (!liveDescendantPids.has(pid)) {
          state.trackedShellPids.delete(shellId);
          this.callbacks.onShellPidExited(sessionId, shellId);
        }
      }
    }

    // Compute the expected direct shell-like count from engine state.
    // Re-read tracked: Tier A above may have called onShellPidExited
    // which decremented engine.tracked. Foreground tool bashes do NOT
    // contribute to this expectation - they are transient and
    // reconciled via the pending-tools guard.
    const tracked = this.callbacks.getActiveShellCount(sessionId);
    const expected = state.preExistingHelpers + tracked;
    const pendingToolsThisCycle = this.callbacks.getPendingToolCount(sessionId);
    const namedIds = this.callbacks.getNamedShellIds(sessionId);
    const anonCount = Math.max(0, tracked - namedIds.length);

    // The foreground-shell memo is only valid while a foreground tool runs.
    // Clear it once the window closes so a stale PID cannot be mis-adopted by
    // a later, unrelated auto-background.
    if (pendingToolsThisCycle === 0) {
      state.candidateForegroundShellPid = null;
    }

    // Tier A PID capture: resolve queued `noteBackgroundShellStarted` ids by
    // tree-diff. A candidate is a topmost shell-like descendant that is
    // neither a known helper nor already tracked. Only auto-assign when the
    // diff is unambiguous (exactly one pending id AND exactly one candidate);
    // otherwise decrement the retry budget and fall back to the count
    // heuristic + 5-min named cap. The foreground-tool memo (consumed in
    // `noteBackgroundShellStarted`) covers the ambiguous auto-background case.
    if (state.pendingCaptures.size > 0) {
      const trackedPids = new Set(state.trackedShellPids.values());
      const candidatePids = topmostShellLike
        .map((descendant) => descendant.pid)
        .filter((pid) => !state.helperPids.has(pid) && !trackedPids.has(pid));
      for (const [shellId, retriesLeft] of [...state.pendingCaptures.entries()]) {
        if (state.trackedShellPids.has(shellId)) {
          state.pendingCaptures.delete(shellId);
          continue;
        }
        if (state.pendingCaptures.size === 1 && candidatePids.length === 1) {
          state.trackedShellPids.set(shellId, candidatePids[0]);
          state.pendingCaptures.delete(shellId);
        } else if (retriesLeft <= 1) {
          state.pendingCaptures.delete(shellId);
        } else {
          state.pendingCaptures.set(shellId, retriesLeft - 1);
        }
      }
    }

    // Tier A liveness: when every tracked NAMED shell has a captured PID still
    // alive in the tree (and there are no anonymous shells muddying the
    // count), confirm liveness REGARDLESS of whether the count heuristic is in
    // sync. This is the churn-proof path: a backgrounded `npx playwright test`
    // that spawns/kills its own app-under-test shells makes the count oscillate
    // (surplus then permanent deficit), but the named shell's own PID is the
    // ground truth. Refreshing the grace anchor here keeps it active until it
    // actually exits (caught by the Tier A PID-exit drain above).
    let livenessConfirmed = false;
    if (namedIds.length > 0 && anonCount === 0) {
      const allNamedAlive = namedIds.every((shellId) => {
        const pid = state.trackedShellPids.get(shellId);
        return pid !== undefined && liveDescendantPids.has(pid);
      });
      if (allNamedAlive) {
        this.callbacks.onShellsObservedAlive(sessionId);
        livenessConfirmed = true;
      }
    }

    // Output-file liveness: ground truth for a NAMED shell with no captured OS
    // PID (Incident B: a backgrounded `npx playwright test --project=electron`
    // was alive but its app-under-test churn kept the count in permanent
    // deficit, so it false-idled at the 5-min cap while its output file kept
    // growing). Growth in size or mtime since the last cycle proves the shell
    // (or its children) is alive. Runs BEFORE the surplus/deficit branches
    // because that deficit is permanent and would otherwise conclude the cycle.
    // ANY growing shell suffices: the hold anchor is session-level and one
    // genuinely-running bg shell justifies ACTIVE; a phantom sibling is
    // reclaimed once the live shell ends (task-notification end or Tier A exit)
    // and stops refreshing. Growth-STOPPED is not an exit signal ON ITS OWN - a
    // quiet live shell is indistinguishable from a dead one by output alone. But
    // sustained quiescence is COUNTED per shell in `sampleNamedShellOutputGrowth`
    // (the `quiescentCycles` field); when it coincides with a persistent
    // process-tree deficit (the shell's OS process is gone) the deficit branch
    // reclaims it as a dropped-end-hook orphan.
    // Quiescence WITHOUT a deficit still just falls through to the caps.
    if (!livenessConfirmed && namedIds.length > 0) {
      if (this.sampleNamedShellOutputGrowth(sessionId, state, namedIds)) {
        this.callbacks.onShellsObservedAlive(sessionId);
        livenessConfirmed = true;
      }
    } else if (namedIds.length === 0 && state.shellOutputFiles.size > 0) {
      // No named shells tracked anymore: release any cached output-file samples.
      state.shellOutputFiles.clear();
    }

    if (shellLikeCount > expected) {
      // Symmetric counterpart to the deficit-side rebase below: a
      // helper process appeared after the first-cycle anchor (MCP
      // server restart, statusline worker spawn, npm.cmd wrapper from
      // an MCP server tool, etc.). Rebase `preExistingHelpers` up so
      // future cycles treat it as part of the baseline.
      //
      // We deliberately do NOT track this as bg work. Real bg shells
      // fire `background_shell_start` hooks which the engine ingests
      // via `processEvent`; anything not on disk is by definition not
      // user/agent-initiated background work. Pre-fix the watcher
      // adopted these as anonymous bg shells and pinned the session in
      // `thinking` indefinitely (the empirical "phantom counter" bug).
      const surplus = shellLikeCount - expected;
      const trackedPids = new Set(state.trackedShellPids.values());
      const newPids = topmostShellLike
        .map((descendant) => descendant.pid)
        .filter((pid) => !state.helperPids.has(pid) && !trackedPids.has(pid));
      if (pendingToolsThisCycle > 0) {
        // Foreground tool's transient bash. Don't rebase yet - it
        // will exit and rebalance against expected on its own. Crucially:
        // do NOT touch `preExistingHelpers` here, otherwise the foreground
        // bash gets baked into pre-existing and we lose the ability
        // to detect its exit naturally.
        //
        // Memoize a SINGLE new foreground shell PID so that, if Claude
        // auto-backgrounds this tool, `noteBackgroundShellStarted` can adopt
        // it as the bg shell's PID for Tier A liveness (the empirical
        // auto-background path). Ambiguous (0 or >1 new) clears the memo.
        state.candidateForegroundShellPid = newPids.length === 1 ? newPids[0] : null;
        state.consecutiveDeficitCycles = 0;
        return;
      }
      // pendingTools === 0: a persistent helper materialized post-anchor.
      // Fold it into the baseline AND remember its PID so it is excluded from
      // future Tier A capture diffs.
      state.preExistingHelpers += surplus;
      for (const pid of newPids) state.helperPids.add(pid);
      state.consecutiveDeficitCycles = 0;
      return;
    }

    if (shellLikeCount < expected) {
      // GUARD 1 (lag tolerance): the OS bash takes 50-500ms to appear
      // after the synchronous hook (worse on Windows). Wait through 2
      // cycles (~4 seconds) before firing natural-exit. The probe-
      // failure guard upstream independently protects against probe
      // timeouts dropping shellLikeCount to 0, and the 5-min escape
      // hatch / 60s stuck-tracking hatch backstop any permanent
      // miscount.
      state.consecutiveDeficitCycles += 1;
      if (state.consecutiveDeficitCycles < 2) {
        return;
      }

      // GUARD 2 (foreground-tool conflation): a foreground `Bash` /
      // `BashOutput` / `BashList` invocation contributes a transient
      // direct-child bash to `shellLikeCount` until it ends. If a
      // genuine bg shell exits while the foreground bash is still
      // alive, `shellLikeCount` only drops once both have exited -
      // and at that moment we can't tell which exit was the bg shell
      // versus the foreground tool. Suppressing decrement while
      // pending tools exist defers the natural-exit attribution to a
      // cycle when no foreground noise is present.
      if (pendingToolsThisCycle > 0) {
        return;
      }

      const delta = expected - shellLikeCount;
      if (anonCount > 0) {
        // Drain ANONYMOUS shells only. A "bg shell exited without firing
        // BackgroundShellEnd" is common on Windows (lost end hook), and
        // anonymous shells have no PID identity for Tier A, so the count
        // heuristic is their only reclaim path. Named shells are deliberately
        // excluded: the engine's ambiguity guard refuses an anonymous
        // (count-based) decrement against a named shell anyway, and named
        // shells are governed by Tier A PID-exit + the 5-min named cap.
        const reported = Math.min(delta, anonCount);
        if (reported > 0) {
          this.callbacks.onNaturalExit(sessionId, reported);
        }
      } else if (namedIds.length > 0) {
        // Only named shells are tracked and none has a captured PID to
        // attribute this deficit to. Two sub-cases:
        //  - Helper churn under a genuinely-live shell (e.g. the app-under-test
        //    shells of a backgrounded E2E exiting): that shell keeps writing
        //    output, so its `quiescentCycles` stays 0 and it is NOT reclaimed.
        //  - A dead PID-less named shell whose `background_shell_end` hook was
        //    dropped (e.g. a fast `npm run build` that exited without the engine
        //    draining its id): its output file has been frozen for many cycles.
        // Reclaim the latter: a named shell with no Tier A PID whose output has
        // been quiescent past the threshold, most-quiescent first, bounded by
        // the deficit so we never drain more than the count says vanished. Do
        // NOT rebase `preExistingHelpers` down (that would corrupt the re-sync
        // once a still-live named shell clears).
        const reclaimable: Array<{ shellId: string; quiescentCycles: number }> = [];
        for (const shellId of namedIds) {
          if (state.trackedShellPids.has(shellId)) continue; // has a Tier A PID
          const entry = state.shellOutputFiles.get(shellId);
          if (entry === undefined) continue; // no on-disk output to judge by
          if (entry.quiescentCycles < NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES) continue;
          reclaimable.push({ shellId, quiescentCycles: entry.quiescentCycles });
        }
        reclaimable.sort((a, b) => b.quiescentCycles - a.quiescentCycles);
        for (const candidate of reclaimable.slice(0, delta)) {
          state.shellOutputFiles.delete(candidate.shellId);
          this.callbacks.onNamedShellLikelyExited(sessionId, candidate.shellId);
        }
      } else {
        // No engine-tracked shells to attribute the exit to. A
        // pre-existing helper (MCP server, statusline worker)
        // restarted or crashed. Adjust `preExistingHelpers` down so
        // future cycles don't keep firing this branch.
        state.preExistingHelpers = Math.max(0, state.preExistingHelpers - delta);
      }
      state.consecutiveDeficitCycles = 0;
    } else {
      // In sync (shellLikeCount === expected): every tracked bg shell is
      // present in the OS tree. Reset the lag-tolerance counter and, when the
      // engine has tracked bg shells, confirm liveness so the engine refreshes
      // the bg-shell sole-holder grace anchor for a long-running shell. Not
      // fired on the surplus branch above (ambiguous helper birth, returns
      // early) nor on a deficit (a possible exit must NOT refresh the grace).
      // Skipped when Tier A liveness already confirmed this cycle (above) so
      // the keep-alive is not double-fired.
      state.consecutiveDeficitCycles = 0;
      if (!livenessConfirmed && tracked > 0) {
        this.callbacks.onShellsObservedAlive(sessionId);
      }
    }
  }

  /**
   * Sample each named shell's output file and report whether any grew since the
   * previous cycle. The first sample for a shell is a BASELINE (records the
   * size/mtime, reports no growth) so a shell that is alive but quiet is not
   * mistaken for growth on its first observation. Returns true when at least
   * one tracked named shell's file advanced in size or mtime.
   */
  private sampleNamedShellOutputGrowth(
    sessionId: string,
    state: SessionWatchState,
    namedIds: string[],
  ): boolean {
    // Prune samples for shells the engine no longer tracks.
    if (state.shellOutputFiles.size > 0) {
      const trackedNamedShellIdSet = new Set(namedIds);
      for (const shellId of [...state.shellOutputFiles.keys()]) {
        if (!trackedNamedShellIdSet.has(shellId)) state.shellOutputFiles.delete(shellId);
      }
    }

    let grew = false;
    for (const shellId of namedIds) {
      const entry = state.shellOutputFiles.get(shellId);
      if (!entry) {
        const filePath = this.callbacks.resolveShellOutputFile(sessionId, shellId);
        if (!filePath) continue;
        const sample = this.statOutputFileFn(filePath);
        if (!sample) continue;
        // First observation is a baseline, not growth.
        state.shellOutputFiles.set(shellId, {
          filePath,
          sizeBytes: sample.sizeBytes,
          mtimeMs: sample.mtimeMs,
          quiescentCycles: 0,
        });
        continue;
      }
      const sample = this.statOutputFileFn(entry.filePath);
      if (!sample) {
        // File vanished: drop the entry so the next cycle re-resolves the path.
        state.shellOutputFiles.delete(shellId);
        continue;
      }
      if (sample.sizeBytes > entry.sizeBytes || sample.mtimeMs > entry.mtimeMs) {
        grew = true;
        entry.quiescentCycles = 0;
      } else {
        // No advance in size or mtime: the shell produced no output this cycle.
        // Accrue toward the output-quiescence reclaim threshold (acted on only
        // when the process tree also shows a persistent deficit; see the named
        // arm of the deficit branch in cycleSession).
        entry.quiescentCycles += 1;
      }
      entry.sizeBytes = sample.sizeBytes;
      entry.mtimeMs = sample.mtimeMs;
    }
    return grew;
  }

}
