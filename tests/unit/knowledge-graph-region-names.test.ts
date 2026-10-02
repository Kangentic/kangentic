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
    /** No stored vectors: `resolveEmbedding` falls back to the tag it was given. */
    storedEmbeddingSignature(): null {
      return null;
    }
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
  parseStoredRegionNames,
  regionNamesCurrent,
  regionNamesUsable,
  withRegionNames,
  type StoredRegionNames,
} from '../../src/main/retrieval/graph/region-names';
import { createGraphService } from '../../src/main/retrieval/graph/graph-service';
import { runProjectionPass, writeProjectionCache } from '../../src/main/retrieval/graph/projection-engine';

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

  describe('as read back from memory_meta', () => {
    it('round-trips a blob the service wrote', () => {
      expect(parseStoredRegionNames(JSON.stringify(stored))).toEqual(stored);
    });

    it('reads nothing from an absent, unparseable, or wrongly shaped blob', () => {
      expect(parseStoredRegionNames(undefined)).toBeNull();
      expect(parseStoredRegionNames('not json')).toBeNull();
      expect(parseStoredRegionNames('null')).toBeNull();
      expect(parseStoredRegionNames(JSON.stringify({ ...stored, signature: 7 }))).toBeNull();
      expect(parseStoredRegionNames(JSON.stringify({ ...stored, summaries: null }))).toBeNull();
    });

    it('reads nothing from a blob with no names object, so laying names over a map cannot throw', () => {
      // A signature and summaries with no `names` used to be accepted, and
      // `withRegionNames` then threw reading `stored.names[granularity]`.
      const withoutNames = JSON.stringify({ signature: 'sig-1', labellerVersion: LABELLER_VERSION, summaries: SUMMARIES_OFF });
      const withNullNames = JSON.stringify({ signature: 'sig-1', labellerVersion: LABELLER_VERSION, summaries: SUMMARIES_OFF, names: null });
      expect(parseStoredRegionNames(withoutNames)).toBeNull();
      expect(parseStoredRegionNames(withNullNames)).toBeNull();

      const map = projection();
      expect(() => withRegionNames(map, parseStoredRegionNames(withoutNames), SUMMARIES_OFF)).not.toThrow();
      expect(withRegionNames(map, parseStoredRegionNames(withoutNames), SUMMARIES_OFF)).toBe(map);
    });
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
    // A console spy whose test failed before its own restore would otherwise
    // stay on for every later test in the file.
    vi.restoreAllMocks();
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

  it('names nothing for a project deleted while its naming waited', async () => {
    // The worker opens with `fileMustExist`: a deleted project's database
    // throws at its open instead of being made again empty.
    let deleted = false;
    const getDb = vi.fn(() => {
      if (deleted) throw new Error('unable to open database file');
      return {} as never;
    });
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const graph = createGraphService({ getDb, onChanged: (projectId) => changed.push(projectId), now: () => clock });
    graph.getProjection('project');

    deleted = true;
    await vi.runAllTimersAsync();

    expect(stored()).toBeNull();
    expect(changed).toEqual([]);
    expect(loggedError).toHaveBeenCalledWith('[knowledge-graph] region names failed:', expect.any(Error));
    loggedError.mockRestore();
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

  it('serves the map and makes the names again when the stored blob has no names object', async () => {
    // The blob names the current map, labeller and summary setting, so only its
    // missing `names` stands between it and being shown. That used to throw out
    // of every snapshot read.
    state.meta.set(REGION_NAMES_KEY, JSON.stringify({
      signature: 'sig-1',
      labellerVersion: LABELLER_VERSION,
      summaries: SUMMARIES_OFF,
    }));
    const graph = service();

    expect(() => graph.getProjection('project')).not.toThrow();
    expect(regionLabel(graph)).toBe('build terminal');

    await vi.runAllTimersAsync();
    expect(stored()?.names).toBeDefined();
    expect(regionLabel(graph)).not.toBe('build terminal');
  });

  it('drops names made for a map rebuilt while they were being made', async () => {
    const graph = service();
    graph.getProjection('project');
    // The rename is scheduled; the map is rebuilt before its last turn writes.
    await vi.advanceTimersByTimeAsync(0);
    // Precondition: the pass is in flight (it yields a turn per granularity and
    // writes only after the last), so nothing is stored yet. Without this the
    // test could pass with the rebuild landing after a finished pass.
    expect(stored()).toBeNull();
    state.projection = projection('sig-2');
    await vi.runAllTimersAsync();

    // What `makeRegionNames` does (graph-service.ts, "A map rebuilt meanwhile has
    // other regions"): after its last granularity it re-reads the cached map and,
    // finding another signature, returns false WITHOUT storing. So nothing is
    // stored for either map and no push goes out. Red-green: with that guard
    // removed the pass would store `signature: 'sig-1'` and push `changed`, and
    // a guard that stored under the NEW signature would leave sig-1's names
    // laid over sig-2, which the old `not.toBe('sig-1')` check let through.
    expect(stored()).toBeNull();
    expect(changed).toEqual([]);
    expect(regionLabel(graph)).toBe('build terminal');

    // That read is what a reader does next: it sees the rebuilt map has no
    // current names and asks again. The names that land are for sig-2.
    await vi.runAllTimersAsync();
    expect(stored()?.signature).toBe('sig-2');
    expect(changed).toEqual(['project']);
    expect(regionLabel(graph)).not.toBe('build terminal');
  });

  describe('a project forgotten while its names are being made', () => {
    /**
     * Starts a naming run and leaves it in flight, with a second request for the
     * same project waiting behind it (`again`). Returns the service, and how many
     * times it had opened the project's index by then: a naming run opens it
     * first thing (`storeFor`), so any later opening is a later run.
     */
    async function runningWithAnotherAskedFor() {
      const getDb = vi.fn(() => ({}) as never);
      const graph = createGraphService({ getDb, onChanged: (projectId) => changed.push(projectId), now: () => clock });
      graph.getProjection('project');
      await vi.advanceTimersByTimeAsync(0);
      // Precondition: the run is in flight (it yields a turn per granularity and
      // writes only after the last), so the request below lands while it runs.
      expect(stored()).toBeNull();
      graph.requestRegionNames('project', true);
      return { graph, getDb, opensWhileRunning: getDb.mock.calls.length };
    }

    // Control for the test below: nobody forgets the project, so the request
    // that arrived mid-run is made after it, which opens the index once more.
    // It shows the harness really sets `again`, so the silence below is the
    // forget and not a request that was never queued.
    it('control: makes the request that arrived mid-run once the run ends, when the project is not forgotten', async () => {
      const { getDb, opensWhileRunning } = await runningWithAnotherAskedFor();

      await vi.runAllTimersAsync();

      expect(getDb.mock.calls.length).toBe(opensWhileRunning + 1);
      // The run that was in flight stored its names and told the renderer once.
      // The request behind it found them current and changed nothing.
      expect(changed).toEqual(['project']);
    });

    // Red-green, two lines of `runRegionNames`. Drop `&& naming.get(projectId)
    // === state` from the finally: `forget` deleted the project's naming state,
    // so the finally's `scheduleRegionNames` makes a fresh one with a timer,
    // which runs and opens the index of a project that is closed for deletion,
    // and the count below is one higher than the control's difference of zero.
    // Drop `naming.get(projectId) === state` from the push (`changed && ...`,
    // leaving `if (changed) onChanged?.(projectId)`): the run finishes after
    // the forget, returns true, and tells the renderer about a project nobody
    // is left to tell, so `changed` is `['project']` instead of empty.
    it('makes no further run for a project forgotten while its names were being made, though one was asked for', async () => {
      const { graph, getDb, opensWhileRunning } = await runningWithAnotherAskedFor();

      graph.forget('project');
      await vi.runAllTimersAsync();

      expect(getDb.mock.calls.length).toBe(opensWhileRunning);
      // Precondition for the silence below: the run finished and stored its
      // names, so `changed` stays empty because of the forget and not because
      // the run never reached its end.
      expect(stored()?.signature).toBe('sig-1');
      expect(changed).toEqual([]);
    });

    // The project is forgotten and then asked for again (closed and reopened)
    // while the first run is still in flight, so the new request owns a naming
    // state of its own. The old run belongs to the state `forget` dropped: it
    // pushes nothing and makes no request of its own, and the one further run is
    // the new state's. Its names are made once and pushed once.
    //
    // Red-green: replace `naming.get(projectId) === state` before the push in
    // `runRegionNames` with a check that the project merely HAS a naming state
    // (`naming.has(projectId)`), or drop it. The old run then finds the new
    // state, pushes as well, and `changed` is `['project', 'project']`.
    //
    // The count of one holds on any interleaving; the single push relies on the
    // new run starting before the old one has stored its names. Both runs yield
    // a turn per granularity (three) and the old one has all three still ahead
    // of it here, so the new run's timer fires between them: the setup's own
    // `stored()` precondition is what says the old run has not finished.
    it('lets the one run asked for after a forget and a new request push, and not the run it replaced', async () => {
      const { graph, getDb, opensWhileRunning } = await runningWithAnotherAskedFor();

      graph.forget('project');
      graph.requestRegionNames('project', true);
      await vi.runAllTimersAsync();

      expect(getDb.mock.calls.length).toBe(opensWhileRunning + 1);
      expect(stored()?.signature).toBe('sig-1');
      expect(changed).toEqual(['project']);
    });

    describe('while a map is being rebuilt', () => {
      let forgetOnFingerprint = false;
      let forgotten = false;

      /** A service whose summaries are on, and which forgets the project the first
       *  time the naming of the rebuilt map reads their fingerprint. That read is
       *  inside `makeRegionNames`, so it is the pass's naming step. */
      function serviceThatForgetsWhileNaming() {
        const graph = createGraphService({
          getDb: () => ({}) as never,
          onChanged: (projectId) => changed.push(projectId),
          summaries: () => ({
            fingerprint: () => {
              if (forgetOnFingerprint) {
                forgetOnFingerprint = false;
                forgotten = true;
                graph.forget('project');
              }
              return fingerprint;
            },
            all: () => new Map([...SUMMARIES].map(([taskId, summary]) => [taskId, { summary }])),
          }),
          now: () => clock,
        });
        graph.setSummaryNamesOn(() => true);
        return graph;
      }

      beforeEach(() => {
        forgetOnFingerprint = false;
        forgotten = false;
        vi.mocked(runProjectionPass).mockReset();
        vi.mocked(writeProjectionCache).mockClear();
        vi.mocked(runProjectionPass).mockResolvedValueOnce({
          projection: projection(),
          counts: { documents: 8, documentsRead: 8, vectorsRead: 8 },
        } as unknown as Awaited<ReturnType<typeof runProjectionPass>>);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
      });

      // Control for the test below: the same pass, no forget, tells the renderer.
      it('control: pushes the new map when the project is not forgotten', async () => {
        const graph = serviceThatForgetsWhileNaming();

        graph.markDirty('project', 'model', 4);
        await vi.runAllTimersAsync();

        expect(writeProjectionCache).toHaveBeenCalledTimes(1);
        expect(changed).toEqual(['project']);
      });

      // Red-green: drop `if (signal.aborted) return;` after the naming in
      // `markDirty`. The pass then goes on to `onChanged` for a project that
      // was forgotten, telling every window about a map nobody can read, and
      // `changed` is `['project']` instead of empty.
      it('does not push the new map when the project is forgotten while it is being named', async () => {
        const graph = serviceThatForgetsWhileNaming();
        forgetOnFingerprint = true;

        graph.markDirty('project', 'model', 4);
        await vi.runAllTimersAsync();

        // The pass reached its naming step, where the project was forgotten.
        expect(writeProjectionCache).toHaveBeenCalledTimes(1);
        expect(forgotten).toBe(true);
        expect(changed).toEqual([]);
      });
    });
  });
});
