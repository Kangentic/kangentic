import { describe, it, expect } from 'vitest';
import { matchTuiViewportToRow } from '../../src/renderer/components/conversation/tui-anchor';
import { reconcileDisplayRows } from '../../src/renderer/components/conversation/display-rows';
import type { TranscriptEntry } from '../../src/shared/types';

/**
 * `matchTuiViewportToRow` maps a terminal's visible scrollback lines (at the
 * moment a conversation viewer was opened) to the transcript row it was most
 * likely showing, so the viewer can open centered there. Covers: an exact
 * match, a match despite whitespace/formatting noise, a tie broken toward
 * the LATEST occurrence, pure noise producing no match, and the zero-match
 * fallback.
 */

function rowsFrom(entries: TranscriptEntry[]) {
  return reconcileDisplayRows([], entries);
}

/** A line long enough (>= 16 normalized chars) to count as real signal. */
function longLine(text: string): string {
  return text.padEnd(20, ' filler');
}

describe('matchTuiViewportToRow', () => {
  it('matches the row whose text exactly contains the sampled viewport lines', () => {
    const rows = rowsFrom([
      { kind: 'user', uuid: 'u1', ts: 1, text: 'run the failing test suite please' },
      { kind: 'assistant', uuid: 'a1', ts: 2, blocks: [{ type: 'text', text: 'Running the full test suite now to reproduce the failure' }] },
    ]);
    const visibleLines = [
      '  some terminal chrome  ',
      'Running the full test suite now to reproduce the failure',
      '  more chrome  ',
    ];

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBe('a1');
  });

  it('matches despite ANSI-adjacent formatting noise (box-drawing chars, extra spaces, case differences)', () => {
    const rows = rowsFrom([
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'Editing the config file to add the new option' }] },
    ]);
    const visibleLines = ['│ EDITING   the    config--file to add the NEW option │'];

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBe('a1');
  });

  it('breaks a tie between two equally-matching rows toward the LATEST one', () => {
    const rows = rowsFrom([
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: longLine('running the exact same command again here') }] },
      { kind: 'user', uuid: 'u2', ts: 2, text: 'unrelated middle turn with its own filler text' },
      { kind: 'assistant', uuid: 'a3', ts: 3, blocks: [{ type: 'text', text: longLine('running the exact same command again here') }] },
    ]);
    const visibleLines = ['running the exact same command again here'];

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBe('a3');
  });

  it('returns null when the visible lines are pure noise (too short to count as signal)', () => {
    const rows = rowsFrom([
      { kind: 'user', uuid: 'u1', ts: 1, text: 'a substantial user turn with real content in it' },
    ]);
    const visibleLines = ['$', '>', '---', 'ok', ''];

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBeNull();
  });

  it('returns null when no row contains any of the sampled lines', () => {
    const rows = rowsFrom([
      { kind: 'user', uuid: 'u1', ts: 1, text: 'a substantial user turn with real content in it' },
    ]);
    const visibleLines = ['this text appears nowhere in the transcript at all'];

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBeNull();
  });

  it('returns null for an empty viewport or an empty row list', () => {
    const rows = rowsFrom([{ kind: 'user', uuid: 'u1', ts: 1, text: 'some real content here for the row' }]);

    expect(matchTuiViewportToRow([], rows)).toBeNull();
    expect(matchTuiViewportToRow(['a real line of terminal content here'], [])).toBeNull();
  });

  it('samples lines from the CENTER of a long viewport, not the edges', () => {
    const rows = rowsFrom([
      { kind: 'assistant', uuid: 'edge', ts: 1, blocks: [{ type: 'text', text: 'this text only appears at the very edge of the viewport sample' }] },
      { kind: 'assistant', uuid: 'center', ts: 2, blocks: [{ type: 'text', text: 'this text only appears in the vertical center of the viewport' }] },
    ]);
    // 40 lines: edge-matching content at index 0 (far outside the ~10-line
    // center sample), center-matching content around the middle.
    const visibleLines = Array.from({ length: 40 }, (_, index) => {
      if (index === 0) return 'this text only appears at the very edge of the viewport sample';
      if (index === 20) return 'this text only appears in the vertical center of the viewport';
      return `filler line number ${index} with enough characters to pass the length floor`;
    });

    const matched = matchTuiViewportToRow(visibleLines, rows);

    expect(matched).toBe('center');
  });

  it('scales the sample window to the captured terminal\'s own height, not a fixed line count', () => {
    const rows = rowsFrom([
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: longLine('the only substantive line in a short terminal capture') }] },
    ]);
    // A short (12-line) capture: the fixed-10-line sample used to nearly
    // consume the whole thing anyway, but scaling (30%, floored at 6) must
    // still land squarely on center content in a viewport this small.
    const shortCapture = [
      'chrome', 'chrome', 'chrome', 'chrome',
      'the only substantive line in a short terminal capture',
      'chrome', 'chrome', 'chrome', 'chrome', 'chrome', 'chrome', 'chrome',
    ];

    expect(matchTuiViewportToRow(shortCapture, rows)).toBe('a1');
  });

  it('samples a wider window from a much taller terminal capture than from a short one', () => {
    const rows = rowsFrom([
      { kind: 'assistant', uuid: 'far', ts: 1, blocks: [{ type: 'text', text: longLine('content sitting further out from dead center') }] },
    ]);
    // 80 lines tall: content 8 lines off center (outside the old fixed
    // 10-line sample [35,45), but within the scaled sample - clamped at the
    // 20-line max - which spans [30,50)).
    const tallCapture = Array.from({ length: 80 }, (_, index) => {
      if (index === 48) return 'content sitting further out from dead center';
      return `filler line number ${index} with enough characters to pass the length floor`;
    });

    expect(matchTuiViewportToRow(tallCapture, rows)).toBe('far');
  });
});
