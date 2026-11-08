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
 */

import type { AgentHistoryView } from '../../../../shared/types';

/** Ctrl+O. */
const TOGGLE_TRANSCRIPT = '\x0f';

/** The footer's opening words in transcript mode, which survive a narrow terminal's cut. */
const TRANSCRIPT_FOOTER = 'Showing detailed transcript';

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
  isShowing: (screenRows) => lastRowWithText(screenRows).trimStart().startsWith(TRANSCRIPT_FOOTER),
};
