import { DATA_TABLE_CELL_PADDING_X_PX } from '../../DataTable';
import { PRIORITY_PILL_CHROME_PX } from '../PriorityBadge';
import { priorityMeterWidth } from '../PriorityMeter';
import { bodyFontFamily } from '../../../utils/text-measure';

/** Measures `text` at a CSS font shorthand, plus letter spacing after each character. */
export type TextMeasurer = (text: string, font: string, letterSpacingPx?: number) => number;

export const CELL_PADDING_PX = DATA_TABLE_CELL_PADDING_X_PX;
/** The header's sort arrow slot (`w-3`) and the `gap-1` before it. */
export const SORT_SLOT_PX = 16;
/** Room between the longest date and the row's menu button. */
export const DATE_BREATHING_PX = 8;

/** A column header's text: 11px semibold, upper case, 0.05em tracking (DataTable's header classes). */
export function headerLabelWidth(label: string, measure: TextMeasurer): number {
  return measure(label.toUpperCase(), `600 11px ${bodyFontFamily()}`, 11 * 0.05);
}

/**
 * The Priority column: the wider of its header (label plus sort slot) and the priority pill,
 * plus the cell's padding. A long translated header widens the column rather than painting into
 * the next one.
 */
export function priorityColumnWidthPx(headerLabel: string, levelCount: number, measure: TextMeasurer): number {
  const header = headerLabelWidth(headerLabel, measure) + SORT_SLOT_PX;
  const pill = priorityMeterWidth(levelCount) + PRIORITY_PILL_CHROME_PX;
  return Math.ceil(Math.max(header, pill) + CELL_PADDING_PX);
}

/**
 * The Updated column: the wider of its header (label plus sort slot) and the widest date sample
 * with breathing room, plus the cell's padding.
 */
export function updatedColumnWidthPx(headerLabel: string, dateSamples: readonly string[], measure: TextMeasurer): number {
  const dateFont = `12px ${bodyFontFamily()}`;
  const widestDate = Math.max(0, ...dateSamples.map((sample) => measure(sample, dateFont)));
  const header = headerLabelWidth(headerLabel, measure) + SORT_SLOT_PX;
  return Math.ceil(Math.max(header, widestDate + DATE_BREATHING_PX) + CELL_PADDING_PX);
}
