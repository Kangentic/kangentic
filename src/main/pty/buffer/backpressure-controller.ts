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

interface BackpressureState {
  inFlight: number;
  pending: number;
  paused: boolean;
}

export class BackpressureController {
  private state = new Map<string, BackpressureState>();

  constructor(
    private readonly getTarget: (sessionId: string) => PauseResumeTarget | null,
    private readonly highWater: number = BACKPRESSURE_HIGH_WATER,
    private readonly lowWater: number = BACKPRESSURE_LOW_WATER,
    private readonly pendingHighWater: number = PENDING_HIGH_WATER,
    private readonly pendingLowWater: number = PENDING_LOW_WATER,
  ) {}

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
    entry.inFlight = Math.max(0, entry.inFlight - bytes);
    this.resumeIfCaughtUp(sessionId, entry);
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
      entry = { inFlight: 0, pending: 0, paused: false };
      this.state.set(sessionId, entry);
    }
    return entry;
  }

  private pauseIfBehind(sessionId: string, entry: BackpressureState): void {
    if (entry.paused) return;
    if (entry.inFlight < this.highWater && entry.pending < this.pendingHighWater) return;
    if (this.tryPause(sessionId)) entry.paused = true;
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
