/**
 * Per-session latch that fires exactly once when an agent first produces
 * "meaningful" PTY output. Used by SessionManager to lift the shimmer
 * overlay in the renderer and to clear the `resuming` flag on resumed
 * sessions.
 *
 * What counts as meaningful is adapter-specific. Claude matches the
 * cursor-hide escape (`\x1b[?25l` - see ClaudeAdapter.detectFirstOutput), as
 * do several other TUI adapters. The decision is delegated to the agent
 * adapter via the `detectFirstOutput` callback passed to `consume()`; when no
 * detector is given, any non-empty chunk qualifies.
 *
 * CAUTION: this latch is a shimmer-overlay heuristic, not proof the AGENT is
 * up. Shell preambles can carry the very escapes the detectors match (pwsh
 * 7.6 emits `\x1b[?25l` at startup - see buildSpawnClearPrelude in
 * src/shared/paths.ts), so on such shells the latch trips on SHELL bytes
 * tens of ms after spawn. Anything that needs "the agent is demonstrably
 * driving the terminal" must key on the stream's alt-screen entry instead
 * (PtyBufferManager's onAltScreenEnter) - misreading this latch as an
 * agent-liveness signal is how the task #573 spawn-race fix initially
 * missed its target.
 *
 * The tracker holds only a set of session IDs. Call `removeSession()`
 * when a session is fully cleaned up, or `clear()` during killAll().
 */
export class FirstOutputTracker {
  private emitted = new Set<string>();

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

  /** True if `consume()` has ever returned true for this session. */
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
  }

  /** Drop all state. Called from SessionManager.killAll(). */
  clear(): void {
    this.emitted.clear();
  }
}
