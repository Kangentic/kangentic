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

/** The first non-space glyph of a row, or '' when blank. */
function firstGlyph(line: BlockLineFacts | undefined): string {
  if (!line) return '';
  return line.text().replace(/^\s+/, '').charAt(0);
}

function isThinkingRow(line: BlockLineFacts | undefined): boolean {
  return THINKING_GLYPHS.has(firstGlyph(line));
}

/** A row that bounds a message block: the next message's bullet, a thinking line, or a user prompt. */
function isMessageBoundary(line: BlockLineFacts | undefined): boolean {
  const glyph = firstGlyph(line);
  return glyph === MESSAGE_BULLET || glyph === PROMPT_GLYPH || THINKING_GLYPHS.has(glyph);
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

/** Scan up from a row to the bullet that owns it, stopping at a thinking line, a user prompt, or the lookback limit. */
function findMessageStart(source: BlockLineSource, y: number): number | null {
  const limit = Math.max(0, y - MAX_MESSAGE_LOOKBACK_ROWS);
  for (let currentRow = y; currentRow >= limit; currentRow -= 1) {
    const glyph = firstGlyph(source.getLine(currentRow));
    if (glyph === MESSAGE_BULLET) return currentRow;
    if (glyph === PROMPT_GLYPH || THINKING_GLYPHS.has(glyph)) return null;
  }
  return null;
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

  // Message / tool block, delimited by "●" bullets. A block runs from its bullet
  // down to (but not including) the next bullet, a thinking line, or a user
  // prompt - so the bullet's sub-lines ("Searched...", "⎿ Added 1 line") and any
  // code / diff it emitted stay in the same block. Takes precedence over the
  // box / quote / text paths so a code block inside a message is not split out.
  const messageStart = findMessageStart(source, y);
  if (messageStart != null) {
    let endY = messageStart;
    while (endY + 1 < source.length && !isMessageBoundary(source.getLine(endY + 1))) endY += 1;
    while (endY > messageStart && isBlankRow(source.getLine(endY))) endY -= 1;
    return { kind: 'message', startY: messageStart, endY };
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
    while (endY + 1 < source.length) {
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
    while (endY + 1 < source.length) {
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
    // muted / "thinking" lines, and the buffer edges. Blanks absorbed at the ends
    // are then trimmed off.
    let startY = y;
    let endY = y;
    while (startY - 1 >= 0 && isMergeableRow(source.getLine(startY - 1))) startY -= 1;
    while (endY + 1 < source.length && isMergeableRow(source.getLine(endY + 1))) endY += 1;
    while (startY < endY && isBlankRow(source.getLine(startY))) startY += 1;
    while (endY > startY && isBlankRow(source.getLine(endY))) endY -= 1;
    return { kind: 'text', startY, endY };
  }

  return null;
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
