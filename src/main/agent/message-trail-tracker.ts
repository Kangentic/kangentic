import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { AgentAdapter } from './agent-adapter';
import { EventType } from '../../shared/types';
import type { AssistantMessageTrailEntry, Session, SessionEvent, TranscriptEntry } from '../../shared/types';
import { assistantMessagePreviews } from './shared/message-preview';
import { getCachedTranscript } from './transcript-cache';

/**
 * Keeps the agent message trail every board card shows: the newest few things
 * each session's agent said, computed in main and PUSHED on change, so a card
 * never fetches a transcript. `resolveTaskTranscript` stitches every session a
 * task ever had (267MB for one task, 319MB across 20 files for a single mobile
 * home-feed refresh, per its own comment), and a board renders every visible
 * card at once, so a per-card read is the one way this feature ships broken.
 *
 * Trigger: the hook events every running session already emits, for every
 * agent (`SessionManager`'s `'event'`), plus `'session-changed'` so a spawn or
 * resume seeds the trail and an exit takes a final read. Each trigger is
 * coalesced per session: one immediate read, then one trailing read after
 * `MESSAGE_TRAIL_MIN_INTERVAL_MS`, and a burst inside that interval folds into
 * the same trailing timer. The trailing read is what makes the trigger set
 * safe: a hook fires as the agent finishes a step, and the record it announces
 * can still be landing on disk.
 *
 * Read: the adapter's stateless bounded window (`parseTranscriptWindow`) over
 * only the bytes appended since the last read. The first read stats the file
 * and starts `MESSAGE_TRAIL_TAIL_BYTES` from its end, so a resumed session
 * shows what its previous run said at once; later reads start at the cursor
 * the previous window handed back. Nothing is retained between reads but that
 * cursor and the trail. An adapter without the window capability falls back
 * to the stat-validated cached parse (`getCachedTranscript`), rate-limited
 * harder because a changed file re-parses its whole bounded tail there.
 *
 * Retention: a trail outlives its session (a paused or exited card keeps what
 * its agent last said) until the session leaves the registry or the map hits
 * `MESSAGE_TRAIL_MAX_SESSIONS`. Both prunes are lazy, not event-driven: a
 * departed session's state is dropped by the next `snapshot()`, which diffs the
 * map against the registry, and nothing else watches for a removal. So a state
 * can outlive its session until the next boot, reload, or project switch calls
 * `syncSessions`. That is bounded by the session cap and costs one idle map
 * entry, which is why it is not worth an eager listener.
 *
 * Unlike `MonitorPeekTracker`, this tracker is not subscribe-gated. The peek
 * tracker taps live PTY output, so it stays off until a monitor names the
 * sessions it draws; this one reads a bounded file tail on a hook the agent
 * already fired, and the board is mounted whenever the app is, so there is no
 * "nobody is looking" state to gate on.
 */

/** Lines kept per session: the comfortable card's clamp. */
export const MESSAGE_TRAIL_MAX_ENTRIES = 5;
/**
 * Cap on each retained line. Higher than the phone's 200 (`MESSAGE_PREVIEW_MAX_CHARS`,
 * sized for a two-line card): the desktop's "latest message" mode wraps one
 * message to five lines on a wide comfortable card, about 275 characters, and a
 * line cut short of the clamp reads as a truncated thought with room to spare.
 */
export const MESSAGE_TRAIL_ENTRY_MAX_CHARS = 400;
/** Floor between two reads of one session on the window path. */
export const MESSAGE_TRAIL_MIN_INTERVAL_MS = 300;
/** Floor on the cached-parse fallback, where a changed file costs a bounded re-parse. */
export const MESSAGE_TRAIL_FALLBACK_MIN_INTERVAL_MS = 2000;
/** How far back the first read of a session starts. Covers the last few turns of a busy session. */
export const MESSAGE_TRAIL_TAIL_BYTES = 64 * 1024;
/** Bytes per window on later reads; a single tool result can run past 100KB. */
export const MESSAGE_TRAIL_WINDOW_BYTES = 256 * 1024;
/** Windows drained per read, so a burst of appends is caught up in one tick without an unbounded loop. */
export const MESSAGE_TRAIL_MAX_WINDOWS_PER_READ = 4;
/** Sessions whose trail is retained; the oldest-tracked is evicted past this. */
export const MESSAGE_TRAIL_MAX_SESSIONS = 200;

/**
 * Events that cannot have put new assistant prose on disk, so they never
 * trigger a read. An agent writes its text BEFORE the tool call that follows
 * it (`tool_start`) or the end of its turn (`idle`); a tool RESULT landing or
 * the user submitting a prompt adds nothing of the agent's. These two are also
 * the most frequent events in a tool burst, so skipping them roughly halves the
 * reads a busy session costs. Anything else still triggers: the trailing read
 * makes an unnecessary trigger cost one bounded read, never a missed line.
 */
const MESSAGE_TRAIL_SILENT_EVENT_TYPES: ReadonlySet<string> = new Set([EventType.ToolEnd, EventType.Prompt]);

/** The three optional adapter capabilities the tracker reads through. */
export type MessageTrailAdapter = Pick<
  AgentAdapter,
  'parseTranscript' | 'parseTranscriptWindow' | 'locateSessionHistoryFile'
>;

/** What the tracker needs to know about a session to find and parse its transcript. */
export interface MessageTrailSessionFacts {
  sessionType: string;
  agentSessionId: string | null;
  cwd: string;
}

/** The slice of `SessionManager` the tracker consumes, so tests can hand it a plain EventEmitter. */
export interface MessageTrailSessionSource {
  on(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  on(event: 'session-changed', listener: (sessionId: string, session: Session) => void): unknown;
  on(
    event: 'agent-session-id',
    listener: (sessionId: string, taskId: string, projectId: string, agentSessionId: string) => void,
  ): unknown;
  getSession(sessionId: string): Session | undefined;
  listSessions(): Session[];
}

export interface MessageTrailTrackerDeps {
  sessionManager: MessageTrailSessionSource;
  /** Session facts from the project DB; null when the row is unknown or the DB will not open. */
  resolveSessionFacts: (sessionId: string, projectId: string) => MessageTrailSessionFacts | null;
  resolveAdapter: (sessionType: string) => MessageTrailAdapter | undefined;
  /** Size of the transcript file, for the first read's tail anchor. Injectable for tests. */
  fileSize?: (filePath: string) => Promise<number>;
  now?: () => number;
  /** Test seams for the two read floors, so coalescing is exercised in milliseconds, not seconds. */
  minIntervalMs?: number;
  fallbackMinIntervalMs?: number;
}

interface TrailState {
  projectId: string;
  facts: MessageTrailSessionFacts | null;
  /** Where the next window read starts; null until the first read has anchored at the tail. */
  cursor: number | null;
  usesFallback: boolean;
  trail: AssistantMessageTrailEntry[];
  lastReadAt: number;
  readInFlight: boolean;
  rereadRequested: boolean;
  trailingTimer: ReturnType<typeof setTimeout> | null;
}

async function statSize(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).size;
}

export class MessageTrailTracker extends EventEmitter {
  private readonly states = new Map<string, TrailState>();
  private readonly fileSize: (filePath: string) => Promise<number>;
  private readonly now: () => number;

  constructor(private readonly deps: MessageTrailTrackerDeps) {
    super();
    this.fileSize = deps.fileSize ?? statSize;
    this.now = deps.now ?? Date.now;
    deps.sessionManager.on('event', (sessionId, event) => {
      if (MESSAGE_TRAIL_SILENT_EVENT_TYPES.has(event.type)) return;
      this.schedule(sessionId);
    });
    deps.sessionManager.on('session-changed', (sessionId) => this.schedule(sessionId));
    deps.sessionManager.on('agent-session-id', (sessionId, _taskId, _projectId, agentSessionId) => {
      // A captured id (Codex, Gemini) or a mid-session fork (Claude /clear)
      // means a different file from here on: re-anchor the cursor at its tail,
      // but keep the trail, since what was said before the fork is still the
      // last thing said.
      const state = this.states.get(sessionId);
      if (state) {
        if (state.facts) state.facts = { ...state.facts, agentSessionId };
        state.cursor = null;
      }
      this.schedule(sessionId);
    });
  }

  /** Every retained trail, oldest line first, for the renderer's mount and HMR re-sync. */
  snapshot(): Record<string, AssistantMessageTrailEntry[]> {
    const live = new Set(this.deps.sessionManager.listSessions().map((session) => session.id));
    const result: Record<string, AssistantMessageTrailEntry[]> = {};
    for (const [sessionId, state] of this.states) {
      if (!live.has(sessionId)) {
        this.dropState(sessionId, state);
        continue;
      }
      if (state.trail.length > 0) result[sessionId] = state.trail;
    }
    return result;
  }

  /** Coalesced entry point for every trigger. Safe to call for any session id. */
  schedule(sessionId: string): void {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    const state = this.stateFor(sessionId, session.projectId);
    if (state.readInFlight) {
      state.rereadRequested = true;
      return;
    }
    const minInterval = this.minIntervalFor(state);
    const elapsed = this.now() - state.lastReadAt;
    if (elapsed >= minInterval) {
      void this.read(sessionId, state);
      this.armTrailingRead(sessionId, state, minInterval);
    } else {
      this.armTrailingRead(sessionId, state, minInterval - elapsed);
    }
  }

  /** Clears every timer. For tests and shutdown; the tracker is inert afterwards. */
  dispose(): void {
    for (const [sessionId, state] of this.states) this.dropState(sessionId, state);
  }

  private stateFor(sessionId: string, projectId: string): TrailState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    if (this.states.size >= MESSAGE_TRAIL_MAX_SESSIONS) {
      // Insertion order is session age, which is the right eviction order.
      const oldest = this.states.entries().next().value;
      if (oldest) this.dropState(oldest[0], oldest[1]);
    }
    const state: TrailState = {
      projectId,
      facts: null,
      cursor: null,
      usesFallback: false,
      trail: [],
      lastReadAt: Number.NEGATIVE_INFINITY,
      readInFlight: false,
      rereadRequested: false,
      trailingTimer: null,
    };
    this.states.set(sessionId, state);
    return state;
  }

  private dropState(sessionId: string, state: TrailState): void {
    if (state.trailingTimer) clearTimeout(state.trailingTimer);
    state.trailingTimer = null;
    this.states.delete(sessionId);
  }

  private minIntervalFor(state: TrailState): number {
    return state.usesFallback
      ? this.deps.fallbackMinIntervalMs ?? MESSAGE_TRAIL_FALLBACK_MIN_INTERVAL_MS
      : this.deps.minIntervalMs ?? MESSAGE_TRAIL_MIN_INTERVAL_MS;
  }

  private armTrailingRead(sessionId: string, state: TrailState, delayMs: number): void {
    if (state.trailingTimer) return;
    const timer = setTimeout(() => {
      state.trailingTimer = null;
      if (state.readInFlight) {
        state.rereadRequested = true;
        return;
      }
      void this.read(sessionId, state);
    }, delayMs);
    timer.unref?.();
    state.trailingTimer = timer;
  }

  private async read(sessionId: string, state: TrailState): Promise<void> {
    state.readInFlight = true;
    state.lastReadAt = this.now();
    try {
      const entries = await this.readNewEntries(sessionId, state);
      if (entries.length > 0) this.merge(sessionId, state, entries);
    } catch {
      // Best effort: a file mid-rotate or an adapter error never stops tracking;
      // the next event reads again.
    } finally {
      state.readInFlight = false;
      if (state.rereadRequested) {
        state.rereadRequested = false;
        // Only re-arm while this state is still the tracked one. An eviction in
        // `stateFor`, or a prune in `snapshot()`, can drop a session whose read
        // is still in flight; re-arming then would leave a timer on an orphaned
        // state that `dispose()` cannot reach, and that would go on emitting
        // against a session id `stateFor` has since re-created.
        if (this.states.get(sessionId) === state) {
          this.armTrailingRead(sessionId, state, this.minIntervalFor(state));
        }
      }
    }
  }

  private async readNewEntries(sessionId: string, state: TrailState): Promise<TranscriptEntry[]> {
    // The agent id is captured after spawn for some adapters, so keep asking
    // the row until it is there (one SQLite lookup per read until then).
    if (!state.facts?.agentSessionId) {
      state.facts = this.deps.resolveSessionFacts(sessionId, state.projectId);
    }
    const facts = state.facts;
    const agentSessionId = facts?.agentSessionId;
    if (!facts || !agentSessionId) return [];
    const adapter = this.deps.resolveAdapter(facts.sessionType);
    if (!adapter) return [];

    const parseWindow = adapter.parseTranscriptWindow;
    const locateFile = adapter.locateSessionHistoryFile;
    if (parseWindow && locateFile) {
      return this.readWindows(adapter, parseWindow, locateFile, facts.cwd, agentSessionId, state);
    }
    const parseTranscript = adapter.parseTranscript;
    if (parseTranscript) {
      state.usesFallback = true;
      const cached = await getCachedTranscript(
        facts.sessionType,
        agentSessionId,
        () => parseTranscript.call(adapter, agentSessionId, facts.cwd),
      );
      return cached.entries;
    }
    return [];
  }

  private async readWindows(
    adapter: MessageTrailAdapter,
    parseWindow: NonNullable<MessageTrailAdapter['parseTranscriptWindow']>,
    locateFile: NonNullable<MessageTrailAdapter['locateSessionHistoryFile']>,
    cwd: string,
    agentSessionId: string,
    state: TrailState,
  ): Promise<TranscriptEntry[]> {
    let cursor: number;
    if (state.cursor === null) {
      const filePath = await locateFile.call(adapter, agentSessionId, cwd);
      if (!filePath) return [];
      const size = await this.fileSize(filePath);
      cursor = Math.max(0, size - MESSAGE_TRAIL_TAIL_BYTES);
    } else {
      cursor = state.cursor;
    }
    const collected: TranscriptEntry[] = [];
    for (let windowIndex = 0; windowIndex < MESSAGE_TRAIL_MAX_WINDOWS_PER_READ; windowIndex += 1) {
      const window = await parseWindow.call(adapter, agentSessionId, cwd, cursor, MESSAGE_TRAIL_WINDOW_BYTES);
      if (window.totalBytes < cursor) {
        // The file shrank under the cursor (a rotate, or a reused id): re-anchor at the new tail.
        cursor = Math.max(0, window.totalBytes - MESSAGE_TRAIL_TAIL_BYTES);
        continue;
      }
      collected.push(...window.entries);
      if (window.nextByteOffset >= window.totalBytes) {
        // `readJsonlWindow` hands back an offset ON the closing newline for a
        // mid-file window but PAST the end for the final one, and every
        // mid-file start drops through its first newline. Stepping back one
        // byte makes the next read's drop consume exactly the newline the
        // last record ended with, instead of the whole first appended record.
        cursor = Math.max(0, window.nextByteOffset - 1);
        break;
      }
      if (window.nextByteOffset <= cursor) break;
      cursor = window.nextByteOffset;
    }
    state.cursor = cursor;
    return collected;
  }

  private merge(sessionId: string, state: TrailState, entries: TranscriptEntry[]): void {
    const previews = assistantMessagePreviews(entries, {
      count: MESSAGE_TRAIL_MAX_ENTRIES,
      maxChars: MESSAGE_TRAIL_ENTRY_MAX_CHARS,
    });
    if (previews.length === 0) return;
    // The window path yields only new records; the fallback yields the whole
    // bounded tail every time. Dedupe by the entry's own uuid so both merge
    // the same way, and push only when a line is genuinely new.
    const known = new Set(state.trail.map((entry) => entry.uuid));
    const fresh = previews.filter((entry) => !known.has(entry.uuid));
    if (fresh.length === 0) return;
    state.trail = [...state.trail, ...fresh].slice(-MESSAGE_TRAIL_MAX_ENTRIES);
    this.emit('trail', sessionId, state.trail, state.projectId);
  }
}
