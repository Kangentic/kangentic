/**
 * Wire-level mirrors of the desktop-app shapes that flow to a phone inside
 * feed events and read-* responses, plus the runtime guards a phone runs
 * before trusting any field. Phase 2 of the protocol: the envelope
 * (messages.ts) and event skeleton (event.ts) were final in Phase 1; these
 * types pin down the payload CONTENTS that were deferred as JsonValue.
 *
 * These are deliberate structural MIRRORS, not imports: this package is a
 * dependency-light leaf shared by desktop and phone, so it cannot import
 * the desktop app's internal types (src/shared/types.ts). The desktop's
 * wire-mappers (src/main/mobile-bridge/handlers/wire-mappers.ts) are the
 * one place each mirror meets its source shape, so a drift shows up there
 * as a compile error instead of a silent phone-side parse failure.
 *
 * Guard philosophy: validate the discriminants and required scalars a
 * consumer dispatches on, pass unrecognized extra fields through untouched
 * (lenient forward compatibility - an older phone must tolerate fields a
 * newer desktop adds), and throw on a malformed required field so the
 * caller can drop the payload cleanly.
 */
import type { JsonValue } from '../wire/messages';
import { isRecord } from '../wire/json-value';

// === Transcript ===

/** Mirrors the desktop's TranscriptBlock. `tool_use.input` is JSON-sanitized by the desktop mapper before it reaches the wire. */
export type TranscriptBlockWire =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue };

/** Mirrors the desktop's per-turn TranscriptTurnUsage token counts. */
export interface TranscriptTurnUsageWire {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type TranscriptSystemSubtypeWire = 'compaction' | 'command' | 'command_output' | 'session_boundary';

/** Mirrors the desktop's TranscriptEntry union - the parsed conversation the phone's transcript-terminal renders. */
export type TranscriptEntryWire =
  | { kind: 'user'; uuid: string; ts: number; text: string }
  | {
      kind: 'assistant';
      uuid: string;
      ts: number;
      model?: string;
      agentName?: string;
      usage?: TranscriptTurnUsageWire;
      blocks: TranscriptBlockWire[];
    }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string; content: string; isError?: boolean }
  | { kind: 'system'; uuid: string; ts: number; subtype: TranscriptSystemSubtypeWire; text: string };

/** One transcript entry at its absolute position in the full transcript at the delta's revision. */
export interface TranscriptUpsertWire {
  index: number;
  entry: TranscriptEntryWire;
}

/**
 * Protocol v2 transcript payload: incremental, never the whole transcript.
 *
 * - 'delta' carries only the entries that changed or appeared since the
 *   last delta the desktop sent on this subscription, as absolute-indexed
 *   upserts in ascending order. A large delta is split across several
 *   events (same revision) so every frame stays well under the transport
 *   caps and the first chunk renders without waiting for the rest. The
 *   phone applies upserts inside or adjacent to its loaded window and
 *   re-requests a window when it detects a gap.
 * - 'reset' tells the phone its local state is unreconstructable from
 *   deltas (entries removed or reordered, or a degraded transcript source
 *   whose uuids are unstable) - drop local entries and re-request a
 *   window via the read-stream 'transcript-window' action.
 *
 * `revision` is the desktop's monotonically increasing whole-transcript
 * version; `totalEntries` is the full transcript length at that revision,
 * which is how the phone knows history extends above its window.
 */
export type TranscriptEventPayload =
  | { mode: 'delta'; revision: number; totalEntries: number; upserts: TranscriptUpsertWire[] }
  | { mode: 'reset'; revision: number; totalEntries: number };

// === Activity ===

/** Mirrors the desktop's ActivityState. 'permission' means the agent paused for user approval (incl. AskUserQuestion / ExitPlanMode pauses). */
export type ActivityStateWire = 'thinking' | 'idle' | 'permission';

/** Mirrors the desktop's ActivityReason discriminated union. */
export type ActivityReasonWire =
  | { kind: 'idle' }
  | { kind: 'permission' }
  | { kind: 'tool'; pendingCount: number; currentTool: string | null }
  | { kind: 'subagent'; depth: number }
  | { kind: 'background-shell'; count: number; ids: string[] }
  | { kind: 'turn-active' };

/**
 * Phone-needed subset of the desktop's SessionUsage. The desktop mapper
 * explicitly picks these fields; renderer-only extras (transcriptPath,
 * rateLimits, sessionId echo) never reach the wire.
 */
export interface SessionUsageWire {
  contextWindow: {
    usedPercentage: number;
    usedTokens: number;
    cacheTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    contextWindowSize: number;
  };
  cost: {
    totalCostUsd: number;
    totalDurationMs: number;
  };
  toolCallCount?: number;
  model: {
    id: string;
    displayName: string;
    effort?: string;
  };
}

/**
 * Loose mirror of the desktop's SessionEvent telemetry entry. `type` is
 * deliberately a plain string, not the desktop's EventType enum, so a new
 * desktop event type does not break an older phone's parser.
 */
export interface SessionEventWire {
  ts: number;
  type: string;
  tool?: string;
  toolId?: string;
  detail?: string;
}

// === Board ===

/** Phone-needed subset of the desktop's Swimlane row (snake_case preserved so the desktop mapper is a mechanical pick). */
export interface BoardColumnWire {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: boolean;
  is_ghost: boolean;
}

/** Phone-needed subset of the desktop's Task row. A non-null `session_id` is the live-session signal the phone's triage view keys on. */
export interface BoardTaskWire {
  id: string;
  display_id: number;
  title: string;
  description: string;
  swimlane_id: string;
  position: number;
  agent: string | null;
  session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  base_branch: string | null;
  labels: string[];
  priority: number;
  attachment_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Phone-needed subset of the desktop's BacklogTask row. */
export interface BacklogItemWire {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  item_type: string | null;
  external_url: string | null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
}

// === Diff ===

/** Mirrors the desktop's GitDiffStatus. */
export type DiffFileStatusWire = 'A' | 'M' | 'D' | 'R' | 'C' | 'U';

/** Exact mirror of the desktop's GitDiffFileEntry. */
export interface DiffFileWire {
  path: string;
  status: DiffFileStatusWire;
  insertions: number;
  deletions: number;
  oldPath?: string;
  binary: boolean;
}

/** Exact mirror of the desktop's GitDiffFilesResult - the read-diff file-list response. */
export interface DiffFileListWire {
  files: DiffFileWire[];
  totalInsertions: number;
  totalDeletions: number;
}

/** Exact mirror of the desktop's GitFileContentResult - the read-diff single-file response. */
export interface DiffFileContentWire {
  original: string;
  modified: string;
  language: string;
}

// === Guards (the phone's trust boundary for desktop-originated payloads) ===

const DIFF_FILE_STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'U'];
const TRANSCRIPT_SYSTEM_SUBTYPES: readonly string[] = ['compaction', 'command', 'command_output', 'session_boundary'];

function requireString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${context} is missing a string "${field}"`);
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string, context: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`${context} is missing a number "${field}"`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, context: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`${context} is missing a boolean "${field}"`);
  return value;
}

function isTranscriptBlockWire(value: unknown): value is TranscriptBlockWire {
  if (!isRecord(value)) return false;
  if (value.type === 'text' || value.type === 'thinking') return typeof value.text === 'string';
  if (value.type === 'tool_use') return typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value;
  return false;
}

function isTranscriptEntryWire(value: unknown): value is TranscriptEntryWire {
  if (!isRecord(value)) return false;
  if (typeof value.uuid !== 'string' || typeof value.ts !== 'number') return false;
  switch (value.kind) {
    case 'user':
      return typeof value.text === 'string';
    case 'assistant':
      return Array.isArray(value.blocks) && value.blocks.every(isTranscriptBlockWire);
    case 'tool_result':
      return typeof value.toolUseId === 'string' && typeof value.content === 'string';
    case 'system':
      return typeof value.subtype === 'string' && TRANSCRIPT_SYSTEM_SUBTYPES.includes(value.subtype) && typeof value.text === 'string';
    default:
      return false;
  }
}

/** Narrows a transcript entry array (windowed-history pages). Throws on a malformed entry so the caller can drop the payload. */
export function parseTranscriptEntriesWire(payload: JsonValue): TranscriptEntryWire[] {
  if (!Array.isArray(payload)) throw new Error('transcript payload must be an array of entries');
  return payload.map((entry, index) => {
    if (!isTranscriptEntryWire(entry)) throw new Error(`transcript payload entry ${index} is malformed`);
    return entry;
  });
}

/** Narrows a transcript event's delta/reset payload. Throws on a malformed required field so the caller can drop the push. */
export function parseTranscriptEventPayload(payload: JsonValue): TranscriptEventPayload {
  if (!isRecord(payload)) throw new Error('transcript payload must be an object');
  const revision = requireNumber(payload, 'revision', 'transcript payload');
  const totalEntries = requireNumber(payload, 'totalEntries', 'transcript payload');
  if (!Number.isInteger(revision) || revision < 0) throw new Error('transcript payload has an invalid "revision"');
  if (!Number.isInteger(totalEntries) || totalEntries < 0) throw new Error('transcript payload has an invalid "totalEntries"');

  if (payload.mode === 'reset') return { mode: 'reset', revision, totalEntries };
  if (payload.mode !== 'delta') throw new Error('transcript payload has an invalid "mode"');
  if (!Array.isArray(payload.upserts)) throw new Error('transcript delta is missing "upserts"');
  const upserts = payload.upserts.map((upsert, position): TranscriptUpsertWire => {
    if (!isRecord(upsert) || typeof upsert.index !== 'number' || !Number.isInteger(upsert.index) || upsert.index < 0) {
      throw new Error(`transcript delta upsert ${position} has an invalid "index"`);
    }
    if (!isTranscriptEntryWire(upsert.entry)) throw new Error(`transcript delta upsert ${position} has a malformed "entry"`);
    return { index: upsert.index, entry: upsert.entry };
  });
  return { mode: 'delta', revision, totalEntries, upserts };
}

/** True for a well-formed ActivityStateWire value. */
export function isActivityStateWire(value: unknown): value is ActivityStateWire {
  return value === 'thinking' || value === 'idle' || value === 'permission';
}

/** True for a well-formed ActivityReasonWire value. */
export function isActivityReasonWire(value: unknown): value is ActivityReasonWire {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'idle':
    case 'permission':
    case 'turn-active':
      return true;
    case 'tool':
      return typeof value.pendingCount === 'number' && (value.currentTool === null || typeof value.currentTool === 'string');
    case 'subagent':
      return typeof value.depth === 'number';
    case 'background-shell':
      return typeof value.count === 'number' && Array.isArray(value.ids) && value.ids.every((id) => typeof id === 'string');
    default:
      return false;
  }
}

/** Narrows a usage payload to the SessionUsageWire subset. Throws on a malformed required field. */
export function parseSessionUsageWire(payload: JsonValue): SessionUsageWire {
  if (!isRecord(payload)) throw new Error('usage payload must be an object');
  const contextWindow = payload.contextWindow;
  if (!isRecord(contextWindow)) throw new Error('usage payload is missing "contextWindow"');
  const cost = payload.cost;
  if (!isRecord(cost)) throw new Error('usage payload is missing "cost"');
  const model = payload.model;
  if (!isRecord(model)) throw new Error('usage payload is missing "model"');
  return {
    contextWindow: {
      usedPercentage: requireNumber(contextWindow, 'usedPercentage', 'usage contextWindow'),
      usedTokens: requireNumber(contextWindow, 'usedTokens', 'usage contextWindow'),
      cacheTokens: requireNumber(contextWindow, 'cacheTokens', 'usage contextWindow'),
      totalInputTokens: requireNumber(contextWindow, 'totalInputTokens', 'usage contextWindow'),
      totalOutputTokens: requireNumber(contextWindow, 'totalOutputTokens', 'usage contextWindow'),
      contextWindowSize: requireNumber(contextWindow, 'contextWindowSize', 'usage contextWindow'),
    },
    cost: {
      totalCostUsd: requireNumber(cost, 'totalCostUsd', 'usage cost'),
      totalDurationMs: requireNumber(cost, 'totalDurationMs', 'usage cost'),
    },
    ...(typeof payload.toolCallCount === 'number' ? { toolCallCount: payload.toolCallCount } : {}),
    model: {
      id: requireString(model, 'id', 'usage model'),
      displayName: requireString(model, 'displayName', 'usage model'),
      ...(typeof model.effort === 'string' ? { effort: model.effort } : {}),
    },
  };
}

/** Narrows a session-event payload to SessionEventWire. Throws on a malformed required field. */
export function parseSessionEventWire(payload: JsonValue): SessionEventWire {
  if (!isRecord(payload)) throw new Error('session event payload must be an object');
  return {
    ts: requireNumber(payload, 'ts', 'session event'),
    type: requireString(payload, 'type', 'session event'),
    ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
    ...(typeof payload.toolId === 'string' ? { toolId: payload.toolId } : {}),
    ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
  };
}

function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${context} is not a string array`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function nullableNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

/** Narrows one board-column row. Throws on a malformed required field. */
export function parseBoardColumnWire(value: JsonValue): BoardColumnWire {
  if (!isRecord(value)) throw new Error('board column must be an object');
  return {
    id: requireString(value, 'id', 'board column'),
    name: requireString(value, 'name', 'board column'),
    description: nullableString(value, 'description'),
    role: nullableString(value, 'role'),
    position: requireNumber(value, 'position', 'board column'),
    color: requireString(value, 'color', 'board column'),
    icon: nullableString(value, 'icon'),
    is_archived: requireBoolean(value, 'is_archived', 'board column'),
    is_ghost: requireBoolean(value, 'is_ghost', 'board column'),
  };
}

/** Narrows one board-task row. Throws on a malformed required field. */
export function parseBoardTaskWire(value: JsonValue): BoardTaskWire {
  if (!isRecord(value)) throw new Error('board task must be an object');
  return {
    id: requireString(value, 'id', 'board task'),
    display_id: requireNumber(value, 'display_id', 'board task'),
    title: requireString(value, 'title', 'board task'),
    description: typeof value.description === 'string' ? value.description : '',
    swimlane_id: requireString(value, 'swimlane_id', 'board task'),
    position: requireNumber(value, 'position', 'board task'),
    agent: nullableString(value, 'agent'),
    session_id: nullableString(value, 'session_id'),
    worktree_path: nullableString(value, 'worktree_path'),
    branch_name: nullableString(value, 'branch_name'),
    pr_number: nullableNumber(value, 'pr_number'),
    pr_url: nullableString(value, 'pr_url'),
    pr_state: nullableString(value, 'pr_state'),
    base_branch: nullableString(value, 'base_branch'),
    labels: Array.isArray(value.labels) ? parseStringArray(value.labels, 'board task labels') : [],
    priority: typeof value.priority === 'number' ? value.priority : 0,
    attachment_count: typeof value.attachment_count === 'number' ? value.attachment_count : 0,
    archived_at: nullableString(value, 'archived_at'),
    created_at: requireString(value, 'created_at', 'board task'),
    updated_at: requireString(value, 'updated_at', 'board task'),
  };
}

/** Narrows one backlog-item row. Throws on a malformed required field. */
export function parseBacklogItemWire(value: JsonValue): BacklogItemWire {
  if (!isRecord(value)) throw new Error('backlog item must be an object');
  return {
    id: requireString(value, 'id', 'backlog item'),
    title: requireString(value, 'title', 'backlog item'),
    description: typeof value.description === 'string' ? value.description : '',
    priority: typeof value.priority === 'number' ? value.priority : 0,
    labels: Array.isArray(value.labels) ? parseStringArray(value.labels, 'backlog item labels') : [],
    position: requireNumber(value, 'position', 'backlog item'),
    item_type: nullableString(value, 'item_type'),
    external_url: nullableString(value, 'external_url'),
    attachment_count: typeof value.attachment_count === 'number' ? value.attachment_count : 0,
    created_at: requireString(value, 'created_at', 'backlog item'),
    updated_at: requireString(value, 'updated_at', 'backlog item'),
  };
}

/** Narrows a read-diff file-list payload. Throws on a malformed required field. */
export function parseDiffFileListWire(payload: JsonValue): DiffFileListWire {
  if (!isRecord(payload)) throw new Error('diff file list must be an object');
  if (!Array.isArray(payload.files)) throw new Error('diff file list is missing "files"');
  const files = payload.files.map((file, index) => {
    if (!isRecord(file)) throw new Error(`diff file entry ${index} must be an object`);
    const status = requireString(file, 'status', `diff file entry ${index}`);
    if (!DIFF_FILE_STATUSES.includes(status)) throw new Error(`diff file entry ${index} has an invalid "status"`);
    return {
      path: requireString(file, 'path', `diff file entry ${index}`),
      status: status as DiffFileStatusWire,
      insertions: requireNumber(file, 'insertions', `diff file entry ${index}`),
      deletions: requireNumber(file, 'deletions', `diff file entry ${index}`),
      ...(typeof file.oldPath === 'string' ? { oldPath: file.oldPath } : {}),
      binary: requireBoolean(file, 'binary', `diff file entry ${index}`),
    };
  });
  return {
    files,
    totalInsertions: requireNumber(payload, 'totalInsertions', 'diff file list'),
    totalDeletions: requireNumber(payload, 'totalDeletions', 'diff file list'),
  };
}

/** Narrows a read-diff single-file payload. Throws on a malformed required field. */
export function parseDiffFileContentWire(payload: JsonValue): DiffFileContentWire {
  if (!isRecord(payload)) throw new Error('diff file content must be an object');
  return {
    original: requireString(payload, 'original', 'diff file content'),
    modified: requireString(payload, 'modified', 'diff file content'),
    language: requireString(payload, 'language', 'diff file content'),
  };
}
