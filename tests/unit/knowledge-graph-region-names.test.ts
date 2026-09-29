/**
 * Region names laid over a built map: made from the titles, plus each task's
 * summary at a lower weight while summaries are on, stored against the map they
 * were made for, and made again only when what they read has changed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../src/shared/types';

const state = {
  projection: null as KnowledgeGraphProjection | null,
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

import { labelClusters, SUMMARY_FILLER, SUMMARY_LABEL_WEIGHT, LABELLER_VERSION } from '../../src/main/retrieval/graph/cluster-labels';
import {
  SUMMARIES_OFF,
  REGION_NAMES_KEY,
  nameRegions,
  regionNamesCurrent,
  regionNamesUsable,
  withRegionNames,
  type StoredRegionNames,
} from '../../src/main/retrieval/graph/region-names';
import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

function node(index: number, title: string, cluster: number): KnowledgeGraphNode {
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
 *  its summaries all name the wheel scroll. Region 1 is about the schema. */
function projection(signature = 'sig-1'): KnowledgeGraphProjection {
  const nodes = [
    node(0, 'Terminal lag report', 0),
    node(1, 'Terminal feels slow', 0),
    node(2, 'Terminal input lag', 0),
    node(3, 'Terminal is sluggish', 0),
    node(4, 'Schema migration for summaries', 1),
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
  } as unknown as KnowledgeGraphProjection;
}

const SUMMARIES = new Map<string, string>([
  ['task-0', 'Added tests covering the wheel scroll in alt screen terminals.'],
  ['task-1', 'Fixed the wheel scroll repaint in alt screen mode.'],
  ['task-2', 'Capped queued wheel scroll reports in alt screen.'],
  ['task-3', 'Reworked the wheel scroll batching for alt screen.'],
]);

describe('the labeller reads summaries at a lower weight', () => {
  const points = new Float32Array(8 * 3);
  const assignment = { clusterOf: Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), clusterCount: 2 };
  const titles = projection().nodes.map((entry) => entry.title ?? '');
  const summaryTexts = projection().nodes.map((entry) => SUMMARIES.get(entry.taskId ?? '') ?? '');

  it('names a region by what its summaries say it touched', () => {
    const titlesOnly = labelClusters(assignment, titles, points, 3);
    const withSummaries = labelClusters(assignment, titles, points, 3, { texts: summaryTexts, weight: SUMMARY_LABEL_WEIGHT, stopWords: SUMMARY_FILLER });
    const region = (summaries: ReturnType<typeof labelClusters>) => summaries.find((summary) => summary.id === 0)?.label ?? '';
    expect(region(titlesOnly)).not.toContain('wheel scroll');
    expect(region(withSummaries)).toContain('wheel scroll');
    // Narration never names a region.
    expect(region(withSummaries)).not.toMatch(/\b(added|tests|covering)\b/);
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
    summaries: '4:2026-09-28T01:00:00.000Z',
    names: { balanced: { 0: 'wheel scroll / alt screen', 1: 'schema migration' } },
  };

  it('are laid over the map they were made for, a few summaries behind included', () => {
    const named = withRegionNames(projection(), stored, '5:2026-09-28T02:00:00.000Z');
    const balanced = named.clusterings.find((entry) => entry.granularity === 'balanced');
    expect(balanced?.regions.map((region) => region.label)).toEqual(['wheel scroll / alt screen', 'schema migration']);
    // A granularity with no stored names keeps the map's own.
    expect(named.clusterings.find((entry) => entry.granularity === 'coarse')?.regions[0].label).toBe('build coarse');
    expect(regionNamesUsable(stored, 'sig-1', '5:2026-09-28T02:00:00.000Z')).toBe(true);
    expect(regionNamesCurrent(stored, 'sig-1', '5:2026-09-28T02:00:00.000Z')).toBe(false);
  });

  it('are not shown on another map, another labeller, or with summaries switched off', () => {
    expect(regionNamesUsable(stored, 'sig-2', stored.summaries)).toBe(false);
    expect(regionNamesUsable({ ...stored, labellerVersion: LABELLER_VERSION - 1 }, 'sig-1', stored.summaries)).toBe(false);
    expect(regionNamesUsable(stored, 'sig-1', SUMMARIES_OFF)).toBe(false);
    const unchanged = withRegionNames(projection(), stored, SUMMARIES_OFF);
    expect(unchanged.clusterings[1].regions[0].label).toBe('build terminal');
  });

  it('are made per granularity from the map itself', () => {
    const titlesOnly = nameRegions(projection(), 'balanced', null);
    const withSummaries = nameRegions(projection(), 'balanced', SUMMARIES);
    expect(Object.keys(titlesOnly).sort()).toEqual(['0', '1']);
    expect(withSummaries[0]).toContain('wheel scroll');
    expect(titlesOnly[0]).not.toContain('wheel scroll');
  });
});

describe('the graph service names regions in the background', () => {
  let summariesOn = false;
  let fingerprint = '4:2026-09-28T01:00:00.000Z';
  let changed: string[] = [];
  let clock = 1_000_000;

  function service() {
    const graph = createGraphService({
      getDb: () => ({}) as never,
      onChanged: (projectId) => changed.push(projectId),
      summaries: () => ({ fingerprint: () => fingerprint, all: () => new Map([...SUMMARIES].map(([taskId, summary]) => [taskId, { summary }])) }),
      now: () => clock,
    });
    graph.setSummaryNamesOn(() => summariesOn);
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
    summariesOn = false;
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
    expect(stored()?.summaries).toBe(SUMMARIES_OFF);
    expect(changed).toEqual(['project']);
    expect(regionLabel(graph)).not.toBe('build terminal');
    // Current names are not made again.
    await vi.runAllTimersAsync();
    expect(changed).toEqual(['project']);
  });

  it('switching summaries on or off shows the map\'s own names until the right ones land', async () => {
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    const titleNames = regionLabel(graph);

    summariesOn = true;
    expect(regionLabel(graph)).toBe('build terminal');
    await vi.runAllTimersAsync();
    expect(regionLabel(graph)).toContain('wheel scroll');

    summariesOn = false;
    expect(regionLabel(graph)).toBe('build terminal');
    await vi.runAllTimersAsync();
    expect(regionLabel(graph)).toBe(titleNames);
  });

  it('keeps the last names while summaries are written, and renames at most every five minutes', async () => {
    summariesOn = true;
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    expect(changed).toHaveLength(1);

    fingerprint = '10:2026-09-28T01:01:00.000Z';
    clock += 30_000;
    // A few summaries behind: still shown.
    expect(regionLabel(graph)).toContain('wheel scroll');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveLength(1);
    clock += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(changed).toHaveLength(2);
    expect(stored()?.summaries).toBe('10:2026-09-28T01:01:00.000Z');
  });

  it('renames at once when the backfill says it has caught up', async () => {
    summariesOn = true;
    const graph = service();
    graph.getProjection('project');
    await vi.runAllTimersAsync();
    fingerprint = '12:2026-09-28T01:02:00.000Z';
    graph.requestRegionNames('project', true);
    // Milliseconds, not the five-minute wait a pass that has not caught up gets.
    await vi.advanceTimersByTimeAsync(10);
    expect(stored()?.summaries).toBe('12:2026-09-28T01:02:00.000Z');
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
