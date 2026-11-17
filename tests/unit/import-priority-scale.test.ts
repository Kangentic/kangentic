/**
 * priorityIndexForName on scales other than the stock one. What a user loses if
 * these break: an import onto a renamed or extended priority scale files every
 * ticket at the wrong level (or at a level the scale does not have), and a label
 * the scale already names is overridden by the Highest/Lowest fallback.
 */
import { describe, expect, it } from 'vitest';
import { priorityIndexForName } from '../../src/shared/priority-scale';

function scaleOf(...labels: string[]): Array<{ label: string }> {
  return labels.map((label) => ({ label }));
}

describe('priorityIndexForName on a custom scale', () => {
  it('lets a label the scale names win over the Highest and Lowest fallbacks', () => {
    const scale = scaleOf('None', 'Highest', 'Lowest', 'Normal', 'Top');
    expect(priorityIndexForName('Highest', scale)).toBe(1);
    expect(priorityIndexForName('Lowest', scale)).toBe(2);
  });

  it('maps Highest to the last level and Lowest to the level just above None on a longer scale', () => {
    const scale = scaleOf('None', 'Minor', 'Normal', 'Major', 'Severe', 'Critical');
    expect(priorityIndexForName('highest', scale)).toBe(5);
    expect(priorityIndexForName('LOWEST', scale)).toBe(1);
  });

  it('matches a label ignoring case and surrounding spaces on both sides', () => {
    const scale = scaleOf('None', '  Soon ', 'Now');
    expect(priorityIndexForName('  sOoN', scale)).toBe(1);
    expect(priorityIndexForName('now ', scale)).toBe(2);
  });

  it('never returns a level the scale does not have', () => {
    expect(priorityIndexForName('Lowest', scaleOf('None'))).toBe(0);
    expect(priorityIndexForName('Highest', scaleOf('None'))).toBe(0);
    expect(priorityIndexForName('High', [])).toBe(0);
    expect(priorityIndexForName('Highest', [])).toBe(0);
  });

  it('imports a blank, unknown or non-string name as None', () => {
    const scale = scaleOf('None', 'Low', 'High');
    expect(priorityIndexForName('   ', scale)).toBe(0);
    expect(priorityIndexForName('Blocker', scale)).toBe(0);
    // The name arrives over IPC, so anything but a string imports at the bottom.
    expect(priorityIndexForName(3, scale)).toBe(0);
  });
});
