import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdleReason } from '../../shared/types';
import type { ActivityState } from '../../shared/types';

const PTY_DEBUG_LOG = path.join(os.tmpdir(), 'kangentic-pty-debug.log');
function trackerLog(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  const line = `[${timestamp}] [tracker] ${message}\n`;
  try { fs.appendFileSync(PTY_DEBUG_LOG, line); } catch { /* ignore */ }
}

/**
 * Timeout in ms before silence is interpreted as idle.
 * Tuned to balance responsiveness vs avoiding flicker from brief output pauses.
 */
const PTY_SILENCE_THRESHOLD_MS = 10_000;

interface PtyActivityCallbacks {
  /** Called when PTY data indicates the agent is working. */
  onThinking(sessionId: string): void;
  /** Called when silence or a prompt pattern indicates the agent is idle. */
  onIdle(sessionId: string, detail: IdleReason): void;
  /** Return current activity state for the session. */
  getActivity(sessionId: string): ActivityState | undefined;
  /** Return whether the session is still running. */
  isSessionRunning(sessionId: string): boolean;
}

/**
 * Tracks PTY output patterns to infer agent activity for agents without
 * hook-based event streams (Aider) or with broken hooks (Codex).
 *
 * Two detection mechanisms:
 * 1. **Prompt detection** - adapter's `detectIdle()` on the activity strategy
 *    returns true when a definitive idle signal (e.g. `aider>` prompt) is
 *    found. Triggers immediate idle transition.
 * 2. **Silence timer** - if no PTY data arrives for `PTY_SILENCE_THRESHOLD_MS`,
 *    the agent is assumed idle. Used by TUI agents (Codex, Gemini) where
 *    prompt patterns are unreliable.
 *
 * PTY detection is automatically suppressed when hook-based thinking events
 * arrive (managed by UsageTracker via `suppress()`).
 */
export class PtyActivityTracker {
  private silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private suppressed = new Set<string>();
  private callbacks: PtyActivityCallbacks;

  constructor(callbacks: PtyActivityCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Suppress PTY detection for a session. Called when hook-based thinking
   * events arrive, proving hooks are working for this session.
   */
  suppress(sessionId: string): void {
    this.suppressed.add(sessionId);
    this.clearTimer(sessionId);
  }

  /** Check if PTY detection is suppressed for a session. */
  isSuppressed(sessionId: string): boolean {
    return this.suppressed.has(sessionId);
  }

  /**
   * Process a chunk of PTY output. Transitions idle -> thinking and resets
   * the silence timer. No-op if suppressed or session not running.
   */
  onData(sessionId: string): void {
    if (this.suppressed.has(sessionId)) {
      trackerLog(`${sessionId.slice(0, 8)} onData SUPPRESSED`);
      return;
    }
    if (!this.callbacks.isSessionRunning(sessionId)) {
      trackerLog(`${sessionId.slice(0, 8)} onData NOT-RUNNING`);
      return;
    }

    const currentActivity = this.callbacks.getActivity(sessionId);
    if (currentActivity === 'idle') {
      trackerLog(`${sessionId.slice(0, 8)} onData idle->thinking`);
      this.callbacks.onThinking(sessionId);
    }

    trackerLog(`${sessionId.slice(0, 8)} resetSilenceTimer (${PTY_SILENCE_THRESHOLD_MS}ms)`);
    this.resetSilenceTimer(sessionId);
  }

  /**
   * Signal a definitive idle pattern detected in PTY output (e.g. prompt).
   * Immediately transitions to idle. No-op if suppressed.
   */
  onIdleDetected(sessionId: string): void {
    if (this.suppressed.has(sessionId)) return;
    if (!this.callbacks.isSessionRunning(sessionId)) return;

    this.clearTimer(sessionId);

    if (this.callbacks.getActivity(sessionId) !== 'idle') {
      this.callbacks.onIdle(sessionId, IdleReason.Prompt);
    }
  }

  /** Clean up timer for a session (suspend, remove, etc.). */
  clearSession(sessionId: string): void {
    this.clearTimer(sessionId);
    this.suppressed.delete(sessionId);
  }

  /** Clean up all timers (shutdown). */
  dispose(): void {
    for (const timer of this.silenceTimers.values()) {
      clearTimeout(timer);
    }
    this.silenceTimers.clear();
    this.suppressed.clear();
  }

  private resetSilenceTimer(sessionId: string): void {
    this.clearTimer(sessionId);

    const timer = setTimeout(() => {
      this.silenceTimers.delete(sessionId);
      if (this.suppressed.has(sessionId)) { trackerLog(`${sessionId.slice(0, 8)} TIMER: suppressed`); return; }
      if (!this.callbacks.isSessionRunning(sessionId)) { trackerLog(`${sessionId.slice(0, 8)} TIMER: not running`); return; }
      const activity = this.callbacks.getActivity(sessionId);
      if (activity !== 'thinking') { trackerLog(`${sessionId.slice(0, 8)} TIMER: skip (state=${activity})`); return; }

      trackerLog(`${sessionId.slice(0, 8)} TIMER: FIRING -> idle`);
      this.callbacks.onIdle(sessionId, IdleReason.Silence);
    }, PTY_SILENCE_THRESHOLD_MS);
    timer.unref();
    this.silenceTimers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const existing = this.silenceTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.silenceTimers.delete(sessionId);
    }
  }
}
