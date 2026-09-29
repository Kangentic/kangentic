import { describe, expect, it } from 'vitest';
import { composeIslands, placeIslands } from '../../src/renderer/components/knowledge-graph/compose-islands';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../src/shared/types';

function node(docKey: string, x: number, balanced: number): KnowledgeGraphNode {
  return {
    docKey, x, y: 0.5, z: 0.5, chunkCount: 1, title: docKey, sessionId: `session-${docKey}`, taskId: null,
    displayId: null, agent: null, model: null, effort: null, durationMs: null, costUsd: null, tokens: null,
    lastActivityMs: null, outcome: null, clusters: { coarse: 0, balanced, fine: balanced },
  };
}

function projection(prefix: string, count: number, regions: number): KnowledgeGraphProjection {
  const nodes = Array.from({ length: count }, (_, index) => node(`${prefix}-${index}`, index / Math.max(1, count - 1), index % regions));
  const regionList = Array.from({ length: regions }, (_, id) => ({ id, label: `${prefix} region ${id}`, x: 0.5, y: 0.5, z: 0.5, size: 1 }));
  return {
    nodes,
    edges: count > 1 ? [{ source: 0, target: 1, similarity: 0.9 }] : [],
    clusterings: [
      { granularity: 'coarse', regions: [{ id: 0, label: `${prefix} all`, x: 0.5, y: 0.5, z: 0.5, size: count }] },
      { granularity: 'balanced', regions: regionList },
      { granularity: 'fine', regions: regionList },
    ],
    signature: `${prefix}-sig`,
    modelTag: 'bge-base',
    dimensions: 768,
    nodeNeighbors: nodes.map((_, index) => (index + 1 < count ? [{ index: index + 1, similarity: 0.8 }] : [])),
    storageBytes: 100,
    builtAt: `2026-09-2${count % 10}T00:00:00.000Z`,
  };
}

describe('composeIslands', () => {
  const composed = composeIslands([
    { projectId: 'p1', name: 'first', projection: projection('a', 4, 2) },
    { projectId: 'p2', name: 'second', projection: projection('b', 3, 3) },
  ]);

  it('concatenates the nodes and records where each island starts and which project owns a node', () => {
    expect(composed.projection.nodes.map((entry) => entry.docKey)).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'b-0', 'b-1', 'b-2']);
    expect(composed.islands).toEqual([
      { projectId: 'p1', name: 'first', start: 0, end: 4 },
      { projectId: 'p2', name: 'second', start: 4, end: 7 },
    ]);
    expect(composed.nodeProjectIds).toEqual(['p1', 'p1', 'p1', 'p1', 'p2', 'p2', 'p2']);
  });

  it('offsets links and neighbours so they never cross between islands', () => {
    expect(composed.projection.edges).toEqual([
      { source: 0, target: 1, similarity: 0.9 },
      { source: 4, target: 5, similarity: 0.9 },
    ]);
    expect(composed.projection.nodeNeighbors[4]).toEqual([{ index: 5, similarity: 0.8 }]);
    expect(composed.projection.nodeNeighbors).toHaveLength(7);
  });

  it('offsets region ids per granularity and names the project each region belongs to', () => {
    const balanced = composed.projection.clusterings.find((clustering) => clustering.granularity === 'balanced')!;
    expect(balanced.regions.map((region) => region.id)).toEqual([0, 1, 2, 3, 4]);
    expect(composed.regionProjectNames.balanced).toEqual(['first', 'first', 'second', 'second', 'second']);
    // The second island's first node was in its own region 0, which is composed region 2.
    expect(composed.projection.nodes[4].clusters.balanced).toBe(2);
    const coarse = composed.projection.clusterings.find((clustering) => clustering.granularity === 'coarse')!;
    expect(coarse.regions.map((region) => region.id)).toEqual([0, 1]);
    expect(composed.projection.nodes[6].clusters.coarse).toBe(1);
  });

  it('draws the largest island at its own size and keeps the islands apart', () => {
    // Shrinking it to fit made the map brighter the moment a second project
    // joined: the same nodes, packed denser, under additive glow.
    const firstXs = composed.projection.nodes.slice(0, 4).map((entry) => entry.x);
    const secondXs = composed.projection.nodes.slice(4).map((entry) => entry.x);
    expect(Math.max(...firstXs) - Math.min(...firstXs)).toBeCloseTo(1, 5);
    expect(Math.max(...firstXs)).toBeLessThan(Math.min(...secondXs));
    // Two side by side need more than one unit box, and the extent says so.
    expect(composed.extent).toBeGreaterThan(2);
  });

  it('changes its signature only when a member map changes', () => {
    const again = composeIslands([
      { projectId: 'p1', name: 'first', projection: projection('a', 4, 2) },
      { projectId: 'p2', name: 'second', projection: projection('b', 3, 3) },
    ]);
    expect(again.projection.signature).toBe(composed.projection.signature);
    const changed = composeIslands([
      { projectId: 'p1', name: 'first', projection: { ...projection('a', 4, 2), signature: 'a-sig-2' } },
      { projectId: 'p2', name: 'second', projection: projection('b', 3, 3) },
    ]);
    expect(changed.projection.signature).not.toBe(composed.projection.signature);
  });

  it('sums storage and takes the latest build time', () => {
    expect(composed.projection.storageBytes).toBe(200);
    expect(composed.projection.builtAt).toBe('2026-09-24T00:00:00.000Z');
  });
});

describe('placeIslands', () => {
  it('keeps the largest island at its own size and scales the rest by the square root of their share', () => {
    const { placements: [large, medium, tiny] } = placeIslands([900, 100, 1]);
    expect(large.scale).toBe(1);
    expect(medium.scale).toBeCloseTo(Math.sqrt(100 / 900), 5);
    // Floored, so a project with a handful of conversations is still a place.
    expect(tiny.scale).toBeGreaterThan(0.3);
  });

  it('lays nineteen islands out on a near-square grid centred on the unit box, none overlapping', () => {
    const { placements, extent } = placeIslands(Array.from({ length: 19 }, (_, index) => 100 - index));
    // Five columns by four rows, each cell wider than an island.
    expect(extent).toBeGreaterThan(5);
    const half = extent / 2;
    for (const placement of placements) {
      expect(placement.centerX - placement.scale / 2).toBeGreaterThanOrEqual(0.5 - half);
      expect(placement.centerX + placement.scale / 2).toBeLessThanOrEqual(0.5 + half);
      expect(placement.centerY - placement.scale / 2).toBeGreaterThanOrEqual(0.5 - half);
      expect(placement.centerY + placement.scale / 2).toBeLessThanOrEqual(0.5 + half);
    }
    for (let first = 0; first < placements.length; first += 1) {
      for (let second = first + 1; second < placements.length; second += 1) {
        const apartX = Math.abs(placements[first].centerX - placements[second].centerX)
          >= (placements[first].scale + placements[second].scale) / 2;
        const apartY = Math.abs(placements[first].centerY - placements[second].centerY)
          >= (placements[first].scale + placements[second].scale) / 2;
        expect(apartX || apartY).toBe(true);
      }
    }
    // The first island (the open project) is at the top left.
    expect(placements[0].centerY).toBeGreaterThan(placements[18].centerY);
    expect(placements[0].centerX).toBeLessThan(placements[1].centerX);
  });

  it('draws one project exactly as its own map', () => {
    const { placements: [only], extent } = placeIslands([500]);
    expect(only.centerX).toBeCloseTo(0.5, 9);
    expect(only.centerY).toBeCloseTo(0.5, 9);
    expect(only.scale).toBe(1);
    expect(extent).toBeCloseTo(1 / 0.84, 5);
  });
});
