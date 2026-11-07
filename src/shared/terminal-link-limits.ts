/**
 * Bounds on the printed paths a terminal asks about. The renderer stops finding
 * candidates at these and main stops answering at them, so one list keeps a row's
 * last path from being found and never answered, which reads as a path that is gone.
 */

/** One row of a TUI is rarely more than this many paths, and each costs an exists check. */
export const MAX_LINK_PATHS_PER_ROW = 12;
export const MAX_PRINTED_PATH_LENGTH = 1024;
