/**
 * Per-session output backpressure for the PTY -> renderer pipeline.
 *
 * The renderer is a single thread shared by every xterm, the React board, and
 * all input; an open-loop PTY can flood it and freeze the UI. This controller
 * tracks bytes emitted to the renderer but not yet acknowledged ("in flight")
 * and pauses a session's PTY output socket once the renderer falls
 * `highWater` bytes behind, resuming when the renderer drains below
 * `lowWater`. The hysteresis prevents pause/resume thrash.
 *
 * Accounting is per-session, so one chatty agent throttles only itself and
 * cannot starve the others. It drives `IPty.pause()` / `IPty.resume()`, which
 * touch only the read side of the PTY socket: user keystrokes (including
 * Ctrl-S / Ctrl-Q) are never affected, unlike the in-band XON/XOFF
 * `handleFlowControl` mechanism, which is deliberately not used.
 *
 * All pause/resume calls are best-effort: a target that throws (or a torn-down
 * PTY) degrades to the prior open-loop behavior rather than crashing.
 *
 * The host's own pending buffer is the second reason to pause. The flush ships
 * at most 256 KB a tick, about 11 MB/s, so a PTY faster than that piled up in
 * the pending buffer while the renderer kept acknowledging and in-flight never
 * reached its high water: measured 2026-10-24 at 5 million characters a second
 * for an on-screen flood, the same climb that crashed the host with "Invalid
 * string length" off screen. `recordPending` pauses on that backlog too, and a
 * paused session resumes only once BOTH counts are low.
 *
 * A pause that no ack answers is released (`releaseStalePauses`). A renderer
 * whose React tree was gone but whose page lived on (the root error boundary
 * after a dev hot update, task #912) kept its port and its focus set, so the
 * host posted to an xterm that no longer existed, nothing acked, and the agent
 * sat paused for ten minutes. A paused session with no ack for `STALE_PAUSE_MS`
 * is resumed with its in-flight reset and its high water raised to
 * `RELEASED_HIGH_WATER` until the next ack. A dead renderer then slows the
 * agent only at the raised cap, once per stale window. A renderer that is alive
 * but stalled past the window gets at most that much more before the host
 * pauses again, not everything the agent writes while it is stalled.
 */

export interface PauseResumeTarget {
  pause(): void;
  resume(): void;
}

// Thresholds are in JavaScript string length (UTF-16 code units), the unit
// both recordEmitted and acknowledge use, not raw bytes. They are equal for
// ASCII terminal output; multibyte content (CJK, emoji) makes the real IPC
// payload larger per unit, which only widens the effective headroom.
/** Pause when more than this many emitted code units are unacknowledged. */
export const BACKPRESSURE_HIGH_WATER = 1024 * 1024;
/** Resume once the in-flight backlog drains below this. */
export const BACKPRESSURE_LOW_WATER = 256 * 1024;
/**
 * Pause when the host's own pending buffer holds more than this. Ordinary
 * output never comes near it: sampled back to back for 30 s (2026-10-24),
 * Claude streaming a 300-line answer peaked at 1,901 characters pending and a
 * 60 Hz full-screen repaint at 2,359. At the flush's ~11 MB/s it is about a
 * third of a second of backlog.
 */
export const PENDING_HIGH_WATER = 4 * 1024 * 1024;
/** Resume once the pending buffer is down to about one flush slice. */
export const PENDING_LOW_WATER = 256 * 1024;
/**
 * A paused session whose renderer has acked nothing for this long is released
 * (see `RELEASED_HIGH_WATER`). A live renderer can go a while without acking, so this sits above
 * every hold it bounds: a scrollback replay holds its output for at most
 * `SCROLLBACK_WATCHDOG_MS` (5 s), a frame hold for `FRAME_HOLD_WATCHDOG_MS`
 * (2 s), and a terminal mount was measured at up to about 6 s under a 25x CPU
 * throttle (`terminal-arrival-focus.md`). Each ack restarts the clock.
 */
export const STALE_PAUSE_MS = 10_000;
/** How often the host looks for a stale pause while any session is paused. */
export const STALE_PAUSE_CHECK_MS = 1_000;
/**
 * The in-flight high water after a stale release, until the next ack. A dead
 * renderer costs the agent one stale window per this many characters. A
 * renderer that is alive but stalled past the window is sent at most this much
 * before the host pauses again. Without a cap, a release posted at the flush's
 * ~11 MB/s for as long as the stall lasted.
 */
export const RELEASED_HIGH_WATER = 8 * BACKPRESSURE_HIGH_WATER;

interface BackpressureState {
  inFlight: number;
  pending: number;
  paused: boolean;
  /** The last pause or ack: the clock a stale pause is measured from. */
  lastProgressAtMs: number;
  /** Released by `releaseStalePauses`: pauses at `releasedHighWater` until the next ack. */
  released: boolean;
}

/** Every field defaults to the constant of the same name above, and `now` to `Date.now`. */
export interface BackpressureOptions {
  highWater?: number;
  lowWater?: number;
  pendingHighWater?: number;
  pendingLowWater?: number;
  now?: () => number;
  stalePauseMs?: number;
  releasedHighWater?: number;
}

/** A pause `releaseStalePauses` let go of. */
export interface StalePauseRelease {
  sessionId: string;
  /** Characters in flight when it was released, none of them acked. */
  inFlight: number;
  /** How long since the pause or the last ack. */
  idleMs: number;
}

export class BackpressureController {
  private state = new Map<string, BackpressureState>();
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly pendingHighWater: number;
  private readonly pendingLowWater: number;
  private readonly now: () => number;
  private readonly stalePauseMs: number;
  private readonly releasedHighWater: number;

  constructor(
    private readonly getTarget: (sessionId: string) => PauseResumeTarget | null,
    options: BackpressureOptions = {},
  ) {
    this.highWater = options.highWater ?? BACKPRESSURE_HIGH_WATER;
    this.lowWater = options.lowWater ?? BACKPRESSURE_LOW_WATER;
    this.pendingHighWater = options.pendingHighWater ?? PENDING_HIGH_WATER;
    this.pendingLowWater = options.pendingLowWater ?? PENDING_LOW_WATER;
    this.now = options.now ?? Date.now;
    this.stalePauseMs = options.stalePauseMs ?? STALE_PAUSE_MS;
    this.releasedHighWater = options.releasedHighWater ?? RELEASED_HIGH_WATER;
  }

  /** Record bytes emitted to the renderer; pause the PTY if it falls behind. */
  recordEmitted(sessionId: string, bytes: number): void {
    if (bytes <= 0) return;
    const entry = this.entryFor(sessionId);
    entry.inFlight += bytes;
    this.pauseIfBehind(sessionId, entry);
  }

  /** Renderer consumed `bytes` (written or dropped); resume once caught up. */
  acknowledge(sessionId: string, bytes: number): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    entry.lastProgressAtMs = this.now();
    // A renderer is consuming again, so the normal high water is back. What
    // was in flight at a release was zeroed then, and its acks still coming
    // make the count run low by at most that much, briefly.
    entry.released = false;
    entry.inFlight = Math.max(0, entry.inFlight - bytes);
    this.resumeIfCaughtUp(sessionId, entry);
  }

  /**
   * Resume every session paused on in-flight bytes that nothing has acked for
   * `stalePauseMs`, reset its in-flight, and raise its high water to
   * `releasedHighWater` until the next ack. A session that reaches the raised
   * cap with still no ack is released again one stale window later. A pause
   * the host's own pending buffer still holds stays until `recordPending` sees
   * it drained, because that one protects the host itself.
   */
  releaseStalePauses(): StalePauseRelease[] {
    const nowMs = this.now();
    const released: StalePauseRelease[] = [];
    for (const [sessionId, entry] of this.state) {
      if (!entry.paused || entry.inFlight <= this.lowWater) continue;
      const idleMs = nowMs - entry.lastProgressAtMs;
      if (idleMs < this.stalePauseMs) continue;
      released.push({ sessionId, inFlight: entry.inFlight, idleMs });
      entry.inFlight = 0;
      entry.released = true;
      this.resumeIfCaughtUp(sessionId, entry);
    }
    return released;
  }

  /** Whether any session is paused, which is when a stale pause is possible. */
  hasPausedSession(): boolean {
    for (const entry of this.state.values()) {
      if (entry.paused) return true;
    }
    return false;
  }

  /** The host's pending (not yet flushed) buffer is now `chars` long; pause
   *  the PTY when it piles up, resume once it and in-flight are both low. */
  recordPending(sessionId: string, chars: number): void {
    const entry = this.state.get(sessionId);
    // Nothing to resume and nothing worth pausing for: keep no entry.
    if (!entry && chars < this.pendingHighWater) return;
    const tracked = entry ?? this.entryFor(sessionId);
    tracked.pending = chars;
    this.pauseIfBehind(sessionId, tracked);
    this.resumeIfCaughtUp(sessionId, tracked);
  }

  /** Resume a paused session (if any) and forget its accounting. */
  release(sessionId: string): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    if (entry.paused) this.tryResume(sessionId);
    this.state.delete(sessionId);
  }

  /** Resume every paused session and clear all accounting. */
  reset(): void {
    for (const [sessionId, entry] of this.state) {
      if (entry.paused) this.tryResume(sessionId);
    }
    this.state.clear();
  }

  /** Test/diagnostic: whether a session is currently paused. */
  isPaused(sessionId: string): boolean {
    return this.state.get(sessionId)?.paused ?? false;
  }

  /** Test/diagnostic: bytes emitted to the renderer but not yet acknowledged. */
  getInFlight(sessionId: string): number {
    return this.state.get(sessionId)?.inFlight ?? 0;
  }

  private entryFor(sessionId: string): BackpressureState {
    let entry = this.state.get(sessionId);
    if (!entry) {
      entry = { inFlight: 0, pending: 0, paused: false, lastProgressAtMs: this.now(), released: false };
      this.state.set(sessionId, entry);
    }
    return entry;
  }

  private pauseIfBehind(sessionId: string, entry: BackpressureState): void {
    if (entry.paused) return;
    const highWater = entry.released ? this.releasedHighWater : this.highWater;
    if (entry.inFlight < highWater && entry.pending < this.pendingHighWater) return;
    if (!this.tryPause(sessionId)) return;
    entry.paused = true;
    entry.lastProgressAtMs = this.now();
  }

  private resumeIfCaughtUp(sessionId: string, entry: BackpressureState): void {
    if (!entry.paused || entry.inFlight > this.lowWater || entry.pending > this.pendingLowWater) return;
    this.tryResume(sessionId);
    // Clear the flag even if tryResume found no live target: a null PTY here
    // is unreachable in practice (kill/suspend call release(), which deletes
    // this entry, before nulling the PTY), and leaving paused=true would only
    // wedge a session whose accounting is already gone.
    entry.paused = false;
  }

  private tryPause(sessionId: string): boolean {
    const target = this.getTarget(sessionId);
    if (!target) return false;
    try {
      target.pause();
      return true;
    } catch {
      return false;
    }
  }

  private tryResume(sessionId: string): void {
    const target = this.getTarget(sessionId);
    if (!target) return;
    try {
      target.resume();
    } catch {
      // best-effort
    }
  }
}
