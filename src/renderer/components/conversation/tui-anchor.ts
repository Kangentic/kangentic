/**
 * Pure matcher: given the terminal's visible scrollback lines at the moment
 * the user opened the conversation viewer, find which display row that
 * viewport was showing, so the viewer can open centered on it instead of
 * always at the bottom. Deliberately simple - exact substring matching on a
 * handful of center lines, no fuzzy scoring, no proportional position
 * mapping (a TUI's rendering does not correspond 1:1 with transcript byte
 * position, so a proportional guess would frequently be wrong).
 */

import type { DisplayRow } from './display-rows';

/** The sample window scales with the CAPTURED terminal's own row count
 *  (`visibleLines.length`), not a fixed line count - the task-detail
 *  terminal and a docked bottom-panel terminal are routinely different
 *  heights, and a fixed sample would be most of a short terminal's viewport
 *  but a narrow, unrepresentative sliver of a tall one. */
const CENTER_SAMPLE_FRACTION = 0.3;
const CENTER_SAMPLE_MIN = 6;
const CENTER_SAMPLE_MAX = 20;
const MIN_NORMALIZED_LINE_LENGTH = 16;

/** Sample window size for a terminal with this many visible lines - a
 *  fraction of the viewport, clamped to [min, max] and to the viewport's own
 *  line count (never larger than what was actually captured). */
function sampleSizeFor(visibleLineCount: number): number {
  const scaled = Math.round(visibleLineCount * CENTER_SAMPLE_FRACTION);
  const clamped = Math.max(CENTER_SAMPLE_MIN, Math.min(CENTER_SAMPLE_MAX, scaled));
  return Math.min(visibleLineCount, clamped);
}

/** Lowercase, collapse everything non-alphanumeric to single spaces, trim.
 *  Strips ANSI-adjacent box-drawing/padding noise and makes whitespace
 *  differences between the TUI's rendering and the transcript's stored text
 *  (wrapping, indentation) irrelevant to the match. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Returns the uuid of the row whose `searchText` best contains the terminal's
 * visible-center lines, or `null` when nothing scores (too little signal in
 * the sampled lines, or no row contains any of them). Ties break toward the
 * LATEST row, since a TUI's visible scrollback most often reflects the most
 * recent occurrence of repeated text (e.g. the same tool run twice).
 */
export function matchTuiViewportToRow(visibleLines: string[], rows: DisplayRow[]): string | null {
  if (visibleLines.length === 0 || rows.length === 0) return null;

  // Sample lines around the viewport's vertical center: the top/bottom edges
  // of a captured viewport are more likely truncated or boundary artifacts,
  // and centering the sample keeps the matched turn roughly centered too,
  // matching how the caller then scrolls to it. The sample size itself scales
  // with THIS capture's own line count (sampleSizeFor), since the terminal
  // panel that was captured (task-detail dialog vs. docked bottom panel) can
  // be a very different height from capture to capture.
  const sampleSize = sampleSizeFor(visibleLines.length);
  const center = Math.floor(visibleLines.length / 2);
  const half = Math.floor(sampleSize / 2);
  const start = Math.max(0, Math.min(Math.max(0, visibleLines.length - sampleSize), center - half));
  const sampleLines = visibleLines.slice(start, start + sampleSize);

  const normalizedLines = sampleLines
    .map(normalizeForMatch)
    .filter((line) => line.length >= MIN_NORMALIZED_LINE_LENGTH);
  if (normalizedLines.length === 0) return null;

  let bestUuid: string | null = null;
  let bestScore = 0;

  for (const row of rows) {
    const normalizedSearchText = normalizeForMatch(row.searchText);
    if (normalizedSearchText.length === 0) continue;
    let score = 0;
    for (const line of normalizedLines) {
      if (normalizedSearchText.includes(line)) score += 1;
    }
    if (score === 0) continue;
    // >= (not >) so a later row with an equal score wins the tie-break.
    if (score >= bestScore) {
      bestScore = score;
      bestUuid = row.uuid;
    }
  }

  return bestUuid;
}
