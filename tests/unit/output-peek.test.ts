import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectPeekLines,
  extractPeekLines,
  peeksEqual,
  PEEK_LINE_COUNT,
  PEEK_MAX_LINE_LENGTH,
} from '../../src/main/pty/buffer/output-peek';

/**
 * The Agent Monitor's output peek, pinned against REAL captured grids rather
 * than hand-authored ones. Both fixtures came out of
 * `scripts/probe-terminal-peek-grid.js` against live sessions; see their
 * `$comment` fields.
 *
 * The fullscreen-TUI fixture is the whole reason this rule is not the obvious
 * one. Its bottom three rows are a composer border, the composer's prompt row,
 * and a mode line, so "last N non-empty lines" returns pure chrome. The
 * assertions below therefore check the EXCLUSIONS explicitly, not just the happy
 * path: a future simplification back to a bottom-anchored rule has to go red.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const GRID_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'terminal-grids');

interface GridFixture {
  label: string;
  inAltScreen: boolean;
  cursorRow: number;
  lines: string[];
}

function readGrid(name: string): GridFixture {
  return JSON.parse(fs.readFileSync(path.join(GRID_DIR, `${name}.json`), 'utf-8'));
}

const claudeGrid = readGrid('claude-fullscreen-tui');
const shellGrid = readGrid('powershell-normal-buffer');

describe('extractPeekLines: fullscreen TUI (captured Claude Code grid)', () => {
  // Explicit 3 here rather than the default: these tests are about WHICH lines the
  // rule selects, and the card renders three whenever it also has label pills to
  // fit. The default's larger budget is pinned separately below.
  const peek = extractPeekLines(claudeGrid.lines, claudeGrid.cursorRow, 3);

  it('returns the tail of what the agent actually said', () => {
    expect(peek).toEqual(['  2. Green', '  3. Amber', '✻ Cooked for 3s']);
  });

  it('excludes the composer, its borders, and the mode line', () => {
    // These three ARE the last three non-empty lines of this grid. If the rule
    // ever reverts to a bottom-anchored scan, this is what a monitor card would
    // display, and this assertion is what catches it.
    const joined = peek.join('\n');
    expect(joined, 'the composer prompt row leaked into the peek').not.toContain('❯ ');
    expect(joined, 'the mode line leaked into the peek').not.toContain('plan mode on');
    // Code points, not a literal regex class: the range's own endpoints ARE
    // box-drawing glyphs, so writing it as a character class would embed the very
    // characters this rule exists to filter out. Mirrors the reasoning the source
    // states for isDecorativeGlyph.
    const isDecorative = (character: string): boolean => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x2500 && codePoint <= 0x259f;
    };
    for (const line of peek) {
      const trimmed = line.trim();
      const isPureRuleLine = trimmed.length > 0
        && [...trimmed].every((character) => character === ' ' || isDecorative(character));
      expect(
        isPureRuleLine,
        `a pure rule line leaked into the peek: ${JSON.stringify(line)}`,
      ).toBe(false);
    }
  });

  it('strips the startup banner art and keeps the text beside it', () => {
    // The three banner rows draw a logo in a left column with real text beside
    // it, so they are not WHOLLY decorative and the whole-line rule misses them.
    // Rendered at card size the art is noise, and it was consuming all three peek
    // lines of a freshly opened terminal, which is exactly when the card most
    // needs to say something. Red-green: without the prefix strip these come back
    // with a column of block glyphs in front of every line.
    const lastBannerRow = claudeGrid.lines.findIndex((line) => line.includes('worktrees'));
    expect(lastBannerRow).toBeGreaterThan(-1);
    expect(extractPeekLines(claudeGrid.lines, lastBannerRow + 1, 3)).toEqual([
      'Claude Code v2.1.220',
      'Sonnet 5 with medium effort · Claude Max',
      '~\\Documents\\GitHub\\kangentic\\.kangentic\\worktrees\\472',
    ]);
  });
});

describe('extractPeekLines: the default budget', () => {
  it('matches the most a card ever draws, since the well is a fixed height', () => {
    // The card renders four rows, or two when label pills share the space. The
    // well does not grow with its content, so anything beyond four lines would
    // be extracted and shipped on every push only to be discarded.
    expect(PEEK_LINE_COUNT).toBe(4);
    expect(extractPeekLines(claudeGrid.lines, claudeGrid.cursorRow)).toHaveLength(PEEK_LINE_COUNT);
  });

  it('grows backwards in time, so a smaller count is a suffix of a larger one', () => {
    // The card trims with `slice(-rows)` to fit its two-row form. That only keeps
    // the RIGHT lines because ordering is oldest-first, which this pins.
    const full = extractPeekLines(claudeGrid.lines, claudeGrid.cursorRow);
    for (const count of [1, 2, 3, 4]) {
      expect(extractPeekLines(claudeGrid.lines, claudeGrid.cursorRow, count)).toEqual(full.slice(-count));
    }
  });

  it('ends on the newest line whatever the count', () => {
    const full = extractPeekLines(claudeGrid.lines, claudeGrid.cursorRow);
    expect(full[full.length - 1]).toBe('✻ Cooked for 3s');
  });
});

describe('collectPeekLines: how much of the grid it touches', () => {
  // The sampler runs this against every session that produced output, twice a
  // second, and each row costs an xterm cell-walk plus a string allocation. These
  // pin the read cost rather than just the result.
  function countingReader(lines: readonly string[]) {
    const readRows: number[] = [];
    return {
      readRows,
      readLine: (row: number) => {
        readRows.push(row);
        return lines[row];
      },
    };
  }

  it('never reads at or below the cursor row', () => {
    // Everything from the cursor down is the composer and the chrome under it.
    // Reading it would be wasted work even before the rule discards it.
    const { readRows, readLine } = countingReader(claudeGrid.lines);
    collectPeekLines(readLine, claudeGrid.cursorRow, PEEK_LINE_COUNT, 0);
    expect(Math.max(...readRows)).toBeLessThan(claudeGrid.cursorRow);
  });

  it('stops as soon as it has enough lines', () => {
    // Red-green for a regression to snapshotting the viewport: against this
    // 30-row grid a full read is 27 rows, while the walk needs 21 to gather four.
    const { readRows, readLine } = countingReader(claudeGrid.lines);
    const collected = collectPeekLines(readLine, claudeGrid.cursorRow, 1, 0);
    expect(collected).toHaveLength(1);
    // Row 26 is a rule and rows 25-13 are blank, so the first KEEPER is row 12.
    expect(readRows).toEqual([26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12]);
  });

  it('honours the floor so a blank grid cannot walk to row zero', () => {
    const { readRows, readLine } = countingReader([]);
    expect(collectPeekLines(readLine, 500, 3, 480)).toEqual([]);
    expect(readRows).toHaveLength(20);
    expect(Math.min(...readRows)).toBe(480);
  });

  it('reads nothing at all for a non-positive count', () => {
    const { readRows, readLine } = countingReader(claudeGrid.lines);
    expect(collectPeekLines(readLine, claudeGrid.cursorRow, 0, 0)).toEqual([]);
    expect(readRows).toHaveLength(0);
  });
});

describe('extractPeekLines: decorative prefixes', () => {
  it('leaves ordinary indentation alone', () => {
    // Indentation carries the shape of real output, so only a run that actually
    // contains a glyph is stripped.
    expect(extractPeekLines(['    indented output'], 1, 1)).toEqual(['    indented output']);
  });

  it('keeps marker glyphs that sit outside the art ranges', () => {
    // The bullet, spinner and prompt markers anchor a line and are not block art,
    // so they must survive. This is what keeps a peek readable rather than a wall
    // of unattributed text.
    const lines = ['● tool finished', '✻ Cooked for 3s', '❯ npm test'];
    expect(extractPeekLines(lines, lines.length, 3)).toEqual(lines);
  });

  it('does not invent a blank line from an all-art row', () => {
    // Belt and braces: such a row is already dropped as wholly decorative, and if
    // that ever stops holding the strip must not turn it into an empty line.
    expect(extractPeekLines(['alpha', '▛▜▛▜'], 2, 2)).toEqual(['alpha']);
  });
});

describe('extractPeekLines: normal buffer (captured PowerShell grid)', () => {
  const peek = extractPeekLines(shellGrid.lines, shellGrid.cursorRow, 3);

  it("returns the command's output, not the trailing prompt", () => {
    expect(peek).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('excludes the prompt the cursor sits on', () => {
    expect(peek.join('\n')).not.toContain('PS C:');
  });
});

describe('extractPeekLines: one rule covers both buffer kinds', () => {
  it('needs no alt-screen branch', () => {
    // The two fixtures disagree on inAltScreen, and the same call handles both.
    // This is why `extractPeekLines` takes no such flag: if it ever needs one,
    // this test is the place that argument gets made.
    expect(claudeGrid.inAltScreen).toBe(true);
    expect(shellGrid.inAltScreen).toBe(false);
    for (const grid of [claudeGrid, shellGrid]) {
      const peek = extractPeekLines(grid.lines, grid.cursorRow);
      expect(peek.length, `${grid.label} produced no peek`).toBeGreaterThan(0);
      expect(peek.length).toBeLessThanOrEqual(PEEK_LINE_COUNT);
    }
  });
});

describe('extractPeekLines: edges', () => {
  it('reports nothing when the cursor is at the top', () => {
    expect(extractPeekLines(['alpha', 'bravo'], 0)).toEqual([]);
  });

  it('treats a negative cursor row as nothing to report, not as the whole buffer', () => {
    // Clamping the other way would surface exactly the composer rows the rule
    // exists to exclude, on a malformed read.
    expect(extractPeekLines(['alpha', 'bravo'], -5)).toEqual([]);
  });

  it('clamps a cursor row past the end to the available lines', () => {
    expect(extractPeekLines(['alpha', 'bravo'], 99)).toEqual(['alpha', 'bravo']);
  });

  it('returns nothing for a non-positive count', () => {
    expect(extractPeekLines(shellGrid.lines, shellGrid.cursorRow, 0)).toEqual([]);
  });

  it('skips blank rows rather than counting them', () => {
    const lines = ['alpha', '', '   ', 'bravo', '', 'charlie', ''];
    expect(extractPeekLines(lines, lines.length, 3)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('caps a very wide line so the payload stays bounded', () => {
    const wide = 'x'.repeat(PEEK_MAX_LINE_LENGTH + 50);
    const [only] = extractPeekLines([wide], 1, 1);
    expect(only).toHaveLength(PEEK_MAX_LINE_LENGTH);
  });

  it('strips trailing padding but preserves leading indentation', () => {
    expect(extractPeekLines(['    indented   '], 1, 1)).toEqual(['    indented']);
  });
});

describe('peeksEqual', () => {
  it('is the change-gate: equal content never re-sends', () => {
    expect(peeksEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(peeksEqual(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(peeksEqual(['a'], ['a', 'b'])).toBe(false);
    expect(peeksEqual([], [])).toBe(true);
  });
});
