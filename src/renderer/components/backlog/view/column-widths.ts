import { DATA_TABLE_CELL_PADDING_X_PX } from '../../DataTable';
import { PILL_SM_MIN_WIDTH_PX, PILL_SM_PADDING_X_PX } from '../../Pill';
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

/**
 * The Labels column (task #1142): two labels of about 100px each and a "+N" chip fit its 236px
 * of content.
 */
export const LABELS_WIDTH_PX = 260;
/** What the Labels cell holds once its padding is taken. */
export const LABELS_CONTENT_PX = LABELS_WIDTH_PX - CELL_PADDING_PX;
/** The space between two label pills (`gap-1`). */
export const LABEL_PILL_GAP_PX = 4;
/** A `sm` Pill's side padding, both sides together. */
export const LABEL_PILL_PADDING_PX = PILL_SM_PADDING_X_PX * 2;
/** A `sm` Pill's minimum width. */
export const LABEL_PILL_MIN_PX = PILL_SM_MIN_WIDTH_PX;
/** A colored label's `border`, both sides together. */
export const LABEL_PILL_BORDER_PX = 2;

/**
 * A label pill's width: its text at 12px (medium weight and a border when the label has a color,
 * as the table draws it) plus the pill's padding, never under the pill's minimum.
 */
export function labelPillWidthPx(text: string, colored: boolean, measure: TextMeasurer, fontFamily: string): number {
  const font = `${colored ? '500 ' : ''}12px ${fontFamily}`;
  const chrome = LABEL_PILL_PADDING_PX + (colored ? LABEL_PILL_BORDER_PX : 0);
  return Math.ceil(Math.max(LABEL_PILL_MIN_PX, measure(text, font) + chrome));
}

/**
 * How many labels, in order, fit `availablePx` on one line. When some do not, the chip for the
 * rest is reserved at its own width (a two-digit count is wider), so the shown labels and the chip
 * fit together. At least one label shows whenever there are any: a first label wider than its room
 * shrinks and ends in an ellipsis.
 */
export function fitLabels(pillWidths: readonly number[], availablePx: number, chipWidthPx: (hiddenCount: number) => number): number {
  const total = pillWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, pillWidths.length - 1) * LABEL_PILL_GAP_PX;
  if (total <= availablePx) return pillWidths.length;
  let used = 0;
  let shown = 0;
  for (const width of pillWidths) {
    const next = used + (shown > 0 ? LABEL_PILL_GAP_PX : 0) + width;
    const hiddenAfter = pillWidths.length - (shown + 1);
    const reserve = hiddenAfter > 0 ? LABEL_PILL_GAP_PX + chipWidthPx(hiddenAfter) : 0;
    if (next + reserve > availablePx) break;
    used = next;
    shown++;
  }
  return Math.max(shown, Math.min(1, pillWidths.length));
}

/**
 * A row's labels laid out on one line: how many show, and whether the first one has to shrink
 * and end in an ellipsis. It does when it is wider than its room, which is the whole cell less the
 * chip when labels are folded away.
 */
export function layoutLabels(
  labels: readonly string[],
  labelColors: Record<string, string>,
  measure: TextMeasurer,
  fontFamily: string,
  availablePx: number = LABELS_CONTENT_PX,
): { shownCount: number; firstTruncates: boolean } {
  const widths = labels.map((label) => labelPillWidthPx(label, Boolean(labelColors[label]), measure, fontFamily));
  const chipWidth = (hiddenCount: number) => labelPillWidthPx(`+${hiddenCount}`, false, measure, fontFamily);
  const shownCount = fitLabels(widths, availablePx, chipWidth);
  const hiddenCount = labels.length - shownCount;
  const firstRoom = availablePx - (hiddenCount > 0 ? LABEL_PILL_GAP_PX + chipWidth(hiddenCount) : 0);
  return { shownCount, firstTruncates: widths.length > 0 && widths[0] > firstRoom };
}
