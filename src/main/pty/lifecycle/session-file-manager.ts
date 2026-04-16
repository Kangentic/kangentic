import fs from 'node:fs';
import type { SessionHistoryReader } from '../readers/session-history-reader';
import type { StatusFileReader } from '../readers/status-file-reader';

/**
 * Per-session path state tracked by this manager. The manager owns the
 * lifecycle of the Kangentic-authored session directory
 * (`<project>/.kangentic/sessions/<sessionId>/`) and the merged settings
 * file written into it.
 */
interface SessionPathState {
  mergedSettingsPath: string | null;
  sessionDir: string | null;
}

/**
 * Coordinates per-session file lifecycle across three concerns:
 *
 *   1. Paths for Kangentic-authored session files (merged settings,
 *      session directory). Tracked in this manager's own state.
 *   2. `SessionHistoryReader` - reads agent-authored rollout/history.
 *   3. `StatusFileReader` - reads Claude Code status.json + events.
 *
 * Call sites use one of three named teardown modes; each method fixes
 * the ordering and which files are preserved versus deleted.
 *
 *   - `detachPreservingFiles` - respawn, suspend, suspendAll.
 *     Null file paths so the old PTY's onExit handler cannot race-delete
 *     files that the next spawn will reuse. Files stay on disk for
 *     --resume.
 *
 *   - `detachOnPtyExit` - fired from node-pty's `exit` handler.
 *     Detaches the status reader without cleanup because suspend()'s
 *     scrollback fallback may still read from it. Leaves session dir +
 *     merged settings path alone - suspend()/remove() may still need them.
 *
 *   - `detachAndDelete` - remove(), killAll().
 *     Full cleanup including file + directory deletion. Only safe when
 *     the session is not going to be resumed.
 *
 * MCP server communication runs over the in-process HTTP server at
 * `src/main/agent/mcp-http-server.ts` - this class no longer carries
 * any per-session command bridge state.
 */
export class SessionFileManager {
  private paths = new Map<string, SessionPathState>();

  constructor(
    private readonly sessionHistoryReader: SessionHistoryReader,
    private readonly statusFileReader: StatusFileReader,
  ) {}

  /**
   * Register path state for a new session. Derives the Kangentic-owned
   * session dir + merged settings path from the adapter's status file
   * output path (`<project>/.kangentic/sessions/<sessionId>/status.json`).
   */
  register(info: { sessionId: string; statusOutputPath: string | null }): void {
    let sessionDir: string | null = null;
    let mergedSettingsPath: string | null = null;
    if (info.statusOutputPath) {
      sessionDir = info.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      mergedSettingsPath = sessionDir + '/settings.json';
    }
    this.paths.set(info.sessionId, { mergedSettingsPath, sessionDir });
  }

  /**
   * Detach for a session that will (or may) be respawned / resumed.
   *
   * Order is load-bearing: detach readers before nullifying paths so a
   * reader callback that fires mid-detach cannot race its teardown;
   * nullify paths last so the next spawn's new register() sees a clean
   * slate and the old onExit handler (still running) won't try to delete
   * files the new spawn is about to use.
   */
  detachPreservingFiles(sessionId: string): void {
    this.sessionHistoryReader.detach(sessionId);
    this.statusFileReader.detachWithoutCleanup(sessionId);
    this.nullifyPaths(sessionId);
  }

  /**
   * Detach for a PTY that has just exited but whose session record
   * remains in the SessionManager map. Files are preserved on disk for
   * crash recovery (pruneStaleResources() is the eventual cleanup).
   *
   * Intentionally does NOT call `sessionHistoryReader.detach` - the
   * suspend path's scrollback fallback scan still reads from it.
   * Intentionally does NOT nullify paths - suspend() or remove() may
   * still need them.
   */
  detachOnPtyExit(sessionId: string): void {
    this.statusFileReader.detachWithoutCleanup(sessionId);
  }

  /**
   * Full cleanup for terminal session removal. Deletes on-disk files
   * too - callers must be sure the session is never coming back.
   */
  detachAndDelete(sessionId: string): void {
    this.cleanupAndRemoveFiles(sessionId);
    this.sessionHistoryReader.detach(sessionId);
    this.statusFileReader.detach(sessionId);
  }

  /**
   * Drop per-session path state without touching disk. Used during
   * respawn after scrollback has been carried over - the new session
   * will register its own state.
   */
  removeSession(sessionId: string): void {
    this.paths.delete(sessionId);
  }

  /**
   * Null out the merged settings path + session dir to prevent an
   * onExit cleanup race during resume. When resuming, the old and new
   * sessions share the same claudeSessionId, so the session dir
   * resolves to the same path. Nulling prevents the old onExit handler
   * from deleting files the new session needs.
   */
  private nullifyPaths(sessionId: string): void {
    const state = this.paths.get(sessionId);
    if (!state) return;
    state.mergedSettingsPath = null;
    state.sessionDir = null;
  }

  /**
   * Delete the merged settings file and session directory. Silent on
   * missing files (may already be gone). Removes the tracked state so
   * repeated calls are safe.
   *
   * NOTE: No .mcp.json cleanup here. The suspend() and onExit() paths
   * handle their own cleanup. killAll() (app shutdown) should NOT clean
   * up - the entry will be re-injected on next session spawn.
   */
  private cleanupAndRemoveFiles(sessionId: string): void {
    const state = this.paths.get(sessionId);
    if (!state) return;

    // Clean up merged settings file (written by Claude's command-builder).
    // status.json and events.jsonl are StatusFileReader's responsibility.
    if (state.mergedSettingsPath) {
      try { fs.unlinkSync(state.mergedSettingsPath); } catch { /* may not exist */ }
    }

    // Remove the session directory and any remaining telemetry files.
    if (state.sessionDir) {
      try { fs.rmSync(state.sessionDir, { recursive: true, force: true }); } catch { /* already gone */ }
    }

    this.paths.delete(sessionId);
  }
}
