/**
 * Pins formatKeyFingerprint's exact semantics against kangentic-mobile's
 * src/screens/usePairedDesktopInfo.ts implementation of the same helper -
 * a user holds the phone next to the desktop screen to compare, so any
 * drift between the two formatters (grouping, case, separator, truncation)
 * would make that comparison fail silently.
 */
import { describe, expect, it } from 'vitest';
import { formatKeyFingerprint } from '../../../packages/protocol/src/roster/fingerprint';

describe('formatKeyFingerprint', () => {
  it('formats the first 16 hex chars as four space-separated groups of four, by default', () => {
    const publicKeyHex = 'a1b2c3d4e5f60789fedcba9876543210';
    expect(formatKeyFingerprint(publicKeyHex)).toBe('a1b2 c3d4 e5f6 0789');
  });

  it('drops the tail silently, past the requested groups', () => {
    const publicKeyHex = 'a1b2c3d4e5f60789fedcba9876543210';
    expect(formatKeyFingerprint(publicKeyHex).length).toBe(19); // 4 groups * 4 chars + 3 spaces
  });

  it('does not change case', () => {
    expect(formatKeyFingerprint('A1B2C3D4E5F60789')).toBe('A1B2 C3D4 E5F6 0789');
  });

  it('respects a custom group count', () => {
    expect(formatKeyFingerprint('a1b2c3d4e5f60789', 2)).toBe('a1b2 c3d4');
  });

  it('joins with a single space, never a mid-dot or other separator', () => {
    expect(formatKeyFingerprint('a1b2c3d4e5f60789')).not.toMatch(/[^a-f0-9 ]/);
  });

  it('yields short/empty trailing groups (still space-joined) for a key shorter than groups * 4 chars', () => {
    const result = formatKeyFingerprint('a1b2c3', 4);
    expect(result.split(' ')).toEqual(['a1b2', 'c3', '', '']);
  });
});
