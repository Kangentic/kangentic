/**
 * What began the quit in progress. A launch the quit ends is reported by the next
 * start as a person giving up unless the quit says otherwise (Sentry DESKTOP-2N
 * was an update's install). A wrong value here is a wrong diagnosis in Sentry,
 * so the default, the first-note-wins rule and the reset are pinned.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { noteQuitBy, quitByNoted, resetQuitBy } from '../../src/main/quit-cause';

describe('quit cause', () => {
  beforeEach(() => {
    resetQuitBy();
  });

  it('is the user\'s unless an update or an OS shutdown said otherwise', () => {
    expect(quitByNoted()).toBe('user');
  });

  it.each(['update', 'os'] as const)('reads %s once it is noted', (by) => {
    noteQuitBy(by);
    expect(quitByNoted()).toBe(by);
  });

  it('keeps the first cause noted, so an OS shutdown during an update\'s quit is still the update\'s', () => {
    noteQuitBy('update');
    noteQuitBy('os');
    expect(quitByNoted()).toBe('update');
  });
});
