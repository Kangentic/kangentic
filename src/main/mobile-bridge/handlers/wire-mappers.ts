/**
 * The one place each @kangentic/protocol wire mirror meets its desktop
 * source shape. Every handler that previously smuggled an app-internal
 * object to the phone via `as unknown as JsonValue` now routes through an
 * explicit mapper here, so a desktop-type change that would break the wire
 * contract surfaces as a compile error in THIS file instead of a silent
 * phone-side parse failure.
 *
 * `toWireJson` is the single envelope-boundary cast: a typed wire payload
 * still needs a JsonValue cast to ride CapabilityResponseMessage.payload
 * (interfaces have no implicit index signature), but by the time it runs,
 * the payload's SHAPE has already been checked against the wire type.
 */
import {
  type ActivityReasonWire,
  type BacklogItemWire,
  type BoardColumnWire,
  type BoardTaskWire,
  type JsonValue,
  type ReadStreamSessionStatusWire,
  type SessionEventWire,
  type SessionSummaryWire,
  type SessionUsageWire,
  type TerminalDimensionsWire,
  type TranscriptBlockWire,
  type TranscriptEntryWire,
} from '@kangentic/protocol';
import { isJsonValue } from '@kangentic/protocol';
import type {
  ActivityReason,
  BacklogTask,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  Swimlane,
  Task,
  TranscriptBlock,
  TranscriptEntry,
} from '../../../shared/types';

/** Envelope-boundary cast for an already-shape-checked wire payload. */
export function toWireJson(payload: unknown): JsonValue {
  return payload as JsonValue;
}

/**
 * SessionManager.getDimensions -> the wire mirror. Undefined (field omitted,
 * not null) when the session has no knowable grid, so a pre-0.4.0 phone's
 * parser never sees the key at all.
 */
export function toTerminalDimensionsWire(dims: { cols: number; rows: number } | null): TerminalDimensionsWire | undefined {
  return dims ? { cols: dims.cols, rows: dims.rows } : undefined;
}

/**
 * SessionStatus -> the wire mirror. The unions are identical today, so
 * this is an identity function whose value is the compile error it raises
 * here (not a silent phone-side parse failure) if either side ever drifts.
 */
export function toReadStreamSessionStatusWire(status: SessionStatus): ReadStreamSessionStatusWire {
  return status;
}

/**
 * JSON-sanitizes a value the wire type declares as JsonValue but the
 * desktop holds as `unknown` (tool_use inputs). Non-JSON values (functions,
 * cycles, undefined) degrade to null rather than poisoning the frame.
 */
function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (isJsonValue(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * A tool_use input above this serialized size ships as a truncated preview
 * marker instead. Transcript text/content spans are already clamped at
 * parse time (transcript-cache MAX_SPAN_CHARS), but tool inputs are
 * deliberately un-clamped there for the desktop viewer - the phone does
 * not need a megabyte Write-file payload inside a prompt card. This clamp
 * plus `clampBlocks` below (which bounds an assistant entry's total block
 * count/size, not just one block's size) together are what let the
 * transcript-sync chunker guarantee its frames stay under the wire cap.
 */
const MAX_TOOL_INPUT_CHARS = 32 * 1024;
const TOOL_INPUT_PREVIEW_CHARS = 2 * 1024;

function clampToolInput(input: JsonValue): JsonValue {
  const serialized = JSON.stringify(input);
  if (serialized.length <= MAX_TOOL_INPUT_CHARS) return input;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, TOOL_INPUT_PREVIEW_CHARS),
  };
}

/**
 * `clampToolInput` bounds a single tool_use input's serialized size, but not
 * how many blocks one assistant entry can carry - an entry with enough
 * blocks (hundreds of small tool_use calls in one turn) can still exceed the
 * wire cap even though every individual block is within budget, and
 * transcript-sync's `chunkUpserts` only splits BETWEEN upserts, never within
 * one entry. Clamp the mapped block list's total serialized size the same
 * way `clampToolInput` clamps a single value, staying comfortably under
 * transcript-sync's DELTA_CHUNK_BUDGET_CHARS (192 KiB) so a clamped entry
 * still fits inside one chunk rather than becoming an oversized singleton.
 * A truncation marker replaces the remainder so the phone can tell the
 * entry was cut, rather than silently receiving a partial one.
 */
export const MAX_ENTRY_BLOCKS_CHARS = 128 * 1024;

function clampBlocks(blocks: TranscriptBlockWire[]): TranscriptBlockWire[] {
  let totalChars = 0;
  const kept: TranscriptBlockWire[] = [];
  for (const block of blocks) {
    const size = JSON.stringify(block).length;
    if (totalChars + size > MAX_ENTRY_BLOCKS_CHARS) {
      kept.push({
        type: 'text',
        text: `[${blocks.length - kept.length} more block(s) omitted: this entry exceeded the per-entry size budget]`,
      });
      return kept;
    }
    totalChars += size;
    kept.push(block);
  }
  return kept;
}

function toTranscriptBlockWire(block: TranscriptBlock): TranscriptBlockWire {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: clampToolInput(asJsonValue(block.input)) };
  }
}

export function toTranscriptEntryWire(entry: TranscriptEntry): TranscriptEntryWire {
  switch (entry.kind) {
    case 'user':
      return { kind: 'user', uuid: entry.uuid, ts: entry.ts, text: entry.text };
    case 'assistant':
      return {
        kind: 'assistant',
        uuid: entry.uuid,
        ts: entry.ts,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.agentName !== undefined ? { agentName: entry.agentName } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
        blocks: clampBlocks(entry.blocks.map(toTranscriptBlockWire)),
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        uuid: entry.uuid,
        ts: entry.ts,
        toolUseId: entry.toolUseId,
        content: entry.content,
        ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
      };
    case 'system':
      return { kind: 'system', uuid: entry.uuid, ts: entry.ts, subtype: entry.subtype, text: entry.text };
  }
}

export function toTranscriptEntriesWire(entries: TranscriptEntry[]): TranscriptEntryWire[] {
  return entries.map(toTranscriptEntryWire);
}

export function toActivityReasonWire(reason: ActivityReason): ActivityReasonWire {
  switch (reason.kind) {
    case 'background-shell':
      return { kind: 'background-shell', count: reason.count, ids: [...reason.ids] };
    default:
      return reason;
  }
}

export function toSessionUsageWire(usage: SessionUsage): SessionUsageWire {
  return {
    contextWindow: {
      usedPercentage: usage.contextWindow.usedPercentage,
      usedTokens: usage.contextWindow.usedTokens,
      cacheTokens: usage.contextWindow.cacheTokens,
      totalInputTokens: usage.contextWindow.totalInputTokens,
      totalOutputTokens: usage.contextWindow.totalOutputTokens,
      contextWindowSize: usage.contextWindow.contextWindowSize,
    },
    cost: {
      totalCostUsd: usage.cost.totalCostUsd,
      totalDurationMs: usage.cost.totalDurationMs,
    },
    ...(usage.toolCallCount !== undefined ? { toolCallCount: usage.toolCallCount } : {}),
    model: {
      id: usage.model.id,
      displayName: usage.model.displayName,
      ...(usage.model.effort !== undefined ? { effort: usage.model.effort } : {}),
    },
  };
}

/**
 * Lifetime session summary for a COMPLETED task. Drops the desktop's
 * `toolBreakdown` (the renderer's per-tool table has no phone counterpart)
 * and keeps everything the phone's summary actually renders.
 */
export function toSessionSummaryWire(summary: SessionSummary): SessionSummaryWire {
  return {
    sessionId: summary.sessionId,
    totalCostUsd: summary.totalCostUsd,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    modelDisplayName: summary.modelDisplayName,
    durationMs: summary.durationMs,
    toolCallCount: summary.toolCallCount,
    compactionCount: summary.compactionCount,
    linesAdded: summary.linesAdded,
    linesRemoved: summary.linesRemoved,
    filesChanged: summary.filesChanged,
    taskCreatedAt: summary.taskCreatedAt,
    startedAt: summary.startedAt,
    exitedAt: summary.exitedAt,
    exitCode: summary.exitCode,
  };
}

export function toSessionEventWire(event: SessionEvent): SessionEventWire {
  return {
    ts: event.ts,
    type: event.type,
    ...(event.tool !== undefined ? { tool: event.tool } : {}),
    ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
}

export function toBoardColumnWire(swimlane: Swimlane): BoardColumnWire {
  return {
    id: swimlane.id,
    name: swimlane.name,
    description: swimlane.description,
    role: swimlane.role,
    position: swimlane.position,
    color: swimlane.color,
    icon: swimlane.icon,
    is_archived: swimlane.is_archived,
    is_ghost: swimlane.is_ghost,
  };
}

export function toBoardTaskWire(task: Task): BoardTaskWire {
  return {
    id: task.id,
    display_id: task.display_id,
    title: task.title,
    description: task.description,
    swimlane_id: task.swimlane_id,
    position: task.position,
    agent: task.agent,
    session_id: task.session_id,
    worktree_path: task.worktree_path,
    branch_name: task.branch_name,
    pr_number: task.pr_number,
    pr_url: task.pr_url,
    pr_state: task.pr_state,
    base_branch: task.base_branch,
    labels: task.labels,
    priority: task.priority,
    attachment_count: task.attachment_count,
    archived_at: task.archived_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export function toBacklogItemWire(item: BacklogTask): BacklogItemWire {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priority: item.priority,
    labels: item.labels,
    position: item.position,
    item_type: item.item_type,
    external_url: item.external_url,
    attachment_count: item.attachment_count,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}
