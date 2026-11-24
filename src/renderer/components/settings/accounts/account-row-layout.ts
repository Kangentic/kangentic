/**
 * The layout an account row and its skeleton share (task #1202), so the skeleton keeps the real
 * row's height and columns when either changes.
 */

/** The row's top line: the name, its tags, and the action slot. */
export const ACCOUNT_ROW_TOP_LINE_CLASS = 'flex min-h-6 items-center gap-2';

/** One grid for every usage line, so the name column is as wide as the longest name and the bars start together. */
export const ACCOUNT_USAGE_GRID_CLASS = 'mt-3 grid grid-cols-[auto_1fr_minmax(84px,auto)] items-center gap-x-2.5 gap-y-3 text-xs tabular-nums text-fg-muted';

/** The percent beside a usage bar. */
export const ACCOUNT_USAGE_PERCENT_CELL_CLASS = 'w-7 flex-shrink-0';

/** The reset time after a usage bar. */
export const ACCOUNT_USAGE_RESET_CELL_CLASS = 'flex items-center whitespace-nowrap pl-1.5';

/** The Add account button's box: its height, border and fill. */
const ADD_ACCOUNT_BOX_CLASS = 'h-7 rounded-md border border-edge-input bg-surface-control';

/** The header button that adds an account, on an agent's card and on More agents. */
export const ADD_ACCOUNT_BUTTON_CLASS =`flex items-center gap-1.5 px-2.5 text-xs text-fg hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${ADD_ACCOUNT_BOX_CLASS}`;

/** The same box, empty, in a skeleton card's header. Its width is the English label's. */
export const ADD_ACCOUNT_SKELETON_CLASS = `block w-[108px] ${ADD_ACCOUNT_BOX_CLASS}`;
