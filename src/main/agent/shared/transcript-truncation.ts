/**
 * The shared "this transcript was too large to read whole" notice.
 *
 * Every adapter's `parseTranscript` reads a bounded TAIL window rather than the
 * whole file (see `readJsonlWindow`), because materializing an unbounded
 * transcript is what OOM'd the main process on 2026-08-20. The parse has since
 * moved to the `kangentic-retrieval` worker, so the same read would now kill the
 * worker instead: every Conversation window, phone and MCP transcript read fails
 * until it restarts, and after three crashes it stays off. That bound silently
 * removes the oldest turns from whatever the user is looking at, so it must
 * never ship without saying so - a conversation that just starts partway
 * through, with no explanation, reads as data loss or a bug.
 *
 * This lives in `shared/` rather than in one adapter precisely so the notice
 * cannot get left behind: the cap and its explanation are adopted together, by
 * every parser, from one place.
 */

import type { TranscriptEntry } from '../../../shared/types';

/**
 * Largest span of SOURCE bytes any adapter's `parseTranscript` reads. Above
 * this, only the most recent `MAX_PARSE_SOURCE_BYTES` are parsed and
 * `prependTruncationMarker` announces the rest.
 *
 * THIS IS THE BOUND THAT PREVENTS THE OOM, and the reason is the PEAK of a
 * parse, not what it retains. Measured on the real 137.9MB transcript from the
 * crash (`node --expose-gc`, `process.memoryUsage().heapUsed`):
 *
 *   readFile string (UTF-8 -> UTF-16)  275.9 MB   <- the actual cost
 *   retained TranscriptEntry[]          12.7 MB   (0.09x source)
 *
 * So a whole-file parse briefly puts ~276MB on the heap to keep ~13MB. That
 * transient is per-CALL and several were live at once: the two lifetime
 * backfills fire un-awaited and unserialized on every run-ending path, and the
 * conversation indexer sweeps session after session. A handful of concurrent
 * 276MB strings is how a 3.4GB heap happens, and it is why capping the READ
 * matters more here than capping any cache.
 *
 * 16MB of source is roughly 32MB of string. On eight real Claude transcripts of
 * 32MB to 548MB it held 528 to 2,371 entries and peaked at 66 to 70MB of RSS in
 * 40 to 53ms (docs/conversation-history-paging-audit.md). For Claude, the
 * omitted head is still covered by the conversation index, which walks the
 * whole file in windows through `parseTranscriptWindow`. Every other agent's
 * index falls back to this same bounded read, so it stops where this read does.
 *
 * Shared by every adapter deliberately. Claude's transcripts happened to be the
 * biggest on the machine that died, but nothing makes the others structurally
 * safe: assuming a transcript is small because it is small TODAY is exactly the
 * assumption that left this unbounded for months.
 */
export const MAX_PARSE_SOURCE_BYTES = 16 * 1024 * 1024;

let activeMaxParseSourceBytes = MAX_PARSE_SOURCE_BYTES;

/**
 * The cap every `parseTranscript` should pass as `readJsonlWindow`'s
 * `maxBytes`. Read through this function rather than the constant so tests can
 * exercise the truncation path against a few hundred bytes: the alternative is
 * writing a 16MB fixture per adapter, which is slow enough that the truncated
 * path would simply go untested - and it is the path where a parser can
 * silently mis-handle a partial window.
 */
export function parseWindowBytes(): number {
  return activeMaxParseSourceBytes;
}

/** Test-only: shrink the parse cap. Pass no argument to restore the default. */
export function setParseWindowBytesForTests(bytes?: number): void {
  activeMaxParseSourceBytes = bytes ?? MAX_PARSE_SOURCE_BYTES;
}

/** Human-readable byte size for the notice text. */
function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * How to page the history a truncated read left out: the conversation it
 * belongs to (the agent's own session id) and the adapter's cursor for the
 * first surviving entry (`AgentAdapter.readTranscriptPage`).
 */
export interface TruncatedHistory {
  conversationId: string;
  cursor: string;
}

/**
 * Build the in-band `system` entry announcing that `omittedBytes` of older
 * conversation were not read.
 *
 * `firstEntryTs` should be the ts of the oldest SURVIVING entry, so that in a
 * stitched multi-session task view the notice sorts to the head of its OWN
 * session rather than ahead of every earlier session.
 *
 * With `history` (an adapter that can page), the notice carries the cursor the
 * Conversation viewer pages from, and its uuid names the conversation: two
 * sessions of one task that left out the same byte count would otherwise share
 * a uuid, and the stitch keeps only the first of a uuid. Its position stays in
 * the uuid, so a re-read that moves the cut makes a new row instead of keeping
 * a stale cursor. The total is left out of it on purpose: it grows with every
 * append.
 */
export function buildTruncationMarker(
  omittedBytes: number,
  totalBytes: number,
  firstEntryTs: number | undefined,
  history?: TruncatedHistory,
): TranscriptEntry {
  return {
    kind: 'system',
    subtype: 'truncated',
    // Stable across re-parses of the same window, and distinct from any real
    // transcript uuid (those come from the agent's own file).
    uuid: history ? `kangentic-truncated:${history.conversationId}:${omittedBytes}` : `kangentic-truncated:${omittedBytes}`,
    ts: firstEntryTs ?? 0,
    ...(history
      ? { earlierHistory: { conversationId: history.conversationId, cursor: history.cursor, position: omittedBytes } }
      : {}),
    // Deliberately makes NO claim about search coverage. An earlier draft said
    // "Search still covers the full history", which is true only for an agent
    // whose adapter implements `parseTranscriptWindow` (Claude today); for the
    // rest the indexer falls back to this same bounded read, so the index is
    // cut off at the same place the reader is. A notice that overstates what
    // survives is worse than one that just states the omission.
    text: `Earlier ${formatBytes(omittedBytes)} of this conversation are not shown `
      + `(the transcript is ${formatBytes(totalBytes)}).`,
  };
}

/**
 * Prepend the notice to `entries` when a window actually omitted something.
 *
 * The no-omission case is the overwhelmingly common one (most transcripts are
 * far under the cap), and it must stay a no-op so ordinary conversations are
 * untouched.
 */
export function prependTruncationMarker(
  entries: TranscriptEntry[],
  omittedBytes: number,
  totalBytes: number,
  history?: TruncatedHistory,
): TranscriptEntry[] {
  if (omittedBytes <= 0) return entries;
  entries.unshift(buildTruncationMarker(omittedBytes, totalBytes, entries[0]?.ts, history));
  return entries;
}
