import fs from 'node:fs';
import type { TranscriptEntry, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { capToNewestEntries } from '../../shared/transcript-truncation';
import { mapGooseRows, tallyToolRows, toolCountsOf, type GooseMessageRow } from './transcript-parser';

/**
 * A conversation on an SSH host, read from the copy of its `goose session export --format json` on this
 * computer. The host keeps it in a database every session shares, so Goose's own export is what crosses the
 * link (`RemoteSessionRelay`), and it lands here as one file, whole.
 *
 * Measured on a real Goose 1.57.0 (`docs/audits/ssh-transcript-exports-audit.md`): one document with the
 * session row's fields, and `conversation`, an array of `{ id, role, created, content, metadata }`. `content`
 * and `metadata` are what the database holds as `content_json` and `metadata_json`, and `created` is its
 * `created_timestamp`, so each message becomes a row and every reader of rows reads it unchanged. A row's id is
 * the message's place: an export has no row ids, and `goose:<place>` is stable while a conversation only grows.
 *
 * Totals are always of the whole file. An export is replaced, never appended to.
 */
export interface GooseExport {
  rows: GooseMessageRow[];
  model: string | null;
  usage: TranscriptUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A session's lifetime tokens: `accumulated_usage`, else its latest turn's, as the database reader falls back. */
function lifetimeUsage(document: Record<string, unknown>): TranscriptUsage | null {
  const accumulated = isRecord(document.accumulated_usage) ? document.accumulated_usage : {};
  const latest = isRecord(document.usage) ? document.usage : {};
  const inputTokens = numberOrNull(accumulated.input_tokens) ?? numberOrNull(latest.input_tokens);
  const outputTokens = numberOrNull(accumulated.output_tokens) ?? numberOrNull(latest.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

/** An export's text as rows, or null for anything that is not one. */
export function parseGooseExport(text: string): GooseExport | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(document) || !Array.isArray(document.conversation)) return null;
  const rows = document.conversation.flatMap((message, index): GooseMessageRow[] => {
    if (!isRecord(message) || typeof message.role !== 'string') return [];
    return [{
      id: index + 1,
      role: message.role,
      content_json: JSON.stringify(message.content ?? []),
      created_timestamp: numberOrNull(message.created) ?? 0,
      metadata_json: isRecord(message.metadata) ? JSON.stringify(message.metadata) : null,
    }];
  });
  const modelConfig = isRecord(document.model_config) ? document.model_config : {};
  return {
    rows,
    model: typeof modelConfig.model_name === 'string' && modelConfig.model_name.length > 0 ? modelConfig.model_name : null,
    usage: lifetimeUsage(document),
  };
}

/** The export in a copy, or null for one that has not arrived or cannot be read. Never proof of anything. */
export function readGooseExportFile(filePath: string): GooseExport | null {
  try {
    return parseGooseExport(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** The conversation, bounded as a tail is. An export has no pager behind it. */
export function gooseExportEntries(exported: GooseExport): TranscriptEntry[] {
  return capToNewestEntries(mapGooseRows(exported.rows, { model: exported.model }));
}

export function gooseExportToolCounts(exported: GooseExport, sinceMs: number | null, untilMs: number | null): TranscriptToolCounts | null {
  return toolCountsOf(tallyToolRows(exported.rows, sinceMs, untilMs));
}

export function gooseExportToolResultTokens(exported: GooseExport, sinceMs: number | null, untilMs: number | null): Record<string, number> {
  return Object.fromEntries(tallyToolRows(exported.rows, sinceMs, untilMs).resultTokensByTool);
}
