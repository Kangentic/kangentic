/**
 * The backlog Labels cell (task #1142) shows as many labels as fit on one line and folds the rest
 * into a "+N" chip. The fit is computed from the label text, so a wrong reserve paints the chip
 * past the cell or hides a label that had room. The measurer is a stub: 10px per character, plus
 * 5px per character at medium weight.
 */
import { describe, expect, it } from 'vitest';
import {
  LABEL_PILL_BORDER_PX,
  LABEL_PILL_GAP_PX,
  LABEL_PILL_MIN_PX,
  LABEL_PILL_PADDING_PX,
  fitLabels,
  labelPillWidthPx,
  layoutLabels,
  type TextMeasurer,
} from '../../src/renderer/components/backlog/view/column-widths';

const measure: TextMeasurer = (text, font) => text.length * (font.startsWith('500 ') ? 15 : 10);
const chipWidth = (hiddenCount: number) => labelPillWidthPx(`+${hiddenCount}`, false, measure, 'sans-serif');

describe('labelPillWidthPx', () => {
  it('adds the pill padding to the text, and the border and weight for a colored label', () => {
    expect(labelPillWidthPx('feature', false, measure, 'sans-serif')).toBe(70 + LABEL_PILL_PADDING_PX);
    expect(labelPillWidthPx('feature', true, measure, 'sans-serif')).toBe(105 + LABEL_PILL_PADDING_PX + LABEL_PILL_BORDER_PX);
  });

  it('never goes under the pill minimum', () => {
    expect(labelPillWidthPx('a', false, measure, 'sans-serif')).toBe(LABEL_PILL_MIN_PX);
  });
});

describe('fitLabels', () => {
  it('shows every label when they all fit, with no chip reserved', () => {
    // 50 + 4 + 50 + 4 + 50 = 158: exactly the room.
    expect(fitLabels([50, 50, 50], 158, chipWidth)).toBe(3);
  });

  it('reserves the chip for the rest when they do not all fit', () => {
    // Without the reserve two labels (104) would fit 140; with the chip and its gap only one does.
    expect(fitLabels([50, 50, 50], 140, chipWidth)).toBe(1);
    // Two labels, a gap and the "+1" chip: 148, still short of the 158 all three need.
    expect(fitLabels([50, 50, 50], 104 + LABEL_PILL_GAP_PX + chipWidth(1), chipWidth)).toBe(2);
  });

  it('reserves a two-digit chip at its own, wider, width', () => {
    const labelsOf = (count: number) => Array.from({ length: count }, () => 40);
    // Two labels and a one-digit chip fit 130px; two labels and a two-digit chip do not.
    expect(40 + LABEL_PILL_GAP_PX + 40 + LABEL_PILL_GAP_PX + chipWidth(8)).toBeLessThanOrEqual(130);
    expect(40 + LABEL_PILL_GAP_PX + 40 + LABEL_PILL_GAP_PX + chipWidth(11)).toBeGreaterThan(130);
    expect(fitLabels(labelsOf(10), 130, chipWidth)).toBe(2);
    expect(fitLabels(labelsOf(13), 130, chipWidth)).toBe(1);
  });

  it('always shows the first label, even one wider than the whole cell', () => {
    expect(fitLabels([400], 236, chipWidth)).toBe(1);
    expect(fitLabels([400, 50], 236, chipWidth)).toBe(1);
  });

  it('shows nothing for a row with no labels', () => {
    expect(fitLabels([], 236, chipWidth)).toBe(0);
  });
});

describe('layoutLabels', () => {
  const widthOf = (text: string, colored = false) => labelPillWidthPx(text, colored, measure, 'sans-serif');
  const layout = (labels: string[], labelColors: Record<string, string>, availablePx?: number) =>
    layoutLabels(labels, labelColors, measure, 'sans-serif', availablePx);

  it('counts a colored label at its wider weight and border', () => {
    const labels = ['aaaa', 'bbbb', 'cccc'];
    const allFit = widthOf('aaaa') + widthOf('bbbb') + widthOf('cccc') + 2 * LABEL_PILL_GAP_PX;
    expect(layout(labels, {}, allFit).shownCount).toBe(3);
    // Coloring one label widens it past the room, so one label no longer fits.
    expect(layout(labels, { aaaa: '#3b82f6' }, allFit).shownCount).toBeLessThan(3);
  });

  it('truncates a first label that fits alone but not beside the chip', () => {
    const firstWidth = widthOf('aaaa');
    const result = layout(['aaaa', 'bbbb'], {}, firstWidth + 10);
    expect(result).toEqual({ shownCount: 1, firstTruncates: true });
  });

  it('does not truncate a first label exactly at its room', () => {
    const firstWidth = widthOf('aaaa');
    const room = firstWidth + LABEL_PILL_GAP_PX + chipWidth(1);
    expect(layout(['aaaa', 'bbbb'], {}, room)).toEqual({ shownCount: 1, firstTruncates: false });
    // One pixel less and it has to shrink.
    expect(layout(['aaaa', 'bbbb'], {}, room - 1).firstTruncates).toBe(true);
  });

  it('reports nothing for no labels, and no truncation when all fit', () => {
    expect(layout([], {})).toEqual({ shownCount: 0, firstTruncates: false });
    expect(layout(['bug', 'ui'], {})).toEqual({ shownCount: 2, firstTruncates: false });
  });
});
