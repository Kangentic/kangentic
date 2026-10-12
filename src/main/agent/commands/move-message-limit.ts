/**
 * The longest message `kangentic_move_task` carries to the destination
 * column's agent: a review's whole reply fits (task #529's ran to about 11,000
 * characters), and a message past it is refused rather than cut.
 *
 * A module of its own, read by the tool's schema and its handler alike, so a
 * test that stubs either one still sees the limit.
 */
export const MOVE_MESSAGE_MAX_CHARS = 20_000;
