import { EventEmitter } from 'node:events';
import { EventType } from '../../shared/types';
import type { AssistantMessageTrailEntry, Session, SessionEvent } from '../../shared/types';
import type { TranscriptAnchor, TranscriptPositionSource } from './shared/transcript-anchor';

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
 * Read: `readTrail`, which the app runs in the retrieval worker
 * (`message-trail-read.ts`), so main parses no transcript. It reads the
 * adapter's bounded window over only the bytes appended since the last read
 * and hands back the newest assistant previews and the next cursor. Nothing
 * is retained between reads but that cursor and the trail. An adapter without
 * the window capability re-parses its whole bounded tail there, so its reads
 * are rate-limited harder.
 *
 * The cursor has a second consumer: it is where a turn begins in its
 * transcript (`transcriptPosition`), so a turn end reads its reply from there
 * and never judges an earlier turn's. So the cursor moves only when a read
 * lands, and only within the file it was read from.
 *
 * Retention: a trail outlives its session until the session leaves the registry
 * or the map hits `MESSAGE_TRAIL_MAX_SESSIONS`.
 *
 * That retention no longer has a consumer, and the reason is worth writing down
 * rather than quietly deleting. It existed so a paused or exited card could keep
 * showing what its agent last said. Every card now hides the trail the moment the
 * session stops running and falls back to the task description, because a trail
 * under a paused glyph, with no progress bar, was indistinguishable from prose
 * the user wrote themselves (`CardMessageTrail`, `monitorSlotKind`). So the
 * retention past exit, and the final read `'session-changed'` takes on the way
 * out, are both dead value today: bounded and harmless (200 sessions x 5 lines),
 * but not load-bearing. Left in place because it is the cheap direction to be
 * wrong in - a trail that outlives its session costs one idle map entry, while
 * dropping it eagerly would need a new signal at exit and would foreclose ever
 * showing a finished agent's last words again.
 *
 * A registry removal drops the state eagerly, on `'session-removed'`. The cap
 * prune and the `snapshot()` diff against the registry stay as the backstop for
 * anything that leaves the registry some other way.
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

/** What the tracker needs to know about a session to find and parse its transcript. */
export interface MessageTrailSessionFacts {
  sessionType: string;
  agentSessionId: string | null;
  cwd: string;
}

/** Session facts once the agent session id is known: what a read of its transcript needs. */
export type MessageTrailReadFacts = MessageTrailSessionFacts & { agentSessionId: string };

/** One read's outcome (`message-trail-read.ts`, run in the retrieval worker). */
export interface TrailRead {
  /** The newest assistant previews among the entries read. */
  previews: AssistantMessageTrailEntry[];
  /** Where the next window read starts; null until anchored at the tail. */
  cursor: number | null;
  /** True when the adapter has no window read and re-parsed its whole tail. */
  usedFallback: boolean;
}

/** The slice of `SessionManager` the tracker consumes, so tests can hand it a plain EventEmitter. */
export interface MessageTrailSessionSource {
  on(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  on(event: 'session-changed', listener: (sessionId: string, session: Session) => void): unknown;
  on(event: 'session-removed', listener: (sessionId: string, session: Session) => void): unknown;
  on(
    event: 'agent-session-id',
    listener: (sessionId: string, taskId: string, projectId: string, agentSessionId: string) => void,
  ): unknown;
  getSession(sessionId: string): Session | undefined;
  listSessions(): Session[];
  /**
   * Where the tracker hands itself over as the source of each turn's
   * transcript anchor (`SessionManager.setTranscriptPositionSource`). Optional,
   * so a test's plain EventEmitter needs nothing.
   */
  setTranscriptPositionSource?(source: TranscriptPositionSource): void;
  /** Told after each read lands (`SessionManager.transcriptReadLanded`). Optional, as above. */
  transcriptReadLanded?(sessionId: string): void;
  /**
   * Told when a read still running will never land, because the session's
   * state was dropped under it (`SessionManager.transcriptReadDropped`).
   * Optional, as above.
   */
  transcriptReadDropped?(sessionId: string): void;
}

export interface MessageTrailTrackerDeps {
  sessionManager: MessageTrailSessionSource;
  /** Session facts from the project DB; null when the row is unknown or the DB will not open. */
  resolveSessionFacts: (sessionId: string, projectId: string) => MessageTrailSessionFacts | null;
  /**
   * Read the session's transcript from `cursor` and return its newest
   * assistant previews (`message-trail-read.ts`). The app runs it in the
   * retrieval worker, so main parses no transcript; tests run it in-process.
   */
  readTrail: (facts: MessageTrailReadFacts, cursor: number | null) => Promise<TrailRead>;
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

export class MessageTrailTracker extends EventEmitter implements TranscriptPositionSource {
  private readonly states = new Map<string, TrailState>();
  private readonly now: () => number;

  constructor(private readonly deps: MessageTrailTrackerDeps) {
    super();
    this.now = deps.now ?? Date.now;
    // The cursor is also where each turn begins in its transcript, which a
    // turn end reads its reply from (`TurnEndedPayload.transcriptAnchor`).
    deps.sessionManager.setTranscriptPositionSource?.(this);
    deps.sessionManager.on('event', (sessionId, event) => {
      if (MESSAGE_TRAIL_SILENT_EVENT_TYPES.has(event.type)) return;
      this.schedule(sessionId);
    });
    deps.sessionManager.on('session-changed', (sessionId) => this.schedule(sessionId));
    deps.sessionManager.on('session-removed', (sessionId) => {
      // The registry dropped the row for good, so its trail goes with it now
      // rather than at the next snapshot(). Clearing the trailing timer here
      // is the part that matters: a read armed for a removed session would
      // otherwise fire against a file that may already be deleted.
      const state = this.states.get(sessionId);
      if (state) this.dropState(sessionId, state);
    });
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

  /**
   * How far into the session's history file the last finished read reached,
   * as a window read resumes from it. Null on the cached-parse fallback, which
   * has no offsets, before the first read has anchored, and after the agent
   * session id changed until a read anchors in the new file.
   *
   * The session manager copies this when a session goes idle and hands it to
   * the next turn as where that turn began (`TranscriptAnchor`), so a turn end
   * never judges a reply from an earlier turn. That works because the cursor
   * moves only when an awaited read lands, never inside a trigger, so a copy
   * taken while the session sits idle can only cover what was on disk then.
   * Keep it that way. The read a Stop starts can land after that copy, so the
   * manager is told when each read lands (`transcriptReadLanded`) and asks
   * `hasPendingRead` whether more of that burst is still to come, and
   * `hasReadInFlight` whether a read running as a turn is stamped can still
   * move that turn's anchor. A read running when its session's state is
   * dropped never lands, and the manager is told so (`transcriptReadDropped`).
   */
  transcriptPosition(sessionId: string): TranscriptAnchor | null {
    const state = this.states.get(sessionId);
    const agentSessionId = state?.facts?.agentSessionId;
    if (!state || state.usesFallback || state.cursor === null || !agentSessionId) return null;
    return { agentSessionId, byteOffset: state.cursor };
  }

  /** Whether a read of the session is running now or armed on its trailing timer. */
  hasPendingRead(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    return state !== undefined && (state.readInFlight || state.trailingTimer !== null);
  }

  /** Whether a read of the session is running now. `read` lets one run at a time per session. */
  hasReadInFlight(sessionId: string): boolean {
    return this.states.get(sessionId)?.readInFlight === true;
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
    // A read still running settles on a state no longer tracked, which
    // announces no landing (`read`), so the manager hears it here instead.
    if (state.readInFlight) this.deps.sessionManager.transcriptReadDropped?.(sessionId);
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
      const previews = await this.readPreviews(sessionId, state);
      if (previews.length > 0) this.merge(sessionId, state, previews);
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
      // Last, so `hasPendingRead` already counts a re-armed trailing read.
      if (this.states.get(sessionId) === state) this.deps.sessionManager.transcriptReadLanded?.(sessionId);
    }
  }

  private async readPreviews(sessionId: string, state: TrailState): Promise<AssistantMessageTrailEntry[]> {
    // The agent id is captured after spawn for some adapters, so keep asking
    // the row until it is there (one SQLite lookup per read until then).
    if (!state.facts?.agentSessionId) {
      state.facts = this.deps.resolveSessionFacts(sessionId, state.projectId);
    }
    const facts = state.facts;
    const agentSessionId = facts?.agentSessionId;
    if (!facts || !agentSessionId) return [];
    const read = await this.deps.readTrail({ ...facts, agentSessionId }, state.cursor);
    // A read that started in a file the session has since left (a captured
    // id, a /clear fork) ends at an offset in that file, which must not become
    // the cursor into the new one.
    if (state.facts?.agentSessionId !== agentSessionId) return read.previews;
    state.cursor = read.cursor;
    state.usesFallback = read.usedFallback;
    return read.previews;
  }

  private merge(sessionId: string, state: TrailState, previews: AssistantMessageTrailEntry[]): void {
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
