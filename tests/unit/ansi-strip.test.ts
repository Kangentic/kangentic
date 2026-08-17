/**
 * Unit tests for `src/shared/ansi-strip.ts`, focused on the contract this
 * branch introduced: `stripAnsiControlCodes` is the control-code-only core
 * (steps 1-5) that `stripAnsiEscapes` now delegates to, and it is used
 * standalone by antigravity's print-runner to clean PTY chrome around a
 * captured JSON blob WITHOUT rewriting bytes that may sit inside that JSON
 * (`stripAnsiEscapes`'s line-ending normalization and trailing-whitespace
 * trim - steps 6-8 - would corrupt a `\r\n` or trailing space embedded in a
 * JSON string value). That divergence between the two functions is the
 * whole reason `stripAnsiControlCodes` exists as its own export, and had no
 * direct test before this file.
 */
import { describe, it, expect } from 'vitest';
import { stripAnsiControlCodes, stripAnsiEscapes } from '../../src/shared/ansi-strip';

describe('stripAnsiControlCodes', () => {
  it('strips CSI (color) sequences and orphaned control bytes', () => {
    const input = '\x1b[31mred text\x1b[0m plain\x07';
    expect(stripAnsiControlCodes(input)).toBe('red text plain');
  });

  it('preserves \\r\\n line endings and trailing whitespace, unlike stripAnsiEscapes', () => {
    // Same input to both functions: only the control-code stripping (steps
    // 1-5) is shared. stripAnsiControlCodes must stop there; stripAnsiEscapes
    // additionally normalizes line endings (steps 6) and trims trailing
    // whitespace per line (step 8).
    const input = 'line one   \r\nline two\x1b[31m colored\x1b[0m   \r\n';

    expect(stripAnsiControlCodes(input)).toBe('line one   \r\nline two colored   \r\n');
    expect(stripAnsiEscapes(input)).toBe('line one\nline two colored\n');
  });
});
