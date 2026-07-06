import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/main/retrieval/token-estimate';

/**
 * `estimateTokens` is the chars/4 proxy the chunker uses to size windows. It
 * must be `ceil(len / 4)` exactly (a conservative over-estimate) so a chunk
 * never slips over the model window because the estimate rounded down.
 */
describe('estimateTokens', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds a single character up to one token', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('maps an exact multiple of 4 without rounding up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up at each 4-char boundary (ceil, never floor)', () => {
    // 5 chars -> 1.25 -> 2, proving the ceil.
    expect(estimateTokens('abcde')).toBe(2);
    // 7 chars -> 1.75 -> 2.
    expect(estimateTokens('abcdefg')).toBe(2);
    // 9 chars -> 2.25 -> 3.
    expect(estimateTokens('a'.repeat(9))).toBe(3);
  });

  it('scales linearly for a long string', () => {
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
    expect(estimateTokens('x'.repeat(4001))).toBe(1001);
  });

  it('counts every character including whitespace and newlines', () => {
    // 3 chars ("a\nb") -> ceil(0.75) -> 1.
    expect(estimateTokens('a\nb')).toBe(1);
  });
});
