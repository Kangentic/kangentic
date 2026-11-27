/**
 * Claude Code's keys for showing a fullscreen conversation as ordinary terminal
 * text, which is how the find bar searches all of it (`AgentHistoryView`).
 *
 * In fullscreen rendering (`CLAUDE_CODE_NO_FLICKER=1`) the conversation lives on the
 * alternate screen, so a terminal holds only the visible rows. Claude's docs give the
 * way out: Ctrl+O opens transcript mode, and `[` there writes the whole conversation,
 * tool output expanded, into the terminal's normal buffer
 * (https://code.claude.com/docs/en/fullscreen#search-and-review-the-conversation).
 * Ctrl+O from that written-out view returns to the prompt.
 *
 * Measured on Claude Code 2.1.319 on Windows through ConPTY:
 * - Idle, with a draft typed, with a permission prompt open, and mid-tool: the keys
 *   wrote the conversation out, Ctrl+O came back, the draft and the prompt were kept,
 *   and a running turn carried on.
 * - What is written out is a snapshot. Output during it is not appended.
 * - A second write-out clears the first, so nothing piles up.
 * - It starts at the last compaction: 7,269 lines (about 470 KB, 2.3 s) for a long
 *   compacted session, 5,396 lines for a 32-minute review.
 * - In transcript mode the footer reads "Showing detailed transcript", at 160 columns
 *   and at 60. The prompt view's footer never does.
 *
 * Measured on Claude Code 2.1.328 on Linux (WSL2, tmux, 120 by 40, fullscreen renderer):
 * - Idle, the footer row starts "Showing detailed transcript · ctrl+o to toggle", as on
 *   Windows.
 * - With a turn streaming, and in the pause before a stream starts, the same row carries the
 *   turn's status first: "working · Showing detailed transcript · ctrl+o to toggle". Read as
 *   the footer only at the row's start, a view opened mid-turn passed for one nothing
 *   recognized, so the host pressed Ctrl+O again and filed Sentry DESKTOP-5K.
 * - With a Bash permission prompt open, the footer starts the row, as idle.
 * - `[` wrote the conversation out in all four states, and Ctrl+O brought Claude back.
 */

import type { AgentHistoryView } from '../../../../shared/types';

/** Ctrl+O. */
const TOGGLE_TRANSCRIPT = '\x0f';

/**
 * The footer's opening words in transcript mode, which survive a narrow terminal's cut, after the
 * short status a running turn puts ahead of them ("working · ").
 */
const TRANSCRIPT_FOOTER = /^(?:[^·]{1,40}\s·\s)?Showing detailed transcript/;

/**
 * The footer is the screen's last row with text. Reading only that row keeps a
 * conversation that quotes the footer, this file's own included, from passing for it.
 */
function lastRowWithText(screenRows: readonly string[]): string {
  for (let index = screenRows.length - 1; index >= 0; index -= 1) {
    if (screenRows[index].trim().length > 0) return screenRows[index];
  }
  return '';
}

export const CLAUDE_HISTORY_VIEW: AgentHistoryView = {
  toggleKeys: TOGGLE_TRANSCRIPT,
  writeOutKeys: '[',
  isShowing: (screenRows) => TRANSCRIPT_FOOTER.test(lastRowWithText(screenRows).trimStart()),
};
