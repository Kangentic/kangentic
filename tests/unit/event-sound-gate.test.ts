/**
 * The gate that keeps a burst of notifications to one sound. Without it, six agents
 * going idle together, or one event firing a toast and a desktop notice, play over
 * each other.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import { createSoundGate } from '../../src/renderer/utils/event-sound-player';

describe('createSoundGate', () => {
  it('lets the first sound of an event through', () => {
    const mayPlay = createSoundGate(1500);
    expect(mayPlay('onAgentIdle', 0, false)).toBe(true);
  });

  it('drops a repeat of the event inside the window, then lets it through', () => {
    const mayPlay = createSoundGate(1500);
    mayPlay('onAgentIdle', 0, false);

    expect(mayPlay('onAgentIdle', 1499, false)).toBe(false);
    expect(mayPlay('onAgentIdle', 1500, false)).toBe(true);
  });

  it('never starts over a sound still playing', () => {
    const mayPlay = createSoundGate(1500);
    expect(mayPlay('onAgentCrash', 0, true)).toBe(false);
  });

  it('does not spend the event\'s window on a sound that never played', () => {
    const mayPlay = createSoundGate(1500);
    mayPlay('onAgentCrash', 0, true);
    expect(mayPlay('onAgentCrash', 1, false)).toBe(true);
  });

  it('keeps events apart', () => {
    const mayPlay = createSoundGate(1500);
    mayPlay('onAgentIdle', 0, false);
    expect(mayPlay('onAgentCrash', 1, false)).toBe(true);
  });
});
