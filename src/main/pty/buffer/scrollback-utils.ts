import { skipTruncatedStringSequence } from '../../../shared/ansi-strip';

/**
 * When scrollback is sliced at MAX_SCROLLBACK, the slice may start in the
 * middle of an escape sequence (e.g. `\x1b[38;2;255;0;0m`). This function finds
 * the first byte that is NOT part of the truncated sequence, so the terminal parser
 * doesn't inherit corrupted graphic state and doesn't paint a payload as text.
 *
 * CSI sequences: ESC [ <parameter bytes 0x30-0x3F>* <intermediate 0x20-0x2F>* <final 0x40-0x7E>
 *   Scanned forward at most 32 bytes.
 * String sequences: ESC ] ... ST  (ST = ESC \ or BEL), an OSC 8 hyperlink's URL among them
 *   See skipTruncatedStringSequence.
 *
 * Returns 0 when the buffer starts cleanly (no truncation detected). Only for a slice
 * at a byte the caller did not choose: a clean start of text reads as a CSI's end here.
 */
export function findSafeStartIndex(data: string): number {
  if (data.length === 0) return 0;

  const scanLimit = Math.min(data.length, 32);

  // If the buffer starts with ESC, the sequence is intact (not truncated).
  if (data.charCodeAt(0) === 0x1b) return 0;

  const pastStringSequence = skipTruncatedStringSequence(data);
  if (pastStringSequence > 0) return pastStringSequence;

  // Check if we're inside a truncated CSI sequence: parameter bytes (0-9 ; : < = > ?)
  // or intermediate bytes (space through /) followed eventually by a final byte (@-~).
  const firstChar = data.charCodeAt(0);
  const isParameterByte = (code: number) => code >= 0x30 && code <= 0x3f;
  const isIntermediateByte = (code: number) => code >= 0x20 && code <= 0x2f;
  const isFinalByte = (code: number) => code >= 0x40 && code <= 0x7e;

  // If the first char looks like it could be mid-CSI (parameter, intermediate, or final byte)
  if (isParameterByte(firstChar) || isIntermediateByte(firstChar) || isFinalByte(firstChar)) {
    // If the first char is itself a final byte, skip just that one byte
    if (isFinalByte(firstChar)) return 1;

    // Scan forward for the final byte that ends the CSI sequence
    for (let index = 0; index < scanLimit; index++) {
      const code = data.charCodeAt(index);
      if (isFinalByte(code)) {
        return index + 1; // skip past the final byte
      }
      // If we hit a char that's not parameter/intermediate, stop scanning
      if (!isParameterByte(code) && !isIntermediateByte(code)) {
        return index;
      }
    }
  }

  // No truncated sequence detected (or scan limit reached without finding end)
  return 0;
}
