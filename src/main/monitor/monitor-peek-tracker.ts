/**
 * Live "recent output peek" for the Agent Monitor: the last few rendered lines of
 * every session's terminal, pushed to the monitor as they change.
 *
 * ## Why this is not on the monitor snapshot
 *
 * `buildMonitorSnapshot` rebuilds only when the DB-resident half of a row can
 * have changed (a session appeared / changed status / exited, or an agent edited
 * a board). Terminal output is none of those, so a peek carried on the snapshot
 * would sit frozen for minutes while the terminal scrolled. The peek has to ride
 * a mechanism that fires on OUTPUT.
 *
 * ## Why `data-tap`
 *
 * `SessionManager`'s `data` event is gated on the renderer's focused set, which
 * is exactly wrong here: the monitor's whole job is showing sessions you are NOT
 * looking at. `data-tap` is the documented focus-independent seam for headless
 * consumers, it already fires from the 16ms flush (so it is pre-coalesced), and
 * it deliberately does not feed backpressure.
 *
 * ## The cost bound, stated rather than implied
 *
 * `data-tap` emits are a no-op when nothing is listening, so this attaches its
 * listener ONLY while a monitor surface is subscribed and detaches when the last
 * one goes away. A closed monitor therefore costs nothing at all. While open:
 *
 *   - per PTY chunk: one `Set.add`, nothing else. No parsing, no grid read.
 *   - per sample tick: an O(rows) synchronous grid read for DIRTY sessions only.
 *   - per push: only sessions whose peek text actually CHANGED.
 *
 * That last gate is what keeps a spinner-ticking TUI quiet. A repainting frame
 * whose visible text is unchanged produces no push.
 *
 * Subscribers are tracked per renderer id because the detached monitor window is
 * a second, independent subscriber; the listener's lifetime follows the union.
 *
 * ## Why the push is cross-project and fanned out
 *
 * Peeks for EVERY session in EVERY registered project go to every subscribed
 * monitor. That is deliberate, and it is the existing contract rather than a new
 * one: `buildMonitorSnapshot` already spans every project by design, and the field
 * this replaced (the task-description excerpt) was fanned out exactly the same way
 * on `MONITOR_CHANGED`. A monitor renderer displays all of those rows, so it needs
 * all of them.
 *
 * Do not read the `SESSION_DATA` exclusion in `POP_OUT_SURFACES.monitor.channels`
 * as a precedent against this. That exclusion is about VOLUME: SESSION_DATA is a
 * raw, unbounded per-session byte stream, so it is routed off the focus map and
 * participates in backpressure. A peek is at most a few short lines, change-gated,
 * and sampled at most twice a second.
 */
import type { SessionManager } from '../pty/session-manager';
import { peeksEqual } from '../pty/buffer/output-peek';

/**
 * How often dirty sessions are resampled. Fast enough that a card reads as live,
 * slow enough that a flooding agent cannot turn the monitor into a busy loop:
 * output arriving at any rate collapses into at most two samples per second.
 */
export const PEEK_SAMPLE_INTERVAL_MS = 500;

export interface MonitorPeekTrackerDeps {
  sessionManager: SessionManager;
  /** Deliver changed peeks. Called only with a non-empty map. */
  emit: (peeks: Record<string, string[]>) => void;
}

export class MonitorPeekTracker {
  private readonly sessionManager: SessionManager;
  private readonly emit: (peeks: Record<string, string[]>) => void;

  /** Renderer ids currently showing a monitor. The listener follows this set. */
  private readonly subscribers = new Set<number>();
  /** Sessions that produced output since the last sample. */
  private readonly dirty = new Set<string>();
  /** Last peek pushed per session, for the change-gate. */
  private lastSent = new Map<string, string[]>();

  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private listening = false;

  private readonly onDataTap = (sessionId: string): void => {
    this.dirty.add(sessionId);
  };

  /**
   * Forget a finished session's bookkeeping.
   *
   * Without this, `lastSent` only ever shrinks on a re-subscribe. Safe to drop on
   * exit: the renderer keeps the peek it was already sent, and the row lives on
   * as "recently finished".
   *
   * Note this clears the change-gate rather than closing it. The PTY's `exit`
   * fires synchronously from node-pty while the last chunk may still be parked on
   * the buffer manager's 16ms flush, so a late `data-tap` can re-dirty the session
   * and re-populate `lastSent` with its final frame. That is desirable, not a
   * leak: the agent's closing lines reach the card instead of being dropped on
   * the exit edge.
   */
  private readonly onSessionExit = (sessionId: string): void => {
    this.dirty.delete(sessionId);
    this.lastSent.delete(sessionId);
  };

  constructor(deps: MonitorPeekTrackerDeps) {
    this.sessionManager = deps.sessionManager;
    this.emit = deps.emit;
  }

  /**
   * Subscribe a renderer. Idempotent per id.
   *
   * Seeds the caller with a full pass over every live session, because an IDLE
   * session emits no output and would otherwise show a blank card until it
   * happened to speak. The seed bypasses the change-gate for the same reason: a
   * newly subscribed renderer has never received these peeks even though this
   * process may already have sent them to someone else.
   */
  subscribe(rendererId: number): void {
    this.subscribers.add(rendererId);
    this.attach();
    this.sampleAll();
  }

  /** Unsubscribe a renderer; the listener and timer stop with the last one. */
  unsubscribe(rendererId: number): void {
    this.subscribers.delete(rendererId);
    if (this.subscribers.size === 0) this.detach();
  }

  /** Full teardown, for app shutdown. */
  dispose(): void {
    this.subscribers.clear();
    this.detach();
    this.lastSent = new Map();
  }

  private attach(): void {
    if (this.listening) return;
    this.listening = true;
    this.sessionManager.on('data-tap', this.onDataTap);
    this.sessionManager.on('exit', this.onSessionExit);
    this.sampleTimer = setInterval(() => this.sampleDirty(), PEEK_SAMPLE_INTERVAL_MS);
  }

  private detach(): void {
    if (!this.listening) return;
    this.listening = false;
    this.sessionManager.off('data-tap', this.onDataTap);
    this.sessionManager.off('exit', this.onSessionExit);
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.dirty.clear();
  }

  /** Resample every live session and push, ignoring the change-gate. */
  private sampleAll(): void {
    const peeks: Record<string, string[]> = {};
    const live = new Set<string>();
    for (const summary of this.sessionManager.listManagedSummaries()) {
      live.add(summary.id);
      const lines = this.sessionManager.getOutputPeek(summary.id);
      if (lines.length === 0) continue;
      this.lastSent.set(summary.id, lines);
      peeks[summary.id] = lines;
    }
    // Drop bookkeeping for sessions the registry has forgotten. Bounded by
    // REGISTRY MEMBERSHIP, not by exit: an exited session stays registered (that
    // is what makes the monitor's "recently finished" rows work), so this only
    // collects once SessionManager.remove() drops it for good.
    for (const sessionId of [...this.lastSent.keys()]) {
      if (!live.has(sessionId)) this.lastSent.delete(sessionId);
    }
    this.dirty.clear();
    if (Object.keys(peeks).length > 0) this.emit(peeks);
  }

  /** Resample only sessions that produced output, and push only real changes. */
  private sampleDirty(): void {
    if (this.dirty.size === 0) return;
    const sampling = [...this.dirty];
    this.dirty.clear();

    const changed: Record<string, string[]> = {};
    for (const sessionId of sampling) {
      const lines = this.sessionManager.getOutputPeek(sessionId);
      if (lines.length === 0) continue;
      const previous = this.lastSent.get(sessionId);
      if (previous && peeksEqual(previous, lines)) continue;
      this.lastSent.set(sessionId, lines);
      changed[sessionId] = lines;
    }
    if (Object.keys(changed).length > 0) this.emit(changed);
  }
}
