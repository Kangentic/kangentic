import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Terminal, IBufferCell, IBufferLine } from '@xterm/xterm';
import type { SelectionRange } from '../../src/renderer/utils/terminal-blocks';

// Spy on `cleanSelectionLines` while keeping every other export (including the
// constants `classifyLine` uses) real, so `cleanTerminalSelection` can be
// proven to take (or skip) the buffer-read path without faking its own logic.
vi.mock('../../src/renderer/utils/terminal-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/utils/terminal-blocks')>();
  return {
    ...actual,
    cleanSelectionLines: vi.fn(actual.cleanSelectionLines),
  };
});

import { cleanSelectionLines, MIN_BOX_RUN_CELLS, MAX_BOX_RUN_START_COLUMN } from '../../src/renderer/utils/terminal-blocks';
import { createBufferLineSource, cleanTerminalSelection } from '../../src/renderer/utils/terminal-block-buffer';

// This module (`terminal-block-buffer.ts`) is the only place that reads real
// xterm cell attributes; `terminal-blocks.test.ts` covers the pure detector
// with hand-built `BlockLineFacts`, never exercising `classifyLine` itself.
// These tests build a minimal typed fake xterm buffer (no DOM, no real
// `@xterm/xterm` instance) to close that gap, plus cover the
// `cleanTerminalSelection` selection/fallback/throw branches.

type ColorSpec = { default: true } | { default: false; mode: 'rgb' | 'palette' | 'other'; value: number };

function defaultColor(): ColorSpec {
  return { default: true };
}

function rgbColor(value: number): ColorSpec {
  return { default: false, mode: 'rgb', value };
}

interface FakeCellSpec {
  chars: string;
  width?: number;
  fg?: ColorSpec;
  bg?: ColorSpec;
}

function makeCell(spec: FakeCellSpec): IBufferCell {
  const fg = spec.fg ?? defaultColor();
  const bg = spec.bg ?? defaultColor();
  const width = spec.width ?? 1;
  const cell = {
    getChars: () => spec.chars,
    getWidth: () => width,
    isFgDefault: () => fg.default,
    isFgRGB: () => !fg.default && fg.mode === 'rgb',
    isFgPalette: () => !fg.default && fg.mode === 'palette',
    getFgColor: () => (fg.default ? 0 : fg.value),
    isBgDefault: () => bg.default,
    isBgRGB: () => !bg.default && bg.mode === 'rgb',
    isBgPalette: () => !bg.default && bg.mode === 'palette',
    getBgColor: () => (bg.default ? 0 : bg.value),
  };
  return cell as unknown as IBufferCell;
}

// A sparse per-column cell list: index === buffer column. A missing index
// (hole or explicit undefined) renders as a blank default-fg/default-bg space.
interface FakeRowSpec {
  cells?: (FakeCellSpec | undefined)[];
  isWrapped?: boolean;
}

function makeLine(row: FakeRowSpec, cols: number): IBufferLine {
  const specs: FakeCellSpec[] = [];
  for (let column = 0; column < cols; column += 1) {
    specs.push(row.cells?.[column] ?? { chars: ' ' });
  }
  const cells = specs.map(makeCell);
  const line = {
    isWrapped: row.isWrapped ?? false,
    length: cols,
    getCell: (x: number): IBufferCell | undefined => cells[x],
    translateToString(trimRight = false, startColumn = 0, endColumn: number = cols): string {
      let text = '';
      for (let x = startColumn; x < endColumn; x += 1) {
        const spec = specs[x];
        if (!spec || (spec.width ?? 1) === 0) continue;
        text += spec.chars;
      }
      return trimRight ? text.replace(/\s+$/, '') : text;
    },
  };
  return line as unknown as IBufferLine;
}

function makeTerminal(rows: FakeRowSpec[], cols = 80, selection?: SelectionRange): Terminal {
  const lines = rows.map((row) => makeLine(row, cols));
  const buffer = {
    length: lines.length,
    getLine: (y: number): IBufferLine | undefined => lines[y],
    getNullCell: (): IBufferCell => makeCell({ chars: ' ' }),
  };
  const terminal = {
    cols,
    buffer: { active: buffer },
    getSelectionPosition: (): SelectionRange | undefined => selection,
  };
  return terminal as unknown as Terminal;
}

// Row builders mirroring the `plain` / `quote` helpers in terminal-blocks.test.ts,
// but at the cell level (real glyph + real fg color) instead of pre-classified facts.
function plainRow(text: string): FakeRowSpec {
  const cells: FakeCellSpec[] = [];
  for (let i = 0; i < text.length; i += 1) cells.push({ chars: text[i] });
  return { cells };
}

function quoteRow(afterBar: string, fgValue = 111): FakeRowSpec {
  const cells: FakeCellSpec[] = [{ chars: '▎', fg: rgbColor(fgValue) }];
  for (let i = 0; i < afterBar.length; i += 1) cells.push({ chars: afterBar[i] });
  return { cells };
}

describe('createBufferLineSource - quote bar detection (classifyLine)', () => {
  it('detects a bar glyph painted with a non-default foreground as a quote bar', () => {
    const terminal = makeTerminal([{ cells: [{ chars: '▎', fg: rgbColor(500) }] }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.quoteBar).toEqual({ column: 0, fgKey: 'rgb:500' });
  });

  it('does not treat a bar glyph in the default foreground as a quote bar', () => {
    const terminal = makeTerminal([{ cells: [{ chars: '▎', fg: defaultColor() }] }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.quoteBar).toBeNull();
  });
});

describe('createBufferLineSource - background run thresholds (classifyLine)', () => {
  it('detects a run of exactly MIN_BOX_RUN_CELLS starting at or before MAX_BOX_RUN_START_COLUMN', () => {
    const cells: FakeCellSpec[] = [];
    for (let x = 0; x < MIN_BOX_RUN_CELLS; x += 1) cells[x] = { chars: ' ', bg: rgbColor(777) };
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.bgRun).toEqual({ key: 'rgb:777', startColumn: 0, endColumn: MIN_BOX_RUN_CELLS });
  });

  it('does not detect a run one cell short of MIN_BOX_RUN_CELLS', () => {
    const cells: FakeCellSpec[] = [];
    for (let x = 0; x < MIN_BOX_RUN_CELLS - 1; x += 1) cells[x] = { chars: ' ', bg: rgbColor(777) };
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.bgRun).toBeNull();
  });

  it('does not detect a qualifying run that starts past MAX_BOX_RUN_START_COLUMN', () => {
    const startColumn = MAX_BOX_RUN_START_COLUMN + 1;
    const cells: FakeCellSpec[] = [];
    for (let x = 0; x < MIN_BOX_RUN_CELLS; x += 1) cells[startColumn + x] = { chars: ' ', bg: rgbColor(777) };
    const terminal = makeTerminal([{ cells }], startColumn + MIN_BOX_RUN_CELLS + 5);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.bgRun).toBeNull();
  });
});

describe('createBufferLineSource - hasDefaultFg (classifyLine)', () => {
  it('is true when the row has a non-space cell in the default foreground', () => {
    const terminal = makeTerminal([{ cells: [{ chars: 'h', fg: defaultColor() }] }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.hasDefaultFg).toBe(true);
  });

  it('is false when every non-space cell is a non-default foreground (a muted/thinking row)', () => {
    const cells: FakeCellSpec[] = [
      { chars: '✻', fg: rgbColor(9) },
      { chars: ' ' },
      { chars: 'C', fg: rgbColor(9) },
      { chars: 'o', fg: rgbColor(9) },
    ];
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    expect(facts.hasDefaultFg).toBe(false);
  });
});

describe('createBufferLineSource - width-0 (wide-char trailing) cells', () => {
  it('skips a width-0 cell for the first-glyph/quote-bar check', () => {
    const cells: FakeCellSpec[] = [
      { chars: '▎', fg: rgbColor(42), width: 0 },
      { chars: ' ' },
      { chars: '▎', fg: rgbColor(99) },
    ];
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    // If the width-0 guard were dropped, column 0's bar would win (fgKey
    // rgb:42) because it would be treated as the first non-space cell scanned.
    expect(facts.quoteBar).toEqual({ column: 2, fgKey: 'rgb:99' });
  });

  it('skips a width-0 cell for the hasDefaultFg check', () => {
    const cells: FakeCellSpec[] = [
      { chars: 'Z', fg: defaultColor(), width: 0 },
      { chars: ' ' },
      { chars: 'Q', fg: rgbColor(7) },
    ];
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    // If the width-0 guard were dropped, the default-fg cell at column 0 would
    // flip hasDefaultFg to true even though no real (width !== 0) cell has it.
    expect(facts.hasDefaultFg).toBe(false);
  });

  it('still counts a width-0 cell toward a background run', () => {
    const cells: FakeCellSpec[] = [];
    cells[0] = { chars: ' ', bg: rgbColor(555) };
    cells[1] = { chars: ' ', bg: rgbColor(555), width: 0 };
    for (let x = 2; x < MIN_BOX_RUN_CELLS; x += 1) cells[x] = { chars: ' ', bg: rgbColor(555) };
    const terminal = makeTerminal([{ cells }], 20);
    const facts = createBufferLineSource(terminal).getLine(0)!;
    // Excluding the width-0 cell would drop the run one cell short of
    // MIN_BOX_RUN_CELLS, so bgRun would be null instead of detected.
    expect(facts.bgRun).toEqual({ key: 'rgb:555', startColumn: 0, endColumn: MIN_BOX_RUN_CELLS });
  });
});

describe('cleanTerminalSelection', () => {
  beforeEach(() => {
    vi.mocked(cleanSelectionLines).mockClear();
  });

  it('returns the injected fallback verbatim when there is no selection, without invoking cleanSelectionLines', () => {
    const terminal = makeTerminal([plainRow('hello')], 20, undefined);
    const fallbackSentinel = 'FALLBACK_NO_SELECTION_SENTINEL';
    const result = cleanTerminalSelection(terminal, () => fallbackSentinel);
    expect(result).toBe(fallbackSentinel);
    expect(cleanSelectionLines).not.toHaveBeenCalled();
  });

  it('cleans a selection over quote-decorated rows via the real buffer classifier (not the fallback)', () => {
    const rows: FakeRowSpec[] = [
      plainRow('Lorem ipsum dolor sit amet.'),
      quoteRow(''),
      quoteRow(' Sed do eiusmod tempor incididunt.'),
      quoteRow(''),
      quoteRow(' Duis aute irure dolor.'),
    ];
    const terminal = makeTerminal(rows, 80, { start: { x: 0, y: 0 }, end: { x: 80, y: 4 } });
    const fallbackSentinel = 'FALLBACK_SHOULD_NOT_APPEAR';
    const result = cleanTerminalSelection(terminal, () => fallbackSentinel);
    expect(result).toBe(
      'Lorem ipsum dolor sit amet.\n\nSed do eiusmod tempor incididunt.\n\nDuis aute irure dolor.',
    );
    expect(result).not.toBe(fallbackSentinel);
    expect(cleanSelectionLines).toHaveBeenCalledTimes(1);
  });

  it('falls back when the buffer read throws', () => {
    const terminal = makeTerminal([plainRow('hello')], 20, { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } });
    (terminal.buffer.active as unknown as { getLine: () => never }).getLine = () => {
      throw new Error('simulated buffer read failure');
    };
    const fallbackSentinel = 'FALLBACK_ON_THROW_SENTINEL';
    const result = cleanTerminalSelection(terminal, () => fallbackSentinel);
    expect(result).toBe(fallbackSentinel);
  });
});
