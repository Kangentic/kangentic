/**
 * resolveImportPriority on scales other than the stock one. What a user loses if
 * these break: an import onto a renamed or extended priority scale files every
 * ticket at the wrong level (or at a level the scale does not have), and a label
 * the scale already names is overridden by the Highest/Lowest fallback.
 */
import { describe, expect, it } from 'vitest';
import { resolveImportPriority } from '../../src/main/boards/shared/priority';

function scaleOf(...labels: string[]): Array<{ label: string }> {
  return labels.map((label) => ({ label }));
}

describe('resolveImportPriority on a custom scale', () => {
  it('lets a label the scale names win over the Highest and Lowest fallbacks', () => {
    const scale = scaleOf('None', 'Highest', 'Lowest', 'Normal', 'Top');
    expect(resolveImportPriority('Highest', scale)).toBe(1);
    expect(resolveImportPriority('Lowest', scale)).toBe(2);
  });

  it('maps Highest to the last level and Lowest to the level just above None on a longer scale', () => {
    const scale = scaleOf('None', 'Minor', 'Normal', 'Major', 'Severe', 'Critical');
    expect(resolveImportPriority('highest', scale)).toBe(5);
    expect(resolveImportPriority('LOWEST', scale)).toBe(1);
  });

  it('matches a label ignoring case and surrounding spaces on both sides', () => {
    const scale = scaleOf('None', '  Soon ', 'Now');
    expect(resolveImportPriority('  sOoN', scale)).toBe(1);
    expect(resolveImportPriority('now ', scale)).toBe(2);
  });

  it('never returns a level the scale does not have', () => {
    expect(resolveImportPriority('Lowest', scaleOf('None'))).toBe(0);
    expect(resolveImportPriority('Highest', scaleOf('None'))).toBe(0);
    expect(resolveImportPriority('High', [])).toBe(0);
    expect(resolveImportPriority('Highest', [])).toBe(0);
  });

  it('imports a blank or unknown name as None', () => {
    const scale = scaleOf('None', 'Low', 'High');
    expect(resolveImportPriority('   ', scale)).toBe(0);
    expect(resolveImportPriority('Blocker', scale)).toBe(0);
  });
});
