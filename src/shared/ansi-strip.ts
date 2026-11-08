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
 * An escape sequence cut off at the end of a chunk: a lone ESC, an unterminated
 * CSI, or a string (OSC, DCS, APC, PM, SOS) still waiting for its terminator. A
 * reader of a chunked stream holds it for the next chunk, so neither half of a
 * split sequence is read as text. An OSC 8 hyperlink splits often: it carries a whole
 * URL, and a stream drawing links is mostly those payloads.
 */
export const TRAILING_PARTIAL_ESCAPE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*|[\]P_^X][^\x07\x1b]*\x1b?|[\x20-\x2f]+)?$/;

/** A carried partial longer than this keeps only its introducer and a trailing ESC. */
const MAX_CARRY_LENGTH = 4096;

/**
 * What to hold over from a partial escape. A long one keeps its introducer
 * (`\x1b]`, `\x1b[`, ...) and a trailing ESC that may start its terminator.
 * The payload between them never matters to a reader of text, and keeping the
 * introducer is what makes the rest of the sequence, when it ends in a later chunk,
 * still read as a sequence. Dropping the whole partial reads that rest as text.
 */
export function carryForPartialEscape(partial: string): string {
  if (partial.length <= MAX_CARRY_LENGTH) return partial;
  return partial.slice(0, 2) + (partial.endsWith('\x1b') ? '\x1b' : '');
}

/**
 * How many leading characters to skip when `data` starts inside a string sequence
 * (OSC, DCS, APC, PM, SOS) whose opening it does not hold, or 0 when it does not.
 * A slice of a stream can start there, and a parser that never saw the opening
 * paints the rest of the payload as text, a hyperlink's URL included.
 *
 * It reads the shape alone. Text cannot be told from a payload, but a string
 * terminator with no opening is never valid, so the first control byte decides: ST
 * or BEL means this was a payload, and anything else means it was text. A plain line
 * that ends in a bell reads as a payload and loses that line, at the head of a
 * slice, which is the accepted cost of BEL being a terminator. An ESC on the slice's
 * last character reads as text before a new sequence: it starts a CSI as often as ST.
 */
export function skipTruncatedStringSequence(data: string): number {
  const scanLimit = Math.min(data.length, MAX_CARRY_LENGTH);
  for (let index = 0; index < scanLimit; index += 1) {
    const code = data.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b) return data.charCodeAt(index + 1) === 0x5c ? index + 2 : 0;
    if (code < 0x20) return 0;
  }
  return 0;
}

/** An OSC 8 open or close cut off at a chunk's end, or an ESC that may start one. */
const TRAILING_PARTIAL_HYPERLINK = /\x1b(?:\](?:8(?:;[^\x07\x1b]*\x1b?)?)?)?$/;
const HYPERLINK_SEQUENCE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** An OSC 8 open, which has a target where a close has none. */
const HYPERLINK_OPEN = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

/**
 * Removes OSC 8 from a chunked stream and keeps the labels, holding a sequence cut at
 * a chunk's end for the next chunk. For a terminal with no way to open a link: left
 * in place, xterm's fallback answers a tap with a `confirm()` and a `window.open()`.
 */
export function createHyperlinkStripper(): (chunk: string) => string {
  let carry = '';
  return (chunk) => {
    // Most chunks hold no link, and this runs on every chunk a phone watches.
    if (!carry && !chunk.includes('\x1b]8') && !chunk.endsWith('\x1b') && !chunk.endsWith('\x1b]')) return chunk;
    const text = carry + chunk;
    const partial = text.match(TRAILING_PARTIAL_HYPERLINK)?.[0] ?? '';
    // Past this the bytes are no URL, and holding them would stall the feed.
    carry = partial.length <= MAX_CARRY_LENGTH ? partial : '';
    const complete = carry ? text.slice(0, -carry.length) : text;
    return complete.replace(HYPERLINK_SEQUENCE, '');
  };
}

/**
 * Writes each OSC 8 hyperlink's target into the text beside its label, for a reader
 * that scrapes URLs. A stripper removes the target with the sequence, which is the
 * only copy of a URL behind a shortened label, and of a whole URL its label wraps.
 */
export function exposeHyperlinkTargets(text: string): string {
  return text.replace(HYPERLINK_OPEN, '$1 ');
}

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
