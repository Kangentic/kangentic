import fs from 'node:fs';
import { FileWatcher } from './file-watcher';
import { Activity } from '../../../shared/types';
import type {
  SessionUsage,
  SessionEvent,
  SessionHistoryParseResult,
  AdapterRuntimeStrategy,
} from '../../../shared/types';

type SessionHistoryHook = NonNullable<AdapterRuntimeStrategy['sessionHistory']>;

/**
 * Generic callback primitives that SessionHistoryReader uses to push
 * parsed telemetry into the rest of the system. None of these mention
 * session-history - they're generic enough that UsageTracker (or any
 * future consumer) can implement them without knowing where the data
 * originated. This is the key separation of concerns that keeps
 * session-history logic isolated from core session infrastructure.
 */
export interface SessionHistoryReaderCallbacks {
  /** A usage snapshot arrived. Partial - merge with existing cache entry. */
  onUsageUpdate(sessionId: string, usage: Partial<SessionUsage>): void;
  /** New events to append to the session event log and dispatch through the state machine. */
  onEvents(sessionId: string, events: SessionEvent[]): void;
  /** Explicit activity transition hint. */
  onActivity(sessionId: string, activity: Activity): void;
  /**
   * Fired once per session the first time a parsed result arrives
   * successfully. Consumers use this to suppress any fallback
   * activity-detection mechanisms (e.g. PTY silence timers) now that
   * authoritative telemetry is flowing.
   */
  onFirstTelemetry(sessionId: string): void;
}

export interface SessionHistoryAttachOptions {
  sessionId: string;
  agentSessionId: string;
  cwd: string;
  hook: SessionHistoryHook;
  /** Optional agent name for diagnostic log messages. */
  agentName?: string;
}

interface WatcherState {
  watcher: FileWatcher;
  filePath: string;
  cursor: number;
  handoffDone: boolean;
  parse: SessionHistoryHook['parse'];
  isFullRewrite: boolean;
}

/**
 * Dispatch a parsed SessionHistoryParseResult into the callback primitives.
 *
 * Extracted as a standalone exported function so unit tests can verify
 * the fan-out logic without setting up real filesystem state. Pure -
 * no I/O, no timers, no side effects beyond the callbacks themselves.
 */
export function dispatchSessionHistoryResult(
  sessionId: string,
  result: SessionHistoryParseResult,
  callbacks: SessionHistoryReaderCallbacks,
): void {
  if (result.usage) {
    callbacks.onUsageUpdate(sessionId, result.usage);
  }
  if (result.events.length > 0) {
    callbacks.onEvents(sessionId, result.events);
  }
  if (result.activity === Activity.Thinking || result.activity === Activity.Idle) {
    callbacks.onActivity(sessionId, result.activity);
  }
}

/**
 * Watches each active session's native session history file (Codex
 * rollout.jsonl, Gemini session.json), tails new content on change,
 * and dispatches parsed telemetry via the generic callback primitives.
 *
 * Owns all session-history-specific logic in one place so SessionManager
 * and UsageTracker can remain free of session-history vocabulary.
 * Composed by SessionManager alongside UsageTracker, PtyBufferManager,
 * and the other per-session subsystems.
 *
 * Cross-platform: uses FileWatcher (fs.watch + polling fallback) so
 * behavior is identical on macOS, Linux, and Windows. No shell-outs.
 * CRLF-tolerant (handled by the adapter parsers).
 */
export class SessionHistoryReader {
  private states = new Map<string, WatcherState>();
  /**
   * Session IDs for which attach() has been called but not yet
   * completed (the async locate() is still in flight). detach() adds
   * to this set as a cancellation signal so an in-flight attach can
   * bail cleanly before installing a watcher.
   */
  private pending = new Set<string>();
  /** Session IDs that detach() cancelled during an in-flight attach. */
  private cancelled = new Set<string>();

  constructor(private readonly callbacks: SessionHistoryReaderCallbacks) {}

  /**
   * Locate the session history file for a session and start tailing it.
   * Called once per session after the PTY scraper captures the
   * agent-reported UUID. Subsequent calls for the same sessionId are
   * no-ops.
   *
   * Fire-and-forget: all errors are logged and degrade gracefully
   * (the session still runs via whatever fallback the consumer has
   * configured - typically PtyActivityTracker).
   */
  async attach(options: SessionHistoryAttachOptions): Promise<void> {
    const { sessionId, agentSessionId, cwd, hook, agentName } = options;
    if (this.states.has(sessionId) || this.pending.has(sessionId)) return;

    this.pending.add(sessionId);
    try {
      let resolvedPath: string | null;
      try {
        resolvedPath = await hook.locate({ agentSessionId, cwd });
      } catch (err) {
        console.warn(`[session-history] locate threw for session=${sessionId.slice(0, 8)}:`, err);
        return;
      }

      // Detach may have been called while we were awaiting locate.
      if (this.cancelled.has(sessionId)) return;

      if (!resolvedPath) {
        console.log(`[session-history] no history file found for session=${sessionId.slice(0, 8)} agent=${agentName ?? 'unknown'} - falling back to PTY activity tracker`);
        return;
      }

      const state: WatcherState = {
        // Placeholder - the FileWatcher reference is assigned below so
        // its onChange callback can close over the same state object.
        watcher: null as unknown as FileWatcher,
        filePath: resolvedPath,
        cursor: 0,
        handoffDone: false,
        parse: hook.parse,
        isFullRewrite: hook.isFullRewrite,
      };

      state.watcher = new FileWatcher({
        filePath: resolvedPath,
        onChange: () => this.processChange(sessionId, state),
      });
      this.states.set(sessionId, state);

      // Trigger an initial read immediately - FileWatcher only fires on
      // subsequent changes, but the file likely has content already.
      this.processChange(sessionId, state);
    } finally {
      this.pending.delete(sessionId);
      this.cancelled.delete(sessionId);
    }
  }

  /**
   * Stop watching a session's history file and release its state.
   * Idempotent - safe to call even if attach was never called or has
   * already been detached. Signals in-flight attach calls to bail.
   */
  detach(sessionId: string): void {
    // Signal any in-flight attach for this session to bail.
    if (this.pending.has(sessionId)) {
      this.cancelled.add(sessionId);
    }
    const state = this.states.get(sessionId);
    if (!state) return;
    state.watcher.close();
    this.states.delete(sessionId);
  }

  /**
   * Close every active watcher and clear all state. Called during
   * shutdown to release fs.watch handles promptly.
   */
  disposeAll(): void {
    for (const state of this.states.values()) {
      state.watcher.close();
    }
    this.states.clear();
    this.pending.clear();
    this.cancelled.clear();
  }

  /**
   * True if a session currently has an active watcher. Used by
   * SessionManager to avoid redundant attach calls and by tests.
   */
  isAttached(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  /**
   * Read new content from a session history file and dispatch parsed
   * telemetry via the callback primitives. Handles both append-mode
   * (Codex: cursor-tracked byte reads) and full-rewrite mode
   * (Gemini: whole-file reads). All errors are swallowed with a WARN
   * log so watcher failures never break the session.
   */
  private processChange(sessionId: string, state: WatcherState): void {
    try {
      let result: SessionHistoryParseResult;

      if (state.isFullRewrite) {
        const content = fs.readFileSync(state.filePath, 'utf-8');
        if (!content) return;
        result = state.parse(content, 'full');
      } else {
        const stat = fs.statSync(state.filePath);
        // Truncation guard: if the file shrank (log rotation, manual
        // edit, or a same-name replacement), reset the cursor to 0 and
        // re-read from the start rather than skipping content or
        // reading garbage beyond EOF.
        if (stat.size < state.cursor) {
          console.warn(`[session-history] ${state.filePath} shrank from ${state.cursor} to ${stat.size} bytes for session=${sessionId.slice(0, 8)} - resetting cursor`);
          state.cursor = 0;
        }
        if (stat.size <= state.cursor) return;
        const length = stat.size - state.cursor;
        const buffer = Buffer.alloc(length);
        const fileDescriptor = fs.openSync(state.filePath, 'r');
        try {
          fs.readSync(fileDescriptor, buffer, 0, length, state.cursor);
        } finally {
          fs.closeSync(fileDescriptor);
        }
        state.cursor = stat.size;
        const chunk = buffer.toString('utf-8');
        if (!chunk) return;
        result = state.parse(chunk, 'append');
      }

      dispatchSessionHistoryResult(sessionId, result, this.callbacks);

      // First successful parse - notify the consumer so it can suppress
      // any fallback activity trackers now that authoritative telemetry
      // is flowing.
      if (!state.handoffDone) {
        state.handoffDone = true;
        this.callbacks.onFirstTelemetry(sessionId);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.warn(`[session-history] ${state.filePath} disappeared for session=${sessionId.slice(0, 8)}, closing watcher`);
        this.detach(sessionId);
      } else {
        console.warn(`[session-history] processChange failed for session=${sessionId.slice(0, 8)}:`, err);
      }
    }
  }
}
