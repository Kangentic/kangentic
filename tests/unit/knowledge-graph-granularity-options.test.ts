/**
 * The Detail control must not offer chips that paint the same map.
 *
 * How finely the map CAN be cut is bounded by the corpus, not by the control.
 * Every band clamps to the same floor on a small index, so all three settings
 * resolve to one identical carve-up - measured across the eight indexed projects
 * on the development machine, four of them collapsed all three granularities to
 * the same region count and two more collapsed two of the three. A chip that
 * repaints the picture you are already looking at is the same defect as a filter
 * row that can only ever do nothing, and this surface hides those.
 */

import { describe, it, expect } from 'vitest';
import { availableGranularities, DEFAULT_GRANULARITY } from '../../src/renderer/components/knowledge-graph/active-clustering';
import type { KnowledgeGraphClustering, KnowledgeGraphGranularity } from '../../src/shared/types';

/** A clustering carrying `count` regions. Only the count is read here, which is
 *  the whole point: two carve-ups with the same count are the same k-means run
 *  over the same layout. */
function clustering(granularity: KnowledgeGraphGranularity, count: number): KnowledgeGraphClustering {
  return {
    granularity,
    regions: Array.from({ length: count }, (unused, index) => ({
      id: index,
      label: `region ${index}`,
      x: 0.5,
      y: 0.5,
      z: 0.5,
      size: 10,
    })),
  };
}

describe('granularity options', () => {
  it('offers all three when the corpus can express all three', () => {
    // The real 646-conversation corpus, which resolves to 22 / 34 / 40.
    expect(
      availableGranularities({
        clusterings: [clustering('coarse', 22), clustering('balanced', 34), clustering('fine', 40)],
      }),
    ).toEqual(['coarse', 'balanced', 'fine']);
  });

  it('drops a granularity that resolves to the map already on offer', () => {
    // A project with about 30 conversations: coarse and balanced both clamp to 3.
    expect(
      availableGranularities({
        clusterings: [clustering('coarse', 3), clustering('balanced', 3), clustering('fine', 4)],
      }),
    ).toEqual(['balanced', 'fine']);
  });

  it('keeps the default over a coarser twin, since it must stay selectable', () => {
    // Dropping balanced would leave the control with no chip for the setting the
    // surface actually starts on, so the survivor of a tie is always the default.
    const available = availableGranularities({
      clusterings: [clustering('coarse', 5), clustering('balanced', 5), clustering('fine', 8)],
    });
    expect(available).toContain(DEFAULT_GRANULARITY);
    expect(available).not.toContain('coarse');
  });

  it('hides the control when every setting is the same map', () => {
    // Four of the eight real projects. One chip is not a choice, so the caller
    // renders nothing rather than an unchangeable control.
    expect(
      availableGranularities({
        clusterings: [clustering('coarse', 3), clustering('balanced', 3), clustering('fine', 3)],
      }),
    ).toEqual([]);
  });

  it('hides the control rather than throwing on a projection with no clusterings', () => {
    expect(availableGranularities(null)).toEqual([]);
    expect(availableGranularities(undefined)).toEqual([]);
    expect(availableGranularities({ clusterings: [] })).toEqual([]);
  });
});
