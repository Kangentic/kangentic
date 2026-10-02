/**
 * What the Knowledge Graph body draws: the open project's snapshot, or several
 * projects' maps composed into islands.
 *
 * One effective snapshot either way, so the body, the canvas and the controls
 * read a single shape. With no scope set (the default) this is the store's own
 * snapshot, untouched, which keeps the single-project path exactly as it was.
 */

import { useMemo } from 'react';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import type {
  KnowledgeGraphBuildProgress,
  KnowledgeGraphCoverageBucket,
  KnowledgeGraphCoverageSummary,
  KnowledgeGraphGranularity,
  KnowledgeGraphSnapshot,
  KnowledgeGraphIndexCorpusSummary,
  KnowledgeGraphIndexSummary,
} from '../../../shared/types';
import { composeIslands, type ComposedIslands, type Island, type IslandSource } from './compose-islands';

export interface GraphView {
  snapshot: KnowledgeGraphSnapshot | null;
  /** The islands, when two or more projects' maps are composed; else null. */
  islands: Island[] | null;
  /** The project each node belongs to, by node index, when a scope is set. */
  nodeProjectIds: string[] | null;
  /** The project each region belongs to, per granularity, when composed. */
  regionProjectNames: Partial<Record<KnowledgeGraphGranularity, string[]>> | null;
  /** Scoped projects whose map is not drawable yet: still loading, or building. */
  pendingProjectIds: string[];
  /** How many unit boxes wide the drawn map is: 1 unless islands are composed.
   *  The camera's reach scales with it (`compose-islands.ts`). */
  worldExtent: number;
}

function addBuckets(first: KnowledgeGraphCoverageBucket, second: KnowledgeGraphCoverageBucket): KnowledgeGraphCoverageBucket {
  const tones: Array<KnowledgeGraphCoverageBucket['tone']> = ['ok', 'neutral', 'problem'];
  return {
    documents: first.documents + second.documents,
    chunks: first.chunks + second.chunks,
    // The worse of the two, so a problem in one project is not averaged away.
    tone: tones[Math.max(tones.indexOf(first.tone), tones.indexOf(second.tone))],
  };
}

/** Coverage across projects: every count summed, the embedded share recomputed. */
export function sumCoverage(summaries: ReadonlyArray<KnowledgeGraphCoverageSummary>): KnowledgeGraphCoverageSummary {
  const [first, ...rest] = summaries;
  const total = rest.reduce<KnowledgeGraphCoverageSummary>((sum, next) => ({
    indexed: addBuckets(sum.indexed, next.indexed),
    sourceMissingButSearchable: addBuckets(sum.sourceMissingButSearchable, next.sourceMissingButSearchable),
    empty: addBuckets(sum.empty, next.empty),
    failed: addBuckets(sum.failed, next.failed),
    notYetIndexed: addBuckets(sum.notYetIndexed, next.notYetIndexed),
    totalDocumentsWithChunks: sum.totalDocumentsWithChunks + next.totalDocumentsWithChunks,
    totalChunks: sum.totalChunks + next.totalChunks,
    totalEmbeddedChunks: sum.totalEmbeddedChunks + next.totalEmbeddedChunks,
    embeddedFraction: 0,
    knownDocumentIdsMatched: sum.knownDocumentIdsMatched + next.knownDocumentIdsMatched,
  }), first);
  return { ...total, embeddedFraction: total.totalChunks > 0 ? total.totalEmbeddedChunks / total.totalChunks : 0 };
}

/** The index across projects: each corpus's counts summed, and the sizes. */
export function sumIndex(summaries: ReadonlyArray<KnowledgeGraphIndexSummary>): KnowledgeGraphIndexSummary {
  const byCorpus = new Map<KnowledgeGraphIndexCorpusSummary['corpus'], KnowledgeGraphIndexCorpusSummary>();
  for (const summary of summaries) {
    for (const entry of summary.corpora) {
      const sum = byCorpus.get(entry.corpus);
      byCorpus.set(entry.corpus, sum
        ? {
          corpus: entry.corpus,
          documents: sum.documents + entry.documents,
          chunks: sum.chunks + entry.chunks,
          embeddedChunks: sum.embeddedChunks + entry.embeddedChunks,
          embeds: sum.embeds && entry.embeds,
        }
        : { ...entry });
    }
  }
  return {
    corpora: [...byCorpus.values()],
    summaries: {
      written: summaries.reduce((total, summary) => total + summary.summaries.written, 0),
      finishedTasks: summaries.reduce((total, summary) => total + summary.summaries.finishedTasks, 0),
      skipped: summaries.reduce((total, summary) => total + (summary.summaries.skipped ?? 0), 0),
    },
    storageBytes: summaries.reduce((total, summary) => total + summary.storageBytes, 0),
  };
}

/**
 * A scope's first-build progress while no map in it is ready: the least
 * advanced of the projects building, so the bar never says more than the slowest
 * map has done. One that has not sent a figure yet counts as just begun.
 */
export function leastBuildProgress(snapshots: ReadonlyArray<KnowledgeGraphSnapshot>): KnowledgeGraphBuildProgress | null {
  let least: KnowledgeGraphBuildProgress | null = null;
  for (const entry of snapshots) {
    if (!entry.building || entry.projection !== null) continue;
    const progress = entry.buildProgress;
    if (!progress) return null;
    if (!least || progress.percent < least.percent) least = progress;
  }
  return least;
}

// hmr-safe: a cache lost across a Fast Refresh costs one recomposition
let lastComposition: { sources: ReadonlyArray<IslandSource>; composed: ComposedIslands } | null = null;

/**
 * `composeIslands`, reused while the ready maps are the same maps in the same
 * order under the same names. A first build's progress push replaces the
 * building project's snapshot a few times a second but never a map, and must
 * not copy every node and edge of the maps beside it each time.
 */
function composeIslandsOnce(sources: ReadonlyArray<IslandSource>): ComposedIslands {
  const held = lastComposition;
  const unchanged = held !== null && held.sources.length === sources.length
    && held.sources.every((source, position) => (
      source.projectId === sources[position].projectId
      && source.name === sources[position].name
      && source.projection === sources[position].projection
    ));
  if (unchanged) return held.composed;
  const composed = composeIslands(sources);
  lastComposition = { sources, composed };
  return composed;
}

export function useGraphView(): GraphView {
  const snapshot = useKnowledgeGraphStore((state) => state.snapshot);
  const openProjectId = useKnowledgeGraphStore((state) => state.projectId);
  const scope = useKnowledgeGraphStore((state) => state.scopeProjectIds);
  const scopeSnapshots = useKnowledgeGraphStore((state) => state.scopeSnapshots);
  const projects = useKnowledgeGraphStore((state) => state.projects);

  // Re-derived when a scoped snapshot changes, which a first build's progress
  // push does a few times a second. The islands are composed again only when a
  // member's map changes (`composeIslandsOnce`), and the composed signature
  // moves only then, so the scene is not rebuilt either.
  return useMemo((): GraphView => {
    if (!scope) {
      return { snapshot, islands: null, nodeProjectIds: null, regionProjectNames: null, pendingProjectIds: [], worldExtent: 1 };
    }
    const nameOf = (projectId: string): string => projects.find((project) => project.id === projectId)?.name ?? 'Project';
    const loaded = scope.flatMap((projectId) => {
      const entry = scopeSnapshots[projectId];
      return entry ? [{ projectId, snapshot: entry }] : [];
    });
    const pendingProjectIds = scope.filter((projectId) => !scopeSnapshots[projectId]?.projection);
    if (loaded.length === 0) {
      // Nothing read yet (the open project is not in scope): a building map,
      // not "no project open", so the surface and its picker stay up.
      return {
        snapshot: snapshot ? { ...snapshot, projection: null, building: true } : null,
        islands: null,
        nodeProjectIds: null,
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }

    // The open project first, then the larger maps, so the grid reads from
    // where the user is working outward.
    const ready: IslandSource[] = loaded
      .filter((entry) => entry.snapshot.projection !== null)
      .map((entry) => ({ projectId: entry.projectId, name: nameOf(entry.projectId), projection: entry.snapshot.projection! }))
      .sort((left, right) => {
        if (left.projectId === openProjectId) return -1;
        if (right.projectId === openProjectId) return 1;
        return right.projection.nodes.length - left.projection.nodes.length;
      });
    const snapshots = loaded.map((entry) => entry.snapshot);
    const base = {
      projectId: openProjectId ?? loaded[0].projectId,
      coverage: sumCoverage(snapshots.map((entry) => entry.coverage)),
      index: sumIndex(snapshots.map((entry) => entry.index)),
      // Surface-wide "building" only while there is nothing to draw at all; a
      // project still building beside ready ones is named on its own.
      building: ready.length === 0 && snapshots.some((entry) => entry.building),
      buildProgress: ready.length === 0 ? leastBuildProgress(snapshots) : null,
      stale: snapshots.some((entry) => entry.stale),
      semanticAvailable: snapshots.every((entry) => entry.semanticAvailable),
    };
    if (ready.length === 0) {
      return {
        snapshot: { ...base, projection: null },
        islands: null,
        nodeProjectIds: null,
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }
    if (ready.length === 1) {
      const only = ready[0];
      return {
        snapshot: { ...base, projection: only.projection },
        islands: null,
        nodeProjectIds: only.projection.nodes.map(() => only.projectId),
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }
    const composed = composeIslandsOnce(ready);
    return {
      snapshot: { ...base, projection: composed.projection },
      islands: composed.islands,
      nodeProjectIds: composed.nodeProjectIds,
      regionProjectNames: composed.regionProjectNames,
      pendingProjectIds,
      worldExtent: composed.extent,
    };
  }, [snapshot, openProjectId, scope, scopeSnapshots, projects]);
}
