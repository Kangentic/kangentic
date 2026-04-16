import type { TranscriptRepository } from '../../db/repositories/transcript-repository';

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
export function stripAnsiEscapes(text: string): string {
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
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x80-\x9f]/g, '');

  // 5. C0 control characters except \t (0x09), \n (0x0a), \r (0x0d).
  //    Strips NUL, BEL, BS, VT, FF, SO, SI, DLE, DC1-DC4, NAK, SYN,
  //    ETB, CAN, EM, SUB, ESC (orphaned), FS, GS, RS, US, DEL.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 6. Normalize line endings: \r\n -> \n, standalone \r -> \n
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/\r/g, '\n');

  // 7. Collapse 3+ consecutive blank lines into 2.
  //    Prevents screen-clear sequences from leaving huge gaps.
  result = result.replace(/\n{3,}/g, '\n\n');

  // 8. Trim trailing whitespace on each line.
  //    Cursor positioning often pads lines with spaces.
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}

/**
 * Streams ANSI-stripped PTY output to SQLite incrementally.
 *
 * Hooks directly into the PTY data stream as a separate consumer
 * (alongside PtyBufferManager). Maintains its own pending buffer per session,
 * independent of PtyBufferManager's 512KB ring buffer. This ensures long
 * sessions (2+ hours) capture the full transcript even after the ring buffer
 * evicts old content.
 *
 * Flushes to the database every 30 seconds (debounced). At worst, a crash
 * loses the last 30 seconds of output.
 */
export class TranscriptWriter {
  /** Per-session pending data not yet flushed to DB. */
  private pending = new Map<string, string>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  /** Tracks which sessions have had their DB row created. */
  private initialized = new Set<string>();

  private static readonly FLUSH_INTERVAL_MS = 30_000;

  constructor(private transcriptRepo: TranscriptRepository) {}

  /**
   * Called on every PTY data chunk (same event source as PtyBufferManager).
   * Strips ANSI codes and accumulates in the pending buffer.
   * Debounces DB writes to every 30 seconds.
   */
  onData(sessionId: string, data: string): void {
    const stripped = stripAnsiEscapes(data);
    if (!stripped) return;

    const existing = this.pending.get(sessionId) ?? '';
    this.pending.set(sessionId, existing + stripped);

    // Debounce: schedule flush if not already scheduled
    if (!this.flushTimers.has(sessionId)) {
      const timer = setTimeout(() => this.flush(sessionId), TranscriptWriter.FLUSH_INTERVAL_MS);
      this.flushTimers.set(sessionId, timer);
    }
  }

  /**
   * Flush pending data for a session to the database.
   * Lazily creates the transcript row on first flush - this avoids
   * FK constraint failures when the sessions DB row hasn't been
   * inserted yet (doSpawn runs before executeSpawnAgent inserts the record).
   */
  flush(sessionId: string): void {
    const timer = this.flushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(sessionId);
    }

    const chunk = this.pending.get(sessionId);
    if (!chunk) return;
    this.pending.set(sessionId, '');

    try {
      // Lazy init: create the transcript row on first flush.
      // By this point the sessions table row exists (inserted by
      // executeSpawnAgent after doSpawn returns).
      if (!this.initialized.has(sessionId)) {
        this.transcriptRepo.create(sessionId);
        this.initialized.add(sessionId);
      }
      this.transcriptRepo.appendChunk(sessionId, chunk);
    } catch (error) {
      // Best effort - don't crash the session if DB write fails
      console.error(`[TranscriptWriter] Failed to flush transcript for ${sessionId.slice(0, 8)}:`, error);
    }
  }

  /**
   * Final flush at session suspend/exit. Ensures all pending data is written.
   */
  finalize(sessionId: string): void {
    this.flush(sessionId);
  }

  /**
   * Clean up on session removal. Flushes remaining data and clears state.
   */
  remove(sessionId: string): void {
    this.finalize(sessionId);
    this.pending.delete(sessionId);
    this.initialized.delete(sessionId);
  }

  /**
   * Clean up all sessions. Called during shutdown.
   */
  finalizeAll(): void {
    for (const sessionId of this.pending.keys()) {
      this.finalize(sessionId);
    }
  }
}
