/**
 * Per-session latch that fires exactly once when an agent first produces
 * "meaningful" PTY output. Used by SessionManager to lift the shimmer
 * overlay in the renderer and to clear the `resuming` flag on resumed
 * sessions.
 *
 * What counts as meaningful is adapter-specific. Claude waits for the
 * alternate-screen-buffer escape (`\x1b[?1049h`) because its shell prompt
 * renders before the CLI actually boots. Other agents default to any
 * non-empty data. The decision is delegated to the agent adapter via the
 * `detectFirstOutput` callback passed to `consume()`; when no detector is
 * given, any non-empty chunk qualifies.
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

  /** Drop per-session state. Called from SessionManager.remove(). */
  removeSession(sessionId: string): void {
    this.emitted.delete(sessionId);
  }

  /** Drop all state. Called from SessionManager.killAll(). */
  clear(): void {
    this.emitted.clear();
  }
}
