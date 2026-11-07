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
import { readableTerminalText, stripAnsiControlCodes, stripAnsiEscapes } from '../../src/shared/ansi-strip';

describe('readableTerminalText', () => {
  it('reads a repainted row whose spaces ConPTY wrote as cursor moves', () => {
    expect(readableTerminalText('Worked\x1b[1Cfor\x1b[C11s')).toBe('Worked for 11s');
  });

  it('keeps the width of a longer move', () => {
    expect(readableTerminalText('a\x1b[3Cb')).toBe('a   b');
  });

  it('caps a move to the right edge, which is positioning rather than a gap', () => {
    expect(readableTerminalText('a\x1b[9999Cb').length).toBeLessThan(300);
  });

  it('breaks the line at a move to a first column, which ConPTY writes in place of a newline', () => {
    const output = '\x1b[HThe command line is too long.\x1b[3;1HC:\\project>\x1b[?25h';
    expect(readableTerminalText(output).split('\n')).toEqual(['', 'The command line is too long.', 'C:\\project>']);
  });

  it('leaves a move to any other column inside its line', () => {
    expect(readableTerminalText('No conversation \x1b[3;17H\x1b[Kfound')).toBe('No conversation found');
  });

  it('leaves stripAnsiEscapes reading them as it did, for the readers that depend on it', () => {
    expect(stripAnsiEscapes('a\x1b[1Cb\x1b[3;1Hc')).toBe('abc');
  });

  it('keeps every capped move of a long run, and returns', () => {
    // 500 moves to the right edge, each capped at 256 spaces, then text.
    expect(readableTerminalText(`${'\x1b[999C'.repeat(500)}x`)).toBe(`${' '.repeat(500 * 256)}x`);
  });
});

describe('stripAnsiEscapes trailing whitespace', () => {
  // A regex that restarts at every space of a run costs the run's length squared
  // when text follows it (128,000 spaces held the main process 19 s). Asserted on
  // the output alone: the old form never returns in time, so the test times out.
  it('leaves a long run of spaces inside a line alone, and trims the line that ends in spaces', () => {
    const run = ' '.repeat(200_000);
    const input = `first${run}after\nsecond   \t \n`;
    expect(stripAnsiEscapes(input)).toBe(`first${run}after\nsecond\n`);
  });

  it('empties a line of only spaces and tabs', () => {
    expect(stripAnsiEscapes('above\n \t  \t\nbelow')).toBe('above\n\nbelow');
  });
});

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
