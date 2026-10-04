import type { PtyDisposable, PtyHandle } from '../host/pty-host-client';

/**
 * Deferred force-kill for a PTY whose agent is still inside its boot window.
 *
 * Claude Code keeps a boot canary in `~/.claude.json`: `fullscreenBootPending[pid]`
 * is written at REPL mount and withdrawn 10 s after the first rendered frame, or
 * on a graceful exit (`/exit`, Ctrl+C, Ctrl+D). A record whose pid is dead at the
 * next launch counts as a strike; one strike runs that launch on the classic
 * renderer, two make the classic renderer sticky until `/tui fullscreen` or a
 * Claude update. Kangentic injects `tui: fullscreen` for every user without a
 * `/tui` choice, so a strike silently brings back the scrollback duplication
 * fullscreen was adopted to fix.
 *
 * A bare `pty.kill()` is ClosePseudoConsole on Windows: Claude gets about 100 ms,
 * and the locked withdrawal of the record (a 1.4 MB read, parse, rewrite under
 * `~/.claude.json.lock`) lands at 82 to 97 ms on an idle machine. Load, or a
 * sibling Claude holding the lock, leaves the record behind. `suspend()` already
 * avoids this by writing the adapter's exit sequence and waiting 1500 ms;
 * `kill()` now does the same for a YOUNG session and keeps the instant teardown
 * for a mature one.
 *
 * The deferred PTY lives here, outside the registry row, on purpose: the row is
 * nulled at once (`session.pty = null`, as before), `remove()` may delete it in
 * the same tick, and the respawn sibling drain hard-kills any row it finds for
 * the same task. Nothing in the registry can reach a PTY parked here, so the
 * grace cannot be cut short by a respawn.
 *
 * The registry attaches NO listener of its own to the PTY. The spawn flow's
 * `onExit` stays attached on the normal path and emits the manager's `'exit'`
 * event, which is what cancels a timer whose PTY exited on its own; a second
 * `ptyRef.onExit` would replace the single handler every unit fixture holds.
 * The captured disposables are detached only at quit, where late callbacks
 * would land on a closed DB.
 */

/** Force-kill delay after the exit sequence, matching `gracefulPtyShutdown`. */
export const KILL_GRACE_MS = 1500;

/**
 * How long after the first alt-screen frame a session still counts as young:
 * Claude's 10 s post-first-frame window plus margin for the locked withdrawal.
 */
export const YOUNG_AFTER_ALT_SCREEN_MS = 12_000;

/**
 * Upper bound on "young" for a session that never entered the alt screen (a
 * `/tui default` user, an agent that renders inline, a shell whose agent died
 * before boot). Alt-screen entry is the canary's upper bound, never a
 * precondition: arming precedes the alt-screen bytes by under 100 ms, so a
 * session with no frame yet is inside the window. A Claude that needs more than
 * a minute from spawn to REPL mount is pathological, and without this bound an
 * inline-rendering session would pay the grace on every teardown for its whole
 * life.
 */
export const YOUNG_SINCE_SPAWN_MS = 60_000;

export interface YoungSessionFields {
  /** ISO timestamp of the spawn. */
  startedAt: string;
  /** Epoch ms of the stream's FIRST alt-screen entry, if it has happened. */
  altScreenEnteredAt?: number;
}

/**
 * Whether a teardown must give the agent the exit sequence and the grace.
 * An unparseable `startedAt` reads as young: the cost of a wrong "mature" is a
 * strike, the cost of a wrong "young" is 1.5 s.
 */
export function isYoungSession(session: YoungSessionFields, now = Date.now()): boolean {
  if (session.altScreenEnteredAt !== undefined) {
    return now - session.altScreenEnteredAt < YOUNG_AFTER_ALT_SCREEN_MS;
  }
  const startedAtMs = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAtMs)) return true;
  return now - startedAtMs < YOUNG_SINCE_SPAWN_MS;
}

/**
 * How long a parked PTY stays listed as awaiting its exit after the force-kill
 * fired, should its exit never be reported (a ConPTY that loses the callback).
 * Matches `awaitExit`'s safety timeout.
 */
export const AWAITING_EXIT_LISTING_MS = 10_000;

export interface DeferredKillInput {
  sessionId: string;
  /** The task the session ran for, so a task reap can wait for this PTY to exit. */
  taskId?: string | null;
  ptyRef: PtyHandle;
  /** The child pid, read by the caller before the row's `pty` was nulled. */
  pid: number | undefined;
  /**
   * The spawn flow's onData / onExit disposables, handed over so the quit path
   * can detach them: after `remove()` the row that held them is gone.
   */
  ptyDisposables?: PtyDisposable[];
}

interface DeferredKillEntry {
  sessionId: string;
  ptyRef: PtyHandle;
  pid: number | undefined;
  timer: ReturnType<typeof setTimeout>;
  ptyDisposables: PtyDisposable[] | undefined;
}

export interface DeferredKillRegistryOptions {
  killPty: (ptyRef: PtyHandle) => boolean;
  graceMs?: number;
}

export interface DeferredKillFlushReport {
  /** Probe-able child pids of the PTYs killed by the flush. */
  pids: number[];
  /** Every PTY the flush killed, including any with no readable pid. */
  count: number;
}

/**
 * The parked PTYs and their force-kill timers. Keyed by the PTY reference, not
 * the session id, so a reused id can never overwrite a live timer and leak an
 * un-killed child.
 */
export class DeferredKillRegistry {
  private readonly entries = new Map<PtyHandle, DeferredKillEntry>();
  /**
   * Every parked session whose PTY has not reported its exit, by session id,
   * with its task. Outlives the entry above: the force-kill's timer removes the
   * entry when it fires, but the process can take a while longer to go, and
   * until it does the pty host still holds it.
   */
  private readonly awaitingExit = new Map<string, { taskId: string | null; expiry: ReturnType<typeof setTimeout> | null }>();
  private readonly killPty: (ptyRef: PtyHandle) => boolean;
  private readonly graceMs: number;

  constructor(options: DeferredKillRegistryOptions) {
    this.killPty = options.killPty;
    this.graceMs = options.graceMs ?? KILL_GRACE_MS;
  }

  /**
   * Park a PTY whose exit sequence the caller has already written, and arm its
   * force-kill. Scheduling the same PTY twice keeps the first timer.
   */
  schedule(input: DeferredKillInput): void {
    if (this.entries.has(input.ptyRef)) return;
    const previous = this.awaitingExit.get(input.sessionId);
    if (previous?.expiry) clearTimeout(previous.expiry);
    this.awaitingExit.set(input.sessionId, { taskId: input.taskId ?? null, expiry: null });
    const timer = setTimeout(() => {
      this.entries.delete(input.ptyRef);
      this.killPty(input.ptyRef);
      const awaiting = this.awaitingExit.get(input.sessionId);
      if (awaiting && !awaiting.expiry) {
        awaiting.expiry = setTimeout(() => this.awaitingExit.delete(input.sessionId), AWAITING_EXIT_LISTING_MS);
        awaiting.expiry.unref?.();
      }
    }, this.graceMs);
    this.entries.set(input.ptyRef, {
      sessionId: input.sessionId,
      ptyRef: input.ptyRef,
      pid: input.pid,
      timer,
      ptyDisposables: input.ptyDisposables,
    });
  }

  /**
   * The session's PTY exited on its own inside the grace: drop the timer. A
   * kill on a dead PTY is swallowed anyway, so this is tidiness, not safety.
   */
  cancel(sessionId: string): boolean {
    let cancelled = false;
    for (const [ptyRef, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.entries.delete(ptyRef);
      cancelled = true;
    }
    // Called on the session's exit: whether or not a timer was still armed,
    // the process is gone.
    const awaiting = this.awaitingExit.get(sessionId);
    if (awaiting?.expiry) clearTimeout(awaiting.expiry);
    this.awaitingExit.delete(sessionId);
    return cancelled;
  }

  /**
   * The parked sessions of these tasks whose PTY has not exited yet, armed or
   * already force-killed. A task reap waits for them: until a PTY exits, the
   * pty host protects it and everything under it.
   */
  sessionsAwaitingExit(taskIds: ReadonlySet<string>): string[] {
    const sessionIds: string[] = [];
    for (const [sessionId, awaiting] of this.awaitingExit) {
      if (awaiting.taskId !== null && taskIds.has(awaiting.taskId)) sessionIds.push(sessionId);
    }
    return sessionIds;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Probe-able child pids of every parked PTY, for the quit drain. */
  pendingPids(): number[] {
    const pids: number[] = [];
    for (const entry of this.entries.values()) {
      if (Number.isInteger(entry.pid) && (entry.pid as number) > 0) pids.push(entry.pid as number);
    }
    return pids;
  }

  /**
   * Detach the captured PTY listeners of every parked entry, leaving the
   * timers armed. Quit-only: a late onData or onExit after `closeAll()` would
   * land on a closed DB and keep the libuv loop referenced past a clean quit.
   */
  detachAllListeners(): void {
    for (const entry of this.entries.values()) {
      disposeAll(entry.ptyDisposables);
      entry.ptyDisposables = undefined;
    }
  }

  /**
   * Force-kill every parked PTY now. Used when no drain will follow (an OS
   * shutdown the app cannot delay, a signal), so nothing may stay deferred.
   */
  flushAll(): DeferredKillFlushReport {
    const pids: number[] = [];
    let count = 0;
    for (const [ptyRef, entry] of [...this.entries]) {
      clearTimeout(entry.timer);
      this.entries.delete(ptyRef);
      disposeAll(entry.ptyDisposables);
      this.killPty(ptyRef);
      count += 1;
      if (Number.isInteger(entry.pid) && (entry.pid as number) > 0) pids.push(entry.pid as number);
    }
    return { pids, count };
  }
}

function disposeAll(disposables: PtyDisposable[] | undefined): void {
  if (!disposables) return;
  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch {
      // Best-effort: node-pty may have already torn down the emitter.
    }
  }
}
