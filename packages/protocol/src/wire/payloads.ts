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
import { base64UrlDecode } from './base64url';
import { isPushCategory, type PushCategory } from '../crypto/push-envelope';
import {
  isActivityReasonWire,
  isActivityStateWire,
  parseBacklogItemWire,
  parseBoardColumnWire,
  parseBoardTaskWire,
  parseDiffFileContentWire,
  parseDiffFileListWire,
  parseSessionUsageWire,
  parseTerminalDimensionsWire,
  parseTranscriptEntriesWire,
  type ActivityReasonWire,
  type ActivityStateWire,
  type BacklogItemWire,
  type BoardColumnWire,
  type BoardTaskWire,
  type DiffFileContentWire,
  type DiffFileListWire,
  type SessionUsageWire,
  type TerminalDimensionsWire,
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
  /**
   * subscribe only: whether this subscription wants live PTY bytes.
   *
   * A phone watching its session list needs activity, permission and
   * transcript pushes, but NOT the terminal - it discards those bytes on
   * arrival. Measured on a live board, that discard cost roughly 13MB an hour
   * of relay traffic and mobile data for a feed showing no terminal at all.
   *
   * Omitted means true, so an older phone keeps the previous behaviour and an
   * older desktop that ignores the field simply keeps sending (wasteful, not
   * broken). Set false for a list-only subscription and re-subscribe with it
   * true when a terminal actually opens.
   */
  terminal?: boolean;
}

/**
 * Mirrors the desktop's SessionStatus. 'suspended' is a registered-but-
 * parked session (resumable placeholder); 'exited' can appear when a
 * snapshot races the session's teardown.
 */
export type ReadStreamSessionStatusWire = 'running' | 'queued' | 'suspended' | 'exited';

const READ_STREAM_SESSION_STATUSES: readonly string[] = ['running', 'queued', 'suspended', 'exited'];

/** Initial snapshot returned on subscribe; live updates arrive as TerminalEvent/ActivityEvent/TranscriptEvent. */
export interface ReadStreamResponsePayload {
  scrollback: string;
  activity: { state: ActivityStateWire | null; reason: ActivityReasonWire | null };
  usage: SessionUsageWire | null;
  /** The live outstanding permission-prompt id (see answer-permission-prompt), or null when none is pending. */
  awaitedPromptId: string | null;
  /**
   * The awaited prompt's numbered option labels, parsed by the desktop from
   * the pending dialog's PTY frame, in keystroke order: options[0] is the
   * row answered with "1\r", options[1] with "2\r", and so on. Absent from
   * pre-0.6.0 desktops; absent or null means unknown (no numbered dialog
   * could be parsed), and the phone falls back to its blind
   * approve/deny keystrokes. Only meaningful while awaitedPromptId is set.
   */
  awaitedPromptOptions?: string[] | null;
  /**
   * The PTY grid the scrollback bytes are laid out for. Absent from
   * pre-0.4.0 desktops; the phone then falls back to inferring a width
   * from the scrollback content.
   */
  ptyDimensions?: TerminalDimensionsWire;
  /**
   * The session's lifecycle status at snapshot time. Absent from
   * pre-0.5.0 desktops; the phone then assumes 'running'.
   */
  sessionStatus?: ReadStreamSessionStatusWire;
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
  const response: ReadStreamResponsePayload = {
    scrollback: payload.scrollback,
    activity: { state: state ?? null, reason: reason ?? null },
    usage: payload.usage === null || payload.usage === undefined ? null : parseSessionUsageWire(payload.usage as JsonValue),
    awaitedPromptId: payload.awaitedPromptId ?? null,
  };
  if (payload.awaitedPromptOptions !== undefined) {
    if (payload.awaitedPromptOptions === null) {
      response.awaitedPromptOptions = null;
    } else if (Array.isArray(payload.awaitedPromptOptions) && payload.awaitedPromptOptions.every((option) => typeof option === 'string')) {
      response.awaitedPromptOptions = payload.awaitedPromptOptions;
    } else {
      throw new Error('read-stream response has an invalid "awaitedPromptOptions"');
    }
  }
  if (payload.ptyDimensions !== undefined) {
    response.ptyDimensions = parseTerminalDimensionsWire(payload.ptyDimensions as JsonValue);
  }
  if (payload.sessionStatus !== undefined) {
    if (typeof payload.sessionStatus !== 'string' || !READ_STREAM_SESSION_STATUSES.includes(payload.sessionStatus)) {
      throw new Error('read-stream response has an invalid "sessionStatus"');
    }
    response.sessionStatus = payload.sessionStatus as ReadStreamSessionStatusWire;
  }
  return response;
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
  if (payload.terminal !== undefined) {
    if (typeof payload.terminal !== 'boolean') throw new Error('read-stream payload has an invalid "terminal"');
    request.terminal = payload.terminal;
  }
  return request;
}

// === read-board ===

/**
 * Which projection of a board the phone wants.
 *
 * - 'sessions': columns, per-column task counts, and only the non-archived
 *   tasks that carry a `session_id`. This is what an agent feed renders: it
 *   watches every project at once but only ever draws the handful of tasks
 *   with a live agent on them.
 * - 'full': every non-archived task, for the one project whose board the user
 *   actually has open.
 *
 * Neither carries the backlog. Sending the field at all is the signal that
 * this phone tolerates a response without one; a phone that omits it gets the
 * pre-0.9.0 payload unchanged.
 */
export type ReadBoardView = 'full' | 'sessions';

export interface ReadBoardRequestPayload {
  projectId?: string;
  /** Defaults to 'subscribe' when omitted. 'unsubscribe' only has an effect when projectId is set - the no-projectId project list is a one-shot read with no live feed to tear down. */
  action?: 'subscribe' | 'unsubscribe';
  /**
   * subscribe only: the projection wanted (protocol 0.9.0). Omitted means the
   * legacy full board WITH the backlog.
   *
   * Measured on a 15-project desktop, the full boards were 63 kB compressed
   * of a ~96 kB cold start, of which 23 kB was a backlog no phone has ever
   * rendered and another 30 kB was tasks with no session on them. Worse, a
   * board subscription re-snapshots on every board change, so that payload
   * repeats for as long as the phone is connected. The 'sessions' projection
   * is 12 kB for the same 15 projects.
   *
   * A pre-0.9.0 desktop ignores the field and returns a full board with no
   * `view` echo, which is exactly how a 0.9.0 phone detects that it must not
   * treat the snapshot as filtered.
   */
  view?: ReadBoardView;
}

export interface ReadBoardProjectSummary {
  id: string;
  name: string;
  /**
   * Accent color for this project ("#rrggbb"). Today the desktop derives
   * it deterministically from the project id; a user-set project color
   * can later override it through this same field. Absent from pre-0.5.0
   * desktops.
   */
  color?: string;
}

/** Returned when the request omits projectId - the phone's project-bootstrap listing. */
export interface ReadBoardProjectListResponsePayload {
  projects: ReadBoardProjectSummary[];
}

/** Returned when the request carries a projectId - a snapshot of that project's board. */
export interface ReadBoardSnapshotResponsePayload {
  projectId: string;
  columns: BoardColumnWire[];
  /** Non-archived tasks; filtered to the ones carrying a `session_id` when `view` is 'sessions'. */
  tasks: BoardTaskWire[];
  /** Absent whenever the request carried a `view` (protocol 0.9.0) - no phone has ever rendered it. */
  backlog?: BacklogItemWire[];
  /** The project's accent color ("#rrggbb"); same semantics as ReadBoardProjectSummary.color. Absent from pre-0.5.0 desktops. */
  projectColor?: string;
  /**
   * The desktop's Layout "Ticket Numbers" setting: whether task cards
   * display their #N number. Absent from pre-0.6.0 desktops (treat as
   * true, the desktop default).
   */
  showTicketNumbers?: boolean;
  /**
   * The projection actually applied, echoed back. Absent from a pre-0.9.0
   * desktop, which always sends a full board - so treat an absent `view` as
   * 'full', never as "filtered, unknown how".
   */
  view?: ReadBoardView;
  /**
   * Non-archived task count per column id, sent with a 'sessions' view because
   * `tasks` is filtered and a count taken from it would be wrong. Appending a
   * card to a column needs the real length.
   */
  taskCountsByColumnId?: Record<string, number>;
}

export type ReadBoardResponsePayload = ReadBoardProjectListResponsePayload | ReadBoardSnapshotResponsePayload;

const ACCENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function parseAccentColor(value: unknown, context: string): string {
  if (typeof value !== 'string' || !ACCENT_COLOR_PATTERN.test(value)) {
    throw new Error(`${context} has an invalid accent color (expected "#rrggbb")`);
  }
  return value;
}

/** Phone-side narrowing of a read-board response (project list or board snapshot). Throws on a malformed required field. */
export function parseReadBoardResponsePayload(payload: JsonValue): ReadBoardResponsePayload {
  if (!isRecord(payload)) throw new Error('read-board response must be an object');

  if (Array.isArray(payload.projects)) {
    const projects = payload.projects.map((project, index): ReadBoardProjectSummary => {
      if (!isRecord(project) || typeof project.id !== 'string' || typeof project.name !== 'string') {
        throw new Error(`read-board project ${index} is malformed`);
      }
      return {
        id: project.id,
        name: project.name,
        ...(project.color !== undefined ? { color: parseAccentColor(project.color, `read-board project ${index}`) } : {}),
      };
    });
    return { projects };
  }

  if (typeof payload.projectId !== 'string') throw new Error('read-board response is missing "projectId"');
  if (!Array.isArray(payload.columns)) throw new Error('read-board response is missing "columns"');
  if (!Array.isArray(payload.tasks)) throw new Error('read-board response is missing "tasks"');
  // 0.9.0+ responses omit the backlog entirely; only a present-but-wrong value is an error.
  if (payload.backlog !== undefined && !Array.isArray(payload.backlog)) {
    throw new Error('read-board response has a non-array "backlog"');
  }
  if (payload.showTicketNumbers !== undefined && typeof payload.showTicketNumbers !== 'boolean') {
    throw new Error('read-board response has a non-boolean "showTicketNumbers"');
  }
  if (payload.view !== undefined && payload.view !== 'full' && payload.view !== 'sessions') {
    throw new Error('read-board response has an invalid "view"');
  }
  return {
    projectId: payload.projectId,
    columns: payload.columns.map((column) => parseBoardColumnWire(column as JsonValue)),
    tasks: payload.tasks.map((task) => parseBoardTaskWire(task as JsonValue)),
    ...(payload.backlog !== undefined
      ? { backlog: payload.backlog.map((item) => parseBacklogItemWire(item as JsonValue)) }
      : {}),
    ...(payload.projectColor !== undefined ? { projectColor: parseAccentColor(payload.projectColor, 'read-board snapshot') } : {}),
    ...(payload.showTicketNumbers !== undefined ? { showTicketNumbers: payload.showTicketNumbers } : {}),
    ...(payload.view !== undefined ? { view: payload.view } : {}),
    ...(payload.taskCountsByColumnId !== undefined
      ? { taskCountsByColumnId: parseTaskCountsByColumnId(payload.taskCountsByColumnId) }
      : {}),
  };
}

/** Narrows the 'sessions' view's per-column task counts; a malformed entry is dropped rather than failing the whole snapshot. */
function parseTaskCountsByColumnId(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error('read-board response has a non-object "taskCountsByColumnId"');
  const counts: Record<string, number> = {};
  for (const [columnId, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) counts[columnId] = count;
  }
  return counts;
}

function parseReadBoardRequestPayload(payload: JsonValue): ReadBoardRequestPayload {
  if (!isRecord(payload)) throw new Error('read-board payload must be an object');
  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    throw new Error('read-board payload has a non-string "projectId"');
  }
  if (payload.action !== undefined && payload.action !== 'subscribe' && payload.action !== 'unsubscribe') {
    throw new Error('read-board payload has an invalid "action"');
  }
  if (payload.view !== undefined && payload.view !== 'full' && payload.view !== 'sessions') {
    throw new Error('read-board payload has an invalid "view"');
  }
  return { projectId: payload.projectId, action: payload.action, view: payload.view };
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

/**
 * Three actions ride the one interactive-terminal grant: a device trusted
 * to type raw bytes into the PTY is equally trusted to resize it, so
 * resize adds no new capability surface.
 *
 * - write (the default when `action` is omitted, which is what every
 *   pre-0.4.0 phone sends): raw bytes into the PTY.
 * - resize: set the PTY grid so the TUI redraws phone-shaped. The desktop
 *   remembers its own last dimensions and restores them when the phone
 *   releases (explicitly, or implicitly on disconnect/revoke).
 * - release-size: give the grid back to the desktop now.
 */
export type InteractiveTerminalRequestPayload =
  | { sessionId: string; action?: 'write'; data: string }
  | { sessionId: string; action: 'resize'; dimensions: TerminalDimensionsWire }
  | { sessionId: string; action: 'release-size' };

export type InteractiveTerminalResponsePayload =
  | { written: boolean }
  | { resized: boolean; colsChanged: boolean }
  | { released: boolean };

function parseInteractiveTerminalRequestPayload(payload: JsonValue): InteractiveTerminalRequestPayload {
  if (!isRecord(payload)) throw new Error('interactive-terminal payload must be an object');
  if (typeof payload.sessionId !== 'string') throw new Error('interactive-terminal payload missing "sessionId"');
  if (payload.action === undefined || payload.action === 'write') {
    if (typeof payload.data !== 'string') throw new Error('interactive-terminal payload missing "data"');
    return { sessionId: payload.sessionId, action: 'write', data: payload.data };
  }
  if (payload.action === 'resize') {
    return {
      sessionId: payload.sessionId,
      action: 'resize',
      dimensions: parseTerminalDimensionsWire(payload.dimensions as JsonValue),
    };
  }
  if (payload.action === 'release-size') {
    return { sessionId: payload.sessionId, action: 'release-size' };
  }
  throw new Error('interactive-terminal payload has an invalid "action"');
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

// === register-push ===

/** The device push key is an XChaCha20-Poly1305 key: exactly 32 bytes, base64url on the wire. */
const PUSH_KEY_LENGTH = 32;

/**
 * Registers (or unregisters) this device for E2E-encrypted push
 * notifications. 'register' carries the device's Expo push token plus a
 * device-generated 32-byte push key (base64url) the desktop seals every
 * notification envelope with (see crypto/push-envelope.ts); 'unregister'
 * carries neither. The desktop keys the registration by the requesting
 * device's roster identity, never by anything in this payload.
 *
 * `categories`, when present, is the device's push preferences: the desktop
 * filters outgoing notifications to this set before sending, so preference
 * enforcement never depends on the receiving device (a future iOS
 * Notification Service Extension stays preference-free). Absent means every
 * category (the default, and what an older device that predates this field
 * implicitly requests); an explicit empty array means none.
 */
export interface RegisterPushRequestPayload {
  action: 'register' | 'unregister';
  expoPushToken?: string;
  pushKeyBase64?: string;
  platform?: 'android' | 'ios';
  categories?: PushCategory[];
}

export interface RegisterPushResponsePayload {
  registered: boolean;
}

export function parseRegisterPushRequestPayload(payload: JsonValue): RegisterPushRequestPayload {
  if (!isRecord(payload)) throw new Error('register-push payload must be an object');
  if (payload.action !== 'register' && payload.action !== 'unregister') {
    throw new Error('register-push payload has an invalid "action"');
  }
  const request: RegisterPushRequestPayload = { action: payload.action };
  if (payload.expoPushToken !== undefined) {
    if (typeof payload.expoPushToken !== 'string') throw new Error('register-push payload has a non-string "expoPushToken"');
    request.expoPushToken = payload.expoPushToken;
  }
  if (payload.pushKeyBase64 !== undefined) {
    if (typeof payload.pushKeyBase64 !== 'string') throw new Error('register-push payload has a non-string "pushKeyBase64"');
    let decodedKey: Uint8Array;
    try {
      decodedKey = base64UrlDecode(payload.pushKeyBase64);
    } catch {
      throw new Error('register-push payload has a malformed "pushKeyBase64"');
    }
    if (decodedKey.length !== PUSH_KEY_LENGTH) {
      throw new Error(`register-push payload "pushKeyBase64" must decode to ${PUSH_KEY_LENGTH} bytes`);
    }
    request.pushKeyBase64 = payload.pushKeyBase64;
  }
  if (payload.platform !== undefined) {
    if (payload.platform !== 'android' && payload.platform !== 'ios') {
      throw new Error('register-push payload has an invalid "platform"');
    }
    request.platform = payload.platform;
  }
  if (payload.categories !== undefined) {
    if (!Array.isArray(payload.categories) || !payload.categories.every((entry) => typeof entry === 'string')) {
      throw new Error('register-push payload has a malformed "categories"');
    }
    // An unrecognized category (e.g. from a newer device) is dropped, not
    // rejected: registration must not fail outright over a category this
    // desktop does not yet know.
    request.categories = payload.categories.filter(isPushCategory);
  }
  if (request.action === 'register') {
    if (request.expoPushToken === undefined) throw new Error('register-push register payload missing "expoPushToken"');
    if (request.pushKeyBase64 === undefined) throw new Error('register-push register payload missing "pushKeyBase64"');
  }
  return request;
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
  'register-push': RegisterPushRequestPayload;
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
  'register-push': RegisterPushResponsePayload;
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
    case 'register-push':
      return parseRegisterPushRequestPayload(payload) as CapabilityRequestPayloadMap[Verb];
    default: {
      const exhaustiveCheck: never = verb;
      throw new Error(`Unknown capability verb: ${String(exhaustiveCheck)}`);
    }
  }
}
