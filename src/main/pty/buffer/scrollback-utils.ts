/**
 * When scrollback is sliced at MAX_SCROLLBACK, the slice may start in the
 * middle of a CSI escape sequence (e.g. `\x1b[38;2;255;0;0m`). This
 * function scans forward (max 32 bytes) to find the first byte that is NOT
 * part of a truncated CSI sequence, so the terminal parser doesn't inherit
 * corrupted graphic state.
 *
 * CSI sequences: ESC [ <parameter bytes 0x30-0x3F>* <intermediate 0x20-0x2F>* <final 0x40-0x7E>
 * OSC sequences: ESC ] ... ST  (ST = ESC \ or BEL)
 *
 * Returns 0 when the buffer starts cleanly (no truncation detected).
 */
export function findSafeStartIndex(data: string): number {
  if (data.length === 0) return 0;

  const scanLimit = Math.min(data.length, 32);

  // If the buffer starts with ESC, the sequence is intact (not truncated).
  if (data.charCodeAt(0) === 0x1b) return 0;

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
