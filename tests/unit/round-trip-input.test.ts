import { describe, it, expect } from 'vitest';
import { isSingleKeystroke, isSingleMouseReport } from '../../src/shared/round-trip-input';

const WHEEL_UP = '\x1b[<64;10;5M';

describe('isSingleMouseReport', () => {
  it('accepts one SGR or X10 report and nothing else', () => {
    expect(isSingleMouseReport(WHEEL_UP)).toBe(true);
    expect(isSingleMouseReport('\x1b[<0;3;4m')).toBe(true);
    expect(isSingleMouseReport('\x1b[M`!!')).toBe(true);
    expect(isSingleMouseReport(WHEEL_UP + WHEEL_UP)).toBe(false);
    expect(isSingleMouseReport('\x1b[O\x1b[I')).toBe(false);
    expect(isSingleMouseReport('hello')).toBe(false);
  });
});

describe('isSingleKeystroke', () => {
  it('accepts one printable character or Backspace, and no report or paste', () => {
    expect(isSingleKeystroke('x')).toBe(true);
    expect(isSingleKeystroke(' ')).toBe(true);
    expect(isSingleKeystroke('\x7f')).toBe(true);
    expect(isSingleKeystroke('\x08')).toBe(true);
    expect(isSingleKeystroke('xy')).toBe(false);
    expect(isSingleKeystroke('\r')).toBe(false);
    expect(isSingleKeystroke('\x1b[I')).toBe(false);
    expect(isSingleKeystroke(WHEEL_UP)).toBe(false);
  });
});
