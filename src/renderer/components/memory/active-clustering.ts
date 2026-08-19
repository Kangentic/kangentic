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
