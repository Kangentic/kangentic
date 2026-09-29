/**
 * Region names laid over a built map, without rebuilding it.
 *
 * A map is expensive to build (a scan of every embedding, a kNN and a layout)
 * and its regions are cut once, at build time. Their NAMES are cheap to make
 * again: about 21 ms a granularity on 998 conversations, from the titles, the
 * regions' members and, with task summaries on, each task's summary. So the names
 * are made here, stored against the map they were made for, and laid over the
 * cached map on every read. That lets summaries rename regions as they are
 * written, lets switching summaries off put the title-only names back, and lets a
 * change to how names are made (`LABELLER_VERSION`) rename every map, none of
 * which moves a node or needs a rebuild.
 *
 * The map's own build-time names stay title-only, and stand in until these
 * exist.
 */

import type { KnowledgeGraphGranularity, KnowledgeGraphProjection } from '../../../shared/types';
import { SUMMARY_FILLER, SUMMARY_LABEL_WEIGHT, LABELLER_VERSION, labelClusters } from './cluster-labels';

/** Where the names are stored, in `memory_meta`. */
export const REGION_NAMES_KEY = 'graph_region_names';

/** The layout's components, as the map is built in (`projection-engine.ts`). */
const LAYOUT_COMPONENTS = 3;

/** What the names were made from, when summaries are off. */
export const SUMMARIES_OFF = 'off';

export interface StoredRegionNames {
  /** The map the names were made for. A region id means nothing on another. */
  readonly signature: string;
  /** How they were made (`LABELLER_VERSION`). */
  readonly labellerVersion: number;
  /** `SUMMARIES_OFF`, or the summaries they read (`SummaryStore.fingerprint()`). */
  readonly summaries: string;
  /** Each granularity's names, by region id. */
  readonly names: Partial<Record<KnowledgeGraphGranularity, Record<number, string>>>;
}

/**
 * The names of one granularity's regions: from the titles, plus each task's
 * summary at a lower weight when `summaryByTask` is given.
 */
export function nameRegions(
  projection: Pick<KnowledgeGraphProjection, 'nodes' | 'clusterings'>,
  granularity: KnowledgeGraphGranularity,
  summaryByTask: ReadonlyMap<string, string> | null,
): Record<number, string> {
  const clustering = projection.clusterings.find((entry) => entry.granularity === granularity);
  if (!clustering) return {};
  const nodes = projection.nodes;
  const points = new Float32Array(nodes.length * LAYOUT_COMPONENTS);
  const clusterOf = new Int32Array(nodes.length);
  let clusterCount = 0;
  for (const region of clustering.regions) clusterCount = Math.max(clusterCount, region.id + 1);
  nodes.forEach((node, row) => {
    points[row * LAYOUT_COMPONENTS] = node.x;
    points[row * LAYOUT_COMPONENTS + 1] = node.y;
    points[row * LAYOUT_COMPONENTS + 2] = node.z;
    const cluster = node.clusters[granularity] ?? 0;
    clusterOf[row] = cluster;
    clusterCount = Math.max(clusterCount, cluster + 1);
  });
  const titles = nodes.map((node) => node.title ?? '');
  const secondary = summaryByTask
    ? {
      texts: nodes.map((node) => (node.taskId ? summaryByTask.get(node.taskId) ?? '' : '')),
      weight: SUMMARY_LABEL_WEIGHT,
      stopWords: SUMMARY_FILLER,
    }
    : undefined;
  const summaries = labelClusters({ clusterOf, clusterCount }, titles, points, LAYOUT_COMPONENTS, secondary);
  return Object.fromEntries(summaries.map((summary) => [summary.id, summary.label]));
}

/**
 * Whether stored names may be SHOWN on this map: made for it, the current way,
 * and with summaries on or off as they are now. They may be a few summaries
 * behind, which `regionNamesCurrent` tells apart.
 */
export function regionNamesUsable(
  stored: StoredRegionNames | null,
  signature: string,
  summaries: string,
): stored is StoredRegionNames {
  return stored !== null
    && stored.signature === signature
    && stored.labellerVersion === LABELLER_VERSION
    && (stored.summaries === SUMMARIES_OFF) === (summaries === SUMMARIES_OFF);
}

/** Whether stored names are exactly what would be made now. */
export function regionNamesCurrent(
  stored: StoredRegionNames | null,
  signature: string,
  summaries: string,
): boolean {
  return regionNamesUsable(stored, signature, summaries) && stored.summaries === summaries;
}

/** The map with stored names over its own, or the map as it is. */
export function withRegionNames<Projection extends Pick<KnowledgeGraphProjection, 'clusterings' | 'signature'>>(
  projection: Projection,
  stored: StoredRegionNames | null,
  summaries: string,
): Projection {
  if (!regionNamesUsable(stored, projection.signature, summaries)) return projection;
  return {
    ...projection,
    clusterings: projection.clusterings.map((clustering) => {
      const names = stored.names[clustering.granularity];
      if (!names) return clustering;
      return {
        ...clustering,
        regions: clustering.regions.map((region) => ({ ...region, label: names[region.id] ?? region.label })),
      };
    }),
  };
}

/** Stored names from `memory_meta`, or null when absent or unreadable. */
export function parseStoredRegionNames(raw: string | undefined): StoredRegionNames | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as StoredRegionNames;
    return typeof parsed?.signature === 'string' && typeof parsed.summaries === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
