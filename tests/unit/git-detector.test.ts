import { describe, it, expect } from 'vitest';
import { isVersionAtLeast } from '../../src/main/git/git-detector';

describe('isVersionAtLeast', () => {
  it('returns true when versions are equal', () => {
    expect(isVersionAtLeast('2.25.0', '2.25.0')).toBe(true);
  });

  it('returns true when actual patch is higher', () => {
    expect(isVersionAtLeast('2.25.1', '2.25.0')).toBe(true);
  });

  it('returns true when actual minor is higher', () => {
    expect(isVersionAtLeast('2.26.0', '2.25.0')).toBe(true);
  });

  it('returns true when actual major is higher', () => {
    expect(isVersionAtLeast('3.0.0', '2.25.0')).toBe(true);
  });

  it('returns false when actual patch is lower', () => {
    expect(isVersionAtLeast('2.25.0', '2.25.1')).toBe(false);
  });

  it('returns false when actual minor is lower', () => {
    expect(isVersionAtLeast('2.24.0', '2.25.0')).toBe(false);
  });

  it('returns false when actual major is lower', () => {
    expect(isVersionAtLeast('1.99.99', '2.25.0')).toBe(false);
  });

  it('handles actual with more segments than minimum', () => {
    expect(isVersionAtLeast('2.43.0', '2.25.0')).toBe(true);
  });

  it('handles actual with fewer segments than minimum', () => {
    expect(isVersionAtLeast('3.0', '2.25.0')).toBe(true);
  });

  it('treats missing segments as zero', () => {
    expect(isVersionAtLeast('2.25', '2.25.0')).toBe(true);
    expect(isVersionAtLeast('2.25', '2.25.1')).toBe(false);
  });

  it('handles real-world git versions', () => {
    // Windows: "2.43.0" from "git version 2.43.0.windows.1"
    expect(isVersionAtLeast('2.43.0', '2.25.0')).toBe(true);
    // Old git
    expect(isVersionAtLeast('2.17.1', '2.25.0')).toBe(false);
    // Exact minimum
    expect(isVersionAtLeast('2.25.0', '2.25.0')).toBe(true);
  });
});
