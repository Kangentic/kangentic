/**
 * The web build serves a recording's serialized frame to any terminal whose grid is not the
 * recording's (demo/README.md, geometry). ConPTY pads every row of such a frame to the recorded
 * width with plain spaces, which wrap into blank rows on a narrower grid and push the frame's
 * cursor off its row. trimRowPadding drops that padding and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { trimRowPadding } from '../captures/helpers/demo-scrollback';

const ESC = '\x1b';

describe('trimRowPadding', () => {
  it('drops default-styled trailing spaces from each row and keeps the cursor sequence', () => {
    const frame = `hello     \r\nworld  ${ESC}[0m   \r\n${ESC}[3;1H`;
    expect(trimRowPadding(frame)).toBe(`hello\r\nworld  ${ESC}[0m\r\n${ESC}[3;1H`);
  });

  it('keeps padding that carries a style, since it paints', () => {
    const diffRow = `${ESC}[41m- removed line        ${ESC}[0m`;
    expect(trimRowPadding(diffRow)).toBe(diffRow);
  });

  it('trims after a reset even when styled text came earlier in the row', () => {
    const row = `${ESC}[32m+ added${ESC}[0m      `;
    expect(trimRowPadding(row)).toBe(`${ESC}[32m+ added${ESC}[0m`);
  });

  it('leaves the padding inside a joined wrapped line alone', () => {
    const joined = 'a'.repeat(154) + '   ' + 'continued';
    expect(trimRowPadding(joined)).toBe(joined);
  });
});
