/**
 * How a Command Terminal names itself, in ONE place because two processes render
 * it: the renderer draws the window's title bar, and main writes the Agent
 * Monitor row's title. Those disagreeing is the bug this file prevents.
 *
 * The number is the window's durable SLOT (`slot-1`, `slot-2`, ...), not a
 * position in any list. That choice is load-bearing:
 *
 *   - It is stable. A window never renames itself because a sibling opened or
 *     closed, and closing slot 2 of 3 leaves "1" and "3" rather than renumbering
 *     a window the user is currently looking at.
 *   - It is the only number BOTH surfaces can agree on. A monitor-side ordinal
 *     derived from `startedAt` disagrees with the window's slot the moment a
 *     terminal is closed and its slot reused, which reads as a bug.
 *
 * Numbering is unconditional rather than "only once a second terminal exists",
 * again for stability: a conditional number changes the title of a window that
 * did not change.
 *
 * ONE case renumbers, deliberately. A renderer reload destroys the (project,
 * slot) pairing map while main keeps every PTY alive, so recovery re-pairs
 * survivors from the slot main recorded (`planTransientRecovery`). If a terminal
 * spawned after the reload has already taken that slot, the survivor cannot have
 * it back and moves to the lowest free one, so a conversation that was "Command
 * Terminal 1" returns as "Command Terminal 2". That breaks the stability rule
 * above, and it is still the right trade: the alternative is one of the two PTYs
 * being left with no window at all, unreachable with its question pending. The
 * rule holds everywhere else - nothing renumbers because a sibling opened or
 * closed.
 */

export const COMMAND_TERMINAL_BASE_TITLE = 'Command Terminal';

/**
 * Numeric suffix of a `slot-N` id, or null when it is absent or unparseable.
 *
 * Unparseable is a real case, not defensive padding: main learns the slot from
 * the renderer at spawn, so a session spawned before that plumbing existed (or by
 * a path that does not send one) legitimately has none, and must fall back to the
 * bare title rather than printing "Command Terminal NaN".
 */
export function commandTerminalSlotNumber(slot: string | null | undefined): number | null {
  if (!slot) return null;
  const match = /^slot-(\d+)$/.exec(slot);
  return match ? Number(match[1]) : null;
}

/** Display title for a Command Terminal window or monitor row. */
export function commandTerminalTitle(slot: string | null | undefined): string {
  const slotNumber = commandTerminalSlotNumber(slot);
  return slotNumber === null ? COMMAND_TERMINAL_BASE_TITLE : `${COMMAND_TERMINAL_BASE_TITLE} ${slotNumber}`;
}
