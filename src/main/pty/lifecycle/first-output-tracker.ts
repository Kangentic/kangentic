/**
 * Per-session latch that fires exactly once. Two owners use it for two
 * different questions:
 *
 * - The pty host runs each adapter's `detectFirstOutput` through `consume()`
 *   and reports a match as `firstOutput`. Main uses that match only to time
 *   the boot geometry re-assert. Claude matches the cursor-hide escape
 *   (`\x1b[?25l` - see ClaudeAdapter.detectFirstOutput), as do several other
 *   TUI adapters; when no detector is given, any non-empty chunk qualifies.
 *
 * - SessionManager keeps its own instance as the launch-overlay latch: it is
 *   marked (`markEmitted`) when the session's agent is demonstrably on screen
 *   (`SessionManager.markAgentReady`), and that is the 'first-output' event
 *   the renderer lifts the shimmer on. `armCeiling()` backstops a session
 *   whose agent never shows that evidence.
 *
 * CAUTION: a detector match is not proof the AGENT is up. Shell preambles can
 * carry the very escapes the detectors match (pwsh 7.6 and Windows PowerShell
 * emit `\x1b[?25l` at startup - see buildSpawnClearPrelude in
 * src/shared/paths.ts), so on such shells the host's latch trips on SHELL
 * bytes tens of ms after spawn. Anything that needs "the agent is demonstrably
 * driving the terminal" must key on the stream's alt-screen entry
 * (PtyBufferManager's onAltScreenEnter) or the agent's output after the spawn
 * handoff (AgentOutputTracker) instead - misreading the detector latch as an
 * agent-liveness signal is how the task #573 spawn-race fix initially missed
 * its target, and how the Command Terminal came to show the PowerShell prompt
 * for seconds before Claude's TUI.
 *
 * Call `removeSession()` when a session is fully cleaned up, or `clear()`
 * during killAll(); both also cancel a pending ceiling.
 */
export class FirstOutputTracker {
  private emitted = new Set<string>();
  private ceilings = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Feed a fresh PTY chunk. If the session has not yet emitted first
   * output and the chunk qualifies, mark it emitted and return true.
   * Returns false if the session already emitted, the chunk doesn't
   * qualify, or the detector rejects it.
   */
  consume(
    sessionId: string,
    data: string,
    detectFirstOutput?: (data: string) => boolean,
  ): boolean {
    if (this.emitted.has(sessionId)) return false;
    const isReady = detectFirstOutput ? detectFirstOutput(data) : data.length > 0;
    if (!isReady) return false;
    this.emitted.add(sessionId);
    return true;
  }

  /**
   * Record a first output decided elsewhere. Returns true the first time for
   * a session, so a repeated report cannot fire twice. Cancels the session's
   * ceiling, which has nothing left to backstop.
   */
  markEmitted(sessionId: string): boolean {
    if (this.emitted.has(sessionId)) return false;
    this.emitted.add(sessionId);
    this.disarmCeiling(sessionId);
    return true;
  }

  /**
   * Run `onCeiling` after `ms` unless the session emits first. A no-op when it
   * already emitted or a ceiling is already armed. The timer is unref'd so it
   * never holds the process open.
   */
  armCeiling(sessionId: string, ms: number, onCeiling: () => void): void {
    if (this.emitted.has(sessionId) || this.ceilings.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.ceilings.delete(sessionId);
      onCeiling();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this.ceilings.set(sessionId, timer);
  }

  /** Cancel a session's pending ceiling, if any. */
  disarmCeiling(sessionId: string): void {
    const timer = this.ceilings.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.ceilings.delete(sessionId);
  }

  /** True if the session has emitted (`consume()` returned true, or `markEmitted`). */
  hasEmitted(sessionId: string): boolean {
    return this.emitted.has(sessionId);
  }

  /**
   * Snapshot of the session IDs that have emitted first output. Used to
   * rebuild the renderer's `sessionFirstOutput` map after an HMR reload (the
   * renderer state resets to {} on module re-evaluation, which would otherwise
   * flash a running session back to "Starting agent..." until its next chunk).
   */
  snapshot(): string[] {
    return Array.from(this.emitted);
  }

  /** Drop per-session state. Called from SessionManager.remove(). */
  removeSession(sessionId: string): void {
    this.emitted.delete(sessionId);
    this.disarmCeiling(sessionId);
  }

  /** Drop all state. Called from SessionManager.killAll(). */
  clear(): void {
    this.emitted.clear();
    for (const timer of this.ceilings.values()) clearTimeout(timer);
    this.ceilings.clear();
  }
}
