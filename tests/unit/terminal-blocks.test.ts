import { describe, it, expect } from 'vitest';
import {
  findBlockAt,
  extractBlockContent,
  cleanSelectionLines,
  BAR_GLYPHS,
  MIN_BOX_RUN_CELLS,
  MAX_BOX_RUN_START_COLUMN,
  MAX_MESSAGE_LOOKBACK_ROWS,
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

function makeSource(lines: FakeLine[], cols = 80): BlockLineSource {
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
    getLine: (y) => facts[y],
  };
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
