/**
 * Where a turn's transcript begins: a byte offset into the session's history
 * file, in the form a window read resumes from (`readWindows`'s cursor). A
 * reply read from it never reaches back before the turn, so a turn that wrote
 * no text has no reply even when the walk back finds no prompt to stop at: a
 * Claude turn a `<task-notification>` opened, or one an `isMeta` peer hand-back
 * or `/loop` wakeup opened, which the parser drops.
 *
 * Clock-free on purpose. The CLI stamps its transcript with its own clock, and
 * a WSL guest's clock can drift minutes from the app's, so a timestamp would
 * read a fresh reply as stale. `agentSessionId` names the file the offset is
 * in; an offset into another file means nothing.
 */
export interface TranscriptAnchor {
  agentSessionId: string;
  byteOffset: number;
}

/**
 * How far a session's transcript has been read: the agent message trail
 * (`MessageTrailTracker`). `SessionManager` takes it as where a turn began
 * (`TurnEndedPayload.transcriptAnchor`) and is handed it through
 * `setTranscriptPositionSource`, since the trail lives in the IPC layer.
 */
export interface TranscriptPositionSource {
  /** Where the last finished read reached, or null when that is not known. */
  transcriptPosition(sessionId: string): TranscriptAnchor | null;
  /** Whether a read of the session's transcript is running or scheduled. */
  hasPendingRead(sessionId: string): boolean;
  /**
   * Whether a read of the session's transcript is running now. One runs at a
   * time per session, so the next read to land is the one running when a turn
   * is stamped. The event that opened the turn can have started it: a
   * `tool_start` triggers a read before the engine stamps the turn, a prompt
   * does not.
   */
  hasReadInFlight(sessionId: string): boolean;
}
