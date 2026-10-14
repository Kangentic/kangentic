import { describe, it, expect } from 'vitest';
import { prefersDarkText, readableTextOn } from '../../src/renderer/utils/readable-text';

/**
 * Text on a column's own color: near-black or white, whichever has the higher
 * WCAG contrast against the fill.
 */
describe('readableTextOn', () => {
  it('puts dark text on the light and mid-tone column colors', () => {
    for (const fill of ['#f59e0b', '#06b6d4', '#f97316', '#ffffff', '#3b82f6']) {
      expect(readableTextOn(fill), fill).toBe('#18181b');
    }
  });

  it('puts white text on a dark fill', () => {
    for (const fill of ['#1e3a8a', '#000000', '#3f3f46', '#7f1d1d']) {
      expect(readableTextOn(fill), fill).toBe('#ffffff');
    }
  });

  it('reads the three-digit form', () => {
    expect(prefersDarkText('#fff')).toBe(true);
    expect(prefersDarkText('#000')).toBe(false);
  });

  it('reads a color that does not parse as dark text', () => {
    expect(prefersDarkText('rebeccapurple')).toBe(true);
    expect(prefersDarkText('')).toBe(true);
  });
});
