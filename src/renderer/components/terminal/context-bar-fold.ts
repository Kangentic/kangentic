/**
 * Which of the context bar's pills fold into its +N list. The bar is one row:
 * the agent, model, effort, rate limits and context always show, and the rest
 * fold, in `CONTEXT_BAR_FOLD_ORDER`, once the row runs out of room. A
 * Command Terminal's 550px floor holds that row (`COMMAND_TERMINAL_FLOOR`);
 * below it, in a window too small for the grid, the rate limits, the context
 * and the agent's name fold too, in that order. The model and effort pickers,
 * and a task's profile picker, never fold.
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
}

export function resolveContextBarFold({ available, fixedWidth, items, moreWidth }: ContextBarFoldInput): Set<ContextBarFoldId> {
  const folded = new Set<ContextBarFoldId>();
  const shownWidth = (): number => items.reduce(
    (total, item) => (folded.has(item.id) ? total : total + item.width),
    fixedWidth + (folded.size > 0 ? moreWidth : 0),
  );
  const present = new Set(items.map((item) => item.id));
  for (const id of CONTEXT_BAR_FOLD_ORDER) {
    if (shownWidth() <= available) break;
    if (present.has(id)) folded.add(id);
  }
  return folded;
}
