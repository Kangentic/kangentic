import { EventType, AgentTool } from '../../shared/types';
import type { SessionEvent } from '../../shared/types';
import { matchesPRCommand } from '../pr/pr-registry';

/**
 * Detects `gh pr ...` (and equivalent) commands so the orchestrator knows when
 * to resolve the task's PR. This is only the *hint* that a PR operation just
 * finished; the matching ToolEnd fires a `pr-candidate` event whose listener
 * runs the authoritative branch->PR query.
 *
 * State: per-session "pending" flag, set when a Bash ToolStart matches
 * a PR-creating command, cleared when the matching Bash ToolEnd arrives
 * (and a `pr-candidate` event fires for that session).
 *
 * Why this is its own module:
 *   - The flag was previously stored on the activity engine, but it
 *     has nothing to do with activity transitions - the engine should
 *     not know about PR sniffing.
 *   - A fallback PR resolve also runs on session exit when ToolEnd was
 *     dropped (event-bridge crash, hook never fired). That path needs
 *     to read and clear the flag from outside the event-ingest loop.
 */
export class PRCommandDetector {
  private pending = new Set<string>();

  /**
   * Inspect one event. On Bash ToolStart with a PR command, mark the
   * session as pending. On Bash ToolEnd while pending, clear the flag
   * and return `{ fireCandidate: true }` so the caller can fire its
   * `pr-candidate` event (which runs the authoritative branch->PR query).
   */
  detect(sessionId: string, event: SessionEvent): { fireCandidate: boolean } {
    if (event.type === EventType.ToolStart
        && event.tool === AgentTool.Bash
        && event.detail
        && matchesPRCommand(event.detail)) {
      this.pending.add(sessionId);
      return { fireCandidate: false };
    }
    if (event.type === EventType.ToolEnd
        && event.tool === AgentTool.Bash
        && this.pending.has(sessionId)) {
      this.pending.delete(sessionId);
      return { fireCandidate: true };
    }
    return { fireCandidate: false };
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Clear the pending flag without firing the callback. Used by the
   *  exit-time fallback scan after it has read the flag. */
  clearPending(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  removeSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
