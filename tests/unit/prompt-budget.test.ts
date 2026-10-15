/**
 * `commandLineLength` and `fitCommandLine` (`src/main/agent/shared/prompt-budget.ts`):
 * how an inline opening prompt is measured against the command line cmd.exe
 * receives, and cut to fit.
 *
 * A cmd host gets every `%` written as `"^%"`, with the backslash run right
 * before it doubled, so a prompt full of them is up to four times as long on the
 * line as it reads. Measuring `text.length` instead let a recap of a few
 * thousand characters overrun cmd.exe's 8,191.
 */
import { describe, it, expect } from 'vitest';
import { INLINE_PROMPT_BUDGET, commandLineLength, fitCommandLine } from '../../src/main/agent/shared/prompt-budget';
import { quoteArg } from '../../src/shared/paths';

/** cmd.exe's longest command line, which the whole built command has to fit. */
const CMD_LINE_LIMIT = 8_191;

describe('INLINE_PROMPT_BUDGET', () => {
  it('leaves room under the cmd.exe limit for the CLI path, its flags and the MCP URL', () => {
    // The documented overhead beside the prompt is up to about 1,000 characters.
    expect(INLINE_PROMPT_BUDGET + 1_000).toBeLessThanOrEqual(CMD_LINE_LIMIT);
  });
});

describe('commandLineLength', () => {
  it('is the plain length for text without a percent sign', () => {
    expect(commandLineLength('')).toBe(0);
    expect(commandLineLength('abc')).toBe(3);
    expect(commandLineLength('line one\nline two')).toBe(17);
  });

  it('counts each percent sign as four characters', () => {
    expect(commandLineLength('%')).toBe(4);
    expect(commandLineLength('100% done')).toBe(9 + 3);
    expect(commandLineLength('%%')).toBe(8);
    expect(commandLineLength('%'.repeat(100))).toBe(400);
  });

  it('counts each backslash right before a percent sign twice, as quoteArg doubles that run', () => {
    expect(commandLineLength('\\%')).toBe(6);
    expect(commandLineLength('\\\\\\%')).toBe(10);
    // A backslash elsewhere is written once.
    expect(commandLineLength('C:\\dir\\file')).toBe(11);
  });

  // A trailing backslash run is left out: quoteArg doubles it too, so it cannot
  // swallow the closing quote, but a prompt never ends in one.
  it('matches the characters quoteArg writes for a cmd host, less the two quotes around them', () => {
    for (const text of ['100% done', 'Fix %PATH% handling', 'a %% b', '%', '\\%', 'C:\\dir\\%TEMP%\\file', 'a \\\\% b']) {
      const written = quoteArg(text, 'cmd.exe');
      expect(written.length).toBe(commandLineLength(text) + 2);
    }
  });
});

describe('fitCommandLine', () => {
  it('returns text that already fits, unchanged, up to and including the limit', () => {
    expect(fitCommandLine('abcdefghij', 10, 'start')).toBe('abcdefghij');
    expect(fitCommandLine('abcdefghij', 10, 'end')).toBe('abcdefghij');
    expect(fitCommandLine('ab%cd', 8, 'start')).toBe('ab%cd');
    expect(fitCommandLine('', 0, 'start')).toBe('');
  });

  it('keeps the start and marks the cut with three dots', () => {
    expect(fitCommandLine('abcdefghij', 8, 'start')).toBe('abcde...');
  });

  it('keeps the end and marks the cut with three dots in front', () => {
    expect(fitCommandLine('abcdefghij', 8, 'end')).toBe('...fghij');
  });

  it('keeps only the marker when the limit leaves room for nothing else', () => {
    expect(fitCommandLine('abcdefghij', 3, 'start')).toBe('...');
    expect(fitCommandLine('abcdefghij', 3, 'end')).toBe('...');
  });

  it('measures the result by command line length, so percent signs cost four each', () => {
    const fitted = fitCommandLine('%'.repeat(100), 50, 'start');
    expect(fitted).toBe(`${'%'.repeat(11)}...`);
    expect(commandLineLength(fitted)).toBeLessThanOrEqual(50);
    const fittedFromEnd = fitCommandLine('%'.repeat(100), 50, 'end');
    expect(fittedFromEnd).toBe(`...${'%'.repeat(11)}`);
    expect(commandLineLength(fittedFromEnd)).toBeLessThanOrEqual(50);
  });

  it('drops a percent sign at the cut whole rather than keeping part of its cost', () => {
    // 'ab%cd' is 8 long on the line; at 7 there is room for 4 beside the marker.
    // The percent sign costs 4 but only 2 remain after 'ab', so it does not go in.
    expect(fitCommandLine('ab%cd', 7, 'start')).toBe('ab...');
    // From the end: 'd' and 'c' take 2 of the 4, and the percent sign no longer fits.
    expect(fitCommandLine('ab%cd', 7, 'end')).toBe('...cd');
  });

  it('keeps a percent sign at the cut when exactly its cost remains', () => {
    // 3 plain characters and a percent sign (cost 4) plus the marker make 10.
    expect(fitCommandLine(`ab%${'x'.repeat(10)}`, 10, 'start')).toBe('ab%x...');
    expect(commandLineLength('ab%x...')).toBe(10);
    expect(fitCommandLine(`${'x'.repeat(10)}%ab`, 10, 'end')).toBe('...x%ab');
    expect(commandLineLength('...x%ab')).toBe(10);
  });
});
