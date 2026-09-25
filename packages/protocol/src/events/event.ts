/**
 * The event contract the phone consumes, pushed as EventMessage.event over
 * an established BridgeSession once Phase 2's capability handlers (desktop
 * bridge module) subscribe SessionManager/transcript-service/DiffService to
 * a session's live state. Six kinds:
 *
 * - transcript: a revision-gated delta from resolveTaskTranscript, for the
 *   phone's transcript-styled conversation view.
 * - activity: a discriminated union consolidating SessionManager's
 *   separate `activity`/`usage`/`event` emissions plus permission state
 *   (carrying the synthesized prompt id `answer-permission-prompt` binds
 *   to), so one event kind covers session telemetry instead of three.
 * - terminal: raw PTY output from the unfiltered data-tap, for the phone's
 *   raw-terminal-mirror view (a distinct consumer from the parsed
 *   transcript).
 * - terminal-resize: the PTY grid changed (desktop pane refit, phone fit
 *   request, or restore-on-release); the phone re-sizes its renderer to
 *   match before the TUI's repaint bytes arrive on the terminal stream.
 * - board: a board-mutation notification, filterable by project and
 *   (optionally) task.
 * - diff: a payload-less "something under this task's worktree changed,
 *   re-fetch via read-diff" signal, mirroring the desktop's GIT_DIFF_CHANGED.
 *
 * Payload contents are typed by the wire mirrors in events/payloads.ts
 * (protocol Phase 2); the desktop's wire-mappers produce them and
 * isBridgeEvent() is the phone's structural trust boundary for a decoded
 * event before its router dispatches on `kind`.
 */
import type { JsonValue } from '../wire/messages';
import { isRecord } from '../wire/json-value';
import {
  isActivityReasonWire,
  isActivityStateWire,
  parseSessionEventWire,
  parseSessionUsageWire,
  parseTerminalDimensionsWire,
  parseTranscriptEventPayload,
  type ActivityReasonWire,
  type ActivityStateWire,
  type SessionEventWire,
  type SessionUsageWire,
  type TerminalDimensionsWire,
  type TranscriptEventPayload,
} from './payloads';

export interface TranscriptEvent {
  kind: 'transcript';
  sessionId: string;
  taskId: string;
  /** Incremental (protocol v2): indexed upserts or a reset signal, never the whole transcript. See TranscriptEventPayload. */
  payload: TranscriptEventPayload;
}

export type ActivityEventPayload =
  | { type: 'activity'; state: ActivityStateWire; reason: ActivityReasonWire }
  | { type: 'usage'; usage: SessionUsageWire }
  | { type: 'event'; event: SessionEventWire }
  /**
   * `options`, when present on a pending push, carries the prompt dialog's
   * numbered option labels in keystroke order (options[0] is answered with
   * "1\r"). Absent from pre-0.6.0 desktops and whenever no numbered dialog
   * could be parsed from the PTY frame; the phone then falls back to its
   * blind approve/deny keystrokes.
   */
  | { type: 'permission'; promptId: string; pending: boolean; options?: string[] }
  /**
   * The streamed session's PTY exited. Pushed once by the desktop's
   * read-stream subscription right before it tears itself down, so the
   * phone learns "this session is over" from the feed itself instead of
   * inferring it from silence. `intentional` distinguishes a deliberate
   * stop (desktop Stop button, suspend, shutdown) from a crash.
   *
   * `spawnProgressLabel`, when present, means the desktop had a respawn in
   * flight for this task when the session ended - a same-column respawn
   * (model switch, agent switch, effort change, isolated-session-track
   * switch) or an in-place restart (a model or effort pick on the running
   * task, a board-profile change, or the auto_command escalation that
   * re-sends a command as the resume prompt, "Re-sending command...") rather
   * than a genuine park. Read it as what the desktop
   * believed, not as a fact about what happens next; the caveats below
   * bound it. `intentional` cannot carry this distinction on its own:
   * the desktop's SessionManager.suspend() sets `status = 'suspended'`
   * before the force-kill for every caller, a respawn and a real park
   * alike, so both reach the phone as `intentional: true`. The string is
   * the desktop's own display text for what it is doing ("Switching
   * model...", "Starting agent...", a live git-queue wait count) - treat it
   * as untrusted display text, not a key to switch on, cap its length, and
   * fall back to generic copy rather than parsing it.
   *
   * INTENT, not a guarantee, on the same terms `BoardColumnWire.spawns_session`
   * documents: the desktop can suspend without a successor ever landing (a
   * board profile change, a failed worktree checkout, a shutdown, a racing
   * move), so a client MUST keep whatever timeout already bounds its
   * session-swap wait and use the label only to skip a redundant one.
   *
   * Absent from pre-0.14.0 desktops, and never sent as `null`. A park that
   * goes through `task-move.ts` (move to To Do, to Done, or into an
   * `auto_spawn=false` column) clears the label first, so it carries none.
   * Five other genuine parks do not clear it - a manual pause, the
   * idle-timeout suspend, the `kill_session` action, project-relocate, and
   * auto-spawn-reconcile - so one of those firing while a label is still in
   * flight sends the label on a real park. The label then survives at most
   * the desktop's 120s spawn-progress TTL. That gap is why the timeout above
   * is mandatory, not advisory.
   *
   * A label can also ride an `intentional: false` exit, since a respawn whose
   * spawn fails still has its label in flight when the PTY dies. The two
   * fields are independent; do not read them as mutually exclusive.
   */
  | { type: 'session-ended'; intentional: boolean; spawnProgressLabel?: string }
  /**
   * The agent's most recent assistant message, already collapsed to a short
   * plain-text preview, pushed whenever it changes.
   *
   * A phone's session list renders exactly one line per session. Deriving it
   * client-side cost a transcript-window request per session (measured 2.3 to
   * 34.6 KB each, to keep a string under 200 characters) plus 0.7 to 3.8
   * seconds of desktop work per request. The desktop already resolves the
   * transcript to compute its delta pushes, so it can carry the line for
   * free on a feed the phone is receiving anyway.
   *
   * Absent from pre-0.8.0 desktops; a phone that sees none should fall back
   * to whatever it can derive locally rather than showing nothing.
   */
  | { type: 'message-preview'; text: string };

export interface ActivityEvent {
  kind: 'activity';
  sessionId: string;
  taskId: string;
  payload: ActivityEventPayload;
}

export interface TerminalEvent {
  kind: 'terminal';
  sessionId: string;
  taskId: string;
  payload: { data: string };
}

export interface TerminalResizeEvent {
  kind: 'terminal-resize';
  sessionId: string;
  taskId: string;
  /** The PTY's new grid; every terminal byte sent after this event is laid out for it. */
  payload: TerminalDimensionsWire;
}

export interface BoardEventPayload {
  change: 'task-created' | 'task-updated' | 'task-deleted' | 'swimlane-updated' | 'backlog-changed';
  ids: string[];
}

export interface BoardEvent {
  kind: 'board';
  projectId: string;
  taskId?: string;
  payload: BoardEventPayload;
}

export interface DiffEvent {
  kind: 'diff';
  taskId: string;
  payload: null;
}

export type BridgeEvent = TranscriptEvent | ActivityEvent | TerminalEvent | TerminalResizeEvent | BoardEvent | DiffEvent;

const BOARD_CHANGES: readonly string[] = ['task-created', 'task-updated', 'task-deleted', 'swimlane-updated', 'backlog-changed'];

/**
 * Narrows an activity event's payload to its typed union. Throws on a
 * malformed required field so the caller can drop the event cleanly.
 */
export function parseActivityEventPayload(payload: JsonValue): ActivityEventPayload {
  if (!isRecord(payload)) throw new Error('activity payload must be an object');
  switch (payload.type) {
    case 'activity': {
      if (!isActivityStateWire(payload.state)) throw new Error('activity payload has an invalid "state"');
      if (!isActivityReasonWire(payload.reason)) throw new Error('activity payload has an invalid "reason"');
      return { type: 'activity', state: payload.state, reason: payload.reason };
    }
    case 'usage':
      return { type: 'usage', usage: parseSessionUsageWire(payload.usage as JsonValue) };
    case 'event':
      return { type: 'event', event: parseSessionEventWire(payload.event as JsonValue) };
    case 'permission': {
      if (typeof payload.promptId !== 'string') throw new Error('permission payload is missing "promptId"');
      if (typeof payload.pending !== 'boolean') throw new Error('permission payload is missing "pending"');
      if (payload.options === undefined) {
        return { type: 'permission', promptId: payload.promptId, pending: payload.pending };
      }
      if (!Array.isArray(payload.options) || !payload.options.every((option) => typeof option === 'string')) {
        throw new Error('permission payload has an invalid "options"');
      }
      return { type: 'permission', promptId: payload.promptId, pending: payload.pending, options: payload.options };
    }
    case 'session-ended': {
      if (typeof payload.intentional !== 'boolean') throw new Error('session-ended payload is missing "intentional"');
      if (payload.spawnProgressLabel === undefined) {
        return { type: 'session-ended', intentional: payload.intentional };
      }
      if (typeof payload.spawnProgressLabel !== 'string') throw new Error('session-ended payload has an invalid "spawnProgressLabel"');
      return { type: 'session-ended', intentional: payload.intentional, spawnProgressLabel: payload.spawnProgressLabel };
    }
    case 'message-preview': {
      if (typeof payload.text !== 'string') throw new Error('message-preview payload is missing "text"');
      return { type: 'message-preview', text: payload.text };
    }
    default:
      throw new Error('activity payload has an unknown "type"');
  }
}

/**
 * Full structural validation of a decoded event - envelope ids AND payload
 * shape per kind. This is the phone-side trust boundary its feed router
 * runs before dispatching; a false return means "drop the event".
 */
export function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'transcript': {
      if (typeof value.sessionId !== 'string' || typeof value.taskId !== 'string') return false;
      try {
        parseTranscriptEventPayload(value.payload as JsonValue);
        return true;
      } catch {
        return false;
      }
    }
    case 'activity': {
      if (typeof value.sessionId !== 'string' || typeof value.taskId !== 'string') return false;
      try {
        parseActivityEventPayload(value.payload as JsonValue);
        return true;
      } catch {
        return false;
      }
    }
    case 'terminal': {
      if (typeof value.sessionId !== 'string' || typeof value.taskId !== 'string') return false;
      return isRecord(value.payload) && typeof value.payload.data === 'string';
    }
    case 'terminal-resize': {
      if (typeof value.sessionId !== 'string' || typeof value.taskId !== 'string') return false;
      try {
        parseTerminalDimensionsWire(value.payload as JsonValue);
        return true;
      } catch {
        return false;
      }
    }
    case 'board': {
      if (typeof value.projectId !== 'string') return false;
      if (value.taskId !== undefined && typeof value.taskId !== 'string') return false;
      if (!isRecord(value.payload)) return false;
      const change = value.payload.change;
      if (typeof change !== 'string' || !BOARD_CHANGES.includes(change)) return false;
      return Array.isArray(value.payload.ids) && value.payload.ids.every((id) => typeof id === 'string');
    }
    case 'diff':
      return typeof value.taskId === 'string' && value.payload === null;
    default:
      return false;
  }
}
