/**
 * Which carve-up of the map is currently on screen.
 *
 * The projection ships every granularity, so choosing one is a lookup rather
 * than a rebuild. Everything that draws or filters by region reads through here,
 * so there is one answer to "which region is this node in" instead of one per
 * call site.
 */

import type {
  MemoryGraphCluster,
  MemoryGraphGranularity,
  MemoryGraphNode,
  MemoryGraphProjection,
} from '../../../shared/types';

export const DEFAULT_GRANULARITY: MemoryGraphGranularity = 'balanced';

export interface ActiveClustering {
  granularity: MemoryGraphGranularity;
  regions: MemoryGraphCluster[];
  /** This node's region id at the active granularity. */
  regionOf: (node: MemoryGraphNode) => number;
}

/**
 * The granularities worth OFFERING, which is not the same as the granularities
 * computed.
 *
 * How finely the map can be cut is bounded by the corpus, not by the control:
 * below roughly 55 conversations every band clamps to the same floor, and the
 * three settings produce one identical carve-up. Measured across the eight
 * indexed projects on the development machine, four of them resolved all three
 * granularities to the same region count and two more collapsed two of the
 * three. Offering three chips that paint the same picture is the same defect as
 * a filter row that can only ever do nothing, and this surface already hides
 * those (the dead facet rows).
 *
 * Deduped by REGION COUNT rather than by identity, since two carve-ups with the
 * same count are the same k-means run over the same layout. Balanced is kept
 * unconditionally: it is the default and has to stay selectable, so it is the
 * survivor of any tie it is in.
 */
export function availableGranularities(
  projection: Pick<MemoryGraphProjection, 'clusterings'> | null | undefined,
): MemoryGraphGranularity[] {
  const clusterings = projection?.clusterings ?? [];
  if (clusterings.length === 0) return [];
  const countOf = (granularity: MemoryGraphGranularity): number | null => {
    const entry = clusterings.find((candidate) => candidate.granularity === granularity);
    return entry ? entry.regions.length : null;
  };

  const defaultCount = countOf(DEFAULT_GRANULARITY);
  const seen = new Set<number>();
  if (defaultCount !== null) seen.add(defaultCount);

  const available: MemoryGraphGranularity[] = [];
  for (const entry of clusterings) {
    const count = entry.regions.length;
    if (entry.granularity === DEFAULT_GRANULARITY) {
      available.push(entry.granularity);
      continue;
    }
    if (seen.has(count)) continue;
    seen.add(count);
    available.push(entry.granularity);
  }
  // One option is not a choice. The caller hides the control rather than
  // rendering a single chip that cannot be changed.
  return available.length > 1 ? available : [];
}

export function resolveClustering(
  projection: Pick<MemoryGraphProjection, 'clusterings'>,
  granularity: MemoryGraphGranularity,
): ActiveClustering {
  const clusterings = projection.clusterings ?? [];
  // Falling back to whatever IS present rather than to an empty map: a
  // projection built before a granularity existed would otherwise render a
  // regionless map with no explanation.
  const entry = clusterings.find((candidate) => candidate.granularity === granularity)
    ?? clusterings.find((candidate) => candidate.granularity === DEFAULT_GRANULARITY)
    ?? clusterings[0];
  const resolved = entry?.granularity ?? granularity;
  return {
    granularity: resolved,
    regions: entry?.regions ?? [],
    regionOf: (node) => node.clusters?.[resolved] ?? 0,
  };
}
