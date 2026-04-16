import fs from 'node:fs';
import { FileWatcher } from './file-watcher';
import type { SessionUsage, SessionEvent, AdapterRuntimeStrategy } from '../../../shared/types';

/**
 * Adapter-owned hook describing how to decode the contents of
 * status.json and events.jsonl. Pulled from `runtime.statusFile`
 * on the agent adapter so this reader stays generic.
 */
export type StatusFileHook = NonNullable<AdapterRuntimeStrategy['statusFile']>;

/**
 * Generic callback primitives that StatusFileReader uses to push parsed
 * telemetry into the rest of the system. None of these mention Claude,
 * statusline, or hooks - they're generic enough that UsageTracker (or
 * any future consumer) can implement them without knowing where the
 * data originated. This mirrors SessionHistoryReader's callback shape
 * so both telemetry readers plug into the same consumer primitives.
 */
export interface StatusFileReaderCallbacks {
  /**
   * A status update arrived - the parser decoded a `SessionUsage` from
   * the status file content. Consumer applies ID capture, heartbeat
   * recovery, and usage cache update.
   */
  onUsageParsed(sessionId: string, usage: SessionUsage): void;
  /**
   * New lines arrived on the events file. Both the raw JSON lines and
   * the parsed events are provided because some consumers (hook-based
   * agent session ID capture) need to re-parse the raw hookContext
   * field that `parseEvent` does not surface.
   */
  onEventsParsed(sessionId: string, rawLines: string[], events: SessionEvent[]): void;
}

export interface StatusFileAttachOptions {
  sessionId: string;
  statusOutputPath: string | null;
  eventsOutputPath: string | null;
  /**
   * Adapter-supplied hook (from `runtime.statusFile`) used to decode
   * status.json and events.jsonl content. Optional: when null, the
   * reader still performs startup file cleanup (delete stale
   * status.json, truncate stale events.jsonl) but skips watcher setup
   * since there's nothing to parse. This is used by sessions whose
   * adapter does not opt into the hook telemetry pipeline (Codex,
   * Gemini, Aider) and by test fixtures.
   */
  statusFileHook: StatusFileHook | null;
}

interface AttachedState {
  statusWatcher: FileWatcher | null;
  eventsWatcher: FileWatcher | null;
  statusOutputPath: string | null;
  eventsOutputPath: string | null;
  eventsFileOffset: number;
  statusFileHook: StatusFileHook | null;
}

/**
 * Watches per-session status.json and events.jsonl files, reads their
 * content on change, parses via the agent's parser, and dispatches
 * parsed telemetry via generic callback primitives.
 *
 * Symmetric with SessionHistoryReader - both subsystems own their
 * FileWatcher instances, own their parse dispatch, and feed the same
 * UsageTracker primitives. The difference: StatusFileReader's source
 * files are written by event-bridge hooks that Kangentic injects into
 * the agent (used today only by Claude), while SessionHistoryReader's
 * source files are written by the agent CLI natively (used today by
 * Codex and Gemini).
 *
 * Owns all Claude-statusline-pipeline-specific logic in one place so
 * SessionManager and UsageTracker can stay free of file-watching
 * concerns.
 *
 * Cross-platform: uses FileWatcher (fs.watch + polling fallback) so
 * behavior is identical on macOS, Linux, and Windows.
 */
export class StatusFileReader {
  private states = new Map<string, AttachedState>();

  constructor(private readonly callbacks: StatusFileReaderCallbacks) {}

  /**
   * Start watching a session's status.json + events.jsonl files. Both
   * paths are optional - a session with neither is a no-op (the
   * adapter isn't using Kangentic's statusline/hook pipeline).
   *
   * Deletes any stale status.json and truncates any stale events.jsonl
   * from a prior run with the same path, so the watcher doesn't emit
   * cached data from the previous session.
   */
  attach(options: StatusFileAttachOptions): void {
    const { sessionId, statusOutputPath, eventsOutputPath, statusFileHook } = options;
    if (this.states.has(sessionId)) return;
    if (!statusOutputPath && !eventsOutputPath) return;

    const state: AttachedState = {
      statusWatcher: null,
      eventsWatcher: null,
      statusOutputPath,
      eventsOutputPath,
      eventsFileOffset: 0,
      statusFileHook,
    };

    // Delete stale status.json so the watcher doesn't emit cached data
    // from a previous session run. Runs regardless of whether a parser
    // is provided - file cleanup is not parser-dependent.
    if (statusOutputPath) {
      try { fs.unlinkSync(statusOutputPath); } catch { /* may not exist */ }

      // Only install the watcher when we have a status-file hook to
      // decode changes. Sessions without a hook still need the file
      // deleted but don't need change notifications.
      if (statusFileHook) {
        state.statusWatcher = new FileWatcher({
          filePath: statusOutputPath,
          onChange: () => this.handleStatusChange(sessionId),
          debounceMs: 100,
        });
        // Immediately read any existing status.json (e.g. resumed sessions).
        this.handleStatusChange(sessionId);
      }
    }

    // Truncate stale events.jsonl. Historical events from a prior run
    // aren't needed - the new session starts with an empty event log.
    //
    // The watcher is installed whenever `eventsOutputPath` is set,
    // regardless of whether the adapter declares a `statusFile` hook.
    // Claude uses the hook to parse events into SessionEvent objects,
    // but non-Claude adapters (Codex, Gemini) still need their raw
    // event lines tailed so `UsageTracker.captureHookSessionIds` can
    // extract the agent-reported session ID from the `hookContext`
    // field on a `session_start` line. Gating this on `statusFileHook`
    // made the fromHook capture path dead code for Codex/Gemini.
    if (eventsOutputPath) {
      try { fs.writeFileSync(eventsOutputPath, ''); } catch { /* bridge may create it */ }

      state.eventsWatcher = new FileWatcher({
        filePath: eventsOutputPath,
        onChange: () => this.handleEventsChange(sessionId),
        debounceMs: 50,
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

    this.states.set(sessionId, state);
  }

  /**
   * Stop watching a session's files and delete them. Called on normal
   * session removal.
   */
  detach(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.closeWatchers(state);

    if (state.statusOutputPath) {
      try { fs.unlinkSync(state.statusOutputPath); } catch { /* may not exist */ }
    }
    if (state.eventsOutputPath) {
      try { fs.unlinkSync(state.eventsOutputPath); } catch { /* may not exist */ }
    }

    this.states.delete(sessionId);
  }

  /**
   * Stop watching a session's files WITHOUT deleting them. Used when
   * resuming a session: the old session's watchers are stopped but its
   * files are left intact because the new session reuses the same
   * paths. Without this, the old onExit handler would race with the
   * new session's attach and delete the new files.
   */
  detachWithoutCleanup(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.closeWatchers(state);
    this.states.delete(sessionId);
  }

  /**
   * Release all watchers and clear state. Used during shutdown. Does
   * NOT delete files because shutdown should be fast and idempotent -
   * a restart will re-attach to the same paths.
   */
  disposeAll(): void {
    for (const state of this.states.values()) {
      this.closeWatchers(state);
    }
    this.states.clear();
  }

  /**
   * True if a session currently has an active attachment. Used by
   * SessionManager to avoid redundant attach calls and by tests.
   */
  isAttached(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  /**
   * Synchronously read any pending bytes from the events file and
   * dispatch them to the consumer. Called from the PTY onExit path
   * to catch `ToolEnd` events that were written just before exit
   * but haven't been picked up by the fs.watch callback yet.
   * Idempotent - safe to call multiple times.
   */
  flushPendingEvents(sessionId: string): void {
    this.handleEventsChange(sessionId);
  }

  // -- Internal --

  private closeWatchers(state: AttachedState): void {
    state.statusWatcher?.close();
    state.statusWatcher = null;
    state.eventsWatcher?.close();
    state.eventsWatcher = null;
  }

  /**
   * Read status.json and dispatch the parsed usage to the consumer.
   * File-not-found and partial-write errors are swallowed - the
   * watcher will fire again on the next real change.
   */
  private handleStatusChange(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || !state.statusOutputPath || !state.statusFileHook) return;
    try {
      const raw = fs.readFileSync(state.statusOutputPath, 'utf-8');
      const usage = state.statusFileHook.parseStatus(raw);
      if (!usage) return;
      this.callbacks.onUsageParsed(sessionId, usage);
    } catch {
      // File may not exist yet, or be partially written - ignore.
    }
  }

  /**
   * Read newly-appended bytes from events.jsonl, split into lines,
   * parse each line, and dispatch both raw lines and parsed events
   * to the consumer. Tracks a per-session byte cursor so only new
   * content is processed on each fire.
   *
   * Truncation guard: if the file shrank since the last read
   * (rotation, manual edit), reset the cursor to 0 and re-read from
   * the start.
   */
  private handleEventsChange(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || !state.eventsOutputPath) return;
    try {
      const stat = fs.statSync(state.eventsOutputPath);
      if (stat.size < state.eventsFileOffset) {
        console.warn(`[status-file] ${state.eventsOutputPath} shrank from ${state.eventsFileOffset} to ${stat.size} bytes for session=${sessionId.slice(0, 8)} - resetting cursor`);
        state.eventsFileOffset = 0;
      }
      if (stat.size <= state.eventsFileOffset) return;

      const length = stat.size - state.eventsFileOffset;
      const buffer = Buffer.alloc(length);
      const fileDescriptor = fs.openSync(state.eventsOutputPath, 'r');
      try {
        fs.readSync(fileDescriptor, buffer, 0, length, state.eventsFileOffset);
      } finally {
        fs.closeSync(fileDescriptor);
      }
      state.eventsFileOffset = stat.size;

      const chunk = buffer.toString('utf-8');
      const rawLines = chunk.split(/\r?\n/).filter((line) => line.length > 0);
      if (rawLines.length === 0) return;

      // Parse into SessionEvent objects only when the adapter has a
      // statusFile hook (currently only Claude). Other adapters still
      // need `rawLines` delivered so the consumer can run
      // hook-based session-ID capture on the `hookContext` field.
      const events: SessionEvent[] = [];
      if (state.statusFileHook) {
        for (const line of rawLines) {
          const event = state.statusFileHook.parseEvent(line);
          if (event) events.push(event);
        }
      }

      this.callbacks.onEventsParsed(sessionId, rawLines, events);
    } catch {
      // File may not exist yet, or be partially written - ignore.
    }
  }
}
