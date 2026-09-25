/**
 * REAL captured Claude Code TUI bytes shared by the devtools terminal tests.
 * Extracted from tests/unit/devtools-terminal-forensics.test.ts so the
 * composed-width measurement can exercise the same genuine byte shapes.
 */

/** Alt-screen entry plus the focus-reporting mode a fullscreen TUI enables. */
export const TUI_SETUP = '\x1b[?1049h\x1b[?1004h';

/**
 * REAL captured bytes, not a synthetic fixture: the frame Claude Code v2.1.222
 * emitted over the PTY after a ctrl+Home jump in a long fullscreen transcript
 * (captured 2026-08-05 via the devtools byte tap; upstream
 * anthropics/claude-code#83714). Ported from task 484's detector test, which is
 * where these bytes were first pinned.
 *
 * It erases every row of a 210x48 grid and draws only chrome - banner,
 * separators, branch chip, mode line - then the TUI goes idle. This is the
 * TOTAL-omission flavour of the defect; the band task 484 chased is the same
 * shape with most rows drawn and a contiguous run missing. Either way the
 * forensics capture has to report the surviving rows faithfully, and the
 * composed-width measurement has to read 210 columns out of its padding rows
 * and separator rules.
 */
export const DEFECTIVE_JUMP_FRAME =
  '\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[m\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2026h\x1b[?2026l\x1b[?25l\x1b[H\x1b[K\x1b[38;2;215;119;87m\r\n ▐\x1b[48;2;0;0;0m▛███▜\x1b[49m▌   \x1b[m\x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.222\x1b[K\x1b[38;2;215;119;87m\r\n▝▜\x1b[48;2;0;0;0m█████\x1b[49m▛▘  \x1b[38;2;153;153;153mFable 5 with xhigh effort · Claude Max\x1b[K\x1b[38;2;215;119;87m\r\n  ▘▘ ▝▝    \x1b[38;2;153;153;153m~\\Documents\\GitHub\\kangentic\\.kangentic\\worktrees\\479\x1b[K\x1b[m\r\n\x1b[K\r\n' +
  ' '.repeat(210) + '\r\n' +
  '\x1b[K\r\n'.repeat(21) +
  ' '.repeat(210) + '\r\n' +
  '\x1b[K\r\n'.repeat(4) +
  ' '.repeat(210) + '\r\n' +
  '\x1b[K\r\n'.repeat(9) +
  '\x1b[K\x1b[38;2;8;145;178m\r\n' +
  '─'.repeat(177) + '\x1b[38;2;0;0;0m\x1b[48;2;8;145;178m fix-alt-screen-terminal-replay \x1b[38;2;8;145;178m\x1b[49m──\x1b[m❯ \x1b[K\x1b[38;2;8;145;178m\r\n' +
  '─'.repeat(210) + '\x1b[m\r\n' +
  '\x1b[K\r\n' +
  '  \x1b[38;2;255;193;7m⏵⏵ auto mode on \x1b[38;2;153;153;153m(shift+tab to cycle) · ← 1 agent\x1b[K\x1b[45;3H\x1b[?25h';
