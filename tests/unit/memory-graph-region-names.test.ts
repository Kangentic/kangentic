/**
 * Region names laid over a built map: made from the titles, plus each task's
 * digest at a lower weight while digests are on, stored against the map they
 * were made for, and made again only when what they read has changed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MemoryGraphNode, MemoryGraphProjection } from '../../src/shared/types';

const state = {
  projection: null as MemoryGraphProjection | null,
  meta: new Map<string, string>(),
};

vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));

vi.mock('../../src/main/retrieval/graph/projection-engine', () => ({
  runProjectionPass: vi.fn(),
  readCachedProjection: () => (state.projection ? JSON.parse(JSON.stringify(state.projection)) : null),
  writeProjectionCache: vi.fn(),
  isProjectionFresh: () => true,
}));

vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    readonly hasVec = true;
    getMeta(key: string): string | undefined {
      return state.meta.get(key);
    }
    setMeta(key: string, value: string): void {
      state.meta.set(key, value);
    }
  },
}));

import { labelClusters, DIGEST_FILLER, DIGEST_LABEL_WEIGHT, LABELLER_VERSION } from '../../src/main/retrieval/graph/cluster-labels';
import {
  DIGESTS_OFF,
  REGION_NAMES_KEY,
  nameRegions,
  regionNamesCurrent,
  regionNamesUsable,
  withRegionNames,
  type StoredRegionNames,
} from '../../src/main/retrieval/graph/region-names';
import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

function node(index: number, title: string, cluster: number): MemoryGraphNode {
  return {
    docKey: `conversation::doc-${index}`,
    x: cluster, y: index / 100, z: 0,
    chunkCount: 5,
    title,
    sessionId: `session-${index}`,
    taskId: `task-${index}`,
    displayId: index,
    agent: null, model: null, effort: null,
    durationMs: null, costUsd: null, tokens: null, lastActivityMs: null,
    outcome: 'done',
    clusters: { coarse: 0, balanced: cluster, fine: cluster },
  };
}

/** Two regions of four conversations. Region 0's titles share nothing useful;
 *  its digests all name the wheel scroll. Region 1 is about the schema. */
function projection(signature = 'sig-1'): MemoryGraphProjection {
  const nodes = [
    node(0, 'Terminal lag report', 0),
    node(1, 'Terminal feels slow', 0),
    node(2, 'Terminal input lag', 0),
    node(3, 'Terminal is sluggish', 0),
    node(4, 'Schema migration for digests', 1),
    node(5, 'Schema migration for effort', 1),
    node(6, 'Schema column cleanup', 1),
    node(7, 'Schema index tuning', 1),
  ];
  return {
    nodes,
    edges: [],
    clusterings: [
      { granularity: 'coarse', regions: [{ id: 0, label: 'build coarse', x: 0, y: 0, z: 0, size: 8 }] },
      { granularity: 'balanced', regions: [
        { id: 0, label: 'build terminal', x: 0, y: 0, z: 0, size: 4 },
        { id: 1, label: 'build schema', x: 1, y: 0, z: 0, size: 4 },
      ] },
      { granularity: 'fine', regions: [
        { id: 0, label: 'build terminal', x: 0, y: 0, z: 0, size: 4 },
        { id: 1, label: 'build schema', x: 1, y: 0, z: 0, size: 4 },
      ] },
    ],
    signature,
    modelTag: 'model',
    dimensions: 4,
    storageBytes: 0,
    builtAt: '2026-09-28T00:00:00.000Z',
  } as unknown as MemoryGraphProjection;
}

const DIGESTS = new Map<string, string>([
  ['task-0', 'Added tests covering the wheel scroll in alt screen terminals.'],
  ['task-1', 'Fixed the wheel scroll repaint in alt screen mode.'],
  ['task-2', 'Capped queued wheel scroll reports in alt screen.'],
  ['task-3', 'Reworked the wheel scroll batching for alt screen.'],
]);

describe('the labeller reads digests at a lower weight', () => {
  const points = new Float32Array(8 * 3);
  const assignment = { clusterOf: Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), clusterCount: 2 };
  const titles = projection().nodes.map((entry) => entry.title ?? '');
  const digestTexts = projection().nodes.map((entry) => DIGESTS.get(entry.taskId ?? '') ?? '');

  it('names a region by what its digests say it touched', () => {
    const titlesOnly = labelClusters(assignment, titles, points, 3);
    const withDigests = labelClusters(assignment, titles, points, 3, { texts: digestTexts, weight: DIGEST_LABEL_WEIGHT, stopWords: DIGEST_FILLER });
    const region = (summaries: ReturnType<typeof labelClusters>) => summaries.find((summary) => summary.id === 0)?.label ?? '';
    expect(region(titlesOnly)).not.toContain('wheel scroll');
    expect(region(withDigests)).toContain('wheel scroll');
    // Narration never names a region.
    expect(region(withDigests)).not.toMatch(/\b(added|tests|covering)\b/);
  });

  it('keeps a product name whole', () => {
    const githubTitles = ['GitHub issues import', 'GitHub issues sync', 'GitHub labels', 'GitHub issues mapping'];
    const summaries = labelClusters(
      { clusterOf: Int32Array.from([0, 0, 0, 0]), clusterCount: 1 },
      githubTitles,
      new Float32Array(4 * 3),
      3,
    );
    expect(summaries[0].label).not.toContain('git hub');
  });
});

describe('stored region names', () => {
  const stored: StoredRegionNames = {
    signature: 'sig-1',
    labellerVersion: LABELLER_VERSION,
    digests: '4:2026-09-28T01:00:00.000Z',
    names: { balanced: { 0: 'wheel scroll / alt screen', 1: 'schema migration' } },
  };

  it('are laid over the map they were made for, a few digests behind included', () => {
    const named = withRegionNames(projection(), stored, '5:2026-09-28T02:00:00.000Z');
    const balanced = named.clusterings.find((entry) => entry.granularity === 'balanced');
    expect(balanced?.regions.map((region) => region.label)).toEqual(['wheel scroll / alt screen', 'schema migration']);
    // A granularity with no stored names keeps the map's own.
    expect(named.clusterings.find((entry) => entry.granularity === 'coarse')?.regions[0].label).toBe('build coarse');
    expect(regionNamesUsable(stored, 'sig-1', '5:2026-09-28T02:00:00.000Z')).toBe(true);
    expect(regionNamesCurrent(stored, 'sig-1', '5:2026-09-28T02:00:00.000Z')).toBe(false);
  });

  it('are not shown on another map, another labeller, or with digests switched off', () => {
    expect(regionNamesUsable(stored, 'sig-2', stored.digests)).toBe(false);
    expect(regionNamesUsable({ ...stored, labellerVersion: LABELLER_VERSION - 1 }, 'sig-1', stored.digests)).toBe(false);
    expect(regionNamesUsable(stored, 'sig-1', DIGESTS_OFF)).toBe(false);
    const unchanged = withRegionNames(projection(), stored, DIGESTS_OFF);
    expect(unchanged.clusterings[1].regions[0].label).toBe('build terminal');
  });

  it('are made per granularity from the map itself', () => {
    const titlesOnly = nameRegions(projection(), 'balanced', null);
    const withDigests = nameRegions(projection(), 'balanced', DIGESTS);
    expect(Object.keys(titlesOnly).sort()).toEqual(['0', '1']);
    expect(withDigests[0]).toContain('wheel scroll');
    expect(titlesOnly[0]).not.toContain('wheel scroll');
  });
});

describe('the graph service names regions in the background', () => {
  let digestsOn = false;
  let fingerprint = '4:2026-09-28T01:00:00.000Z';
  let changed: string[] = [];
  let clock = 1_000_000;

  function service() {
    const graph = createGraphService({
      getDb: () => ({}) as never,
      onChanged: (projectId) => changed.push(projectId),
      digests: () => ({ fingerprint: () => fingerprint, all: () => new Map([...DIGESTS].map(([taskId, digest]) => [taskId, { digest }])) }),
      now: () => clock,
    });
    graph.setDigestNamesOn(() => digestsOn);
    return graph;
  }
  const stored = (): StoredRegionNames | null => {
    const raw = state.meta.get(REGION_NAMES_KEY);
    return raw ? JSON.parse(raw) as StoredRegionNames : null;
  };
  const regionLabel = (graph: ReturnType<typeof service>) =>
    graph.getProjection('project')?.clusterings.find((entry) => entry.granularity === 'balanced')?.regions[0].label;

  beforeEach(() => {
    vi.useFakeTimers();
    state.projection = projection();
    state.meta = new Map();
    digestsOn = false;
    fingerprint = '4:2026-09-28T01:00:00.000Z';
    changed = [];
    clock = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names a map that has none at once, and pushes when the names land', async () => {
    const graph = service();
    expect(regionLabel(graph)).toBe('build terminal');
    await vi.runAllTimersAsync();
    expect(stored()?.digests).toBe(DIGESTS_OFF);
    expect(changed).toEqual(['project']);
    expect(regionLabel(graph)).not.toBe('build terminal');
    // Current names are not made again.
    await vi.runAllTimersAsync();
    expect(changed).toEqual(['project']);
  });

  it('switching digests on or off shows the map\'s own names until the right ones land', async () => {
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    const titleNames = regionLabel(graph);

    digestsOn = true;
    expect(regionLabel(graph)).toBe('build terminal');
    await vi.runAllTimersAsync();
    expect(regionLabel(graph)).toContain('wheel scroll');

    digestsOn = false;
    expect(regionLabel(graph)).toBe('build terminal');
    await vi.runAllTimersAsync();
    expect(regionLabel(graph)).toBe(titleNames);
  });

  it('keeps the last names while digests are written, and renames at most every five minutes', async () => {
    digestsOn = true;
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    expect(changed).toHaveLength(1);

    fingerprint = '10:2026-09-28T01:01:00.000Z';
    clock += 30_000;
    // A few digests behind: still shown.
    expect(regionLabel(graph)).toContain('wheel scroll');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveLength(1);
    clock += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(changed).toHaveLength(2);
    expect(stored()?.digests).toBe('10:2026-09-28T01:01:00.000Z');
  });

  it('renames at once when the backfill says it has caught up', async () => {
    digestsOn = true;
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    fingerprint = '12:2026-09-28T01:02:00.000Z';
    graph.requestRegionNames('project', true);
    // Milliseconds, not the five-minute wait a pass that has not caught up gets.
    await vi.advanceTimersByTimeAsync(10);
    expect(stored()?.digests).toBe('12:2026-09-28T01:02:00.000Z');
  });

  it('drops names made for a map rebuilt while they were being made', async () => {
    const graph = service();
    graph.getProjection('project');
    // The rename is scheduled; the map is rebuilt before its last turn writes.
    await vi.advanceTimersByTimeAsync(0);
    state.projection = projection('sig-2');
    await vi.runAllTimersAsync();
    expect(stored()?.signature).not.toBe('sig-1');
  });
});
