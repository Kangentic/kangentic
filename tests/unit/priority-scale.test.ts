/**
 * The shared priority-scale readers. What a user loses without them: a board
 * import that matches a provider's "High" only on exact text drops a padded or
 * differently cased name to the bottom level, and a non-string priority that
 * arrives over IPC would throw inside the import instead of landing at the
 * bottom level.
 */
import { describe, it, expect } from 'vitest';
import { priorityIndexForName, priorityScaleFrom } from '../../src/shared/priority-scale';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';

const SCALE = [
  { label: 'Low', color: '#111111' },
  { label: 'High ', color: '#222222' },
  { label: 'Urgent', color: '#333333' },
];

describe('priorityIndexForName', () => {
  it('ignores case and surrounding whitespace on both sides', () => {
    expect(priorityIndexForName(' high ', SCALE)).toBe(1);
    expect(priorityIndexForName('URGENT', SCALE)).toBe(2);
  });

  it('lands on the index of a reordered or renamed scale', () => {
    const reordered = [SCALE[2], SCALE[1], SCALE[0]];
    expect(priorityIndexForName('Low', reordered)).toBe(2);
    const renamed = [{ label: 'Meh', color: '#000000' }, { label: 'Critical', color: '#ffffff' }];
    expect(priorityIndexForName('Critical', renamed)).toBe(1);
  });

  it('returns the bottom level for an unmatched or empty name', () => {
    expect(priorityIndexForName('Blocker', SCALE)).toBe(0);
    expect(priorityIndexForName('', SCALE)).toBe(0);
  });

  it('returns the bottom level for anything that is not a string', () => {
    expect(priorityIndexForName(undefined, SCALE)).toBe(0);
    expect(priorityIndexForName(2, SCALE)).toBe(0);
    expect(priorityIndexForName({ label: 'Urgent' }, SCALE)).toBe(0);
  });
});

describe('priorityScaleFrom', () => {
  it('reads an absent or empty scale as the seeded scale', () => {
    expect(priorityScaleFrom(undefined)).toBe(DEFAULT_PRIORITY_CONFIG);
    expect(priorityScaleFrom([])).toBe(DEFAULT_PRIORITY_CONFIG);
  });

  it('returns a given scale unchanged', () => {
    expect(priorityScaleFrom(SCALE)).toBe(SCALE);
  });
});
