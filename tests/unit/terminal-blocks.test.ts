import { describe, it, expect } from 'vitest';
import {
  findBlockAt,
  findPromptRegionTop,
  extractBlockContent,
  cleanSelectionLines,
  BAR_GLYPHS,
  MIN_BOX_RUN_CELLS,
  MAX_BOX_RUN_START_COLUMN,
  MAX_MESSAGE_LOOKBACK_ROWS,
  MAX_MESSAGE_INTERIOR_BLANK_ROWS,
  PROMPT_REGION_LOOKBACK_ROWS,
  type BlockLineFacts,
  type BlockLineSource,
} from '../../src/renderer/utils/terminal-blocks';

// A fake buffer row. `raw` is the full row text where string index === buffer
// column (all fixtures use single-cell characters), so `text(start, end)` slices
// it directly, matching xterm's exclusive-endColumn `translateToString`.
interface FakeLine {
  raw: string;
  isWrapped?: boolean;
  quoteBar?: { column: number; fgKey: string } | null;
  bgRun?: { key: string; startColumn: number; endColumn: number } | null;
  hasDefaultFg?: boolean;
}

const ORANGE = 'rgb:14120791';
const SHADE = 'rgb:3618615';

function makeSource(lines: FakeLine[], cols = 80, cursorRow?: number): BlockLineSource {
  const facts: BlockLineFacts[] = lines.map((line) => ({
    isWrapped: line.isWrapped ?? false,
    quoteBar: line.quoteBar ?? null,
    bgRun: line.bgRun ?? null,
    hasDefaultFg: line.hasDefaultFg ?? true,
    text(startColumn = 0, endColumn?: number) {
      return line.raw.slice(startColumn, endColumn);
    },
  }));
  return {
    length: facts.length,
    cols,
    cursorRow,
    getLine: (y) => facts[y],
  };
}

// A tab-header / submit bar row of an interactive prompt (default-fg text with
// the widget's checkbox + confirm glyphs). Plain otherwise.
function tabHeader(raw: string): FakeLine {
  return { raw };
}

// A shaded, ❯-pointed selected option row of an interactive prompt.
function selectedOption(raw: string): FakeLine {
  return { raw, bgRun: { key: SHADE, startColumn: 0, endColumn: 80 } };
}

// A muted / "thinking" status row: undecorated, all non-default foreground.
function muted(raw: string): FakeLine {
  return { raw, hasDefaultFg: false };
}

// A quote row: optional indent before the bar glyph, then the bar, then content.
function quote(afterBar: string, indent = 0, fgKey = ORANGE): FakeLine {
  const column = indent;
  return {
    raw: ' '.repeat(indent) + '▎' + afterBar,
    quoteBar: { column, fgKey },
  };
}

// A shaded box row: the whole line carries the background run.
function box(content: string, key = SHADE, startColumn = 0, endColumn = 80): FakeLine {
  return { raw: content, bgRun: { key, startColumn, endColumn } };
}

function plain(raw: string, isWrapped = false): FakeLine {
  return { raw, isWrapped };
}

describe('terminal-blocks constants', () => {
  it('excludes box-drawing verticals from the bar glyph set (avoids box-border false positives)', () => {
    expect(BAR_GLYPHS.has('▎')).toBe(true);
    expect(BAR_GLYPHS.has('│')).toBe(false);
    expect(BAR_GLYPHS.has('┃')).toBe(false);
  });

  it('keeps sensible box-run thresholds', () => {
    expect(MIN_BOX_RUN_CELLS).toBeGreaterThan(0);
    expect(MAX_BOX_RUN_START_COLUMN).toBeGreaterThanOrEqual(0);
  });
});

describe('findBlockAt - quote blocks', () => {
  it('expands a hit in the middle to the full block bounds', () => {
    const source = makeSource([
      plain('intro'),
      quote(' one'),
      quote(' two'),
      quote(' three'),
      plain('after'),
    ]);
    const range = findBlockAt(source, 2);
    expect(range).toEqual({ kind: 'quote', startY: 1, endY: 3, barColumn: 0 });
  });

  it('detects a single-row quote block', () => {
    const source = makeSource([plain('a'), quote(' solo'), plain('b')]);
    expect(findBlockAt(source, 1)).toEqual({ kind: 'quote', startY: 1, endY: 1, barColumn: 0 });
  });

  it('returns a text block (not null) on a plain row', () => {
    const source = makeSource([plain('nothing here')]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 0 });
  });

  it('does not merge adjacent quote blocks with a different fg color', () => {
    const source = makeSource([
      quote(' a', 0, ORANGE),
      quote(' b', 0, ORANGE),
      quote(' c', 0, 'rgb:999999'),
    ]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'quote', startY: 0, endY: 1, barColumn: 0 });
    expect(findBlockAt(source, 2)).toEqual({ kind: 'quote', startY: 2, endY: 2, barColumn: 0 });
  });

  it('does not merge quote blocks whose bar sits at a different column', () => {
    const source = makeSource([quote(' a', 0), quote(' b', 2)]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'quote', startY: 0, endY: 0, barColumn: 0 });
    expect(findBlockAt(source, 1)).toEqual({ kind: 'quote', startY: 1, endY: 1, barColumn: 2 });
  });

  it('clamps expansion at the top of the buffer (scrollback-evicted block start)', () => {
    const source = makeSource([quote(' a'), quote(' b'), plain('end')]);
    expect(findBlockAt(source, 1)).toEqual({ kind: 'quote', startY: 0, endY: 1, barColumn: 0 });
  });
});

describe('findBlockAt - box blocks', () => {
  it('expands a shaded box to its bounds', () => {
    const source = makeSource([plain('x'), box('  a'), box('  b'), plain('y')]);
    expect(findBlockAt(source, 1)).toEqual({ kind: 'box', startY: 1, endY: 2 });
  });

  it('splits boxes with a different background key', () => {
    const source = makeSource([box('a', SHADE), box('b', 'rgb:111111')]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'box', startY: 0, endY: 0 });
    expect(findBlockAt(source, 1)).toEqual({ kind: 'box', startY: 1, endY: 1 });
  });

  it('splits boxes whose runs do not overlap in columns', () => {
    const source = makeSource([
      { raw: 'left', bgRun: { key: SHADE, startColumn: 0, endColumn: 4 } },
      { raw: '      right', bgRun: { key: SHADE, startColumn: 6, endColumn: 11 } },
    ]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'box', startY: 0, endY: 0 });
    expect(findBlockAt(source, 1)).toEqual({ kind: 'box', startY: 1, endY: 1 });
  });
});

describe('findBlockAt - message blocks (bullet-delimited)', () => {
  const build = () => makeSource([
    plain('● I\'ll make a trivial change'),   // 0 message bullet
    plain('  Searched for 2 patterns'),        // 1 sub-line (kept)
    plain(''),                                  // 2 interior blank
    plain('● I\'ll add a harmless comment'),   // 3 message bullet
    plain('● Update(README.md)'),              // 4 tool bullet
    plain('  ⎿ Added 1 line'),                 // 5 tool result (kept)
    plain('      1 +<!-- test -->'),           // 6 code
    plain('      2 </p>'),                      // 7 code
    muted('✻ Cooked for 3s'),                  // 8 thinking (excluded)
    plain('● Done. I made a change'),          // 9 message bullet
  ]);

  it('groups a bullet with its sub-lines up to the next bullet (from anywhere inside)', () => {
    expect(findBlockAt(build(), 0)).toEqual({ kind: 'message', startY: 0, endY: 1 });
    expect(findBlockAt(build(), 1)).toEqual({ kind: 'message', startY: 0, endY: 1 });
  });

  it('groups a tool bullet with its result and code lines', () => {
    expect(findBlockAt(build(), 4)).toEqual({ kind: 'message', startY: 4, endY: 7 });
    expect(findBlockAt(build(), 6)).toEqual({ kind: 'message', startY: 4, endY: 7 });
  });

  it('is not copyable on a thinking line, and a thinking line bounds a message', () => {
    expect(findBlockAt(build(), 8)).toBeNull();
    expect(findBlockAt(build(), 4)?.endY).toBe(7); // stops before the ✻ line at 8
  });

  it('starts a fresh block at each bullet', () => {
    expect(findBlockAt(build(), 3)).toEqual({ kind: 'message', startY: 3, endY: 3 });
    expect(findBlockAt(build(), 9)).toEqual({ kind: 'message', startY: 9, endY: 9 });
  });

  it('strips the bullet and left-aligns the message content', () => {
    const source = makeSource([
      plain('● Update(README.md)'),
      plain('  ⎿ Added 1 line'),
      plain('  1 +code'),
    ]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('Update(README.md)\n⎿ Added 1 line\n1 +code');
  });
});

describe('findBlockAt - message lookback bound', () => {
  it('resolves a message when its bullet is within the lookback window', () => {
    const source = makeSource([plain('● nearby message'), plain('  body a'), plain('  body b')]);
    expect(findBlockAt(source, 2)).toEqual({ kind: 'message', startY: 0, endY: 2 });
  });

  it('does not scan past MAX_MESSAGE_LOOKBACK_ROWS to claim a distant bullet as the block start', () => {
    // A single bullet at row 0, then more than the lookback limit of plain body
    // rows. Hitting the last row must NOT walk all the way back to the bullet
    // (that unbounded O(scrollback) scan is the perf regression this bound fixes)
    // - it falls through to a local text block instead of a giant message block.
    const lines: FakeLine[] = [plain('● far-away message start')];
    for (let i = 0; i < MAX_MESSAGE_LOOKBACK_ROWS + 2; i += 1) lines.push(plain(`body line ${i}`));
    const hitRow = lines.length - 1;
    const range = findBlockAt(makeSource(lines), hitRow);
    expect(range?.kind).toBe('text');
    expect(range?.kind).not.toBe('message');
  });
});

describe('findBlockAt - text messages', () => {
  it('expands a run of content rows into one message, trimming outer blanks', () => {
    const source = makeSource([plain(''), plain('line a'), plain('line b'), plain('')]);
    expect(findBlockAt(source, 1)).toEqual({ kind: 'text', startY: 1, endY: 2 });
  });

  it('merges paragraphs across an interior blank line into one message', () => {
    const source = makeSource([plain('first para'), plain(''), plain('second para')]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 2 });
    expect(findBlockAt(source, 2)).toEqual({ kind: 'text', startY: 0, endY: 2 });
  });

  it('returns null when hit-testing a blank row directly', () => {
    const source = makeSource([plain('a'), plain(''), plain('b')]);
    expect(findBlockAt(source, 1)).toBeNull();
    // The surrounding content rows still merge into one message.
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 2 });
  });

  it('is not copyable on a muted / thinking row, and a muted row bounds a message', () => {
    const source = makeSource([plain('reply text'), plain(''), muted('* Crunched for 3s')]);
    expect(findBlockAt(source, 2)).toBeNull();
    // The message stops before the muted row (and the trailing blank is trimmed).
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 0 });
  });

  it('does not merge two messages separated by a muted line', () => {
    const source = makeSource([plain('first reply'), muted('* thinking'), plain('second reply')]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 0 });
    expect(findBlockAt(source, 2)).toEqual({ kind: 'text', startY: 2, endY: 2 });
  });

  it('does not swallow an adjacent box or quote row into a text message', () => {
    const source = makeSource([plain('prose'), box('  code'), quote(' quoted')]);
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 0 });
    expect(findBlockAt(source, 1)).toEqual({ kind: 'box', startY: 1, endY: 1 });
  });
});

describe('findBlockAt - live interactive prompt (AskUserQuestion)', () => {
  // The layout of Claude Code's AskUserQuestion widget as it sits in the buffer:
  // an assistant message, a dim planning link, the tab-header / submit bar, the
  // question paragraph, a ❯-pointed shaded selected option, dim description rows,
  // plain option rows, and the keyboard-hint row. The cursor is parked at the
  // hint row (where an Ink TUI leaves the caret, at the bottom of the widget).
  const TAB_HEADER = 5;
  const HINT_ROW = 15;
  const build = (cursorRow: number | undefined = HINT_ROW) => makeSource([
    plain('● The search-subsystem report is in, with two corrections.'), // 0 message bullet
    plain('  Waiting on the other two exploration reports.'),            // 1 message body
    plain(''),                                                            // 2 blank
    muted('Planning: /mock/plan.md'),                                     // 3 dim planning link
    plain(''),                                                            // 4 blank
    tabHeader('← ☐ Model delivery ☐ Embed host ☐ Scope ☐ Backfill ✓ Submit →'), // 5 tab header
    plain(''),                                                            // 6 blank
    plain('How should the embedding model reach the machine?'),          // 7 question paragraph
    selectedOption('❯ 1. Download on first use (Recommended)'),          // 8 selected (shaded) option
    muted('   Reuse the dictation model downloader.'),                   // 9 dim description
    plain('  2. Bundle in installer'),                                    // 10 option row
    muted('   Ship model files via extraResources.'),                    // 11 dim description
    plain('  3. Bundle small, download better'),                          // 12 option row
    plain('  4. Type something.'),                                        // 13 option row
    plain(''),                                                            // 14 blank
    muted('Enter to select · Tab/Arrow keys to navigate · Esc to cancel'), // 15 hint row
  ], 80, cursorRow);

  it('locates the region top at the tab header (scanning up from the cursor)', () => {
    expect(findPromptRegionTop(build())).toBe(TAB_HEADER);
  });

  it('returns null anywhere inside the widget (option rows, question, header, hint)', () => {
    const source = build();
    expect(findBlockAt(source, TAB_HEADER)).toBeNull();       // tab header
    expect(findBlockAt(source, 7)).toBeNull();                // question paragraph
    expect(findBlockAt(source, 8)).toBeNull();                // shaded selected option (box path)
    expect(findBlockAt(source, 10)).toBeNull();               // plain option row (text path)
    expect(findBlockAt(source, 12)).toBeNull();               // plain option row
    expect(findBlockAt(source, HINT_ROW)).toBeNull();         // hint row
  });

  it('ends the assistant message above the prompt before the tab header', () => {
    const range = findBlockAt(build(), 0);
    expect(range?.kind).toBe('message');
    expect(range?.startY).toBe(0);
    expect(range?.endY).toBeLessThan(TAB_HEADER);
  });

  it('never returns a range that excludes its hit row', () => {
    const source = build();
    for (let y = 0; y < 16; y += 1) {
      const range = findBlockAt(source, y);
      if (range) {
        expect(range.startY).toBeLessThanOrEqual(y);
        expect(range.endY).toBeGreaterThanOrEqual(y);
      }
    }
  });

  it('still ends the message at the tab-header boundary without cursor info (glyph fallback)', () => {
    const source = build(undefined); // no cursorRow -> no cursor-anchored region
    // The tab header is itself never copyable...
    expect(findBlockAt(source, TAB_HEADER)).toBeNull();
    // ...and it still bounds the message above it.
    const range = findBlockAt(source, 0);
    expect(range?.kind).toBe('message');
    expect(range?.endY).toBeLessThan(TAB_HEADER);
  });
});

describe('findPromptRegionTop - seed and boundary rules', () => {
  it('a ● between the cursor and a header cancels the region (a stale header in scrollback)', () => {
    const source = makeSource([
      tabHeader('☐ A ☐ B ✓ Submit'), // 0 old widget header in scrollback
      plain('  some output'),          // 1
      plain('● a newer message'),      // 2 boundary between cursor and the header
      plain('  more output'),          // 3
    ], 80, 3);
    expect(findPromptRegionTop(source)).toBeNull();
  });

  it('a single checkbox row is not a seed (a TodoWrite line echoed in a message)', () => {
    const source = makeSource([
      plain('● message'),       // 0
      plain('☐ fix the tests'), // 1 single checkbox - not a header
      plain('  done'),          // 2
    ], 80, 2);
    expect(findPromptRegionTop(source)).toBeNull();
    // The todo row keeps its normal classification (copyable, inside the message).
    const range = findBlockAt(source, 1);
    expect(range?.kind).toBe('message');
    expect(range?.startY).toBe(0);
  });

  it('a check-only row is not a seed (vitest output, a checkmark table)', () => {
    const source = makeSource([
      plain('● message'),               // 0
      plain('✓ passed a  ✓ passed b'),  // 1 two checks, zero checkboxes - not a header
      plain('  trailing'),              // 2
    ], 80, 2);
    expect(findPromptRegionTop(source)).toBeNull();
  });

  it('does not stop the up-scan at the widget\'s own ❯ selected-option row', () => {
    const source = makeSource([
      tabHeader('☐ A ☐ B ✓ Submit'),          // 0 header (the seed)
      plain('the question'),                    // 1
      selectedOption('❯ 1. option'),            // 2 ❯ row between header and cursor
      plain('  a description'),                 // 3
    ], 80, 3);
    expect(findPromptRegionTop(source)).toBe(0);
  });

  it('ignores a header seed beyond the lookback window', () => {
    const lines: FakeLine[] = [tabHeader('☐ A ☐ B ✓ Submit')];
    for (let i = 0; i < PROMPT_REGION_LOOKBACK_ROWS + 5; i += 1) lines.push(plain(`filler ${i}`));
    const cursorRow = lines.length - 1;
    expect(findPromptRegionTop(makeSource(lines, 80, cursorRow))).toBeNull();
  });

  it('returns null when the source carries no cursor position', () => {
    const source = makeSource([tabHeader('☐ A ☐ B ✓ Submit'), plain('x')]);
    expect(findPromptRegionTop(source)).toBeNull();
  });
});

describe('isTabHeaderText - single-checkbox-plus-confirm disjunct', () => {
  // isTabHeaderText returns true on `checkboxes >= 2 || (checkboxes >= 1 &&
  // checks >= 1)`. Every other fixture in this file uses 2+ checkboxes, so this
  // exercises the second disjunct in isolation via a single-option
  // AskUserQuestion render ("☐ Confirm  ✓ Submit"): exactly one checkbox glyph
  // plus one confirm glyph.
  it('seeds the live-prompt region on a "1 checkbox + 1 confirm" header, and every row at/below it is suppressed', () => {
    const source = makeSource([
      plain('● Confirm this destructive action?'), // 0 message bullet
      tabHeader('☐ Confirm  ✓ Submit'),             // 1 header: 1 checkbox + 1 confirm glyph
      plain(''),                                     // 2 blank
      plain('This will delete 3 files.'),            // 3 question text
      muted('Enter to confirm · Esc to cancel'),     // 4 hint row (cursor)
    ], 80, 4);

    expect(findPromptRegionTop(source)).toBe(1);
    // The header row itself, and every row at/below it, is inside the live widget.
    expect(findBlockAt(source, 1)).toBeNull();
    expect(findBlockAt(source, 3)).toBeNull();
    expect(findBlockAt(source, 4)).toBeNull();
  });
});

describe('findBlockAt - downLimit region-clamp on the quote / box / text expansion loops', () => {
  // The quote, box, and text `expandDown` loops changed their downward bound
  // from `source.length` to the region-aware `downLimit` (`regionTop - 1`). In
  // every other fixture in this file the widget rows are already excluded by
  // the earlier blanket `y >= regionTop` guard in `findBlockAt` before the
  // loop-level bound is ever consulted, so these cases start the block ABOVE
  // `regionTop` (where that guard does not apply) and give the loop's own
  // matching condition a reason to want to keep going past the header -
  // proving the `downLimit` clamp itself is load-bearing, not just the earlier
  // guard.

  it('quote: stops expansion at the widget boundary, not the buffer end', () => {
    // Rows 3 and 4 (inside the "widget") coincidentally carry a matching
    // quoteBar too, so the naive same-column/same-color loop condition alone
    // would keep absorbing them; only the region-aware downLimit stops it at
    // row 2.
    const source = makeSource([
      plain('intro'),                                                       // 0
      quote(' one'),                                                        // 1 quote start (hit here)
      quote(' two'),                                                        // 2
      { raw: '☐ A ☐ B ✓ Submit', quoteBar: { column: 0, fgKey: ORANGE } },  // 3 tab header (regionTop seed)
      quote(' widget row'),                                                 // 4 inside the widget
      plain('the question'),                                                // 5
      muted('hint'),                                                        // 6 cursor
    ], 80, 6);

    expect(findPromptRegionTop(source)).toBe(3);
    const range = findBlockAt(source, 1);
    expect(range).toEqual({ kind: 'quote', startY: 1, endY: 2, barColumn: 0 });
    expect(range!.endY).toBeLessThan(3);
  });

  it('box: stops expansion at the widget boundary, not the buffer end', () => {
    // Same shape as the quote case: rows 3 and 4 coincidentally carry a
    // matching bgRun too, so only the downLimit clamp stops the box at row 2.
    const source = makeSource([
      plain('intro'),                                                                   // 0
      box('  a'),                                                                       // 1 box start (hit here)
      box('  b'),                                                                       // 2
      { raw: '☐ A ☐ B ✓ Submit', bgRun: { key: SHADE, startColumn: 0, endColumn: 80 } }, // 3 tab header (regionTop seed)
      box('  widget row', SHADE),                                                       // 4 inside the widget
      plain('the question'),                                                            // 5
      muted('hint'),                                                                     // 6 cursor
    ], 80, 6);

    expect(findPromptRegionTop(source)).toBe(3);
    const range = findBlockAt(source, 1);
    expect(range).toEqual({ kind: 'box', startY: 1, endY: 2 });
    expect(range!.endY).toBeLessThan(3);
  });

  it('text: stops expansion at the widget boundary, not the buffer end', () => {
    // A plain content row passes isContentRow just as readily as a normal
    // paragraph line - the text accept function (isMergeableRow) does not
    // check isTabHeaderText/isMessageBoundary at all, so only the downLimit
    // clamp keeps this paragraph from merging the header (and the question
    // line after it) into the same block.
    const source = makeSource([
      plain('a paragraph starting'),   // 0 text start (hit here)
      tabHeader('☐ A ☐ B ✓ Submit'),   // 1 tab header (regionTop seed)
      plain('the question'),            // 2
      muted('hint'),                    // 3 cursor
    ], 80, 3);

    expect(findPromptRegionTop(source)).toBe(1);
    const range = findBlockAt(source, 0);
    expect(range).toEqual({ kind: 'text', startY: 0, endY: 0 });
    expect(range!.endY).toBeLessThan(1);
  });
});

describe('findBlockAt - blank-run cap (giant empty region during a live repaint)', () => {
  // A streaming message whose spinner boundary transiently vanished, leaving a
  // screenful of blank rows below the message and a dim tip row at the bottom.
  const GULF = 20;
  const build = () => {
    const lines: FakeLine[] = [
      plain('● I\'ll look at the screenshot and the PR.'), // 0 message bullet
      plain('  Reading 1 file, running 1 command.'),       // 1 message body
    ];
    for (let i = 0; i < GULF; i += 1) lines.push(plain('')); // 2..21 blank gulf
    lines.push(muted('Tip: Use /btw to ask a side question.')); // 22 dim tip row
    return makeSource(lines);
  };

  it('caps a message block before a blank gulf larger than the cap', () => {
    const range = findBlockAt(build(), 0);
    expect(range?.kind).toBe('message');
    expect(range?.startY).toBe(0);
    // The block ends at the last content row, well before the gulf and the tip.
    expect(range?.endY).toBe(1);
    expect(range?.endY).toBeLessThanOrEqual(1 + MAX_MESSAGE_INTERIOR_BLANK_ROWS);
  });

  it('returns null in the blank gulf and on the tip row below it', () => {
    const source = build();
    expect(findBlockAt(source, 10)).toBeNull(); // deep in the gulf
    expect(findBlockAt(source, 22)).toBeNull(); // the dim tip row
  });

  it('a text block below a large blank gap does not crawl up through it', () => {
    const lines: FakeLine[] = [plain('top content')];
    for (let i = 0; i < MAX_MESSAGE_INTERIOR_BLANK_ROWS + 2; i += 1) lines.push(plain('')); // gap larger than the cap
    lines.push(plain('bottom content'));
    const source = makeSource(lines);
    const bottom = lines.length - 1;
    const range = findBlockAt(source, bottom);
    expect(range?.kind).toBe('text');
    expect(range?.startY).toBe(bottom); // just the bottom row, not merged up through the gap
    expect(range?.endY).toBe(bottom);
    // And the top block is likewise isolated to itself.
    expect(findBlockAt(source, 0)).toEqual({ kind: 'text', startY: 0, endY: 0 });
  });
});

describe('extractBlockContent - text messages', () => {
  it('copies a plain paragraph verbatim (dedenting shared indent)', () => {
    const source = makeSource([plain('  hello'), plain('  world')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('hello\nworld');
  });

  it('keeps an interior blank line between merged paragraphs', () => {
    const source = makeSource([plain('para one'), plain(''), plain('para two')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('para one\n\npara two');
  });

  it('strips a leading bullet and aligns the continuation', () => {
    const source = makeSource([plain('• First point of the reply'), plain('  continues here')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('First point of the reply\ncontinues here');
  });

  it('leaves an ASCII dash-led line untouched (not treated as a bullet)', () => {
    const source = makeSource([plain('- not a bullet glyph')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('- not a bullet glyph');
  });
});

describe('extractBlockContent - quote blocks', () => {
  it('strips the bar and the uniform leading gap, preserving relative indent', () => {
    const source = makeSource([
      quote(' First quoted line here'),
      quote(''),
      quote('   indented code inside quote'),
    ]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe(
      'First quoted line here\n\n  indented code inside quote',
    );
  });

  it('preserves an interior blank (bar-only) line', () => {
    const source = makeSource([quote(' a'), quote(''), quote(' b')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('a\n\nb');
  });

  it('handles a bar sitting at a non-zero column', () => {
    const source = makeSource([quote(' hello', 2), quote(' world', 2)]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('hello\nworld');
  });
});

describe('extractBlockContent - box blocks', () => {
  it('dedents the common leading whitespace and trims trailing padding', () => {
    const source = makeSource([box('  const x = 42;   '), box('  return x;')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('const x = 42;\nreturn x;');
  });

  it('preserves relative indentation inside the box', () => {
    const source = makeSource([box('function f() {'), box('  return 1;'), box('}')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('function f() {\n  return 1;\n}');
  });

  it('strips the prompt marker and left-aligns the box by removing its common margin', () => {
    // The box has a uniform 2-space left margin; the first line carries a `❯`
    // prompt marker in that margin. The result is dedented so <task> is flush left
    // and the relative XML indentation is preserved.
    const source = makeSource([box('❯ <task>'), box('    <title>x</title>'), box('  </task>')]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('<task>\n  <title>x</title>\n</task>');
  });

  it('keeps box rows on separate lines even when flagged wrapped (full-width fill artifact)', () => {
    // A shaded box fills the full width, so xterm marks each row isWrapped; the
    // rows must NOT collapse into one padded line.
    const source = makeSource([
      { raw: 'line one', isWrapped: false, bgRun: { key: SHADE, startColumn: 0, endColumn: 80 } },
      { raw: 'line two', isWrapped: true, bgRun: { key: SHADE, startColumn: 0, endColumn: 80 } },
      { raw: 'line three', isWrapped: true, bgRun: { key: SHADE, startColumn: 0, endColumn: 80 } },
    ]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('line one\nline two\nline three');
  });
});

describe('extractBlockContent - wrapped rows', () => {
  it('keeps each visual row on its own line (the TUI wrap flag is unreliable)', () => {
    // xterm's isWrapped is corrupted by full-width fills and word-wrap, so we do
    // not merge on it - each row is copied as its own trimmed line.
    const source = makeSource([
      quote(' start of a very long'),
      { raw: '▎ line that wrapped', quoteBar: { column: 0, fgKey: ORANGE }, isWrapped: true },
    ]);
    const range = findBlockAt(source, 0)!;
    expect(extractBlockContent(source, range)).toBe('start of a very long\nline that wrapped');
  });
});

describe('cleanSelectionLines', () => {
  it('strips quote decoration only from decorated rows in a mixed selection', () => {
    const source = makeSource([
      plain('Lorem ipsum dolor sit amet.'),
      quote(''),
      quote(' Sed do eiusmod tempor incididunt.'),
      quote(''),
      quote(' Duis aute irure dolor.'),
    ]);
    const cleaned = cleanSelectionLines(source, { start: { x: 0, y: 0 }, end: { x: 80, y: 4 } });
    expect(cleaned).toBe(
      'Lorem ipsum dolor sit amet.\n\nSed do eiusmod tempor incididunt.\n\nDuis aute irure dolor.',
    );
    expect(cleaned).not.toContain('▎');
  });

  it('does not strip when the selection starts to the right of the bar', () => {
    // Selection begins at column 4, past the bar at column 0.
    const source = makeSource([quote(' hello world')]);
    const cleaned = cleanSelectionLines(source, { start: { x: 4, y: 0 }, end: { x: 12, y: 0 } });
    expect(cleaned).toBe('llo worl');
  });

  it('honors an exclusive end column on the last row', () => {
    const source = makeSource([plain('0123456789')]);
    // start.x=2, end.x=5 -> chars at columns 2,3,4.
    const cleaned = cleanSelectionLines(source, { start: { x: 2, y: 0 }, end: { x: 5, y: 0 } });
    expect(cleaned).toBe('234');
  });

  it('takes full width on intermediate rows and the start row of a multi-row selection', () => {
    const source = makeSource([plain('first line'), plain('second line'), plain('third')]);
    const cleaned = cleanSelectionLines(source, { start: { x: 6, y: 0 }, end: { x: 5, y: 2 } });
    expect(cleaned).toBe('line\nsecond line\nthird');
  });

  it('unwraps soft-wrapped plain rows via the real isWrapped flag', () => {
    const source = makeSource([plain('abcdef'), plain('ghij', true)]);
    const cleaned = cleanSelectionLines(source, { start: { x: 0, y: 0 }, end: { x: 80, y: 1 } });
    expect(cleaned).toBe('abcdefghij');
  });

  it('trims outer blank lines but keeps interior blanks', () => {
    const source = makeSource([plain(''), plain('a'), plain(''), plain('b'), plain('')]);
    const cleaned = cleanSelectionLines(source, { start: { x: 0, y: 0 }, end: { x: 80, y: 4 } });
    expect(cleaned).toBe('a\n\nb');
  });
});
