/**
 * Unit tests for the composed-width measurement
 * (src/devtools/main/composed-width.ts): the width a child TUI is actually
 * composing rows at, read from its own byte stream.
 *
 * This is the third layer beside the pty-vs-grid invariants. The defect it
 * exists for (task 573): a resize applied in the spawn window never reaches
 * the child, which then composes 120-column rows inside a 306-column PTY -
 * every pty-vs-grid invariant reads healthy because Kangentic set both sides
 * itself. The measurement must read the 120 out of the bytes.
 */
import { describe, it, expect } from 'vitest';
import {
  measureComposedCols,
  COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS,
} from '../../src/devtools/main/composed-width';
import { TUI_SETUP, DEFECTIVE_JUMP_FRAME } from '../fixtures/claude-code-frames';

const ALT = '\x1b[?1049h';

describe('measureComposedCols', () => {
  it('reads the glued-rows defect: a child composing 120 inside a wider PTY', () => {
    // The shape from the live capture: full-width rules and padding rows at
    // the child's believed width, relying on autowrap that never fires because
    // the real terminal is wider.
    const stream =
      ALT +
      ('\x1b[H' + '─'.repeat(120) + '\r\n' + ' '.repeat(120) + '\r\n' + 'text\x1b[K\r\n').repeat(3);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(120);
    expect(measurement.sampleCount).toBeGreaterThanOrEqual(2);
  });

  it('measures 210 from the REAL captured Claude Code frame', () => {
    // Genuine bytes at 210 columns: three 210-space padding rows, a 210-rule,
    // and a 177-rule that must NOT win (the 177 partial rule is unexplained
    // noise the fold must shrug off, not evidence).
    const measurement = measureComposedCols(TUI_SETUP + DEFECTIVE_JUMP_FRAME);
    expect(measurement.composedCols).toBe(210);
    expect(measurement.sampleCount).toBeGreaterThanOrEqual(4);
  });

  it('excludes bytes before the last alt-screen entry', () => {
    // A shell `cat` of a 500-char divider before the TUI booted must not vote:
    // outside the alternate buffer, run length says nothing about width.
    const stream = '='.repeat(500) + ALT + ('─'.repeat(120) + '\r\n').repeat(3);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(120);
  });

  it('prefers the window after the last clear-screen (a heal repaints from 2J)', () => {
    // Stale wide runs composed at 306 before the heal, then a clear-screen
    // repaint at the corrected 120. The verdict must follow the repaint.
    const stream =
      ALT +
      ('─'.repeat(306) + '\r\n').repeat(3) +
      '\x1b[2J' +
      ('─'.repeat(120) + '\r\n').repeat(4);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(120);
  });

  it('falls back to the full window when the post-2J slice is too thin', () => {
    // Fewer than COMPOSED_WIDTH_MIN_WINDOW_SAMPLES candidates after the clear:
    // one sample is not enough to overrule the rest of the window.
    const stream =
      ALT + ('─'.repeat(306) + '\r\n').repeat(3) + '\x1b[2J' + '─'.repeat(120) + '\r\n';
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(306);
  });

  it('counts ECH erase spans as width votes', () => {
    const stream = ALT + '\x1b[210X\r\n'.repeat(3);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(210);
    expect(measurement.sampleCount).toBe(3);
  });

  it('splits runs at escape sequences so SGR params neither merge nor extend a run', () => {
    // Two 60-rules separated by a color change are two 60-candidates, never a
    // 120-run - and the SGR digits themselves must not count as content.
    const stream = ALT + '─'.repeat(60) + '\x1b[38;5;1m' + '─'.repeat(60);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(60);
    expect(measurement.sampleCount).toBe(2);
  });

  it('measures wide glyphs in columns via the Unicode 11 table, not code units', () => {
    // 30 CJK wide characters span 60 columns. A code-unit counter reads 30,
    // which is below the signal floor and would yield null.
    const stream = ALT + '漢'.repeat(30);
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(60);
  });

  it('folds an autowrap-concatenated double row back to the base width (live 2026-08-29 false red)', () => {
    // Claude pads rows to full width and reaches the next row by AUTOWRAP, not
    // CR/LF, so two adjacent same-glyph rows arrive as ONE 2W-length run.
    // Measured live: a healthy 306-column session produced nine 612-length
    // runs and the max aggregate called it a 612-column child. The evidence
    // 612 is ambiguous between {612, 306, 204, 153, ...}; the reference grid
    // breaks that tie.
    const measurement = measureComposedCols(ALT + '─'.repeat(612), 306);
    expect(measurement.composedCols).toBe(306);
  });

  it('needs no reference once a single-height row joins the concatenated one', () => {
    // A 306 row plus a 612 double-row: base 306 explains both, base 612 only
    // one, so the evidence alone settles it.
    const measurement = measureComposedCols(
      ALT + '─'.repeat(612) + '\r\n' + '─'.repeat(306),
    );
    expect(measurement.composedCols).toBe(306);
    expect(measurement.sampleCount).toBe(2);
  });

  it('the reference tie-break cannot manufacture agreement for a truly divergent child', () => {
    // A child composing 120 that glued five rows via autowrap (600) plus two
    // single rows: base 120 explains all three candidates; nothing near the
    // 306 reference explains more, so the verdict stays 120.
    const measurement = measureComposedCols(
      ALT + '─'.repeat(600) + '\r\n' + '─'.repeat(120) + '\r\n' + '─'.repeat(120),
      306,
    );
    expect(measurement.composedCols).toBe(120);
  });

  it('a sub-multiple base cannot out-explain the truth with near-miss noise (live 2026-08-29 histogram)', () => {
    // The measured multiset from a live healthy 306-column frame: exact-width
    // rules and 2x-wrapped padding rows (the signal), plus arbitrary-length
    // content-padding remainders (ECH 301/236, spaces 264/297) that fit no
    // width. Under a k-scaled tolerance, base 102 claimed the ECH-301 spans
    // at k=3 (off 5, slack 6) that 306 rightly rejected (off 5, slack 2) and
    // won the fold. The verdict must be 306.
    const stream =
      ALT +
      ('─'.repeat(306) + '\r\n').repeat(12) +
      (' '.repeat(612) + '\r\n').repeat(3) +
      '\x1b[301X\r\n'.repeat(6) +
      '\x1b[236X\r\n'.repeat(5) +
      (' '.repeat(264) + '\r\n').repeat(3) +
      (' '.repeat(297) + '\r\n').repeat(3);
    const measurement = measureComposedCols(stream, 306);
    expect(measurement.composedCols).toBe(306);
    expect(measurement.sampleCount).toBe(15);
  });

  it('a dense sub-width lattice cannot out-vote a reference-consistent child (live 2026-08-29 WSL probe)', () => {
    // A healthy 120-column child (never resized, so healthy by construction)
    // whose busy frame carries 40- and 80-column indent runs alongside its
    // 120-rules and 240 wrapped pads. Every multiple of 120 is also one of
    // 40, so base 40 strictly dominated the fold and read the session as
    // stuck at 40. The reference-consistency pre-filter keeps the verdict on
    // the physically-bounded evidence: only a child believing 120 can emit
    // runs at k*120.
    const stream =
      ALT +
      ('─'.repeat(120) + '\r\n').repeat(4) +
      ' '.repeat(240) + '\r\n' +
      (' '.repeat(40) + 'indented text\r\n').repeat(8) +
      (' '.repeat(80) + 'deeper\r\n').repeat(5);
    const measurement = measureComposedCols(stream, 120);
    expect(measurement.composedCols).toBe(120);
    expect(measurement.sampleCount).toBe(5);
  });

  it('structural mass names the true width against dense sub-width noise (task #573 live histogram)', () => {
    // The 2026-08-30 recurrence: a child composing 120 inside a 306 PTY. Its
    // measured ring carried 95 full-width rules at 120 alongside box borders
    // and dividers at 40/47/73/80 and sub-width ECH spans (84/108/115).
    // Count-scored folding named base 46, and the base-40 lattice explains
    // every 120-multiple plus the stray indents, edging out the truth on any
    // bare count. Sub-linear length weighting keeps the 40-lattice inside the
    // near-tie band instead of ahead, and the reference tie-break then names
    // 120 - the width carrying virtually all the structural evidence.
    const stream =
      ALT +
      ('─'.repeat(120) + '\r\n').repeat(95) +
      ('─'.repeat(47) + '\r\n').repeat(21) +
      ('─'.repeat(73) + '\r\n').repeat(21) +
      (' '.repeat(40) + 'indent\r\n').repeat(7) +
      (' '.repeat(80) + 'indent\r\n').repeat(7) +
      '\x1b[84X\r\n'.repeat(20) +
      '\x1b[108X\r\n'.repeat(20) +
      '\x1b[115X\r\n'.repeat(20);
    const measurement = measureComposedCols(stream, 306);
    expect(measurement.composedCols).toBe(120);
    expect(measurement.sampleCount).toBe(95);
  });

  it('returns null when nothing in the window qualifies', () => {
    const stream =
      ALT + '─'.repeat(COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS - 1) + '\r\nplain prose text\r\n';
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBeNull();
    expect(measurement.sampleCount).toBe(0);
  });

  it('returns null for an empty ring', () => {
    const measurement = measureComposedCols('');
    expect(measurement.composedCols).toBeNull();
  });

  it('bounds the scan to the last COMPOSED_WIDTH_TAIL_CHARS: a long-running session cannot be out-voted by rows that scrolled out of the window', () => {
    // The realistic long-running-session shape: no alt-screen marker anywhere
    // in the stream at all - the entry scrolled out of the ring long ago.
    // ~60KB of stale 200-column rows precede a repaint at the corrected
    // 306-column width. Without the tail bound the 300 stale 200-candidates
    // would out-vote the 160 healthy 306-candidates on raw explained count
    // (300 > 160); the tail must exclude the stale rows entirely rather than
    // merely being outweighed by them.
    const staleRows = ('─'.repeat(200) + '\r\n').repeat(300);
    // 160 rows of 308 chars (306 dashes + \r\n) is 49280 code units, itself
    // past COMPOSED_WIDTH_TAIL_CHARS (49152) - the 48KB tail lands entirely
    // inside healthyRows, 128 code units short of its start, so no 200-column
    // row ever reaches the scan.
    const healthyRows = ('─'.repeat(306) + '\r\n').repeat(160);
    const stream = staleRows + healthyRows;
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(306);
  });

  it('caps the autowrap explanation at COMPOSED_WIDTH_MAX_WRAP_MULTIPLE: a 7x run is not folded into the base', () => {
    // composedCols alone cannot discriminate this bound: base 100 wins the
    // fold whether or not the 700-length run (7x100, one past the k<=6 cap)
    // is explained by it. sampleCount is the field that moves: 3 with the
    // cap enforced (only the three 100-candidates explained), 4 if the cap
    // were raised or removed (the 700-candidate would join them).
    const stream =
      ALT + ['─'.repeat(100), '─'.repeat(100), '─'.repeat(100), '─'.repeat(700)].join('\r\n');
    const measurement = measureComposedCols(stream);
    expect(measurement.composedCols).toBe(100);
    expect(measurement.sampleCount).toBe(3);
  });
});
