/**
 * The event contract skeleton the phone consumes. Phase 1 establishes the
 * three event FAMILIES (transcript, board, activity) and their envelope
 * shape; Phase 2 (data feeds & interactive control) is what actually maps
 * desktop internals - SessionManager's `data`/`activity` events,
 * transcript-service output, repository/DiffService mutations - onto
 * these envelopes. Keeping `payload` as JsonValue here rather than a
 * fully-typed shape per event avoids guessing at Phase 2's real mapping
 * before that integration exists.
 */
import type { JsonValue } from '../wire/messages';

export interface TranscriptEvent {
  kind: 'transcript';
  sessionId: string;
  taskId: string;
  payload: JsonValue;
}

export interface BoardEvent {
  kind: 'board';
  taskId: string;
  payload: JsonValue;
}

export interface ActivityEvent {
  kind: 'activity';
  sessionId: string;
  taskId: string;
  payload: JsonValue;
}

export type BridgeEvent = TranscriptEvent | BoardEvent | ActivityEvent;
