/**
 * Concrete per-verb request/response payload shapes. `CapabilityRequestMessage.payload`
 * and `CapabilityResponseMessage.payload` stay `JsonValue` on the envelope
 * (messages.ts) - these interfaces narrow that generic value at the handler
 * boundary, and the `parse*RequestPayload` guards below are the runtime
 * checks a handler runs against an untrusted phone-originated request before
 * trusting any field.
 *
 * Fields that mirror an app-internal shape the protocol package cannot
 * import (git diff results, board rows, an MCP tool's result) stay
 * `JsonValue`, same rationale as messages.ts/events/event.ts: this package
 * is a dependency-light leaf shared by desktop and phone, so it does not
 * know the desktop app's internal types. Only the fixed envelope fields
 * (ids, actions, booleans) are concretely typed and runtime-validated here.
 */
import type { CapabilityVerb } from '../capabilities/verbs';
import type { JsonValue } from './messages';
import { isJsonValue, isRecord } from './json-value';
import {
  isActivityReasonWire,
  isActivityStateWire,
  parseBacklogItemWire,
  parseBoardColumnWire,
  parseBoardTaskWire,
  parseDiffFileContentWire,
  parseDiffFileListWire,
  parseSessionUsageWire,
  parseTranscriptEntriesWire,
  type ActivityReasonWire,
  type ActivityStateWire,
  type BacklogItemWire,
  type BoardColumnWire,
  type BoardTaskWire,
  type DiffFileContentWire,
  type DiffFileListWire,
  type SessionUsageWire,
  type TranscriptEntryWire,
} from '../events/payloads';

// === read-stream ===

export interface ReadStreamRequestPayload {
  sessionId: string;
  /**
   * 'transcript-window' is a one-shot windowed-history read: the newest
   * `limit` transcript entries strictly before `beforeIndex` (or the tail
   * when `beforeIndex` is omitted). The desktop may return fewer entries
   * than `limit` to keep the response frame small - page again from the
   * returned `startIndex`. Live updates after 'subscribe' arrive as
   * incremental TranscriptEvent deltas, never full transcripts.
   */
  action: 'subscribe' | 'unsubscribe' | 'transcript-window';
  /** transcript-window only: fetch entries strictly before this absolute index. Omit for the newest window. */
  beforeIndex?: number;
  /** transcript-window only: maximum entries wanted (the desktop may cap this and may return fewer). */
  limit?: number;
}

/** Initial snapshot returned on subscribe; live updates arrive as TerminalEvent/ActivityEvent/TranscriptEvent. */
export interface ReadStreamResponsePayload {
  scrollback: string;
  activity: { state: ActivityStateWire | null; reason: ActivityReasonWire | null };
  usage: SessionUsageWire | null;
  /** The live outstanding permission-prompt id (see answer-permission-prompt), or null when none is pending. */
  awaitedPromptId: string | null;
}

/** Phone-side narrowing of a read-stream subscribe response. Throws on a malformed required field. */
export function parseReadStreamResponsePayload(payload: JsonValue): ReadStreamResponsePayload {
  if (!isRecord(payload)) throw new Error('read-stream response must be an object');
  if (typeof payload.scrollback !== 'string') throw new Error('read-stream response is missing "scrollback"');
  if (!isRecord(payload.activity)) throw new Error('read-stream response is missing "activity"');
  const state = payload.activity.state;
  const reason = payload.activity.reason;
  if (state !== null && !isActivityStateWire(state)) throw new Error('read-stream response has an invalid activity "state"');
  if (reason !== null && !isActivityReasonWire(reason)) throw new Error('read-stream response has an invalid activity "reason"');
  if (payload.awaitedPromptId !== null && typeof payload.awaitedPromptId !== 'string') {
    throw new Error('read-stream response has an invalid "awaitedPromptId"');
  }
  return {
    scrollback: payload.scrollback,
    activity: { state: state ?? null, reason: reason ?? null },
    usage: payload.usage === null || payload.usage === undefined ? null : parseSessionUsageWire(payload.usage as JsonValue),
    awaitedPromptId: payload.awaitedPromptId ?? null,
  };
}

/**
 * A contiguous slice of the transcript, returned by the read-stream
 * 'transcript-window' action. `startIndex` is the absolute index of
 * `entries[0]`; `startIndex > 0` means more history exists above.
 */
export interface TranscriptWindowResponsePayload {
  revision: number;
  totalEntries: number;
  startIndex: number;
  entries: TranscriptEntryWire[];
}

/** Phone-side narrowing of a transcript-window response. Throws on a malformed required field. */
export function parseTranscriptWindowResponsePayload(payload: JsonValue): TranscriptWindowResponsePayload {
  if (!isRecord(payload)) throw new Error('transcript-window response must be an object');
  const { revision, totalEntries, startIndex } = payload;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new Error('transcript-window response has an invalid "revision"');
  }
  if (typeof totalEntries !== 'number' || !Number.isInteger(totalEntries) || totalEntries < 0) {
    throw new Error('transcript-window response has an invalid "totalEntries"');
  }
  if (typeof startIndex !== 'number' || !Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error('transcript-window response has an invalid "startIndex"');
  }
  return {
    revision,
    totalEntries,
    startIndex,
    entries: parseTranscriptEntriesWire(payload.entries as JsonValue),
  };
}

function parseReadStreamRequestPayload(payload: JsonValue): ReadStreamRequestPayload {
  if (!isRecord(payload)) throw new Error('read-stream payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('read-stream payload missing "sessionId"');
  if (payload.action !== 'subscribe' && payload.action !== 'unsubscribe' && payload.action !== 'transcript-window') {
    throw new Error('read-stream payload has an invalid "action"');
  }
  const request: ReadStreamRequestPayload = { sessionId: payload.sessionId, action: payload.action };
  if (payload.beforeIndex !== undefined) {
    if (typeof payload.beforeIndex !== 'number' || !Number.isInteger(payload.beforeIndex) || payload.beforeIndex < 0) {
      throw new Error('read-stream payload has an invalid "beforeIndex"');
    }
    request.beforeIndex = payload.beforeIndex;
  }
  if (payload.limit !== undefined) {
    if (typeof payload.limit !== 'number' || !Number.isInteger(payload.limit) || payload.limit < 1) {
      throw new Error('read-stream payload has an invalid "limit"');
    }
    request.limit = payload.limit;
  }
  return request;
}

// === read-board ===

export interface ReadBoardRequestPayload {
  projectId?: string;
  /** Defaults to 'subscribe' when omitted. 'unsubscribe' only has an effect when projectId is set - the no-projectId project list is a one-shot read with no live feed to tear down. */
  action?: 'subscribe' | 'unsubscribe';
}

export interface ReadBoardProjectSummary {
  id: string;
  name: string;
}

/** Returned when the request omits projectId - the phone's project-bootstrap listing. */
export interface ReadBoardProjectListResponsePayload {
  projects: ReadBoardProjectSummary[];
}

/** Returned when the request carries a projectId - a snapshot of that project's board. */
export interface ReadBoardSnapshotResponsePayload {
  projectId: string;
  columns: BoardColumnWire[];
  tasks: BoardTaskWire[];
  backlog: BacklogItemWire[];
}

export type ReadBoardResponsePayload = ReadBoardProjectListResponsePayload | ReadBoardSnapshotResponsePayload;

/** Phone-side narrowing of a read-board response (project list or board snapshot). Throws on a malformed required field. */
export function parseReadBoardResponsePayload(payload: JsonValue): ReadBoardResponsePayload {
  if (!isRecord(payload)) throw new Error('read-board response must be an object');

  if (Array.isArray(payload.projects)) {
    const projects = payload.projects.map((project, index) => {
      if (!isRecord(project) || typeof project.id !== 'string' || typeof project.name !== 'string') {
        throw new Error(`read-board project ${index} is malformed`);
      }
      return { id: project.id, name: project.name };
    });
    return { projects };
  }

  if (typeof payload.projectId !== 'string') throw new Error('read-board response is missing "projectId"');
  if (!Array.isArray(payload.columns)) throw new Error('read-board response is missing "columns"');
  if (!Array.isArray(payload.tasks)) throw new Error('read-board response is missing "tasks"');
  if (!Array.isArray(payload.backlog)) throw new Error('read-board response is missing "backlog"');
  return {
    projectId: payload.projectId,
    columns: payload.columns.map((column) => parseBoardColumnWire(column as JsonValue)),
    tasks: payload.tasks.map((task) => parseBoardTaskWire(task as JsonValue)),
    backlog: payload.backlog.map((item) => parseBacklogItemWire(item as JsonValue)),
  };
}

function parseReadBoardRequestPayload(payload: JsonValue): ReadBoardRequestPayload {
  if (!isRecord(payload)) throw new Error('read-board payload must be an object');
  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    throw new Error('read-board payload has a non-string "projectId"');
  }
  if (payload.action !== undefined && payload.action !== 'subscribe' && payload.action !== 'unsubscribe') {
    throw new Error('read-board payload has an invalid "action"');
  }
  return { projectId: payload.projectId, action: payload.action };
}

// === read-diff ===

/** Mirrors DiffService's GitDiffScope in the desktop app; kept as a literal union here rather than an import, since the protocol package does not depend on the app. */
export type ReadDiffScope = 'working' | 'staged' | 'branch';

export interface ReadDiffRequestPayload {
  taskId: string;
  projectId: string;
  filePath?: string;
  scope?: ReadDiffScope;
  /** Defaults to 'subscribe' when omitted. Only the file-list watch (no filePath) has a live feed to tear down; a single-file content fetch is always one-shot. */
  action?: 'subscribe' | 'unsubscribe';
}

/** The desktop's GitDiffFilesResult mirror (no filePath) or GitFileContentResult mirror (filePath set). */
export type ReadDiffResponsePayload = DiffFileListWire | DiffFileContentWire;

/** Phone-side narrowing of a read-diff response, discriminated by the presence of "files". Throws on a malformed required field. */
export function parseReadDiffResponsePayload(payload: JsonValue): ReadDiffResponsePayload {
  if (!isRecord(payload)) throw new Error('read-diff response must be an object');
  return 'files' in payload ? parseDiffFileListWire(payload) : parseDiffFileContentWire(payload);
}

function parseReadDiffRequestPayload(payload: JsonValue): ReadDiffRequestPayload {
  if (!isRecord(payload)) throw new Error('read-diff payload must be an object');
  if (typeof payload.taskId !== 'string') throw new Error('read-diff payload missing "taskId"');
  if (typeof payload.projectId !== 'string') throw new Error('read-diff payload missing "projectId"');
  if (payload.filePath !== undefined && typeof payload.filePath !== 'string') {
    throw new Error('read-diff payload has a non-string "filePath"');
  }
  if (payload.scope !== undefined && payload.scope !== 'working' && payload.scope !== 'staged' && payload.scope !== 'branch') {
    throw new Error('read-diff payload has an invalid "scope"');
  }
  if (payload.action !== undefined && payload.action !== 'subscribe' && payload.action !== 'unsubscribe') {
    throw new Error('read-diff payload has an invalid "action"');
  }
  return {
    taskId: payload.taskId,
    projectId: payload.projectId,
    filePath: payload.filePath,
    scope: payload.scope,
    action: payload.action,
  };
}

// === send-user-message ===

export interface SendUserMessageRequestPayload {
  sessionId: string;
  text: string;
}

export interface SendUserMessageResponsePayload {
  delivered: boolean;
}

function parseSendUserMessageRequestPayload(payload: JsonValue): SendUserMessageRequestPayload {
  if (!isRecord(payload)) throw new Error('send-user-message payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('send-user-message payload missing "sessionId"');
  if (typeof payload.text !== 'string') throw new Error('send-user-message payload missing "text"');
  return { sessionId: payload.sessionId, text: payload.text };
}

// === move-task ===

export interface MoveTaskRequestPayload {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
  projectId: string;
}

export interface MoveTaskResponsePayload {
  ok: boolean;
}

function parseMoveTaskRequestPayload(payload: JsonValue): MoveTaskRequestPayload {
  if (!isRecord(payload)) throw new Error('move-task payload must be an object');
  if (typeof payload.taskId !== 'string') throw new Error('move-task payload missing "taskId"');
  if (typeof payload.targetSwimlaneId !== 'string') throw new Error('move-task payload missing "targetSwimlaneId"');
  if (typeof payload.targetPosition !== 'number') throw new Error('move-task payload missing "targetPosition"');
  if (typeof payload.projectId !== 'string') throw new Error('move-task payload missing "projectId"');
  return {
    taskId: payload.taskId,
    targetSwimlaneId: payload.targetSwimlaneId,
    targetPosition: payload.targetPosition,
    projectId: payload.projectId,
  };
}

// === answer-permission-prompt ===

export interface AnswerPermissionPromptRequestPayload {
  sessionId: string;
  /** The prompt id the phone believes is outstanding - the handler rejects a stale/replayed answer whose id no longer matches the live awaited prompt. */
  promptId: string;
  keystrokes: string;
}

export interface AnswerPermissionPromptResponsePayload {
  answered: boolean;
}

function parseAnswerPermissionPromptRequestPayload(payload: JsonValue): AnswerPermissionPromptRequestPayload {
  if (!isRecord(payload)) throw new Error('answer-permission-prompt payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('answer-permission-prompt payload missing "sessionId"');
  if (typeof payload.promptId !== 'string') throw new Error('answer-permission-prompt payload missing "promptId"');
  if (typeof payload.keystrokes !== 'string') throw new Error('answer-permission-prompt payload missing "keystrokes"');
  return { sessionId: payload.sessionId, promptId: payload.promptId, keystrokes: payload.keystrokes };
}

// === interactive-terminal ===

export interface InteractiveTerminalRequestPayload {
  sessionId: string;
  data: string;
}

export interface InteractiveTerminalResponsePayload {
  written: boolean;
}

function parseInteractiveTerminalRequestPayload(payload: JsonValue): InteractiveTerminalRequestPayload {
  if (!isRecord(payload)) throw new Error('interactive-terminal payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('interactive-terminal payload missing "sessionId"');
  if (typeof payload.data !== 'string') throw new Error('interactive-terminal payload missing "data"');
  return { sessionId: payload.sessionId, data: payload.data };
}

// === board-tool-read / board-tool-write ===
// Despite the shape ("tool" + "params"), this is NOT the MCP protocol - no
// agent, LLM, or JSON-RPC round-trip is involved. `tool` names an entry in
// the desktop's internal task/board/backlog CRUD registry
// (src/main/agent/commands/index.ts's commandHandlers), the same registry
// the actual MCP server also happens to dispatch into. The bridge calls it
// directly, the same way read-board/move-task call their own repositories/
// handleTaskMove directly - this is reuse of that registry, not a second
// MCP surface.

export interface BoardToolRequestPayload {
  tool: string;
  params: JsonValue;
}

export interface BoardToolResponsePayload {
  result: JsonValue;
}

function parseBoardToolRequestPayload(payload: JsonValue): BoardToolRequestPayload {
  if (!isRecord(payload)) throw new Error('board-tool payload must be an object');
  if (typeof payload.tool !== 'string') throw new Error('board-tool payload missing "tool"');
  if (payload.params === undefined || !isJsonValue(payload.params)) throw new Error('board-tool payload missing a JSON "params"');
  return { tool: payload.tool, params: payload.params };
}

// === dispatch map + entry point ===

export interface CapabilityRequestPayloadMap {
  'read-stream': ReadStreamRequestPayload;
  'read-board': ReadBoardRequestPayload;
  'read-diff': ReadDiffRequestPayload;
  'send-user-message': SendUserMessageRequestPayload;
  'move-task': MoveTaskRequestPayload;
  'answer-permission-prompt': AnswerPermissionPromptRequestPayload;
  'interactive-terminal': InteractiveTerminalRequestPayload;
  'board-tool-read': BoardToolRequestPayload;
  'board-tool-write': BoardToolRequestPayload;
}

export interface CapabilityResponsePayloadMap {
  'read-stream': ReadStreamResponsePayload | TranscriptWindowResponsePayload;
  'read-board': ReadBoardResponsePayload;
  'read-diff': ReadDiffResponsePayload;
  'send-user-message': SendUserMessageResponsePayload;
  'move-task': MoveTaskResponsePayload;
  'answer-permission-prompt': AnswerPermissionPromptResponsePayload;
  'interactive-terminal': InteractiveTerminalResponsePayload;
  'board-tool-read': BoardToolResponsePayload;
  'board-tool-write': BoardToolResponsePayload;
}

/**
 * Validates and narrows a decoded capability-request's generic JsonValue
 * payload into its verb-specific shape. This is the runtime trust boundary:
 * every field the phone supplies is checked before a handler reads it.
 */
export function parseCapabilityRequestPayload<Verb extends CapabilityVerb>(
  verb: Verb,
  payload: JsonValue,
): CapabilityRequestPayloadMap[Verb] {
  switch (verb) {
    case 'read-stream':
      return parseReadStreamRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'read-board':
      return parseReadBoardRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'read-diff':
      return parseReadDiffRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'send-user-message':
      return parseSendUserMessageRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'move-task':
      return parseMoveTaskRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'answer-permission-prompt':
      return parseAnswerPermissionPromptRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'interactive-terminal':
      return parseInteractiveTerminalRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    case 'board-tool-read':
    case 'board-tool-write':
      return parseBoardToolRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    default: {
      const exhaustiveCheck: never = verb;
      throw new Error(`Unknown capability verb: ${String(exhaustiveCheck)}`);
    }
  }
}
