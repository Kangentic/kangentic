/**
 * Pure entry-to-row transformation for the conversation viewer, shared by
 * scrolling, in-viewer search, and the open-at-position TUI-anchor match.
 *
 * A `DisplayRow` folds a tool_result into its owning tool_use card (moved
 * here from ConversationView's inline memos) and additionally carries:
 *   - `results`: a ROW-SCOPED map (only this row's own tool_use ids), not the
 *     whole-transcript map. This is what lets `MemoConversationRow`'s default
 *     shallow-compare bail during a live-poll tick that only changed a
 *     DIFFERENT row's tool result - passing the shared whole-transcript map
 *     busts every row's memo on every append.
 *   - `estimatedHeight`: precomputed here (not in the virtualizer's
 *     `estimateSize`) so it can be text-length-aware instead of a flat
 *     constant, cutting scrollbar jump and imprecise `scrollToIndex`.
 *   - `searchText` / `searchSegments`: a lexical index for the in-viewer
 *     search bar and the TUI-anchor match, with enough structure to
 *     auto-expand a folded card when a hit lands inside it.
 *
 * `reconcileDisplayRows` reuses a previous row's object reference (identity)
 * whenever its uuid and a cheap content signature both match, which is what
 * lets `MemoConversationRow` skip re-rendering (and re-parsing markdown) for
 * every row a live-poll tick did not actually change - only a genuinely new
 * or changed row gets a new object.
 */

import type { TranscriptEntry } from '../../../shared/types';
import { buildResultsByUseId } from '../../../shared/transcript-format';
import { sanitizeTranscriptText } from '../../../shared/ansi-strip';

export interface DisplayRowResult {
  content: string;
  isError: boolean;
}

/** A span of `searchText` that came from a specific renderable part of the
 *  row. `expandKey` is the same key `ConversationView`'s `expandedKeys` set
 *  uses for that part (a tool_use id, an orphan `orphan:<uuid>` key, or a
 *  thinking-block `<uuid>:think:<index>` key) - `null` for text that is
 *  always visible (a user turn, a system divider, an assistant text block),
 *  so a hit there needs no auto-expand. */
export interface SearchSegment {
  start: number;
  end: number;
  expandKey: string | null;
}

export interface DisplayRow {
  /** The TranscriptEntry uuid; used as the React key AND the scroll-to target. */
  uuid: string;
  entry: TranscriptEntry;
  /** This row's own tool_use results only (see file doc comment). */
  results: Map<string, DisplayRowResult>;
  estimatedHeight: number;
  searchText: string;
  searchSegments: SearchSegment[];
  /** Cheap content fingerprint used only by `reconcileDisplayRows` to decide
   *  whether a previous row object can be reused. Not meant to be read by
   *  renderer code. */
  signature: string;
}

/** A user turn that is nothing but a slash-command invocation (e.g.
 *  "/code-review", "/model opus"). Requires whitespace/end after the command
 *  word so a path like "/usr/bin/foo" is not mistaken for a command. */
export function isSlashCommandRow(entry: TranscriptEntry): boolean {
  return entry.kind === 'user' && /^\/[a-zA-Z][\w-]*(?:\s|$)/.test(entry.text.trim());
}

/** Classifies an entry's speaker for the row box color / system divider. */
export function speakerGroup(entry: TranscriptEntry): 'user' | 'agent' | 'tool' | 'system' {
  switch (entry.kind) {
    case 'user':
      return 'user';
    case 'system':
      return 'system';
    case 'tool_result':
      return 'tool';
    default:
      return 'agent';
  }
}

const MAX_SEARCH_TEXT_CHARS = 16_000;

const BASE_HEIGHT = 56;
const LINE_HEIGHT = 20;
const TOOL_CARD_HEIGHT = 34;
const THINKING_TOGGLE_HEIGHT = 24;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 900;
/** Rough characters-per-wrapped-line at the viewer's default width, used only
 *  to estimate row height before the real DOM measurement lands. */
const CHARS_PER_LINE = 80;

function estimateTextLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
  }
  return lines;
}

function summarizeToolInputForSearch(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function estimateRowHeight(entry: TranscriptEntry): number {
  let height = BASE_HEIGHT;
  switch (entry.kind) {
    case 'user':
    case 'system':
      height += estimateTextLines(entry.text) * LINE_HEIGHT;
      break;
    case 'tool_result':
      height += TOOL_CARD_HEIGHT;
      break;
    case 'assistant':
      for (const block of entry.blocks) {
        if (block.type === 'text') {
          height += estimateTextLines(block.text) * LINE_HEIGHT;
        } else if (block.type === 'thinking') {
          height += THINKING_TOGGLE_HEIGHT;
        } else {
          height += TOOL_CARD_HEIGHT;
        }
      }
      break;
  }
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
}

interface SearchIndexBuilder {
  parts: string[];
  segments: SearchSegment[];
  offset: number;
}

function appendSegment(builder: SearchIndexBuilder, text: string, expandKey: string | null): void {
  if (text.length === 0) return;
  if (builder.offset > 0) {
    builder.parts.push(' ');
    builder.offset += 1;
  }
  if (builder.offset >= MAX_SEARCH_TEXT_CHARS) return;
  const remaining = MAX_SEARCH_TEXT_CHARS - builder.offset;
  const clipped = text.length > remaining ? text.slice(0, remaining) : text;
  const start = builder.offset;
  builder.parts.push(clipped);
  builder.offset += clipped.length;
  builder.segments.push({ start, end: builder.offset, expandKey });
}

function buildSearchIndex(
  entry: TranscriptEntry,
  results: Map<string, DisplayRowResult>,
): { searchText: string; searchSegments: SearchSegment[] } {
  const builder: SearchIndexBuilder = { parts: [], segments: [], offset: 0 };

  switch (entry.kind) {
    case 'user':
      appendSegment(builder, sanitizeTranscriptText(entry.text), null);
      break;
    case 'system':
      appendSegment(builder, sanitizeTranscriptText(entry.text), null);
      break;
    case 'tool_result':
      appendSegment(builder, sanitizeTranscriptText(entry.content), `orphan:${entry.uuid}`);
      break;
    case 'assistant':
      entry.blocks.forEach((block, index) => {
        if (block.type === 'text') {
          appendSegment(builder, sanitizeTranscriptText(block.text), null);
        } else if (block.type === 'thinking') {
          appendSegment(builder, sanitizeTranscriptText(block.text), `${entry.uuid}:think:${index}`);
        } else {
          appendSegment(builder, block.name, block.id);
          appendSegment(builder, summarizeToolInputForSearch(block.input), block.id);
          const result = results.get(block.id);
          if (result) appendSegment(builder, sanitizeTranscriptText(result.content), block.id);
        }
      });
      break;
  }

  return { searchText: builder.parts.join(''), searchSegments: builder.segments };
}

/** Cheap content fingerprint: everything a row RENDERS, so a change to any of
 *  it (including a late tool_result landing on this row, or the stamped
 *  agentName) busts reuse - but nothing else (e.g. scroll position) does. */
function computeSignature(entry: TranscriptEntry, results: Map<string, DisplayRowResult>): string {
  const parts: string[] = [entry.kind, String(entry.ts)];
  switch (entry.kind) {
    case 'user':
      parts.push(String(entry.text.length));
      break;
    case 'system':
      parts.push(entry.subtype, String(entry.text.length));
      break;
    case 'tool_result':
      parts.push(entry.toolUseId, String(entry.content.length), entry.isError ? '1' : '0');
      break;
    case 'assistant':
      parts.push(entry.model ?? '', entry.agentName ?? '');
      for (const block of entry.blocks) {
        if (block.type === 'tool_use') {
          const result = results.get(block.id);
          parts.push(
            `tool:${block.id}:${block.name}:${summarizeToolInputForSearch(block.input).length}`
            + (result ? `:${result.content.length}:${result.isError ? '1' : '0'}` : ':none'),
          );
        } else {
          parts.push(`${block.type}:${block.text.length}`);
        }
      }
      break;
  }
  return parts.join('|');
}

/** This entry's own tool_use results, scoped out of the whole-transcript
 *  `resultsByUseId` map (see the file doc comment for why row-scoping is the
 *  memo-bail win). */
function rowResultsFor(entry: TranscriptEntry, resultsByUseId: Map<string, DisplayRowResult>): Map<string, DisplayRowResult> {
  const results = new Map<string, DisplayRowResult>();
  if (entry.kind === 'assistant') {
    for (const block of entry.blocks) {
      if (block.type !== 'tool_use') continue;
      const result = resultsByUseId.get(block.id);
      if (result) results.set(block.id, result);
    }
  }
  return results;
}

function buildRow(entry: TranscriptEntry, results: Map<string, DisplayRowResult>): DisplayRow {
  const signature = computeSignature(entry, results);
  const { searchText, searchSegments } = buildSearchIndex(entry, results);
  return {
    uuid: entry.uuid,
    entry,
    results,
    estimatedHeight: estimateRowHeight(entry),
    searchText,
    searchSegments,
    signature,
  };
}

/**
 * Fold `entries` into display rows, reusing a previous row's OBJECT
 * REFERENCE whenever its uuid and content signature both match a row from
 * `previousRows`. A tool_result entry whose owning tool_use appeared in an
 * assistant turn is folded into that turn's row (not emitted as its own
 * row); an unowned one (e.g. after a resume) renders standalone.
 */
export function reconcileDisplayRows(previousRows: DisplayRow[], entries: TranscriptEntry[]): DisplayRow[] {
  const previousByUuid = new Map<string, DisplayRow>();
  for (const row of previousRows) previousByUuid.set(row.uuid, row);

  const resultsByUseId = buildResultsByUseId(entries);

  const ownedToolUseIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') ownedToolUseIds.add(block.id);
    }
  }

  const rows: DisplayRow[] = [];
  // Defense in depth: the uuid is the React key AND the virtualizer's
  // measurement-cache key, so a duplicate collapses reconciliation (stale
  // rows pile up, boxes overlap). resolveTaskTranscript already dedups the
  // stitched multi-session timeline, but guard here too so no upstream
  // source (a resume replay, an index-fallback collision) can ever break
  // the render.
  const seenUuids = new Set<string>();
  for (const entry of entries) {
    if (
      entry.kind === 'tool_result'
      && entry.toolUseId
      && ownedToolUseIds.has(entry.toolUseId)
    ) {
      continue; // folded into its owning tool_use card
    }
    if (seenUuids.has(entry.uuid)) continue;
    seenUuids.add(entry.uuid);

    const previous = previousByUuid.get(entry.uuid);
    // Always compute against the CURRENT resultsByUseId - entry-reference
    // equality alone is not enough to prove a row is unchanged, since an
    // assistant entry's folded results come from a SEPARATE tool_result
    // entry elsewhere in the array; that tool_result landing (or changing)
    // must still bust this row even though the assistant entry object itself
    // never changed.
    const currentResults = rowResultsFor(entry, resultsByUseId);
    const candidateSignature = computeSignature(entry, currentResults);
    if (previous && previous.signature === candidateSignature) {
      rows.push(previous);
      continue;
    }
    rows.push(buildRow(entry, currentResults));
  }
  return rows;
}
