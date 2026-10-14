import { describe, it, expect } from 'vitest';
import { formatCallDuration, formatCost, formatDuration, formatSpan, formatSpanCompact } from '../../src/renderer/utils/format-session';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatCost', () => {
  it('returns $0.00 for NaN', () => {
    expect(formatCost(NaN)).toBe('$0.00');
  });

  it('returns $0.00 for Infinity', () => {
    expect(formatCost(Infinity)).toBe('$0.00');
  });

  it('returns $0.00 for negative Infinity', () => {
    expect(formatCost(-Infinity)).toBe('$0.00');
  });

  it('returns $0.00 for negative values', () => {
    expect(formatCost(-5)).toBe('$0.00');
    expect(formatCost(-0.50)).toBe('$0.00');
  });

  it('returns $0.00 for zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('returns <$0.01 for tiny positive values below one cent', () => {
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(0.009)).toBe('<$0.01');
  });

  it('formats values at exactly one cent', () => {
    expect(formatCost(0.01)).toBe('$0.01');
  });

  it('formats normal values with two decimal places', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(42)).toBe('$42.00');
    expect(formatCost(99.99)).toBe('$99.99');
  });

  it('adds thousands separators for large values', () => {
    expect(formatCost(1495.17)).toBe('$1,495.17');
    expect(formatCost(12345.60)).toBe('$12,345.60');
    expect(formatCost(1000000)).toBe('$1,000,000.00');
  });
});

describe('formatDuration', () => {
  it('returns seconds for durations under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('returns minutes and seconds for durations under an hour', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(3599000)).toBe('59m 59s');
  });

  it('returns hours and minutes for durations over an hour', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(5400000)).toBe('1h 30m');
    expect(formatDuration(7261000)).toBe('2h 1m');
  });

  it('rounds milliseconds to nearest second', () => {
    expect(formatDuration(1499)).toBe('1s');
    expect(formatDuration(1500)).toBe('2s');
  });
});

describe('formatSpan', () => {
  it('reads the two largest units, days included', () => {
    expect(formatSpan(9 * DAY + 9 * HOUR + 12 * MINUTE)).toBe('9d 9h');
    expect(formatSpan(HOUR + 59 * MINUTE + 30 * SECOND)).toBe('1h 59m');
    expect(formatSpan(37 * MINUTE + 37 * SECOND)).toBe('37m 37s');
    expect(formatSpan(5 * SECOND)).toBe('5s');
  });

  it('drops a zero second unit', () => {
    expect(formatSpan(16 * DAY)).toBe('16d');
    expect(formatSpan(2 * HOUR)).toBe('2h');
    expect(formatSpan(20 * MINUTE)).toBe('20m');
  });

  it('reads a negative span as nothing', () => {
    expect(formatSpan(-5 * SECOND)).toBe('0s');
  });
});

describe('formatSpanCompact', () => {
  it('rounds a span under an hour to whole minutes', () => {
    expect(formatSpanCompact(23 * MINUTE + 43 * SECOND)).toBe('24m');
    expect(formatSpanCompact(58 * MINUTE + 29 * SECOND)).toBe('58m');
    expect(formatSpanCompact(MINUTE + 3 * SECOND)).toBe('1m');
  });

  it('rounds a span of hours to minutes, and of days to hours', () => {
    expect(formatSpanCompact(HOUR + 5 * MINUTE + 40 * SECOND)).toBe('1h 6m');
    expect(formatSpanCompact(7 * DAY + 9 * HOUR + 42 * MINUTE)).toBe('7d 10h');
  });

  it('keeps seconds under a minute', () => {
    expect(formatSpanCompact(45 * SECOND)).toBe('45s');
  });

  it('rounds before choosing the unit, so a span just under an hour or a day reads as one', () => {
    expect(formatSpanCompact(59 * MINUTE + 31 * SECOND)).toBe('1h');
    expect(formatSpanCompact(23 * HOUR + 59 * MINUTE + 31 * SECOND)).toBe('1d');
    expect(formatSpanCompact(HOUR)).toBe('1h');
  });
});

describe('formatCallDuration', () => {
  it('reads a short call to a tenth of a second', () => {
    expect(formatCallDuration(2_400)).toBe('2.4s');
    expect(formatCallDuration(25_600)).toBe('25.6s');
  });

  it('reads a call of a minute or more as a span', () => {
    expect(formatCallDuration(MINUTE + 12 * SECOND)).toBe('1m 12s');
  });

  it('rounds before choosing the unit, so a call just under a minute reads as one', () => {
    expect(formatCallDuration(59_960)).toBe('1m');
    expect(formatCallDuration(MINUTE)).toBe('1m');
    expect(formatCallDuration(59_940)).toBe('59.9s');
    expect(formatCallDuration(0)).toBe('0.0s');
  });
});
