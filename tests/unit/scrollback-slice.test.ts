import { describe, it, expect } from 'vitest';
import { findSafeStartIndex } from '../../src/main/pty/buffer/scrollback-utils';

describe('findSafeStartIndex', () => {
  it('returns 0 for empty string', () => {
    expect(findSafeStartIndex('')).toBe(0);
  });

  it('skips 1 byte when text starts with a CSI-final-range letter', () => {
    // 'h' (0x68) falls in the CSI final byte range (0x40-0x7E), so the
    // function conservatively skips it. Losing 1 byte from a 512KB buffer
    // is invisible in practice.
    expect(findSafeStartIndex('hello world')).toBe(1);
  });

  it('returns 0 for text starting with a non-CSI character', () => {
    // Characters below 0x20 (control chars) are not in any CSI byte range
    expect(findSafeStartIndex('\nhello world')).toBe(0);
  });

  it('returns 0 when buffer starts with a complete ESC sequence', () => {
    expect(findSafeStartIndex('\x1b[31mhello')).toBe(0);
  });

  it('returns 0 when buffer starts with ESC (intact sequence start)', () => {
    expect(findSafeStartIndex('\x1b[38;2;255;0;0m')).toBe(0);
  });

  it('skips truncated CSI parameter bytes up to the final byte', () => {
    // Simulates slicing mid-sequence: "38;2;255;0;0mhello"
    // Parameter bytes (0-9, ;) then final byte 'm' (0x6d)
    const truncated = '38;2;255;0;0mhello';
    const safeIndex = findSafeStartIndex(truncated);
    expect(safeIndex).toBe(13); // skip past the 'm'
    expect(truncated.slice(safeIndex)).toBe('hello');
  });

  it('skips a single final byte at the start', () => {
    // Just 'm' at the start (tail end of a CSI sequence)
    expect(findSafeStartIndex('mhello')).toBe(1);
  });

  it('handles lone final byte "H" (cursor position)', () => {
    expect(findSafeStartIndex('Htext')).toBe(1);
  });

  it('skips intermediate bytes followed by final byte', () => {
    // Intermediate byte 0x20 (space) + final byte 'q'
    expect(findSafeStartIndex(' qrest')).toBe(2);
  });

  it('returns 0 when scan limit (32) reached without finding final byte', () => {
    // 33 parameter bytes with no final byte exceeds the 32-char scan limit
    const longParams = '0;'.repeat(17).slice(0, 33);
    expect(findSafeStartIndex(longParams)).toBe(0);
  });

  it('handles OSC sequence remnant (text followed by BEL)', () => {
    // 'M' (0x4D) is in the CSI final byte range, so the function
    // conservatively skips it. This is safe since we're only trimming
    // 1 byte from a 512KB buffer boundary.
    expect(findSafeStartIndex('My Title\x07rest')).toBe(1);
  });

  it('handles mixed parameter and intermediate bytes', () => {
    // Parameter bytes then intermediate byte then final byte
    const truncated = '1;2 qtext';
    const safeIndex = findSafeStartIndex(truncated);
    expect(safeIndex).toBe(5); // skip past 'q'
    expect(truncated.slice(safeIndex)).toBe('text');
  });

  it('stops at non-CSI character during scan', () => {
    // Parameter bytes then a regular character (not intermediate or final)
    // Character 0x01 (SOH) is outside all CSI byte ranges
    const truncated = '1;2\x01rest';
    const safeIndex = findSafeStartIndex(truncated);
    expect(safeIndex).toBe(3); // stops at the non-CSI byte
  });
});
