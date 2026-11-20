/**
 * The backlog's Priority and Updated columns size to `max(header + sort slot, content) + cell
 * padding` (task #1137), so a long translated header widens its column instead of painting into
 * the next one. The measurer is a stub: 10px per character plus the letter spacing it is given.
 */
import { describe, expect, it } from 'vitest';
import {
  CELL_PADDING_PX,
  DATE_BREATHING_PX,
  SORT_SLOT_PX,
  priorityColumnWidthPx,
  updatedColumnWidthPx,
  type TextMeasurer,
} from '../../src/renderer/components/backlog/view/column-widths';
import { PRIORITY_PILL_CHROME_PX } from '../../src/renderer/components/backlog/PriorityBadge';
import { priorityMeterWidth } from '../../src/renderer/components/backlog/PriorityMeter';

const measure: TextMeasurer = (text, _font, letterSpacingPx = 0) => text.length * 10 + letterSpacingPx * text.length;

const LONG_HEADER = 'PRIORITATSSTUFE-ZUGEORDNET';

function headerWidth(label: string): number {
  return measure(label.toUpperCase(), '', 11 * 0.05) + SORT_SLOT_PX;
}

describe('priorityColumnWidthPx', () => {
  it('uses the pill when it is wider than a short header', () => {
    const levelCount = 5;
    const pill = priorityMeterWidth(levelCount) + PRIORITY_PILL_CHROME_PX;
    expect(headerWidth('A')).toBeLessThan(pill);
    expect(priorityColumnWidthPx('A', levelCount, measure)).toBe(Math.ceil(pill + CELL_PADDING_PX));
  });

  it('widens to a header wider than the pill, so it never paints into the next column', () => {
    const levelCount = 5;
    const pill = priorityMeterWidth(levelCount) + PRIORITY_PILL_CHROME_PX;
    expect(headerWidth(LONG_HEADER)).toBeGreaterThan(pill);
    expect(priorityColumnWidthPx(LONG_HEADER, levelCount, measure)).toBe(
      Math.ceil(headerWidth(LONG_HEADER) + CELL_PADDING_PX),
    );
  });
});

describe('updatedColumnWidthPx', () => {
  const dates = ['now', '3 days ago', '11 months ago'];

  it('uses the widest date plus breathing room when the header is short', () => {
    const widest = Math.max(...dates.map((date) => measure(date, '')));
    expect(headerWidth('A')).toBeLessThan(widest + DATE_BREATHING_PX);
    expect(updatedColumnWidthPx('A', dates, measure)).toBe(Math.ceil(widest + DATE_BREATHING_PX + CELL_PADDING_PX));
  });

  it('widens to a header wider than every date, so it never paints into the next column', () => {
    const widest = Math.max(...dates.map((date) => measure(date, '')));
    expect(headerWidth(LONG_HEADER)).toBeGreaterThan(widest + DATE_BREATHING_PX);
    expect(updatedColumnWidthPx(LONG_HEADER, dates, measure)).toBe(
      Math.ceil(headerWidth(LONG_HEADER) + CELL_PADDING_PX),
    );
  });

  it('still sizes to the header when there are no date samples', () => {
    expect(updatedColumnWidthPx('A', [], measure)).toBe(Math.ceil(Math.max(headerWidth('A'), DATE_BREATHING_PX) + CELL_PADDING_PX));
  });
});
