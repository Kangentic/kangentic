/**
 * How long an idle session may keep painting before a turn wait that asks for
 * it stops waiting for quiet (`waitForTurnCompletion`'s `idleWithoutQuietMs`).
 * A CLI repaints its status line while its own background agents run, so an
 * idle session can paint for minutes after its Stop (#804). The turn-end pass
 * gives up after its own whole wait of the same length (`turnSettled`), so the
 * two are one number.
 *
 * Its own module so a test that mocks the turn wait keeps the real value.
 */
export const PAINT_GIVE_UP_MS = 120_000;
