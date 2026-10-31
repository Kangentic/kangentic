/**
 * Which of the context bar's pills fold into its +N list. The bar is one row:
 * the agent, model, effort, rate limits and context always show, and the rest
 * fold, in `CONTEXT_BAR_FOLD_ORDER`, before a bar would drop under
 * `METER_COMFORT_TRACK_PX`. A Command Terminal's 630px floor holds that row
 * with the bars at their own 40px minimum (`COMMAND_TERMINAL_FLOOR`); below it,
 * in a window too small for the grid, the rate limits, the context and the
 * agent's name fold too, in that order. The model and effort pickers, and a
 * task's profile picker, never fold.
 *
 * Every width here is one the fold cannot change: a pill's own width, wherever
 * it is, and a meter's width with its tracks at their minimum. Deciding from the
 * row's live overflow would flip a pill in and out at the edge.
 */

/** The order pills fold in, first to last. The last three fold only under the floor. */
export const CONTEXT_BAR_FOLD_ORDER = [
  'shell',
  'version',
  'agent-active',
  'elapsed',
  'tokens',
  'tool-calls',
  'cost',
  'context-fraction',
  'rate-limits',
  'context',
  'agent',
] as const;

export type ContextBarFoldId = typeof CONTEXT_BAR_FOLD_ORDER[number];

/**
 * The width a bar keeps before anything outside the five gives up its room to
 * it. Under it, the next pill in the order folds; once only the five are left,
 * a bar narrows to its own minimum.
 */
export const METER_COMFORT_TRACK_PX = 80;

/** The pills outside the five that always show, the context counts included. */
const OPTIONAL_FOLD_IDS: ReadonlySet<ContextBarFoldId> = new Set(
  CONTEXT_BAR_FOLD_ORDER.slice(0, CONTEXT_BAR_FOLD_ORDER.indexOf('rate-limits')),
);

export function isContextBarFoldId(value: string | undefined): value is ContextBarFoldId {
  return value !== undefined && (CONTEXT_BAR_FOLD_ORDER as readonly string[]).includes(value);
}

export interface ContextBarFoldItem {
  id: ContextBarFoldId;
  /** The room it takes in the row, the gap before it included. */
  width: number;
}

export interface ContextBarFoldInput {
  /** The row's width, less the bar's padding. */
  available: number;
  /** The room everything that never folds takes, gaps included. */
  fixedWidth: number;
  items: ContextBarFoldItem[];
  /** The +N pill's room, the gap before it included. It shows once anything folds. */
  moreWidth: number;
  /**
   * Per meter, the room its tracks take at `METER_COMFORT_TRACK_PX` beyond
   * their minimum. Counted while any pill outside the five still shows.
   */
  meterComfort?: Partial<Record<ContextBarFoldId, number>>;
}

export function resolveContextBarFold({ available, fixedWidth, items, moreWidth, meterComfort = {} }: ContextBarFoldInput): Set<ContextBarFoldId> {
  const folded = new Set<ContextBarFoldId>();
  const comfortWidth = (): number => {
    const optionalShown = items.some((item) => OPTIONAL_FOLD_IDS.has(item.id) && !folded.has(item.id));
    if (!optionalShown) return 0;
    return items.reduce((total, item) => (folded.has(item.id) ? total : total + (meterComfort[item.id] ?? 0)), 0);
  };
  const shownWidth = (): number => items.reduce(
    (total, item) => (folded.has(item.id) ? total : total + item.width),
    fixedWidth + (folded.size > 0 ? moreWidth : 0) + comfortWidth(),
  );
  const present = new Set(items.map((item) => item.id));
  for (const id of CONTEXT_BAR_FOLD_ORDER) {
    if (shownWidth() <= available) break;
    if (present.has(id)) folded.add(id);
  }
  return folded;
}
