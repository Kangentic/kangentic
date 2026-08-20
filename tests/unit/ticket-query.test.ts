import { describe, it, expect } from 'vitest';
import { parseTicketQuery, matchesTicketPrefix } from '../../src/shared/ticket-query';

/**
 * Pure-function coverage for the `#<number>` ticket-search syntax shared by the
 * unified search core, the MCP task-search handler, and the board toolbar
 * filter. See src/shared/ticket-query.ts.
 */

describe('parseTicketQuery', () => {
  it('returns the digit string for a bare "#" + digits query', () => {
    expect(parseTicketQuery('#42')).toBe('42');
    expect(parseTicketQuery('#4')).toBe('4');
    expect(parseTicketQuery('#0')).toBe('0');
    expect(parseTicketQuery('#100')).toBe('100');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parseTicketQuery('  #7 ')).toBe('7');
    expect(parseTicketQuery('\t#12\n')).toBe('12');
  });

  it('returns null for a bare number with no "#" (text search keeps working)', () => {
    expect(parseTicketQuery('42')).toBeNull();
    expect(parseTicketQuery('0')).toBeNull();
  });

  it('returns null when the query is not exactly "#" + digits', () => {
    expect(parseTicketQuery('#')).toBeNull();
    expect(parseTicketQuery('#4a')).toBeNull();
    expect(parseTicketQuery('#4 2')).toBeNull();
    expect(parseTicketQuery('a#4')).toBeNull();
    expect(parseTicketQuery('##4')).toBeNull();
    expect(parseTicketQuery('#-4')).toBeNull();
    expect(parseTicketQuery('fix #4')).toBeNull();
    expect(parseTicketQuery('foo')).toBeNull();
    expect(parseTicketQuery('')).toBeNull();
    expect(parseTicketQuery('   ')).toBeNull();
  });
});

describe('matchesTicketPrefix', () => {
  it('matches the exact number', () => {
    expect(matchesTicketPrefix(42, '42')).toBe(true);
    expect(matchesTicketPrefix(4, '4')).toBe(true);
  });

  it('prefix-matches so a live filter narrows as digits are typed', () => {
    expect(matchesTicketPrefix(4, '4')).toBe(true);
    expect(matchesTicketPrefix(40, '4')).toBe(true);
    expect(matchesTicketPrefix(41, '4')).toBe(true);
    expect(matchesTicketPrefix(400, '4')).toBe(true);
    expect(matchesTicketPrefix(42, '4')).toBe(true);
    expect(matchesTicketPrefix(420, '42')).toBe(true);
  });

  it('does not match a non-prefix number', () => {
    expect(matchesTicketPrefix(5, '4')).toBe(false);
    expect(matchesTicketPrefix(14, '4')).toBe(false);
    expect(matchesTicketPrefix(52, '42')).toBe(false);
  });

  it('treats digits as the canonical decimal string, so leading zeros match nothing', () => {
    expect(matchesTicketPrefix(4, '04')).toBe(false);
    expect(matchesTicketPrefix(40, '04')).toBe(false);
  });
});
