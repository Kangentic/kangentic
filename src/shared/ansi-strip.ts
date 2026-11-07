/**
 * Pure ANSI/control-code stripping shared between the main process (PTY
 * scrollback capture) and the renderer/shared transcript formatter. Lives in
 * `shared/` so `transcript-format.ts` can sanitize parsed transcript content
 * without depending on a main-process module.
 *
 * No imports: keep this module dependency-free so it is safe to bundle into
 * both the renderer and the main process.
 */

/**
 * Hardened ANSI escape code stripper.
 *
 * Handles the full XTerm control sequence specification (ECMA-48 / ISO 6429):
 *
 *   CSI  - Control Sequence Introducer (ESC [ ... final) - colors, cursor, erase
 *   OSC  - Operating System Command    (ESC ] ... BEL/ST) - window title, hyperlinks
 *   DCS  - Device Control String       (ESC P ... ST)     - sixel, XTGETTCAP
 *   APC  - Application Program Command (ESC _ ... ST)     - custom app data
 *   PM   - Privacy Message             (ESC ^ ... ST)     - rarely used
 *   SOS  - Start of String             (ESC X ... ST)     - rarely used
 *   SS2  - Single Shift 2              (ESC N)
 *   SS3  - Single Shift 3              (ESC O)
 *   C1   - 8-bit control codes         (U+0080-U+009F)
 *
 * The regex patterns are derived from the ansi-regex npm package (chalk/ansi-regex,
 * 100M+ weekly downloads) extended with DCS/APC/PM/SOS coverage from the XTerm
 * Control Sequences specification (invisible-island.net/xterm/ctlseqs).
 *
 * The result is readable plain text. Not pretty, but complete.
 */

/**
 * The control-code core of `stripAnsiEscapes` (steps 1-5): removes escape
 * sequences and control bytes WITHOUT the whitespace normalization of steps
 * 6-8, so callers that must preserve exact payload bytes (e.g. a JSON blob
 * embedded in PTY output - see antigravity's print-runner) can share the
 * hardened patterns instead of carrying a copy that silently drifts.
 */
export function stripAnsiControlCodes(text: string): string {
  // 1. String-type sequences terminated by ST (ESC \) or BEL:
  //    OSC (ESC ]), DCS (ESC P), APC (ESC _), PM (ESC ^), SOS (ESC X)
  //    Also handles 8-bit C1 initiators (\x9d for OSC, \x90 for DCS, etc.)
  //    Uses non-greedy match to find the nearest terminator.
  let result = text.replace(
    /(?:\x1b[P\]X^_]|\x90|\x9d|\x9e|\x9f|\x98)[\s\S]*?(?:\x1b\\|\x07|\x9c)/g,
    '',
  );

  // 2. CSI sequences: ESC [ (or C1 CSI \x9b) followed by parameter bytes,
  //    intermediate bytes, and a final byte.
  //    Parameter bytes: 0x30-0x3F (digits, semicolon, <=>? etc.)
  //    Intermediate bytes: 0x20-0x2F (space, !"#$%&'()*+,-./)
  //    Final byte: 0x40-0x7E (@A-Z[\]^_`a-z{|}~)
  //    This covers SGR colors, cursor movement, erase, scroll, private modes, etc.
  result = result.replace(
    /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,
    '',
  );

  // 3. Two-character ESC sequences (ESC + single byte 0x20-0x7E):
  //    Charset selection (ESC ( B), cursor save/restore (ESC 7/8),
  //    index (ESC D), reverse index (ESC M), newline (ESC E),
  //    SS2 (ESC N), SS3 (ESC O), keypad modes (ESC = / ESC >), etc.
  result = result.replace(/\x1b[\x20-\x7e]/g, '');

  // 4. Standalone 8-bit C1 control codes (U+0080-U+009F).
  //    These are single-byte equivalents of ESC-initiated sequences.
  //    Rarely emitted by modern terminals but must be handled for robustness.
  result = result.replace(/[\x80-\x9f]/g, '');

  // 5. C0 control characters except \t (0x09), \n (0x0a), \r (0x0d).
  //    Strips NUL, BEL, BS, VT, FF, SO, SI, DLE, DC1-DC4, NAK, SYN,
  //    ETB, CAN, EM, SUB, ESC (orphaned), FS, GS, RS, US, DEL.
  return result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
export function stripAnsiEscapes(text: string): string {
  let result = stripAnsiControlCodes(text);

  // 6. Normalize line endings: \r\n -> \n, standalone \r -> \n
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/\r/g, '\n');

  // 7. Collapse 3+ consecutive blank lines into 2.
  //    Prevents screen-clear sequences from leaving huge gaps.
  result = result.replace(/\n{3,}/g, '\n\n');

  // 8. Trim trailing whitespace on each line.
  //    Cursor positioning often pads lines with spaces. The lookbehind starts one
  //    attempt per run: without it a run with text after it costs its length
  //    squared, and 128,000 spaces held the main process 19 s (measured).
  result = result.replace(/(?<![ \t])[ \t]+$/gm, '');

  return result;
}

/** A move to the right edge (`\x1b[999C`) is positioning, not a gap in a sentence. */
const MAX_EXPANDED_SPACES = 256;

/**
 * Terminal output as lines a matcher can read. `stripAnsiEscapes` deletes every
 * cursor move, and ConPTY writes some of a line's layout as moves:
 *
 *  - A repainted row is a cell diff, where a cell the last frame already held is
 *    skipped with a cursor-forward. Its spaces arrive as `\x1b[1C` and are lost
 *    (`Workedfor11s` in stored transcripts). Each becomes its spaces.
 *  - A new row can arrive as a move to its first column rather than a newline.
 *    Measured on cmd 10.0.26200 after `cls`: `\x1b[HThe command line is too
 *    long.\x1b[3;1HC:\project>`, which stripped reads as one line that ends in
 *    the prompt. Each becomes a line break. A move to any other column stays a
 *    move: ConPTY lands one in the middle of a sentence when it repaints.
 *
 * Kept apart from `stripAnsiEscapes` because its other readers depend on what it
 * returns today: `resize-manager.ts` dedups frames on it, so added spaces would
 * change what counts as activity, and `transcript-writer.ts` stores it.
 */
export function readableTerminalText(text: string): string {
  const laidOut = text
    .replace(/\x1b\[(\d*)C/g, (_move, count: string) => {
      const columns = count === '' ? 1 : Number(count);
      return ' '.repeat(Math.min(columns, MAX_EXPANDED_SPACES));
    })
    .replace(/\x1b\[(?:\d*;1)?H/g, '\n');
  return stripAnsiEscapes(laidOut);
}

/**
 * Sanitize a span of transcript content (a user prompt, an assistant text
 * block, or a tool result) into clean plain text safe for human reading and
 * for re-ingestion by another agent over MCP.
 *
 * Transcript content parsed from native session JSONL is usually clean, but
 * tool results can carry raw terminal output (a Bash command that printed
 * ANSI colors, a tool that emitted control characters), and that lands in the
 * stored content verbatim. Running every rendered span through the same
 * stripper the PTY path uses guarantees the structured transcript never leaks
 * escape sequences or stray control bytes into the markdown.
 */
export function sanitizeTranscriptText(text: string): string {
  return stripAnsiEscapes(text);
}
