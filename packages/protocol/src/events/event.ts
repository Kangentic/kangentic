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
 */
import type { JsonValue } from '../wire/messages';

export interface TranscriptEvent {
  kind: 'transcript';
  sessionId: string;
  taskId: string;
  payload: JsonValue;
}

export type ActivityEventPayload =
  | { type: 'activity'; state: JsonValue; reason: JsonValue }
  | { type: 'usage'; usage: JsonValue }
  | { type: 'event'; event: JsonValue }
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
