import fs from 'node:fs';
import path from 'node:path';
import { FileWatcher } from './file-watcher';
import { CommandBridge } from '../agent/command-bridge';
import { getProjectDb } from '../db/database';
import type { Task } from '../../shared/types';

interface SessionFileWatcherCallbacks {
  onUsageFileChanged(sessionId: string, statusOutputPath: string): void;
  onEventsFileChanged(sessionId: string, eventsOutputPath: string): void;
  onTaskCreated(sessionId: string, task: Task, columnName: string, swimlaneId: string): void;
  onTaskUpdated(sessionId: string, task: Task): void;
  onTaskDeleted(sessionId: string, task: Task): void;
  onBacklogChanged(sessionId: string): void;
  onLabelColorsChanged(sessionId: string, colors: Record<string, string>): void;
}

interface WatcherState {
  statusFileWatcher: FileWatcher | null;
  eventsFileWatcher: FileWatcher | null;
  commandBridge: CommandBridge | null;
  statusOutputPath: string | null;
  eventsOutputPath: string | null;
  mergedSettingsPath: string | null;
  eventsFileOffset: number;
}

/**
 * Manages per-session file watchers for usage data, event logs, and command bridge.
 *
 * Each session can have up to three watchers: usage (status.json), events (activity.jsonl),
 * and command bridge (commands.jsonl). This module owns their lifecycle and file cleanup.
 */
export class SessionFileWatcher {
  private watchers = new Map<string, WatcherState>();
  private callbacks: SessionFileWatcherCallbacks;

  constructor(callbacks: SessionFileWatcherCallbacks) {
    this.callbacks = callbacks;
  }

  startAll(info: {
    sessionId: string;
    projectId: string;
    cwd: string;
    statusOutputPath: string | null;
    eventsOutputPath: string | null;
  }): void {
    const { sessionId, projectId, statusOutputPath, eventsOutputPath } = info;

    // Derive merged settings path from statusOutputPath pattern
    // statusOutputPath = <project>/.kangentic/sessions/<sessionId>/status.json
    // mergedSettingsPath = <project>/.kangentic/sessions/<sessionId>/settings.json
    let mergedSettingsPath: string | null = null;
    if (statusOutputPath) {
      const sessionDir = statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      mergedSettingsPath = sessionDir + '/settings.json';
    }

    const state: WatcherState = {
      statusFileWatcher: null,
      eventsFileWatcher: null,
      commandBridge: null,
      statusOutputPath,
      eventsOutputPath,
      mergedSettingsPath,
      eventsFileOffset: 0,
    };
    this.watchers.set(sessionId, state);

    // Delete stale status.json so the usage watcher doesn't emit
    // cached data from the previous session run
    if (statusOutputPath) {
      try { fs.unlinkSync(statusOutputPath); } catch { /* may not exist yet */ }
    }

    // Start watching the status output file for usage data
    if (statusOutputPath) {
      state.statusFileWatcher = new FileWatcher({
        filePath: statusOutputPath,
        onChange: () => this.callbacks.onUsageFileChanged(sessionId, statusOutputPath),
        label: `Usage:${sessionId.slice(0, 8)}`,
        debounceMs: 100,
        initialGracePeriodMs: 15_000,
      });
      // Immediately read any existing status.json (e.g. resumed sessions after restart)
      this.callbacks.onUsageFileChanged(sessionId, statusOutputPath);
    }

    // Start watching the events JSONL file for activity log
    if (eventsOutputPath) {
      // Truncate existing file on resume - historical events aren't needed
      try {
        fs.writeFileSync(eventsOutputPath, '');
      } catch {
        // File may not exist yet - that's OK, bridge will create it
      }

      state.eventsFileWatcher = new FileWatcher({
        filePath: eventsOutputPath,
        onChange: () => this.callbacks.onEventsFileChanged(sessionId, eventsOutputPath),
        label: `Event:${sessionId.slice(0, 8)}`,
        debounceMs: 50,
        initialGracePeriodMs: 15_000,
        isStale: () => {
          try {
            const stat = fs.statSync(eventsOutputPath);
            return stat.size > state.eventsFileOffset;
          } catch {
            return false;
          }
        },
      });
    }

    // Start command bridge for MCP server communication (if session dir exists)
    if (statusOutputPath) {
      const sessionDir = statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      const commandsPath = path.join(sessionDir, 'commands.jsonl');
      const responsesDir = path.join(sessionDir, 'responses');

      // Derive project path from statusOutputPath pattern:
      // <projectPath>/.kangentic/sessions/<sessionId>/status.json
      const projectPath = path.resolve(statusOutputPath, '..', '..', '..', '..');

      state.commandBridge = new CommandBridge({
        commandsPath,
        responsesDir,
        projectId,
        getProjectDb: () => getProjectDb(projectId),
        getProjectPath: () => projectPath,
        onTaskCreated: (task, columnName, swimlaneId) => {
          this.callbacks.onTaskCreated(sessionId, task, columnName, swimlaneId);
        },
        onTaskUpdated: (task) => {
          this.callbacks.onTaskUpdated(sessionId, task);
        },
        onTaskDeleted: (task) => {
          this.callbacks.onTaskDeleted(sessionId, task);
        },
        onBacklogChanged: () => {
          this.callbacks.onBacklogChanged(sessionId);
        },
        onLabelColorsChanged: (colors) => {
          this.callbacks.onLabelColorsChanged(sessionId, colors);
        },
      });
      state.commandBridge.start();
    }
  }

  /** Close watchers but preserve session files on disk. */
  stopAll(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    state.statusFileWatcher?.close();
    state.statusFileWatcher = null;
    state.eventsFileWatcher?.close();
    state.eventsFileWatcher = null;
    state.commandBridge?.stop();
    state.commandBridge = null;
  }

  /**
   * Null out file paths to prevent onExit cleanup race.
   * When resuming a session, the old and new sessions share the same
   * claudeSessionId, so files resolve to the same path. Nulling prevents
   * the old onExit handler from deleting files the new session needs.
   */
  nullifyPaths(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;
    state.statusOutputPath = null;
    state.eventsOutputPath = null;
    state.mergedSettingsPath = null;
  }

  /** Stop watchers and clean up status + events + merged settings files. */
  cleanupAndRemove(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    this.stopAll(sessionId);

    // NOTE: No .mcp.json cleanup here. The suspend() and onExit() paths
    // handle their own cleanup. killAll() (app shutdown) should NOT clean up -
    // the entry will be re-injected on next session spawn.

    // Clean up status JSON file
    if (state.statusOutputPath) {
      try { fs.unlinkSync(state.statusOutputPath); } catch { /* may not exist */ }
    }

    // Clean up events JSONL file
    if (state.eventsOutputPath) {
      try { fs.unlinkSync(state.eventsOutputPath); } catch { /* may not exist */ }
    }

    // Clean up merged settings file
    if (state.mergedSettingsPath) {
      try { fs.unlinkSync(state.mergedSettingsPath); } catch { /* may not exist */ }
    }

    // Try to remove the now-empty session directory
    if (state.statusOutputPath) {
      const sessionDir = state.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      try { fs.rmdirSync(sessionDir); } catch { /* dir may not be empty or already gone */ }
    }

    this.watchers.delete(sessionId);
  }

  getEventsFileOffset(sessionId: string): number {
    return this.watchers.get(sessionId)?.eventsFileOffset ?? 0;
  }

  setEventsFileOffset(sessionId: string, offset: number): void {
    const state = this.watchers.get(sessionId);
    if (state) state.eventsFileOffset = offset;
  }

  removeSession(sessionId: string): void {
    this.watchers.delete(sessionId);
  }
}
