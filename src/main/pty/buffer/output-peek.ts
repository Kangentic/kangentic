/**
 * The Agent Monitor's "recent output peek": the last few meaningful rendered
 * lines of a session's terminal, extracted from the PARSED grid.
 *
 * Pure and grid-shaped on purpose (it takes plain strings plus a cursor row, not
 * an xterm handle) so the rule is unit-testable against captured fixtures
 * without a terminal, and so the one interesting decision lives in one place.
 *
 * ## Why the rule is what it is
 *
 * The rule was designed against two REAL captured grids
 * (`tests/fixtures/terminal-grids/`, produced by
 * `scripts/probe-terminal-peek-grid.js`), not from first principles, because the
 * obvious rule is wrong in a way that is invisible from source.
 *
 * "Take the last N non-empty lines" returns, for a real Claude Code session, the
 * composer's prompt row, then a full-width horizontal rule, then the mode line
 * ("plan mode on (shift+tab to cycle)").
 *
 * That is the input box and the mode line. A fullscreen TUI (Claude runs
 * `tui: fullscreen`, i.e. the alt screen) anchors its composer to the BOTTOM of
 * the grid, so the bottom rows are chrome and the agent's actual output sits in
 * the middle. The card would have shipped full of box-drawing characters.
 *
 * Two adjustments fix it, and together they cover BOTH buffer kinds with no
 * alt-screen branch, which is why this takes no `inAltScreen` flag:
 *
 *   1. **Read above the cursor.** In a fullscreen TUI the cursor sits in the
 *      composer, so everything above it is transcript. In a normal-buffer shell
 *      the cursor sits on the trailing prompt, so everything above it is output.
 *      One rule, both worlds.
 *   2. **Skip rule lines.** Adjustment 1 alone still returns the composer's top
 *      border, because a border is a non-empty line above the cursor. Lines made
 *      only of box-drawing / block-element glyphs carry no information at this
 *      size, so they are dropped.
 *
 * Applied to the captured Claude grid this yields the three lines a user would
 * actually want on a card: the tail of the assistant's answer plus its status
 * line. Applied to the captured PowerShell grid it yields the command's output.
 *
 * Deliberately NOT agent-aware. Nothing here branches on which CLI is running,
 * so it stays outside the reach of `.claude/rules/agent-adapters-boundary.md`.
 * If some future agent's TUI genuinely defeats this, the escape hatch is an
 * `AgentAdapter` capability, not a name check added here.
 */

/**
 * Lines extracted per peek.
 *
 * Matches the most a monitor card ever draws (four rows, or two when label pills
 * share the space), because the card's peek well is a FIXED height rather than
 * one that grows with its content. Sending more would be pure payload: the
 * renderer trims to what fits and the surplus is discarded on every push.
 */
export const PEEK_LINE_COUNT = 4;

/**
 * Hard cap per line, so the payload stays bounded no matter how wide the grid
 * is. A card truncates far below this; the cap exists to bound what crosses IPC
 * for a very wide terminal, not to control presentation.
 */
export const PEEK_MAX_LINE_LENGTH = 200;

/**
 * A line carrying no information at card size: empty, or drawn entirely from the
 * Box Drawing (U+2500-U+257F) and Block Elements (U+2580-U+259F) ranges.
 *
 * Scoped to "the WHOLE line is glyphs" on purpose. A MIXED line is real content
 * and is kept, but its art is stripped first: see `stripDecorativePrefix`.
 */
const BOX_DRAWING_FIRST = 0x2500;
const BLOCK_ELEMENTS_LAST = 0x259f;

function isDecorativeGlyph(codePoint: number): boolean {
  return codePoint >= BOX_DRAWING_FIRST && codePoint <= BLOCK_ELEMENTS_LAST;
}

/**
 * Drop a run of block art from the START of a line, keeping the text after it.
 *
 * An agent CLI's startup banner draws a multi-row logo in a left-hand column with
 * real text beside it, so those rows are neither wholly decorative (the
 * whole-line rule above misses them) nor readable as-is. Rendered into a card at
 * 12px the art is meaningless noise, and it was eating all three peek lines of a
 * freshly opened terminal, which is exactly when a card most needs to say
 * something. Stripping it leaves the useful half: the CLI name and version, the
 * model, and the working directory.
 *
 * Only a LEADING run is stripped, and only when it actually contains a glyph, so
 * ordinary indentation survives untouched (that indentation is what carries the
 * shape of real output). Markers outside the range are unaffected, which is what
 * keeps the prompt, bullet, and spinner glyphs that anchor a line readable.
 */
function stripDecorativePrefix(text: string): string {
  let index = 0;
  let sawGlyph = false;
  for (const character of text) {
    if (character === ' ') {
      index += character.length;
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isDecorativeGlyph(codePoint)) break;
    sawGlyph = true;
    index += character.length;
  }
  if (!sawGlyph) return text;
  const remainder = text.slice(index);
  // A line that was ONLY art should already have been dropped as decorative;
  // returning the original rather than '' keeps this from inventing a blank line
  // if that ever stops holding.
  return remainder.length > 0 ? remainder : text;
}

/**
 * Cap a line by CODE POINT, not by UTF-16 code unit.
 *
 * A plain `slice(0, n)` can land inside a surrogate pair and ship half of one
 * across IPC, which renders as U+FFFD in the card. Terminal output carries
 * astral characters routinely (emoji in an agent's status line), and the rest of
 * this file already walks by code point for exactly this reason. The buffer
 * manager solves the same problem at the byte seam with `surrogateSafeFlushEnd`.
 */
function capLineLength(text: string): string {
  if (text.length <= PEEK_MAX_LINE_LENGTH) return text;
  return Array.from(text).slice(0, PEEK_MAX_LINE_LENGTH).join('');
}

function isDecorativeLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Code points rather than a regex character class: the range's own endpoints
  // are box-drawing glyphs, so writing it as a literal class would embed the
  // very characters this file exists to filter out.
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (character === ' ') continue;
    if (!isDecorativeGlyph(codePoint)) return false;
  }
  return true;
}

/**
 * The last `count` meaningful lines strictly ABOVE `cursorRow`, read LAZILY.
 *
 * Takes an accessor rather than an array so the caller never has to materialize
 * rows this will not look at. That matters on the live path: the sampler runs
 * against every session that produced output, twice a second, and each row it
 * asks for costs an `xterm` cell-walk plus a string allocation. Rows at or below
 * the cursor are never examined at all, and the walk stops as soon as it has
 * enough lines rather than always reading down to the floor.
 *
 * The saving is real but modest, so do not read it as "a handful": on the
 * captured fullscreen-TUI grid the composer chrome sits between the cursor and
 * the transcript, so collecting the default 4 lines still reads about 21 of the
 * 27 rows available above the cursor (`tests/unit/output-peek.test.ts` pins the
 * count). Blank grids are the cheap case, dense TUIs the expensive one.
 *
 * @param readLine  Plain text of one ABSOLUTE buffer row (no ANSI). May return
 *                  undefined for a row that does not exist.
 * @param cursorRow Absolute row the cursor is on (`baseY + cursorY`).
 * @param floorRow  Lowest row to look at, so the walk is bounded even when the
 *                  grid is mostly blank.
 */
export function collectPeekLines(
  readLine: (row: number) => string | undefined,
  cursorRow: number,
  count: number,
  floorRow: number,
): string[] {
  if (count <= 0) return [];
  const collected: string[] = [];
  for (let row = cursorRow - 1; row >= floorRow && collected.length < count; row--) {
    const text = readLine(row);
    if (text === undefined || isDecorativeLine(text)) continue;
    // Strip BEFORE capping, so a wide art column cannot spend the line budget.
    collected.push(capLineLength(stripDecorativePrefix(text).trimEnd()));
  }
  return collected.reverse();
}

/**
 * Array-shaped convenience over `collectPeekLines`, for callers that already hold
 * the rows (the fixture-backed tests, chiefly).
 *
 * @param lines     Rendered grid rows indexed by ABSOLUTE buffer row.
 * @param cursorRow Absolute row the cursor is on.
 */
export function extractPeekLines(
  lines: readonly string[],
  cursorRow: number,
  count: number = PEEK_LINE_COUNT,
): string[] {
  // A cursor at or above the top leaves nothing to report. Clamping rather than
  // treating a negative as "whole buffer" keeps a malformed read silent instead
  // of surfacing the composer we just went to the trouble of excluding.
  const ceiling = Math.min(Math.max(cursorRow, 0), lines.length);
  return collectPeekLines((row) => lines[row], ceiling, count, 0);
}

/** Value equality for the change-gate, so an unchanged peek is never re-sent. */
export function peeksEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}
