import fs from 'node:fs';

interface WatcherState {
  mergedSettingsPath: string | null;
  sessionDir: string | null;
}

/**
 * Tracks per-session merged settings + session directory paths so
 * `cleanupAndRemove` can delete them on session exit.
 *
 * MCP server communication runs over the in-process HTTP server at
 * `src/main/agent/mcp-http-server.ts` -- this class no longer carries
 * any per-session command bridge state. Telemetry file watching
 * (status.json, events.jsonl) is owned by StatusFileReader, not here.
 */
export class SessionFileWatcher {
  private watchers = new Map<string, WatcherState>();

  startAll(info: {
    sessionId: string;
    statusOutputPath: string | null;
  }): void {
    const { sessionId, statusOutputPath } = info;

    // Derive session dir + merged settings path from statusOutputPath.
    // statusOutputPath = <project>/.kangentic/sessions/<sessionId>/status.json
    // mergedSettingsPath = <project>/.kangentic/sessions/<sessionId>/settings.json
    let sessionDir: string | null = null;
    let mergedSettingsPath: string | null = null;
    if (statusOutputPath) {
      sessionDir = statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      mergedSettingsPath = sessionDir + '/settings.json';
    }

    this.watchers.set(sessionId, { mergedSettingsPath, sessionDir });
  }

  /**
   * No-op kept for call-site compatibility with `session-manager`. The
   * MCP server is global to main and not per-session, so there's nothing
   * to stop on a per-session basis.
   */
  stopAll(_sessionId: string): void {}

  /**
   * Null out the merged settings path + session dir to prevent onExit
   * cleanup race. When resuming a session, the old and new sessions
   * share the same claudeSessionId, so the session dir resolves to
   * the same path. Nulling prevents the old onExit handler from
   * deleting files the new session needs.
   *
   * Status/events paths live on StatusFileReader, not here - their
   * own detach path handles the resume race via `detachWithoutCleanup`.
   */
  nullifyPaths(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;
    state.mergedSettingsPath = null;
    state.sessionDir = null;
  }

  /** Stop watchers and clean up merged settings file + session directory. */
  cleanupAndRemove(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    this.stopAll(sessionId);

    // NOTE: No .mcp.json cleanup here. The suspend() and onExit() paths
    // handle their own cleanup. killAll() (app shutdown) should NOT clean up -
    // the entry will be re-injected on next session spawn.

    // Clean up merged settings file (written by Claude's command-builder).
    // status.json and events.jsonl are StatusFileReader's responsibility.
    if (state.mergedSettingsPath) {
      try { fs.unlinkSync(state.mergedSettingsPath); } catch { /* may not exist */ }
    }

    // Try to remove the now-empty session directory.
    if (state.sessionDir) {
      try { fs.rmdirSync(state.sessionDir); } catch { /* dir may not be empty or already gone */ }
    }

    this.watchers.delete(sessionId);
  }

  removeSession(sessionId: string): void {
    this.watchers.delete(sessionId);
  }
}
