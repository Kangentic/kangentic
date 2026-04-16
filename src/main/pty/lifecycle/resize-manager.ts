import { stripAnsiEscapes } from '../buffer/transcript-writer';
import type { ActivityState } from '../../../shared/types';

/**
 * Per-session state for suppressing TUI redraw flicker on resize.
 *
 * TUI agents (Codex, Gemini) redraw the full screen when the PTY resizes
 * (panel mount/unmount, project switch). The redraw produces "new" PTY
 * chunks that would otherwise flip activity idle->thinking, causing a
 * spurious flicker every time the user switches panels.
 *
 * Two layers of defense, both agent-agnostic:
 *
 *   1. Resize grace period (1500ms): if a resize happened within the
 *      grace window AND the session is currently idle AND the session
 *      has been woken at least once, treat incoming data as redraw noise.
 *      Frames still go in the dedup buffer so future identical chunks
 *      are filtered, but activity tracking is NOT poked.
 *
 *   2. Content dedup ring buffer (16 normalized frames): even outside
 *      the grace window, duplicate normalized content is treated as a
 *      redraw and skipped. Catches late refreshes and Codex's rotating
 *      input placeholder text that varies across otherwise-identical
 *      redraws.
 *
 * Normalization strips ANSI escapes and collapses whitespace so layout
 * differences from cursor positioning / line wrapping don't defeat the
 * frame comparison.
 *
 * Ownership: SessionManager constructs one instance and calls into it
 * from the resize path and the PTY data activity-detection path. All
 * state is per-session and cleaned up via removeSession().
 */
export class ResizeManager {
  private static readonly DEDUP_HISTORY_SIZE = 16;
  private static readonly GRACE_PERIOD_MS = 1500;

  private recentFrames = new Map<string, string[]>();
  private lastResizeAt = new Map<string, number>();
  private sessionsEverWoken = new Set<string>();

  /**
   * Record that the PTY was just resized for this session. Starts the
   * grace window during which redraw noise is suppressed.
   */
  notifyResize(sessionId: string, now: number = Date.now()): void {
    this.lastResizeAt.set(sessionId, now);
  }

  /**
   * Decide whether an incoming PTY chunk should notify activity tracking.
   * Returns true if the chunk represents genuine new activity and the
   * caller should poke the activity state machine; false if it should
   * be treated as redraw noise and ignored.
   *
   * Side effect: on a true return, the session is marked "ever woken"
   * so that subsequent resize-grace suppression can kick in. On a new
   * frame (true or false), the dedup history is updated.
   */
  shouldNotifyOnData(
    sessionId: string,
    data: string,
    currentActivity: ActivityState | undefined,
    now: number = Date.now(),
  ): boolean {
    const stripped = data.includes('\x1b') ? stripAnsiEscapes(data) : data;
    const normalized = stripped.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) return false;

    const history = this.recentFrames.get(sessionId) ?? [];
    const isContentNew = !history.includes(normalized);
    if (!isContentNew) return false;

    history.push(normalized);
    if (history.length > ResizeManager.DEDUP_HISTORY_SIZE) {
      history.shift();
    }
    this.recentFrames.set(sessionId, history);

    const lastResize = this.lastResizeAt.get(sessionId) ?? 0;
    const inResizeGrace = now - lastResize < ResizeManager.GRACE_PERIOD_MS;
    const hasBeenWoken = this.sessionsEverWoken.has(sessionId);
    const suppressForResize = inResizeGrace && currentActivity === 'idle' && hasBeenWoken;
    if (suppressForResize) return false;

    this.sessionsEverWoken.add(sessionId);
    return true;
  }

  /** Drop all per-session state. Called from SessionManager.remove(). */
  removeSession(sessionId: string): void {
    this.recentFrames.delete(sessionId);
    this.lastResizeAt.delete(sessionId);
    this.sessionsEverWoken.delete(sessionId);
  }
}
