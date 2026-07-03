// Pure detection and extraction of "special text blocks" (quote blocks and
// shaded code/content boxes) from a terminal buffer, so their content can be
// copied without the CLI's visual decoration (the left quote bar and the
// leading indentation the agent paints in front of quoted / boxed text).
//
// This module is intentionally DOM-free and does not import any runtime value
// from '@xterm/xterm', so it can be unit-tested under vitest (Node, no jsdom)
// by feeding a synthetic BlockLineSource. The live bridge that adapts a real
// xterm IBuffer to this interface lives in `terminal-block-buffer.ts`.
//
// Detection is a GENERIC VISUAL heuristic (glyph class + non-default cell
// attributes), never keyed to an agent name or to specific RGB values, per
// `.claude/rules/agent-adapters-boundary.md`. Color keys are opaque strings
// compared only for equality WITHIN a candidate block, never matched against a
// hardcoded constant.
//
// Empirical basis (captured from live Claude Code v2.1.198 by reconstructing the
// interpreted xterm buffer from raw scrollback):
//   - Quote lines paint a left bar glyph (U+258E "▎") as the first non-space
//     cell with a non-default RGB foreground, repeated per row.
//   - Boxed content paints an identical non-default RGB background across a run
//     of consecutive cells (observed full-width, starting near column 0-3).
//   - `getSelectionPosition()` returns a half-open range: end.x is EXCLUSIVE
//     (a 3-char selection at column 2 reports start.x=2, end.x=5).

/** Facts about one buffer row, produced by an adapter (real IBuffer or a test fake). */
export interface BlockLineFacts {
  /** True when this row is a soft-wrap continuation of the previous row. */
  readonly isWrapped: boolean;
  /**
   * Present when the first non-space cell is a left-bar glyph painted with a
   * non-default foreground (a quote-decorated line).
   */
  readonly quoteBar: { readonly column: number; readonly fgKey: string } | null;
  /**
   * The first qualifying run of consecutive cells sharing an identical
   * non-default background color. `endColumn` is EXCLUSIVE.
   */
  readonly bgRun: { readonly key: string; readonly startColumn: number; readonly endColumn: number } | null;
  /**
   * True when the row has at least one non-space cell painted in the DEFAULT
   * foreground (i.e. real body text). A row rendered entirely in a non-default
   * foreground is a de-emphasized status / "thinking" line, not message content.
   */
  readonly hasDefaultFg: boolean;
  /**
   * The row text between buffer columns [startColumn, endColumn) (endColumn
   * exclusive), wide-character safe. The adapter delegates to
   * `IBufferLine.translateToString`; test fakes slice a plain string.
   */
  text(startColumn?: number, endColumn?: number): string;
}

/** A source of classified buffer rows. */
export interface BlockLineSource {
  /** Total buffer lines (scrollback + viewport). */
  readonly length: number;
  /** Terminal width in columns. */
  readonly cols: number;
  /**
   * Absolute buffer row of the live cursor (`baseY + cursorY`), when known. Used
   * to locate the live interactive-prompt region (a widget the user is answering,
   * painted at / around the cursor at the bottom of the viewport) so it is never
   * offered as copyable output. Undefined when the adapter cannot supply it (a
   * test fake, or a partial buffer with no finite cursor position).
   */
  readonly cursorRow?: number;
  getLine(y: number): BlockLineFacts | undefined;
}

export type BlockKind = 'quote' | 'box' | 'text' | 'message';

export interface BlockRange {
  readonly kind: BlockKind;
  readonly startY: number;
  readonly endY: number;
  /** Set for quote blocks: the buffer column of the bar glyph. */
  readonly barColumn?: number;
}

/** A half-open selection range as reported by xterm's `getSelectionPosition()` (end.x exclusive). */
export interface SelectionRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/**
 * Left block-element bar glyphs (U+258F..U+2589) used as quote / emphasis bars.
 * Box-drawing verticals (U+2502 "│", U+2503 "┃") are DELIBERATELY EXCLUDED: they
 * form box borders, so including them would mis-detect a box sidewall as a quote.
 */
export const BAR_GLYPHS: ReadonlySet<string> = new Set(['▏', '▎', '▍', '▌', '▋', '▊', '▉']);

/** A background run must span at least this many cells to count as a shaded box. */
export const MIN_BOX_RUN_CELLS = 6;

/** A background run must start at or before this column to count as a shaded box. */
export const MAX_BOX_RUN_START_COLUMN = 8;

/**
 * Leading marker glyphs stripped from the first line of a block: list bullets and
 * the CLI prompt marker (`❯`). A copied message / list item / prompt loses its
 * marker. Restricted to these glyphs (not ASCII `-` / `*` / `>`) so a line of
 * prose or code that happens to start with a dash or angle bracket is never altered.
 */
export const LEADING_MARKER_GLYPHS: ReadonlySet<string> = new Set(['•', '‣', '◦', '▪', '▫', '·', '●', '∙', '❯']);

// Agent-TUI marker glyphs (Claude Code and similar CLIs). Detected as generic
// visual markers (like the quote bar and list bullets), not by agent name.
/** Bullet that starts an assistant message or tool call (e.g. "● Update(README.md)"). */
const MESSAGE_BULLET = '●';
/** Prompt marker that starts a user input line (a shaded box). */
const PROMPT_GLYPH = '❯';
/** Star / spinner glyphs that lead a de-emphasized "thinking" status line ("✻ Cogitated for 16s"). */
const THINKING_GLYPHS: ReadonlySet<string> = new Set(['✻', '✽', '✶', '✳', '✢', '✷', '✴', '✵', '❋', '✱', '✲', '✦', '✧', '⏺']);
/**
 * Checkbox glyphs an interactive prompt paints for each tab / option
 * (U+2610 "☐" unchecked, U+2611 "☑" checked).
 */
const PROMPT_CHECKBOX_GLYPHS: ReadonlySet<string> = new Set(['☐', '☑']);
/** Confirm glyphs (a "✓ Submit" tab, or a selected-checkbox variant). */
const PROMPT_CHECK_GLYPHS: ReadonlySet<string> = new Set(['✓', '✔']);

/** The first non-space glyph of a materialized row string, or '' when blank. */
function firstGlyphOf(text: string): string {
  return text.replace(/^\s+/, '').charAt(0);
}

/** The first non-space glyph of a row, or '' when blank. */
function firstGlyph(line: BlockLineFacts | undefined): string {
  if (!line) return '';
  return firstGlyphOf(line.text());
}

/**
 * True when a materialized row string looks like an interactive prompt's
 * tab-header / submit bar (Claude Code's AskUserQuestion widget paints
 * "☐ Tab A  ☐ Tab B  ✓ Submit"). A generic glyph pattern, not an agent name:
 * at least two checkbox glyphs, OR at least one checkbox plus a confirm glyph.
 * A single checkbox (a TodoWrite line "☐ fix tests" echoed in the transcript,
 * or a lone rendered checkbox) is NOT a header, so it never suppresses copy; a
 * "✓ ... ✓" row (vitest output, a checkmark table) is not a header either.
 */
function isTabHeaderText(text: string): boolean {
  let checkboxes = 0;
  let checks = 0;
  for (const glyph of text) {
    if (PROMPT_CHECKBOX_GLYPHS.has(glyph)) checkboxes += 1;
    else if (PROMPT_CHECK_GLYPHS.has(glyph)) checks += 1;
  }
  return checkboxes >= 2 || (checkboxes >= 1 && checks >= 1);
}

/** Row-level wrapper of {@link isTabHeaderText}. */
function isTabHeaderRow(line: BlockLineFacts | undefined): boolean {
  return !!line && isTabHeaderText(line.text());
}

function isThinkingRow(line: BlockLineFacts | undefined): boolean {
  return THINKING_GLYPHS.has(firstGlyph(line));
}

/** A row that bounds a message block: the next message's bullet, a thinking line, a user prompt, or a prompt tab-header. */
function isMessageBoundary(line: BlockLineFacts | undefined): boolean {
  if (!line) return false;
  const text = line.text();
  const glyph = firstGlyphOf(text);
  if (glyph === MESSAGE_BULLET || glyph === PROMPT_GLYPH || THINKING_GLYPHS.has(glyph)) return true;
  return isTabHeaderText(text);
}

/**
 * How far a message-start scan looks back before giving up. `findBlockAt` calls
 * `findMessageStart` unconditionally, so an uncapped scan is O(scrollback) on
 * every hit test for any terminal with no bullet / boundary glyph above the hit
 * row - a plain shell (the Command Terminal) or a hover deep inside one very
 * large message - and that cost lands on the render-thread critical path (hover
 * moves and up to ~60/sec streaming-refresh redraws). A message whose bullet
 * sits more than this many rows above the hit row is simply not recognized as a
 * single block (it degrades to a text / box / quote block), an acceptable trade.
 */
export const MAX_MESSAGE_LOOKBACK_ROWS = 500;

/**
 * How far up from the cursor the live-prompt-region scan looks for a tab-header
 * seed. A widget taller than this (a long wrapped question plus many options)
 * simply is not recognized by the cursor path; the glyph-boundary fallback in
 * `isMessageBoundary` / `findMessageStart` still stops message absorption.
 */
export const PROMPT_REGION_LOOKBACK_ROWS = 40;

/**
 * A run of more than this many consecutive blank rows ends a message / text
 * block's expansion. Bounds the block against a screenful of blank rows that a
 * live TUI transiently paints (a spinner boundary that vanishes mid-repaint),
 * which would otherwise frame a giant empty region.
 */
export const MAX_MESSAGE_INTERIOR_BLANK_ROWS = 4;

/** Scan up from a row to the bullet that owns it, stopping at a thinking line, a user prompt, a prompt tab-header, or the lookback limit. */
function findMessageStart(source: BlockLineSource, y: number): number | null {
  const limit = Math.max(0, y - MAX_MESSAGE_LOOKBACK_ROWS);
  for (let currentRow = y; currentRow >= limit; currentRow -= 1) {
    const line = source.getLine(currentRow);
    const text = line ? line.text() : '';
    const glyph = firstGlyphOf(text);
    if (glyph === MESSAGE_BULLET) return currentRow;
    if (glyph === PROMPT_GLYPH || THINKING_GLYPHS.has(glyph)) return null;
    if (isTabHeaderText(text)) return null;
  }
  return null;
}

/**
 * Find the top row of the live interactive-prompt region (the widget the user is
 * currently answering, painted at / around the cursor), or null when there is no
 * cursor info or no header within the lookback. Scans UP from the cursor row for
 * the topmost tab-header seed, stopping at a message bullet or a thinking line.
 *
 * The stop set is deliberately narrower than {@link isMessageBoundary}: it
 * excludes the prompt glyph `❯`, because the widget's own selected-option row
 * starts with `❯` and sits between the cursor and the header, so stopping there
 * would never reach the header. Every row at or below the returned top is the
 * live widget and must not be offered as copyable output.
 */
export function findPromptRegionTop(source: BlockLineSource): number | null {
  const cursorRow = source.cursorRow;
  if (cursorRow == null || !Number.isFinite(cursorRow)) return null;
  const start = Math.min(cursorRow, source.length - 1);
  const limit = Math.max(0, start - PROMPT_REGION_LOOKBACK_ROWS);
  let seedRow: number | null = null;
  for (let currentRow = start; currentRow >= limit; currentRow -= 1) {
    const line = source.getLine(currentRow);
    const text = line ? line.text() : '';
    const glyph = firstGlyphOf(text);
    if (glyph === MESSAGE_BULLET || THINKING_GLYPHS.has(glyph)) break;
    if (isTabHeaderText(text)) seedRow = currentRow;
  }
  return seedRow;
}

function isBlankRow(line: BlockLineFacts | undefined): boolean {
  return !line || line.text().trim() === '';
}

function isDecoratedRow(line: BlockLineFacts | undefined): boolean {
  return !!line && (!!line.quoteBar || !!line.bgRun);
}

/**
 * A primary text-content row: non-blank, undecorated, with real default-fg text.
 * A de-emphasized status / "thinking" line (undecorated but rendered entirely in
 * a non-default foreground) fails this test, so it is never copyable and always
 * bounds a text message rather than merging into it.
 */
function isContentRow(line: BlockLineFacts | undefined): boolean {
  return !!line && !isBlankRow(line) && !isDecoratedRow(line) && line.hasDefaultFg;
}

/** A row that may be absorbed into a text message (content, or an interior blank). */
function isMergeableRow(line: BlockLineFacts | undefined): boolean {
  return isContentRow(line) || isBlankRow(line);
}

/**
 * Given a buffer row, find the special block that contains it (expanding up and
 * down to the block's bounds), or null when the row is not inside a block.
 *
 * Quote blocks expand while neighbor rows share the same bar column AND fg color.
 * Box blocks expand while neighbor rows share the same background color key and
 * their column runs overlap (so two vertically stacked but distinct boxes that
 * happen to share a color do not merge).
 */
export function findBlockAt(source: BlockLineSource, y: number): BlockRange | null {
  const line = source.getLine(y);
  if (!line) return null;

  // Thinking / status lines ("✻ Cogitated for 16s") are not copyable.
  if (isThinkingRow(line)) return null;

  // A live interactive prompt (an AskUserQuestion widget: tab header, question,
  // options, hint) is not output the user copies - it is a form they are
  // answering. Every row at or below the region top is suppressed, so no hover
  // highlight, click-to-copy, or right-click "Copy Block" ever lands on an option
  // row, the question text, the shaded selection, or the tab header.
  const regionTop = findPromptRegionTop(source);
  if (regionTop != null && y >= regionTop) return null;

  // A tab-header row is itself never copyable, even when the cursor-anchored
  // region is unavailable (its active tab's default-fg label would otherwise pass
  // isContentRow and become a one-row text block).
  if (isTabHeaderRow(line)) return null;

  // The region top (when known) is an exclusive ceiling on downward expansion (the last
  // row a block may include): no block may grow into the live widget. Without a region it
  // is the buffer end.
  const downLimit = regionTop != null ? regionTop - 1 : source.length - 1;

  // Message / tool block, delimited by "●" bullets. A block runs from its bullet
  // down to (but not including) the next bullet, a thinking line, a user prompt,
  // or a prompt tab-header - so the bullet's sub-lines ("Searched...", "⎿ Added 1
  // line") and any code / diff it emitted stay in the same block. Takes precedence
  // over the box / quote / text paths so a code block inside a message is not split
  // out. A run of > MAX_MESSAGE_INTERIOR_BLANK_ROWS blank rows also ends the block,
  // so a transiently-vanishing boundary during a live repaint cannot make the block
  // swallow a screenful of blank rows.
  const messageStart = findMessageStart(source, y);
  if (messageStart != null) {
    const endY = expandDown(source, messageStart, downLimit, (next) => !isMessageBoundary(next));
    // If the trimmed block ends above the hover row (a blank gulf or trailing
    // blanks moved endY up), the pointer is not inside this message - fall through
    // to the other classifiers, which return null for the blank gulf and the muted
    // tip row below it. This is what neutralizes the "giant empty region".
    if (y <= endY) return { kind: 'message', startY: messageStart, endY };
  }

  if (line.quoteBar) {
    const { column, fgKey } = line.quoteBar;
    let startY = y;
    let endY = y;
    while (startY - 1 >= 0) {
      const previous = source.getLine(startY - 1);
      if (previous?.quoteBar && previous.quoteBar.column === column && previous.quoteBar.fgKey === fgKey) {
        startY -= 1;
      } else {
        break;
      }
    }
    while (endY + 1 <= downLimit) {
      const next = source.getLine(endY + 1);
      if (next?.quoteBar && next.quoteBar.column === column && next.quoteBar.fgKey === fgKey) {
        endY += 1;
      } else {
        break;
      }
    }
    return { kind: 'quote', startY, endY, barColumn: column };
  }

  if (line.bgRun) {
    let startY = y;
    let endY = y;
    while (startY - 1 >= 0) {
      const previous = source.getLine(startY - 1);
      const current = source.getLine(startY);
      if (previous?.bgRun && current?.bgRun && bgRunsContinue(previous.bgRun, current.bgRun)) {
        startY -= 1;
      } else {
        break;
      }
    }
    while (endY + 1 <= downLimit) {
      const next = source.getLine(endY + 1);
      const current = source.getLine(endY);
      if (next?.bgRun && current?.bgRun && bgRunsContinue(next.bgRun, current.bgRun)) {
        endY += 1;
      } else {
        break;
      }
    }
    return { kind: 'box', startY, endY };
  }

  if (isContentRow(line)) {
    // A text message merges consecutive content rows AND the blank lines between
    // them (so a multi-paragraph reply is one block), bounded by decorated blocks,
    // muted / "thinking" lines, the live-widget region, and the buffer edges. The
    // same blank-run cap as the message path applies in BOTH directions, so a
    // content row below a large blank gap does not crawl up through the gap and
    // rebuild a giant block. Blanks absorbed at the ends are then trimmed off.
    const startY = expandUp(source, y, 0, (previous) => isMergeableRow(previous));
    // expandDown already trims trailing blanks; only leading blanks remain to trim.
    const endY = expandDown(source, y, downLimit, (next) => isMergeableRow(next));
    let trimmedStart = startY;
    while (trimmedStart < endY && isBlankRow(source.getLine(trimmedStart))) trimmedStart += 1;
    return { kind: 'text', startY: trimmedStart, endY };
  }

  return null;
}

/**
 * Expand a block downward from `startY` while `accept(row)` holds and the row
 * stays within `downLimit`, stopping early at a run of more than
 * MAX_MESSAGE_INTERIOR_BLANK_ROWS consecutive blank rows and trimming any
 * trailing blanks. Returns the last row that belongs to the block.
 */
function expandDown(
  source: BlockLineSource,
  startY: number,
  downLimit: number,
  accept: (row: BlockLineFacts | undefined) => boolean,
): number {
  let endY = startY;
  let blankRun = 0;
  while (endY + 1 <= downLimit) {
    const next = source.getLine(endY + 1);
    if (!accept(next)) break;
    if (isBlankRow(next)) {
      blankRun += 1;
      if (blankRun > MAX_MESSAGE_INTERIOR_BLANK_ROWS) break;
    } else {
      blankRun = 0;
    }
    endY += 1;
  }
  while (endY > startY && isBlankRow(source.getLine(endY))) endY -= 1;
  return endY;
}

/**
 * Expand a block upward from `startY` while `accept(row)` holds and the row stays
 * at or above `upLimit`, stopping early at a run of more than
 * MAX_MESSAGE_INTERIOR_BLANK_ROWS consecutive blank rows. Returns the first row
 * that belongs to the block (leading blanks are trimmed by the caller).
 */
function expandUp(
  source: BlockLineSource,
  startY: number,
  upLimit: number,
  accept: (row: BlockLineFacts | undefined) => boolean,
): number {
  let currentStart = startY;
  let blankRun = 0;
  while (currentStart - 1 >= upLimit) {
    const previous = source.getLine(currentStart - 1);
    if (!accept(previous)) break;
    if (isBlankRow(previous)) {
      blankRun += 1;
      if (blankRun > MAX_MESSAGE_INTERIOR_BLANK_ROWS) break;
    } else {
      blankRun = 0;
    }
    currentStart -= 1;
  }
  return currentStart;
}

function bgRunsContinue(
  a: { key: string; startColumn: number; endColumn: number },
  b: { key: string; startColumn: number; endColumn: number },
): boolean {
  return a.key === b.key && a.startColumn < b.endColumn && b.startColumn < a.endColumn;
}

/**
 * Extract the clean content of a block: the left bar / leading indent that the
 * CLI painted for decoration is removed, while relative indentation inside the
 * block and interior blank lines are preserved.
 */
export function extractBlockContent(source: BlockLineSource, range: BlockRange): string {
  const rawLines: { text: string; isWrapped: boolean }[] = [];

  let boxStart = Number.POSITIVE_INFINITY;
  let boxEnd = Number.NEGATIVE_INFINITY;
  if (range.kind === 'box') {
    for (let y = range.startY; y <= range.endY; y += 1) {
      const line = source.getLine(y);
      if (line?.bgRun) {
        boxStart = Math.min(boxStart, line.bgRun.startColumn);
        boxEnd = Math.max(boxEnd, line.bgRun.endColumn);
      }
    }
  }

  // For a text paragraph, strip a leading marker (bullet / prompt) on the first
  // line (and its trailing gap) so the content aligns; continuation lines are
  // indented to the same column, so slicing every row there yields clean text.
  const textContentColumn = range.kind === 'text' ? leadingMarkerContentColumn(source.getLine(range.startY)?.text() ?? '') : 0;

  for (let y = range.startY; y <= range.endY; y += 1) {
    const line = source.getLine(y);
    if (!line) {
      rawLines.push({ text: '', isWrapped: false });
      continue;
    }
    let text: string;
    if (range.kind === 'quote') {
      text = line.text((range.barColumn ?? 0) + 1);
    } else if (range.kind === 'box' && Number.isFinite(boxStart)) {
      text = line.text(boxStart, boxEnd);
    } else if (range.kind === 'text') {
      text = line.text(textContentColumn);
    } else {
      text = line.text();
    }
    rawLines.push({ text, isWrapped: line.isWrapped });
  }

  // Box and message rows do not share one content column. Replace the leading
  // marker (the `❯` prompt or `●` bullet) on the first non-blank line with a
  // space rather than slicing it off, so the line keeps its left margin and the
  // common-indent dedent below removes that margin uniformly (left-aligning it).
  if (range.kind === 'box' || range.kind === 'message') {
    const firstNonBlank = rawLines.find((row) => row.text.trim() !== '');
    if (firstNonBlank) firstNonBlank.text = neutralizeLeadingMarker(firstNonBlank.text);
  }

  // Each visual row becomes its own line. xterm's wrap flag is unreliable in the
  // agent TUI - a full-width background fill sets it on every box row, and
  // word-wrapped prose leaves it unset - so merging on it both keeps padding
  // (huge interior gaps) and falsely joins separate lines (e.g. two bullets).
  // Keeping one line per row trims each row's padding and never mis-joins.
  return finalizeLines(rawLines, undefined, false);
}

/**
 * If a string's first non-space glyph is a leading marker (bullet / prompt),
 * return the column where its content begins (past the marker and the following
 * gap); otherwise 0.
 */
function leadingMarkerContentColumn(text: string): number {
  const firstNonSpace = text.search(/\S/);
  if (firstNonSpace < 0 || !LEADING_MARKER_GLYPHS.has(text[firstNonSpace])) return 0;
  const afterMarker = text.slice(firstNonSpace + 1);
  const gap = afterMarker.length - afterMarker.replace(/^ +/, '').length;
  return firstNonSpace + 1 + gap;
}

/** Replace a leading marker glyph (bullet / prompt) with a space, keeping every column position so the common-indent dedent can remove it. */
function neutralizeLeadingMarker(text: string): string {
  const firstNonSpace = text.search(/\S/);
  if (firstNonSpace < 0 || !LEADING_MARKER_GLYPHS.has(text[firstNonSpace])) return text;
  return `${text.slice(0, firstNonSpace)} ${text.slice(firstNonSpace + 1)}`;
}

/**
 * Clean a selection for copy: strip quote decoration on each selected row where
 * the buffer proves the row is decorated (the first non-space cell is a bar
 * glyph and the selection actually covers it). Plain rows are copied verbatim
 * (within the selected columns). Soft wraps are unwrapped using the real
 * `isWrapped` flag rather than a column heuristic.
 */
export function cleanSelectionLines(source: BlockLineSource, range: SelectionRange): string {
  const rows: { text: string; isWrapped: boolean; decorated: boolean }[] = [];

  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const line = source.getLine(y);
    if (!line) {
      rows.push({ text: '', isWrapped: false, decorated: false });
      continue;
    }
    const lineStart = y === range.start.y ? range.start.x : 0;
    const lineEnd = y === range.end.y ? range.end.x : source.cols;

    if (line.quoteBar && lineStart <= line.quoteBar.column) {
      // Selection covers the bar: this row is decorated. Take the text after
      // the bar; the uniform leading gap is removed by the shared dedent below.
      const contentStart = Math.max(lineStart, line.quoteBar.column + 1);
      rows.push({ text: line.text(contentStart, lineEnd), isWrapped: line.isWrapped, decorated: true });
    } else {
      rows.push({ text: line.text(lineStart, lineEnd), isWrapped: line.isWrapped, decorated: false });
    }
  }

  return finalizeLines(rows, (row) => row.decorated === true);
}

/**
 * Join soft-wrapped rows, dedent the common leading whitespace of the eligible
 * lines, trim trailing whitespace per line, and trim outer blank lines.
 *
 * `dedentEligible` selects which logical lines participate in the common-indent
 * calculation and dedent. When omitted, every line is eligible (block
 * extraction). For selection cleaning, only decorated rows are dedented so a
 * plain line mixed into the selection keeps its own indentation.
 */
function finalizeLines(
  rows: { text: string; isWrapped: boolean; decorated?: boolean }[],
  dedentEligible?: (row: { text: string; isWrapped: boolean; decorated?: boolean }) => boolean,
  mergeWrapped = true,
): string {
  // 1. Merge soft-wrap continuations into logical lines. Disabled for shaded
  //    boxes: their full-width background fill sets xterm's wrap flag on every
  //    row, so merging would collapse the box into one padded line.
  const logical: { text: string; eligible: boolean }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const eligible = dedentEligible ? dedentEligible(row) : true;
    if (mergeWrapped && i > 0 && row.isWrapped && logical.length > 0) {
      logical[logical.length - 1].text += row.text;
    } else {
      logical.push({ text: row.text, eligible });
    }
  }

  // 2. Trim trailing whitespace per logical line.
  for (const entry of logical) {
    entry.text = entry.text.replace(/\s+$/, '');
  }

  // 3. Dedent the common leading whitespace across eligible, non-blank lines.
  let commonIndent = Number.POSITIVE_INFINITY;
  for (const entry of logical) {
    if (!entry.eligible || entry.text === '') continue;
    const leading = entry.text.length - entry.text.replace(/^ +/, '').length;
    commonIndent = Math.min(commonIndent, leading);
  }
  if (Number.isFinite(commonIndent) && commonIndent > 0) {
    for (const entry of logical) {
      if (entry.eligible && entry.text !== '') {
        entry.text = entry.text.slice(commonIndent);
      }
    }
  }

  // 4. Trim outer blank lines; preserve interior blanks.
  const result = logical.map((entry) => entry.text);
  while (result.length > 0 && result[0] === '') result.shift();
  while (result.length > 0 && result[result.length - 1] === '') result.pop();

  return result.join('\n');
}
