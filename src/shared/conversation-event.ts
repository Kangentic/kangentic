/**
 * The normalized, agent-agnostic conversation-event schema and the pure
 * `normalizeTranscript` mapper from the structured `TranscriptEntry[]`.
 *
 * This is the positioning contract for the searchable-conversation-memory work:
 * a single, versioned, serializable event stream that ANY surface can render
 * from - the desktop conversation viewer today, and a future companion / live
 * stream tomorrow. It flattens an assistant turn's blocks into discrete events
 * (message / thinking / tool_call), inlines each tool call's result, and lifts
 * the common file-editing tools into a typed `file_edit` event via the shared
 * shape-based `parseFileEditTool` (so a diff renders the same everywhere).
 *
 * Pure and lossless with respect to display: it never re-reads files or
 * synthesizes content - it only reshapes what the transcript already contains.
 * See `feedback_conversation_viewer_transcript_fidelity` in memory.
 */

import type { TranscriptEntry, TranscriptBlock } from './types';
import { parseFileEditTool, type FileEdit } from './tool-diff';

/** Bump when the event shape changes so a consumer (e.g. a pinned mobile client)
 *  can detect and adapt to an incompatible stream. */
export const CONVERSATION_EVENT_SCHEMA_VERSION = 1;

/** A tool call's inlined outcome (its `tool_result`). */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export type ConversationEvent =
  | { type: 'message'; role: 'user' | 'assistant'; uuid: string; ts: number; text: string }
  | { type: 'thinking'; uuid: string; ts: number; text: string }
  | {
      type: 'tool_call';
      uuid: string;
      ts: number;
      toolId: string;
      name: string;
      input: unknown;
      result: ToolOutcome | null;
    }
  | {
      type: 'file_edit';
      uuid: string;
      ts: number;
      toolId: string;
      name: string;
      edit: FileEdit;
      result: ToolOutcome | null;
    }
  | { type: 'system'; uuid: string; ts: number; subtype: 'compaction' | 'command' | 'command_output' | 'session_boundary'; text: string };

/**
 * Flatten a structured transcript into the normalized event stream. Tool results
 * are inlined onto their owning tool call; a result whose owning `tool_use` is
 * absent from this parse (an orphan, e.g. after a resume) is surfaced as its own
 * `tool_call` event so nothing is silently dropped.
 */
export function normalizeTranscript(entries: TranscriptEntry[]): ConversationEvent[] {
  const resultByToolId = new Map<string, ToolOutcome>();
  const ownedToolIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'tool_result') {
      resultByToolId.set(entry.toolUseId, { content: entry.content, isError: !!entry.isError });
    } else if (entry.kind === 'assistant') {
      for (const block of entry.blocks) {
        if (block.type === 'tool_use') ownedToolIds.add(block.id);
      }
    }
  }

  const events: ConversationEvent[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        events.push({ type: 'message', role: 'user', uuid: entry.uuid, ts: entry.ts, text: entry.text });
        break;
      case 'system':
        events.push({ type: 'system', uuid: entry.uuid, ts: entry.ts, subtype: entry.subtype, text: entry.text });
        break;
      case 'tool_result':
        if (!ownedToolIds.has(entry.toolUseId)) {
          events.push({
            type: 'tool_call',
            uuid: entry.uuid,
            ts: entry.ts,
            toolId: entry.toolUseId,
            name: '(orphan result)',
            input: null,
            result: { content: entry.content, isError: !!entry.isError },
          });
        }
        break;
      case 'assistant':
        for (const block of entry.blocks) {
          const event = normalizeBlock(block, entry.uuid, entry.ts, resultByToolId);
          if (event) events.push(event);
        }
        break;
    }
  }
  return events;
}

function normalizeBlock(
  block: TranscriptBlock,
  uuid: string,
  ts: number,
  resultByToolId: Map<string, ToolOutcome>,
): ConversationEvent | null {
  if (block.type === 'text') {
    // Empty assistant text blocks (common padding around tool calls) add nothing.
    return block.text.trim().length === 0 ? null : { type: 'message', role: 'assistant', uuid, ts, text: block.text };
  }
  if (block.type === 'thinking') {
    return { type: 'thinking', uuid, ts, text: block.text };
  }
  // tool_use: lift a file edit into a typed event, else a generic tool call.
  const result = resultByToolId.get(block.id) ?? null;
  const edit = parseFileEditTool(block.input);
  return edit
    ? { type: 'file_edit', uuid, ts, toolId: block.id, name: block.name, edit, result }
    : { type: 'tool_call', uuid, ts, toolId: block.id, name: block.name, input: block.input, result };
}
