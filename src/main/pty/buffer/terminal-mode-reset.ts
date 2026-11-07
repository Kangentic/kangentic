/**
 * The bytes the Reset terminal action feeds a session's stream.
 *
 * Fed through `PtyBufferManager.onData`, as if the PTY had printed them, so the
 * ring, the headless parser, the live flush and the mode tracker all take them
 * at one point in the stream. A byte replay of an older ring re-parses the mode
 * sets it holds and then this, so it ends cleared too.
 *
 * Who owns the modes decides how much of this applies. A running agent owns its
 * alt screen and input modes, and repaints do not give them back. Claude Code's
 * resize path re-sends mouse tracking only, it re-enters the alt screen only on
 * SIGCONT, and it re-sends bracketed paste only on input after a quiet gap. A
 * full clear would strand a live fullscreen agent in the normal buffer, and a
 * multi-line paste would submit line by line. So `keepInputModes` is true for
 * a live agent, and that path touches display state alone.
 *
 * Four traps shape the bytes. Each was hit in a probe against `@xterm/headless`,
 * and `tests/unit/terminal-mode-reset.test.ts` pins the result:
 *
 * - DECSTR (`\x1b[!p`) turns bracketed paste and DECCKM off, so the live-agent
 *   path cannot use it, and it leaves mouse tracking and the alt screen on, so
 *   the full path gets nothing from it.
 * - RIS (`\x1bc`) wipes the grid and scrollback, and a shell does not repaint.
 * - DECRC restores origin mode and the charset. `\x1b[?1049l` restores the
 *   cursor the same way, and does so even in the normal buffer. So there is no
 *   save and restore here, and `?1049l` goes out only from the alt screen, first.
 * - DECSTBM and `\x1b[?6l` home the cursor, so an absolute CUP ends the sequence.
 *   CUP is the last byte because a replayed frame keeps the cursor it left.
 */

/** Mouse tracking, the mouse encodings, focus reports, bracketed paste, DECCKM. */
const INPUT_MODES_OFF = '\x1b[?1;9;1000;1002;1003;1004;1005;1006;1015;1016;2004l';
/** DECKPNM, the keypad half of the input modes. */
const NUMERIC_KEYPAD = '\x1b>';
const SHOW_CURSOR = '\x1b[?25h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

/**
 * Full scroll region, origin mode off, default SGR, ASCII in G0 and G0 shifted
 * in, insert mode off, autowrap on, and any synchronized frame closed. The leading
 * ESC also ends an unterminated OSC or DCS, which would otherwise swallow all
 * later output.
 */
const DISPLAY_STATE_RESET = '\x1b[r\x1b[?6l\x1b[0m\x1b(B\x0f\x1b[4l\x1b[?7h\x1b[?2026l';

export interface TerminalCursor {
  /** Viewport-relative, 0-based. */
  row: number;
  col: number;
}

export interface TerminalModeResetOptions {
  /** A live agent owns the input modes and the cursor's visibility, so they stay. */
  keepInputModes: boolean;
  /** Leave the alt screen. The caller sets this only when `keepInputModes` is false. */
  leaveAltScreen: boolean;
  /** Where the cursor should rest once the sequence has run. */
  cursor: TerminalCursor;
}

export function buildTerminalModeReset({ keepInputModes, leaveAltScreen, cursor }: TerminalModeResetOptions): string {
  return (leaveAltScreen ? LEAVE_ALT_SCREEN : '')
    + (keepInputModes ? '' : INPUT_MODES_OFF + NUMERIC_KEYPAD + SHOW_CURSOR)
    + DISPLAY_STATE_RESET
    + `\x1b[${cursor.row + 1};${cursor.col + 1}H`;
}
