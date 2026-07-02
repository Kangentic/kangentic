// Emulated PTY scrollback that paints a quote block and a shaded code box, using
// the interpreted-buffer shapes captured from live Claude Code (see the Phase 0
// notes in src/renderer/utils/terminal-blocks.ts): a left bar glyph (U+258E)
// with a non-default RGB foreground for the quote, and an identical non-default
// RGB background run for the box.
//
// CRLF (\r\n) here is real PTY output, not authored line-ending punctuation: a
// bare \n advances the row without a carriage return, so the terminal would
// render a staircase. This is recorded terminal data (the documented exception
// in .claude/rules/text-formatting.md and cross-platform-parity.md).
const NL = '\r\n';
const ESC = '\x1b';
const ORANGE = `${ESC}[38;2;215;119;87m`;
const RESET = `${ESC}[m`;
const BG = `${ESC}[48;2;55;55;55m`;
const WHITE = `${ESC}[38;2;255;255;255m`;
const CLEAR_EOL = `${ESC}[0K`;

/** The clean lines the quote block should yield when copied (no bar, no gap). */
export const QUOTE_LINES = ['Quote line one', 'Quote line two', 'Quote line three', 'Quote line four'];

/** The clean lines the code box should yield when copied (dedented). */
export const BOX_LINES = ['const answer = 42;', 'return answer;'];

/** Emulated scrollback: intro, a 4-row quote block, a plain gap, a 2-row shaded box. */
export const TERMINAL_BLOCK_FIXTURE =
  [
    'Normal intro line',
    ...QUOTE_LINES.map((line) => `${ORANGE}▎${RESET} ${line}`),
    'Between the blocks',
    '',
    ...BOX_LINES.map((line) => `${BG}${WHITE}  ${line}${CLEAR_EOL}${RESET}`),
    'Trailing plain line',
  ].join(NL) + NL;
