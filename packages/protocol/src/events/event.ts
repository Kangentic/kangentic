/**
 * The event contract the phone consumes, pushed as EventMessage.event over
 * an established BridgeSession once Phase 2's capability handlers (desktop
 * bridge module) subscribe SessionManager/transcript-service/DiffService to
 * a session's live state. Five kinds:
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
  parseTranscriptEntriesWire,
  type ActivityReasonWire,
  type ActivityStateWire,
  type SessionEventWire,
  type SessionUsageWire,
  type TranscriptEntryWire,
} from './payloads';

export interface TranscriptEvent {
  kind: 'transcript';
  sessionId: string;
  taskId: string;
  payload: TranscriptEntryWire[];
}

export type ActivityEventPayload =
  | { type: 'activity'; state: ActivityStateWire; reason: ActivityReasonWire }
  | { type: 'usage'; usage: SessionUsageWire }
  | { type: 'event'; event: SessionEventWire }
  | { type: 'permission'; promptId: string; pending: boolean };

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

export type BridgeEvent = TranscriptEvent | ActivityEvent | TerminalEvent | BoardEvent | DiffEvent;

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
      return { type: 'permission', promptId: payload.promptId, pending: payload.pending };
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
        parseTranscriptEntriesWire(value.payload as JsonValue);
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
