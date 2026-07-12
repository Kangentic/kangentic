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

// === read-stream ===

export interface ReadStreamRequestPayload {
  sessionId: string;
  action: 'subscribe' | 'unsubscribe';
}

/** Initial snapshot returned on subscribe; live updates arrive as TerminalEvent/ActivityEvent/TranscriptEvent. */
export interface ReadStreamResponsePayload {
  scrollback: string;
  activity: JsonValue;
  usage: JsonValue | null;
  /** The live outstanding permission-prompt id (see answer-permission-prompt), or null when none is pending. */
  awaitedPromptId: string | null;
}

function parseReadStreamRequestPayload(payload: JsonValue): ReadStreamRequestPayload {
  if (!isRecord(payload)) throw new Error('read-stream payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('read-stream payload missing "sessionId"');
  if (payload.action !== 'subscribe' && payload.action !== 'unsubscribe') {
    throw new Error('read-stream payload has an invalid "action"');
  }
  return { sessionId: payload.sessionId, action: payload.action };
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
  columns: JsonValue;
  tasks: JsonValue;
  backlog: JsonValue;
}

export type ReadBoardResponsePayload = ReadBoardProjectListResponsePayload | ReadBoardSnapshotResponsePayload;

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

/** Structurally mirrors the desktop app's GitDiffFilesResult (no filePath) or GitFileContentResult (filePath set). */
export type ReadDiffResponsePayload = JsonValue;

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
  'read-stream': ReadStreamResponsePayload;
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
