/**
 * Several projects' maps drawn as one scene: one island per project.
 *
 * Each project's projection is laid out on its own, in its own embedding space,
 * and cached per project. Composing them is therefore a placement, not a new
 * layout: each map is scaled by how many conversations it holds and set into a
 * cell of a grid, and every index (nodes, links, neighbours, regions) is offset
 * so the composed projection reads exactly like a single one to everything that
 * draws it. No link crosses between islands, because no similarity was ever
 * computed across projects, and a combined layout would cost a fresh neighbour
 * search and layout over the union on every change of selection.
 *
 * Pure, so the placement and the index arithmetic can be pinned without a scene.
 */

import type {
  MemoryGraphCluster,
  MemoryGraphClustering,
  MemoryGraphEdge,
  MemoryGraphGranularity,
  MemoryGraphNode,
  MemoryGraphProjection,
} from '../../../shared/types';

export interface IslandSource {
  projectId: string;
  name: string;
  projection: MemoryGraphProjection;
}

export interface Island {
  projectId: string;
  name: string;
  /** Node indices [start, end) in the composed projection. */
  start: number;
  end: number;
}

export interface ComposedIslands {
  projection: MemoryGraphProjection;
  islands: Island[];
  /** The project each composed node came from, by node index. */
  nodeProjectIds: string[];
  /** The project each composed region belongs to, by region id, per granularity. */
  regionProjectNames: Partial<Record<MemoryGraphGranularity, string[]>>;
}

/** Share of a grid cell the largest island fills, leaving a gutter between islands. */
const ISLAND_FILL = 0.84;
/** The smallest an island is drawn, relative to the largest, so a project with a
 *  handful of conversations is still a place on the map rather than a speck. */
const MIN_ISLAND_SCALE = 0.32;

/**
 * Where each island sits and how large it is, in the unit box.
 *
 * A near-square grid, filled row by row in the order given (the caller puts the
 * open project first). Each island's side scales with the square root of its
 * conversation count, so its AREA tracks how much work it holds.
 */
export function placeIslands(sizes: ReadonlyArray<number>): Array<{ centerX: number; centerY: number; scale: number }> {
  const count = sizes.length;
  if (count === 0) return [];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cell = 1 / Math.max(columns, rows);
  const offsetX = (1 - columns * cell) / 2;
  const offsetY = (1 - rows * cell) / 2;
  const largest = Math.max(1, ...sizes);
  return sizes.map((size, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const relative = Math.max(MIN_ISLAND_SCALE, Math.sqrt(Math.max(size, 1) / largest));
    return {
      centerX: offsetX + (column + 0.5) * cell,
      // Row 0 at the TOP: world y points up.
      centerY: 1 - (offsetY + (row + 0.5) * cell),
      scale: cell * ISLAND_FILL * relative,
    };
  });
}

function placed(value: number, center: number, scale: number): number {
  return center + (value - 0.5) * scale;
}

export function composeIslands(sources: ReadonlyArray<IslandSource>): ComposedIslands {
  const placements = placeIslands(sources.map((source) => source.projection.nodes.length));
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const nodeNeighbors: Array<ReadonlyArray<{ index: number; similarity: number }>> = [];
  const nodeProjectIds: string[] = [];
  const islands: Island[] = [];
  const granularities = new Set<MemoryGraphGranularity>();
  for (const source of sources) {
    for (const clustering of source.projection.clusterings) granularities.add(clustering.granularity);
  }
  const regionsByGranularity = new Map<MemoryGraphGranularity, MemoryGraphCluster[]>();
  const regionProjectNames: Partial<Record<MemoryGraphGranularity, string[]>> = {};
  for (const granularity of granularities) {
    regionsByGranularity.set(granularity, []);
    regionProjectNames[granularity] = [];
  }

  sources.forEach((source, sourceIndex) => {
    const { centerX, centerY, scale } = placements[sourceIndex];
    const nodeOffset = nodes.length;
    // Where this island's regions start, per granularity, so a node's region id
    // and the region list agree after the offset.
    const regionOffsets = new Map<MemoryGraphGranularity, number>();
    for (const granularity of granularities) {
      regionOffsets.set(granularity, regionsByGranularity.get(granularity)?.length ?? 0);
    }
    const ownClustering = (granularity: MemoryGraphGranularity): MemoryGraphClustering | undefined =>
      source.projection.clusterings.find((clustering) => clustering.granularity === granularity)
      ?? source.projection.clusterings[0];

    for (const node of source.projection.nodes) {
      const clusters = {} as Record<MemoryGraphGranularity, number>;
      for (const granularity of granularities) {
        const own = node.clusters[granularity] ?? node.clusters[ownClustering(granularity)?.granularity ?? granularity] ?? 0;
        clusters[granularity] = own + (regionOffsets.get(granularity) ?? 0);
      }
      nodes.push({
        ...node,
        x: placed(node.x, centerX, scale),
        y: placed(node.y, centerY, scale),
        z: placed(node.z, 0.5, scale),
        clusters,
      });
      nodeProjectIds.push(source.projectId);
    }
    for (const edge of source.projection.edges) {
      edges.push({ ...edge, source: edge.source + nodeOffset, target: edge.target + nodeOffset });
    }
    for (const list of source.projection.nodeNeighbors ?? []) {
      nodeNeighbors.push(list.map((entry) => ({ index: entry.index + nodeOffset, similarity: entry.similarity })));
    }
    // A projection that shipped fewer neighbour lists than nodes still lines up.
    while (nodeNeighbors.length < nodes.length) nodeNeighbors.push([]);

    for (const granularity of granularities) {
      const clustering = ownClustering(granularity);
      const target = regionsByGranularity.get(granularity);
      const names = regionProjectNames[granularity];
      if (!clustering || !target || !names) continue;
      const offset = regionOffsets.get(granularity) ?? 0;
      for (const region of clustering.regions) {
        target.push({
          ...region,
          id: region.id + offset,
          x: placed(region.x, centerX, scale),
          y: placed(region.y, centerY, scale),
          z: placed(region.z, 0.5, scale),
        });
        names.push(source.name);
      }
    }

    islands.push({ projectId: source.projectId, name: source.name, start: nodeOffset, end: nodes.length });
  });

  const clusterings: MemoryGraphClustering[] = [...granularities].map((granularity) => ({
    granularity,
    regions: regionsByGranularity.get(granularity) ?? [],
  }));
  const first = sources[0]?.projection;
  return {
    projection: {
      nodes,
      edges,
      clusterings,
      // Changes only when a member's own map changes, so a recomposition that
      // changes nothing does not rebuild the scene.
      signature: `islands:${sources.map((source) => `${source.projectId}=${source.projection.signature}`).join('|')}`,
      modelTag: first?.modelTag ?? '',
      dimensions: first?.dimensions ?? 0,
      nodeNeighbors,
      storageBytes: sources.reduce((total, source) => total + (source.projection.storageBytes ?? 0), 0),
      builtAt: sources.reduce((latest, source) => (source.projection.builtAt > latest ? source.projection.builtAt : latest), ''),
    },
    islands,
    nodeProjectIds,
    regionProjectNames,
  };
}
