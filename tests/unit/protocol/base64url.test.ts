import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { base64UrlDecode, base64UrlEncode } from '../../../packages/protocol/src/wire/base64url';

describe('base64url', () => {
  it('round-trips arbitrary byte lengths (covers all padding cases)', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64, 100]) {
      const bytes = randomBytes(length);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      const decoded = base64UrlDecode(encoded);
      expect(Buffer.from(decoded).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    }
  });

  it('rejects an invalid character', () => {
    expect(() => base64UrlDecode('!!!not-valid???')).toThrow();
  });
});
